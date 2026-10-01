# shellcheck shell=bash
# Deploy a build to a test environment (dev) and run the full-flow tests against it, holding the
# lock that keeps every other run off the environment meanwhile. Used by
# .github/workflows/e2e-dev.yml and scripts/run-e2e.sh. Needs az (signed in), jq, curl, node and
# the repository's root dependencies (npx swa), with the repository root as the working directory.
# docs/RUNBOOK.md, "Full-flow tests on dev".
#
# e2e_run is the whole run. In order:
#
#   1. refuse anything but a test environment (e2e_check_target): never prod;
#   2. build the test image in the environment's registry (it touches nothing the tests use);
#   3. take the lock (e2e-real/lock-holder.mjs, in the background; it waits up to 45 minutes for
#      a run that holds it);
#   4. publish the API to the environment's Function App and upload the site, then wait until the
#      site serves this build;
#   5. start the test job with the image, handing it the lease (E2E_LOCK_LEASE_ID) to renew;
#   6. wait for the execution to end (55 minutes at most);
#   7. release the lock.
#
# Between steps it checks the lock is still held; a run that lost it deploys and starts nothing
# more. An exit at any point (an error, Ctrl+C, a cancelled workflow) releases the lock, unless
# the test job is still running: then it only stops renewing, and the job keeps the lease until
# it ends.
#
# The az acr calls take AZ_SUB (scripts/lib/env.sh) when it is set, and az's selected subscription
# otherwise.

# The Container Apps API version both callers use.
E2E_API=2025-07-01
# infra/testharness.bicep declares this container; e2e-real/lib/lock.mjs names the blob.
E2E_LOCK_CONTAINER=locks

_e2e_github() { [ -n "${GITHUB_ACTIONS:-}" ]; }
_e2e_mask() { if _e2e_github; then echo "::add-mask::$1"; fi; }
_e2e_error() {
  if _e2e_github; then echo "::error::$*" >&2; else echo "error: $*" >&2; fi
}

# In a GitHub Actions job, az was signed in by azure/login with an OIDC token that lasts minutes,
# and holds no refresh token: once an access token runs out (after about an hour), or az needs one
# for a new resource, it cannot get another. A run can last two hours, so this signs az in again
# with a fresh OIDC token, at most every 10 minutes. Elsewhere it does nothing. Needs
# AZURE_CLIENT_ID, AZURE_TENANT_ID and SUBSCRIPTION_ID in a workflow job.
E2E_AZ_LOGIN_AT=0
e2e_az_refresh() {
  [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || return 0
  [ "${1:-}" = now ] || [ $(( $(date +%s) - E2E_AZ_LOGIN_AT )) -ge 600 ] || return 0
  local oidc
  oidc=$(curl -fsS --max-time 30 -H @<(printf 'Authorization: Bearer %s\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN") \
    "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=api://AzureADTokenExchange" | jq -r '.value // empty') && [ -n "$oidc" ] ||
    { _e2e_error "could not get an OIDC token from GitHub"; return 1; }
  _e2e_mask "$oidc"
  az login --service-principal -u "$AZURE_CLIENT_ID" -t "$AZURE_TENANT_ID" --federated-token "$oidc" \
    --allow-no-subscriptions --only-show-errors -o none || { _e2e_error "could not sign az in again"; return 1; }
  az account set -s "$SUBSCRIPTION_ID" || return 1
  E2E_AZ_LOGIN_AT=$(date +%s)
}

# e2e_stage_api
# Packs the built API (npm run build) as the Deploy workflow does: api/dist/bundle.js, host.json
# and package.json, no node_modules, zipped to api.zip. The bundle must name the built site's
# script (web/dist/shell/project.html), so build both from the same commit.
e2e_stage_api() {
  local script
  rm -rf api-deploy api.zip && mkdir -p api-deploy/dist || return 1
  cp api/dist/bundle.js api-deploy/dist/bundle.js && cp api/host.json api/package.json api-deploy/ || return 1
  [ "$(node -p "require('./api-deploy/package.json').main")" = dist/bundle.js ] ||
    { _e2e_error "api/package.json's main is not dist/bundle.js"; return 1; }
  script=$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' web/dist/shell/project.html || true)
  if [ -z "$script" ] || ! grep -qF "$script" api-deploy/dist/bundle.js; then
    _e2e_error "the API bundle does not name the built site's script; build web and api together"
    return 1
  fi
  (cd api-deploy && zip -qr ../api.zip .) || return 1
  echo "staged api.zip"
}

# e2e_check_target ENV RESOURCE_GROUP SWA_NAME JOB_NAME
# This path deploys whatever commit it is given, so it refuses prod, and any name that is not the
# environment's own. e2e_deploy checks the resources' environment tags as well.
e2e_check_target() {
  local env=$1 rg=$2 swa=$3 job=$4
  [[ $env =~ ^[a-z][a-z0-9]{0,5}$ ]] || { _e2e_error "not an environment name: $env"; return 1; }
  [ "$env" != prod ] || { _e2e_error "the full-flow tests deploy to a test environment, never to prod"; return 1; }
  [ "$rg" = "rg-atlasrelay-$env" ] || { _e2e_error "resource group $rg is not $env's"; return 1; }
  [ "$swa" = "swa-atlasrelay-$env" ] || { _e2e_error "static web app $swa is not $env's"; return 1; }
  [ "$job" = "caj-atlasrelay-$env-e2e" ] || { _e2e_error "test job $job is not $env's"; return 1; }
}

# e2e_build_image REGISTRY RESOURCE_GROUP TAG
# Builds e2e-real/Dockerfile in the registry with ACR Tasks. az uploads only what
# e2e-real/Dockerfile.dockerignore lets through (e2e-real/ and web/e2e/ui.ts). The build log goes to
# stderr; stdout gets the image pinned by digest, e.g.
# cratlasrelaydevabc123.azurecr.io/atlasrelay-e2e@sha256:<64 hex>.
e2e_build_image() {
  local registry=$1 rg=$2 tag=$3 run_id run status="" image
  # With --no-wait the CLI prints no JSON; the run id is only in its "Queued a build with ID" line
  # on stderr.
  run_id=$(az acr build ${AZ_SUB[@]+"${AZ_SUB[@]}"} -r "$registry" -g "$rg" -f e2e-real/Dockerfile -t "atlasrelay-e2e:$tag" \
    --platform linux/amd64 --no-wait . 2>&1 >/dev/null | sed -n 's/.*Queued a build with ID: \([A-Za-z0-9]*\).*/\1/p' | tail -1)
  [ -n "$run_id" ] || { echo "error: the registry returned no build id" >&2; return 1; }
  echo "build $run_id queued in $registry" >&2
  # Follows the build until it ends. The status below is what counts.
  az acr task logs ${AZ_SUB[@]+"${AZ_SUB[@]}"} -r "$registry" -g "$rg" --run-id "$run_id" >&2 || echo "warning: could not read the build log" >&2
  for _ in $(seq 1 90); do
    run=$(az acr task show-run ${AZ_SUB[@]+"${AZ_SUB[@]}"} -r "$registry" -g "$rg" --run-id "$run_id" -o json) || return 1
    status=$(jq -r '.status // empty' <<< "$run")
    case "$status" in Succeeded|Failed|Canceled|Error|Timeout) break ;; esac
    sleep 10
  done
  [ "$status" = Succeeded ] || { echo "error: build $run_id ended ${status:-unfinished}" >&2; return 1; }
  image=$(jq -r '.outputImages[0] // {} | "\(.registry)/\(.repository)@\(.digest)"' <<< "$run")
  [[ $image =~ ^[a-z0-9]+\.azurecr\.io/atlasrelay-e2e@sha256:[0-9a-f]{64}$ ]] ||
    { echo "error: build $run_id reported no image digest ($image)" >&2; return 1; }
  printf '%s\n' "$image"
}

# e2e_start_job JOB_URL IMAGE RUN_ID GIT_SHA [BASE_URL] [LEASE_ID]
# Starts the job with its own container definition, the image swapped for IMAGE, a run id the
# results are filed under and, given one, the lease the job renews instead of taking the lock
# itself. Everything else (the variables naming the vault and the secrets, CPU, memory, the
# registry) comes from the job as Bicep declared it. Prints the execution's name.
e2e_start_job() {
  local job_url=$1 image=$2 run_id=$3 sha=$4 base_url=${5:-} lease=${6:-} body execution
  body=$(az rest --method get --url "$job_url?api-version=$E2E_API" -o json |
    jq -c --arg image "$image" --arg run "$run_id" --arg sha "$sha" --arg base "$base_url" --arg lease "$lease" '
      def setenv($n; $v): (.env // []) | map(select(.name != $n)) + [{name: $n, value: $v}];
      {containers: [.properties.template.containers[]
        | .image = $image
        | .env = (setenv("E2E_RUN_ID"; $run))
        | .env = (setenv("E2E_IMAGE"; $image))
        | .env = (setenv("E2E_GIT_SHA"; $sha))
        | if $base != "" then .env = (setenv("BASE_URL"; $base)) else . end
        | if $lease != "" then .env = (setenv("E2E_LOCK_LEASE_ID"; $lease)) else . end]}') || return 1
  execution=$(az rest --method post --url "$job_url/start?api-version=$E2E_API" --body "$body" --query name -o tsv) || return 1
  [ -n "$execution" ] || { echo "error: the job did not return an execution name" >&2; return 1; }
  printf '%s\n' "$execution"
}

# ---------- the lock ----------

E2E_LOCK_PID=""
E2E_LOCK_DIR=""
E2E_LOCK_LEASE=""
E2E_LOCK_LOST=""

# e2e_lock_take BLOB_URL RUN_ID GIT_SHA
# Starts e2e-real/lock-holder.mjs in the background and returns once it holds the lock, or fails
# when it gives up (it waits 45 minutes at most). Sets E2E_LOCK_LEASE.
e2e_lock_take() {
  local blob_url=$1 run_id=$2 sha=$3 deadline code
  E2E_LOCK_DIR=$(mktemp -d)
  node e2e-real/lock-holder.mjs --blob-url "$blob_url" --lease-file "$E2E_LOCK_DIR/lease" \
    --run-id "$run_id" --git-sha "$sha" --parent-pid "$$" &
  E2E_LOCK_PID=$!
  # The holder ends its own wait after 45 minutes; this bound only covers a holder that hangs.
  deadline=$(( $(date +%s) + 47 * 60 ))
  while [ ! -s "$E2E_LOCK_DIR/lease" ]; do
    if ! kill -0 "$E2E_LOCK_PID" 2> /dev/null; then
      code=0; wait "$E2E_LOCK_PID" || code=$?
      E2E_LOCK_PID=""
      _e2e_error "did not get the lock (lock holder exited $code)"
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      _e2e_error "did not get the lock in 47 minutes"
      e2e_lock_end leave
      return 1
    fi
    sleep 2
  done
  E2E_LOCK_LEASE=$(< "$E2E_LOCK_DIR/lease")
}

# e2e_lock_held: true while the holder runs, which it does only while it holds the lease.
e2e_lock_held() {
  [ -z "$E2E_LOCK_LOST" ] && [ -n "$E2E_LOCK_PID" ] && kill -0 "$E2E_LOCK_PID" 2> /dev/null && return 0
  if [ -z "$E2E_LOCK_LOST" ]; then
    E2E_LOCK_LOST=1
    _e2e_error "this run no longer holds the lock; another run may be using dev"
  fi
  return 1
}

# e2e_lock_end release|leave
# release: give the lease up. leave: stop renewing it and let the test job, which renews it too,
# keep it until it ends; it lapses within 60 seconds after that.
e2e_lock_end() {
  local how=$1 pid=$E2E_LOCK_PID
  E2E_LOCK_PID=""
  if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
    if [ "$how" = release ]; then kill -TERM "$pid" 2> /dev/null || true; else kill -USR2 "$pid" 2> /dev/null || true; fi
    for _ in $(seq 1 20); do kill -0 "$pid" 2> /dev/null || break; sleep 1; done
    kill -KILL "$pid" 2> /dev/null || true
  fi
  [ -z "$E2E_LOCK_DIR" ] || rm -rf "$E2E_LOCK_DIR"
  E2E_LOCK_DIR=""
}

# ---------- deploying ----------

# e2e_deploy SUBSCRIPTION ENV RESOURCE_GROUP SWA_NAME SITE_DIR API_ZIP
# Publishes API_ZIP to the Function App linked to the site, uploads SITE_DIR to the site's
# production environment, and waits until the site serves it. The same steps as the Deploy
# workflow, with the same roles (infra/rbac.bicep), against ENV's resources only: each must carry
# the tag environment=ENV.
e2e_deploy() {
  local sub=$1 env=$2 rg=$3 swa=$4 site_dir=$5 api_zip=$6 site_url site host ids lower app app_env scm token code id status script
  site_url="https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Web/staticSites/$swa"
  site=$(az rest --method get --url "$site_url?api-version=2024-04-01" -o json) || return 1
  host=$(jq -r '.properties.defaultHostname // empty' <<< "$site")
  [ "$(jq -r '.tags.environment // empty' <<< "$site")" = "$env" ] && [ -n "$host" ] ||
    { _e2e_error "$swa is not tagged environment=$env, or has no hostname"; return 1; }

  ids=$(az rest --method get --url "$site_url/linkedBackends?api-version=2024-04-01" --query "value[].properties.backendResourceId" -o tsv) || return 1
  lower=$(printf '%s\n%s' "$ids" "/subscriptions/$sub/resourcegroups/$rg/providers/microsoft.web/sites/func-atlasrelay-$env-" | tr '[:upper:]' '[:lower:]')
  if [ "$(grep -c . <<< "$ids")" != 1 ] || [[ "$(sed -n 1p <<< "$lower")" != "$(sed -n 2p <<< "$lower")"* ]]; then
    _e2e_error "$swa needs exactly one linked Function App of its own, func-atlasrelay-$env-* in $rg (found: ${ids:-none})"
    return 1
  fi
  app=$(az rest --method get --url "$ids?api-version=2024-04-01" -o json) || return 1
  app_env=$(jq -r '.tags.environment // empty' <<< "$app")
  scm=$(jq -r '[.properties.hostNameSslStates[] | select(.hostType == "Repository") | .name][0] // empty' <<< "$app")
  [ "$app_env" = "$env" ] && [ -n "$scm" ] || { _e2e_error "the Function App is not tagged environment=$env, or has no deployment host"; return 1; }

  # The API first, then the site, as the Deploy workflow does: a failed publish leaves the
  # previous API and site in place together. One POST to the publish endpoint with a Microsoft
  # Entra token; no publishing password exists.
  echo "publishing the API to $(basename "$ids")"
  token=$(az account get-access-token --query accessToken -o tsv) || return 1
  _e2e_mask "$token"
  code=$(curl -sS --max-time 300 -o "$E2E_LOCK_DIR/publish.txt" -w '%{http_code}' -X POST "https://$scm/api/publish?RemoteBuild=false" \
    -H @<(printf 'Authorization: Bearer %s\n' "$token") -H 'Content-Type: application/zip' --data-binary "@$api_zip") || return 1
  case "$code" in
    200) ;;
    202)
      # A 202 carries the deployment's id. Its status: 4 succeeded; 3 failed; -1 or 5 cancelled;
      # 6 partly succeeded. The endpoint can miss a poll while the app restarts.
      id=$(tr -d '"[:space:]' < "$E2E_LOCK_DIR/publish.txt")
      [[ $id =~ ^[A-Za-z0-9-]+$ ]] || { _e2e_error "publish returned no deployment id"; return 1; }
      status=""
      for _ in $(seq 1 120); do
        sleep 5
        status=$(curl -sS --max-time 30 "https://$scm/api/deployments/$id" -H @<(printf 'Authorization: Bearer %s\n' "$token") |
          jq -r '.status // empty' 2> /dev/null || true)
        case "$status" in 4|3|-1|5|6) break ;; esac
      done
      [ "$status" = 4 ] || { _e2e_error "the API deployment ended with status ${status:-unknown (not finished in 10 minutes)}"; return 1; }
      ;;
    *) _e2e_error "publish answered $code"; cat "$E2E_LOCK_DIR/publish.txt" >&2; return 1 ;;
  esac
  echo "API published"

  e2e_lock_held || return 1
  # The site's deployment token goes to the CLI in its environment, never on a command line.
  token=$(az staticwebapp secrets list -n "$swa" -g "$rg" --subscription "$sub" --query properties.apiKey -o tsv) || return 1
  [ -n "$token" ] || { _e2e_error "could not read $swa's deployment token"; return 1; }
  _e2e_mask "$token"
  echo "uploading $site_dir to $swa"
  SWA_CLI_DEPLOYMENT_TOKEN=$token npx --no-install swa deploy "$site_dir" --env production \
    --swa-config-location "$site_dir" --no-use-keychain || { _e2e_error "the site upload failed"; return 1; }

  # The upload returns before every edge serves the new files; wait for this build's script.
  script=$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$site_dir/index.html" | head -1)
  [ -n "$script" ] || { _e2e_error "$site_dir/index.html names no script"; return 1; }
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 20 "https://$host/?e2e=$RANDOM" 2> /dev/null | grep -qF "$script"; then
      echo "https://$host serves this build"
      return 0
    fi
    sleep 10
  done
  _e2e_error "https://$host does not serve this build 5 minutes after the upload"
  return 1
}

# ---------- the run ----------

# TimedOut is this script's own: it stopped an execution that ran too long.
_e2e_terminal() { case "${1:-}" in Succeeded|Failed|Stopped|Degraded|TimedOut) return 0 ;; *) return 1 ;; esac; }

_e2e_output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }

# On any exit: release the lock, or leave it to a test job that is still running.
_e2e_on_exit() {
  local code=$?
  if [ -n "$E2E_LOCK_PID" ] && [ -n "${E2E_EXECUTION:-}" ] && ! _e2e_terminal "${E2E_STATUS:-}"; then
    echo "the test job ($E2E_EXECUTION) is still running and keeps the lock until it ends (45 minutes at most); this run no longer renews it" >&2
    e2e_lock_end leave
  else
    # Nothing to release when the holder already stopped; this clears its directory.
    e2e_lock_end release
  fi
  return "$code"
}

# e2e_run, with these set:
#   E2E_ENV E2E_SUBSCRIPTION E2E_RG E2E_SWA E2E_JOB E2E_REGISTRY_NAME E2E_RESULTS_ACCOUNT
#   E2E_RUN_ID E2E_SHA E2E_IMAGE_TAG
#   E2E_SITE_DIR   the built site, e.g. web/dist
#   E2E_API_ZIP    the staged API (e2e_stage_api)
#   E2E_BASE_URL   optional: the address the tests use instead of the job's own
#   E2E_WAIT       false: return once the job is running (default true)
# Sets E2E_IMAGE, E2E_JOB_URL, E2E_EXECUTION and E2E_STATUS, and in a workflow writes them (as
# image, job_url, execution, status, run_id) to GITHUB_OUTPUT. Returns 0 only if the execution
# succeeded (or, with E2E_WAIT=false, started) and the lock was held throughout.
e2e_run() {
  local blob_url deadline status=""
  E2E_EXECUTION="" E2E_STATUS="" E2E_JOB_URL="" E2E_IMAGE=""
  e2e_check_target "$E2E_ENV" "$E2E_RG" "$E2E_SWA" "$E2E_JOB" || return 1
  for f in "$E2E_SITE_DIR/index.html" "$E2E_API_ZIP"; do
    [ -s "$f" ] || { _e2e_error "$f is missing; build the site and stage the API first"; return 1; }
  done
  [[ $E2E_RESULTS_ACCOUNT =~ ^[a-z0-9]{3,24}$ ]] || { _e2e_error "not a storage account name: $E2E_RESULTS_ACCOUNT"; return 1; }
  blob_url="https://$E2E_RESULTS_ACCOUNT.blob.core.windows.net/$E2E_LOCK_CONTAINER/full-flow"
  E2E_JOB_URL="https://management.azure.com/subscriptions/$E2E_SUBSCRIPTION/resourceGroups/$E2E_RG/providers/Microsoft.App/jobs/$E2E_JOB"
  _e2e_output run_id "$E2E_RUN_ID"
  _e2e_output job_url "$E2E_JOB_URL"

  # The test image first: building it changes nothing on the environment, so it needs no lock,
  # and a run that waits for the lock waits with its image ready.
  e2e_az_refresh now || return 1
  echo "building the test image in $E2E_REGISTRY_NAME"
  E2E_IMAGE=$(e2e_build_image "$E2E_REGISTRY_NAME" "$E2E_RG" "$E2E_IMAGE_TAG") || return 1
  echo "built $E2E_IMAGE"
  _e2e_output image "$E2E_IMAGE"

  trap _e2e_on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  echo "taking the lock $E2E_LOCK_CONTAINER/full-flow in $E2E_RESULTS_ACCOUNT"
  e2e_lock_take "$blob_url" "$E2E_RUN_ID" "$E2E_SHA" || return 1

  e2e_az_refresh || return 1
  e2e_lock_held || return 1
  e2e_deploy "$E2E_SUBSCRIPTION" "$E2E_ENV" "$E2E_RG" "$E2E_SWA" "$E2E_SITE_DIR" "$E2E_API_ZIP" || return 1

  e2e_az_refresh || return 1
  e2e_lock_held || return 1
  E2E_EXECUTION=$(e2e_start_job "$E2E_JOB_URL" "$E2E_IMAGE" "$E2E_RUN_ID" "$E2E_SHA" "${E2E_BASE_URL:-}" "$E2E_LOCK_LEASE") || return 1
  _e2e_output execution "$E2E_EXECUTION"
  echo "started $E2E_EXECUTION (run $E2E_RUN_ID)"

  # The job gives a run 45 minutes; a start can wait a few minutes for capacity.
  deadline=$(( $(date +%s) + 55 * 60 ))
  local running_since=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    e2e_az_refresh || true
    status=$(az rest --method get --url "$E2E_JOB_URL/executions/$E2E_EXECUTION?api-version=$E2E_API" --query properties.status -o tsv 2> /dev/null || true)
    _e2e_terminal "$status" && break
    # A run that lost the lock keeps waiting: the job notices too, stops its tests the way Ctrl+C
    # does (the credit return still runs) and fails, and its results are worth reading.
    e2e_lock_held || true
    if [ "${E2E_WAIT:-true}" = false ] && [ "$status" = Running ]; then
      # The job takes over the lease within seconds of starting (it reads the vault first). Two
      # more minutes of renewing cover that; should the lease lapse first anyway, the job finds
      # it gone and stops before it signs in.
      [ "$running_since" != 0 ] || running_since=$(date +%s)
      if [ $(( $(date +%s) - running_since )) -ge 120 ]; then
        E2E_STATUS=$status
        _e2e_output status "$E2E_STATUS"
        echo "the job is running and renews the lock itself; not waiting for it to end"
        return 0
      fi
    fi
    echo "$(date -u +%H:%M:%S) ${status:-pending}"
    sleep 20
  done
  if ! _e2e_terminal "$status"; then
    _e2e_error "execution $E2E_EXECUTION did not finish in 55 minutes (last status: ${status:-unknown}); stopping it"
    az rest --method post --url "$E2E_JOB_URL/executions/$E2E_EXECUTION/stop?api-version=$E2E_API" -o none || true
    status=TimedOut
  fi
  E2E_STATUS=$status
  _e2e_output status "$E2E_STATUS"
  echo "execution $E2E_EXECUTION: $E2E_STATUS"
  e2e_lock_held || return 1
  e2e_lock_end release
  echo "released the lock"
  [ "$E2E_STATUS" = Succeeded ]
}
