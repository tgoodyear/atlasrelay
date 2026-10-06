# shellcheck shell=bash
# Deploy a build to a test environment (dev) and run the full-flow tests against it, holding the
# lock that keeps every other run off the environment meanwhile. Used by
# .github/workflows/e2e-dev.yml and scripts/run-e2e.sh. Needs az (signed in), jq, curl and node,
# with the repository root as the working directory.
# docs/RUNBOOK.md, "Full-flow tests on dev".
#
# e2e_run is the whole run. In order:
#
#   1. refuse anything but a test environment (e2e_check_target): never prod;
#   2. build the test image in the environment's registry (it touches nothing the tests use);
#   3. take the lock (e2e-real/lock-holder.mjs, in the background; it waits up to 45 minutes for
#      a run that holds it);
#   4. publish the API to the environment's Function App and upload the site (from the registry,
#      e2e_upload_site), then wait until the site serves this build;
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
    --platform linux/amd64 --timeout 1200 --no-wait . 2>&1 >/dev/null | sed -n 's/.*Queued a build with ID: \([A-Za-z0-9]*\).*/\1/p' | tail -1)
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
  # The request body names the lease, so it goes through a file rather than the command line.
  body=$(mktemp) || return 1
  az rest ${AZ_SUB[@]+"${AZ_SUB[@]}"} --method get --url "$job_url?api-version=$E2E_API" -o json |
    jq -c --arg image "$image" --arg run "$run_id" --arg sha "$sha" --arg base "$base_url" --arg lease "$lease" '
      def setenv($n; $v): (.env // []) | map(select(.name != $n)) + [{name: $n, value: $v}];
      {containers: [.properties.template.containers[]
        | .image = $image
        | .env = (setenv("E2E_RUN_ID"; $run))
        | .env = (setenv("E2E_IMAGE"; $image))
        | .env = (setenv("E2E_GIT_SHA"; $sha))
        | if $base != "" then .env = (setenv("BASE_URL"; $base)) else . end
        | if $lease != "" then .env = (setenv("E2E_LOCK_LEASE_ID"; $lease)) else . end]}' > "$body" ||
    { rm -f "$body"; return 1; }
  execution=$(az rest ${AZ_SUB[@]+"${AZ_SUB[@]}"} --method post --url "$job_url/start?api-version=$E2E_API" --body "@$body" --query name -o tsv) ||
    { rm -f "$body"; return 1; }
  rm -f "$body"
  [ -n "$execution" ] || { echo "error: the job did not return an execution name" >&2; return 1; }
  printf '%s\n' "$execution"
}

# ---------- the lock ----------

E2E_LOCK_PID=""
E2E_LOCK_DIR=""
E2E_LOCK_LEASE=""
E2E_LOCK_LOST=""

# Sleeps in the background and waits for it, so a signal's trap runs at once rather than after
# the sleep.
_e2e_sleep() { sleep "$1" & wait $! || true; }

# e2e_lock_take BLOB_URL RUN_ID GIT_SHA
# Starts e2e-real/lock-holder.mjs in the background and returns once it holds the lock, or fails
# when it gives up (it waits 45 minutes at most). Sets E2E_LOCK_LEASE.
e2e_lock_take() {
  local blob_url=$1 run_id=$2 sha=$3 deadline code
  E2E_LOCK_DIR=$(mktemp -d)
  node e2e-real/lock-holder.mjs --blob-url "$blob_url" --lease-file "$E2E_LOCK_DIR/lease" \
    --run-id "$run_id" --git-sha "$sha" --parent-pid "$$" --subscription "${E2E_SUBSCRIPTION:-}" &
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
    _e2e_sleep 2
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
    if [ "$how" = release ]; then kill -USR1 "$pid" 2> /dev/null || true; else kill -USR2 "$pid" 2> /dev/null || true; fi
    for _ in $(seq 1 20); do kill -0 "$pid" 2> /dev/null || break; sleep 1; done
    kill -KILL "$pid" 2> /dev/null || true
  fi
  [ -z "$E2E_LOCK_DIR" ] || rm -rf "$E2E_LOCK_DIR"
  E2E_LOCK_DIR=""
}

# ---------- deploying ----------

# What is deploying right now, so an exit can wait for it (or cancel it) before it releases the
# lock: a deploy that lands after the release would overwrite the next run's build.
#   api <scm host> <deployment id> <token> <start>   or   site <registry> <resource group> <run id> <start>
#   or, while the request that starts one has no answer yet, unknown <what> - - - <start>
E2E_IN_FLIGHT=()
# Set once the request to start the job has gone out.
E2E_START_SENT=""
# The registry ends an upload run 20 minutes after it is queued (--timeout 1200), whatever happens.
# A Flex Consumption deployment has no such limit, so its wait stops at the same 20 minutes.
E2E_DEPLOY_LIMIT=1200

# e2e_settle_deploy: true once the deploy in flight, if any, has ended. It cancels a site upload
# and waits for it to stop, which the registry's own timeout guarantees; it waits for an API
# deployment. Bounded by E2E_DEPLOY_LIMIT from the deploy's start, plus a minute.
e2e_settle_deploy() {
  [ ${#E2E_IN_FLIGHT[@]} -gt 0 ] || return 0
  local status="" until=$(( ${E2E_IN_FLIGHT[4]} + E2E_DEPLOY_LIMIT + 60 ))
  case "${E2E_IN_FLIGHT[0]}" in
    unknown)
      # The request went out and its answer did not come back, so a deploy may be running with no
      # id to follow or cancel. Keep the lock for as long as that deploy could last.
      local kind="an API deployment"
      [ "${E2E_IN_FLIGHT[1]}" = api ] || kind="a site upload"
      echo "$kind may have started without this run learning its id; keeping the lock until $(date -r "$until" +%H:%M:%S 2> /dev/null || date -d "@$until" +%H:%M:%S) in case it did" >&2
      while [ "$(date +%s)" -lt "$until" ]; do sleep 10; done
      # The registry ends an upload by then; an API deployment has no such limit.
      if [ "${E2E_IN_FLIGHT[1]}" = site ]; then E2E_IN_FLIGHT=(); return 0; fi
      status="not known" ;;
    api)
      echo "waiting for the API deployment to end before giving up the lock" >&2
      while [ "$(date +%s)" -lt "$until" ]; do
        status=$(curl -sS --max-time 30 "https://${E2E_IN_FLIGHT[1]}/api/deployments/${E2E_IN_FLIGHT[2]}" \
          -H @<(printf 'Authorization: Bearer %s\n' "${E2E_IN_FLIGHT[3]}") | jq -r '.status // empty' 2> /dev/null || true)
        case "$status" in 4|3|-1|5|6) E2E_IN_FLIGHT=(); return 0 ;; esac
        sleep 5
      done ;;
    site)
      echo "cancelling the site upload (${E2E_IN_FLIGHT[3]}) before giving up the lock" >&2
      az acr task cancel-run ${AZ_SUB[@]+"${AZ_SUB[@]}"} -r "${E2E_IN_FLIGHT[1]}" -g "${E2E_IN_FLIGHT[2]}" --run-id "${E2E_IN_FLIGHT[3]}" -o none 2> /dev/null || true
      while [ "$(date +%s)" -lt "$until" ]; do
        status=$(az acr task show-run ${AZ_SUB[@]+"${AZ_SUB[@]}"} -r "${E2E_IN_FLIGHT[1]}" -g "${E2E_IN_FLIGHT[2]}" --run-id "${E2E_IN_FLIGHT[3]}" \
          --query status -o tsv 2> /dev/null || true)
        case "$status" in Succeeded|Failed|Canceled|Error|Timeout) E2E_IN_FLIGHT=(); return 0 ;; esac
        sleep 10
      done ;;
  esac
  local what="API deployment ${E2E_IN_FLIGHT[2]}"
  [ "${E2E_IN_FLIGHT[0]}" != unknown ] || what="API deployment (id not known)"
  [ "${E2E_IN_FLIGHT[0]}" != site ] || what="site upload run ${E2E_IN_FLIGHT[3]}"
  _e2e_error "the $what had not ended (last status: ${status:-unknown}); leaving the lock to lapse rather than releasing it. Check dev's build before the next run."
  return 1
}

# e2e_upload_site REGISTRY RESOURCE_GROUP SITE_DIR DEPLOYMENT_TOKEN
# Uploads SITE_DIR to the static web app's production environment with the Static Web Apps upload
# client (the image the Deploy workflow's upload action runs), as an ACR Tasks run in the
# environment's registry. The client is built for x86-64 only, so it cannot run on an Apple
# silicon Mac without Rosetta; in the registry it runs the same from anywhere, with the roles the
# image build uses. The token reaches the container as a secret value of the run: ACR keeps it
# out of the run's log and its stored definition, and az's command log records no values, but it
# is on az's command line while az queues the run. The build context is SITE_DIR alone.
e2e_upload_site() {
  local registry=$1 rg=$2 site_dir=$3 token=$4 ctx run_id queued status=""
  ctx=$(mktemp -d) || return 1
  cp -R "$site_dir" "$ctx/app" || { rm -rf "$ctx"; return 1; }
  # The variables are the ones the Static Web Apps CLI (swa deploy) sets for the client.
  cat > "$ctx/acr-upload.yaml" << 'YAML'
version: v1.1.0
steps:
  - id: upload
    cmd: --entrypoint /bin/staticsites/StaticSitesClient mcr.microsoft.com/appsvc/staticappsclient:stable
    timeout: 900
    env:
      - DEPLOYMENT_ACTION=upload
      - DEPLOYMENT_PROVIDER=SwaCli
      - REPOSITORY_BASE=/workspace
      - APP_LOCATION=app
      - CONFIG_FILE_LOCATION=app
      - SKIP_APP_BUILD=true
      - SKIP_API_BUILD=true
      - VERBOSE=false
      - DEPLOYMENT_TOKEN={{.Values.token}}
YAML
  # Queued, not followed, so its id is known: an exit while it runs cancels it (e2e_settle_deploy).
  queued=$(date +%s)
  E2E_IN_FLIGHT=(unknown site - - "$queued")
  run_id=$(az acr run ${AZ_SUB[@]+"${AZ_SUB[@]}"} -r "$registry" -g "$rg" --set-secret "token=$token" -f acr-upload.yaml \
    --timeout "$E2E_DEPLOY_LIMIT" --no-wait "$ctx" 2>&1 >/dev/null | sed -n 's/.*Queued a run with ID: \([A-Za-z0-9]*\).*/\1/p' | tail -1)
  rm -rf "$ctx"
  [ -n "$run_id" ] || { _e2e_error "the registry returned no run id for the upload"; return 1; }
  E2E_IN_FLIGHT=(site "$registry" "$rg" "$run_id" "$queued")
  az acr task logs ${AZ_SUB[@]+"${AZ_SUB[@]}"} -r "$registry" -g "$rg" --run-id "$run_id" || echo "warning: could not read the upload's log" >&2
  for _ in $(seq 1 120); do
    status=$(az acr task show-run ${AZ_SUB[@]+"${AZ_SUB[@]}"} -r "$registry" -g "$rg" --run-id "$run_id" --query status -o tsv) || return 1
    case "$status" in Succeeded|Failed|Canceled|Error|Timeout) break ;; esac
    _e2e_sleep 10
  done
  case "$status" in Succeeded|Failed|Canceled|Error|Timeout) E2E_IN_FLIGHT=() ;; esac
  [ "$status" = Succeeded ] || { _e2e_error "upload run $run_id ended ${status:-unfinished}"; return 1; }
}

# e2e_deploy SUBSCRIPTION ENV RESOURCE_GROUP SWA_NAME REGISTRY SITE_DIR API_ZIP
# Publishes API_ZIP to the Function App linked to the site, uploads SITE_DIR to the site's
# production environment, and waits until the site serves it. The same steps as the Deploy
# workflow, with the same roles (infra/rbac.bicep), against ENV's resources only: each must carry
# the tag environment=ENV.
e2e_deploy() {
  local sub=$1 env=$2 rg=$3 swa=$4 registry=$5 site_dir=$6 api_zip=$7 site_url site host ids lower app app_env scm token code id status script published
  site_url="https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Web/staticSites/$swa"
  site=$(az rest --subscription "$sub" --method get --url "$site_url?api-version=2024-04-01" -o json) || return 1
  host=$(jq -r '.properties.defaultHostname // empty' <<< "$site")
  [ "$(jq -r '.tags.environment // empty' <<< "$site")" = "$env" ] && [ -n "$host" ] ||
    { _e2e_error "$swa is not tagged environment=$env, or has no hostname"; return 1; }

  ids=$(az rest --subscription "$sub" --method get --url "$site_url/linkedBackends?api-version=2024-04-01" --query "value[].properties.backendResourceId" -o tsv) || return 1
  lower=$(printf '%s\n%s' "$ids" "/subscriptions/$sub/resourcegroups/$rg/providers/microsoft.web/sites/func-atlasrelay-$env-" | tr '[:upper:]' '[:lower:]')
  if [ "$(grep -c . <<< "$ids")" != 1 ] || [[ "$(sed -n 1p <<< "$lower")" != "$(sed -n 2p <<< "$lower")"* ]]; then
    _e2e_error "$swa needs exactly one linked Function App of its own, func-atlasrelay-$env-* in $rg (found: ${ids:-none})"
    return 1
  fi
  app=$(az rest --subscription "$sub" --method get --url "$ids?api-version=2024-04-01" -o json) || return 1
  app_env=$(jq -r '.tags.environment // empty' <<< "$app")
  scm=$(jq -r '[.properties.hostNameSslStates[] | select(.hostType == "Repository") | .name][0] // empty' <<< "$app")
  [ "$app_env" = "$env" ] && [ -n "$scm" ] || { _e2e_error "the Function App is not tagged environment=$env, or has no deployment host"; return 1; }

  # The API first, then the site, as the Deploy workflow does: a failed publish leaves the
  # previous API and site in place together. One POST to the publish endpoint with a Microsoft
  # Entra token; no publishing password exists.
  echo "publishing the API to $(basename "$ids")"
  token=$(az account get-access-token --subscription "$sub" --query accessToken -o tsv) || return 1
  _e2e_mask "$token"
  published=$(date +%s)
  E2E_IN_FLIGHT=(unknown api - - "$published")
  code=$(curl -sS --max-time 300 -o "$E2E_LOCK_DIR/publish.txt" -w '%{http_code}' -X POST "https://$scm/api/publish?RemoteBuild=false" \
    -H @<(printf 'Authorization: Bearer %s\n' "$token") -H 'Content-Type: application/zip' --data-binary "@$api_zip") || return 1
  case "$code" in
    200) E2E_IN_FLIGHT=() ;;
    202)
      # A 202 carries the deployment's id. Its status: 4 succeeded; 3 failed; -1 or 5 cancelled;
      # 6 partly succeeded. The endpoint can miss a poll while the app restarts.
      id=$(tr -d '"[:space:]' < "$E2E_LOCK_DIR/publish.txt")
      [[ $id =~ ^[A-Za-z0-9-]+$ ]] || { _e2e_error "publish returned no deployment id"; return 1; }
      E2E_IN_FLIGHT=(api "$scm" "$id" "$token" "$published")
      status=""
      for _ in $(seq 1 120); do
        _e2e_sleep 5
        status=$(curl -sS --max-time 30 "https://$scm/api/deployments/$id" -H @<(printf 'Authorization: Bearer %s\n' "$token") |
          jq -r '.status // empty' 2> /dev/null || true)
        case "$status" in 4|3|-1|5|6) break ;; esac
      done
      case "$status" in 4|3|-1|5|6) E2E_IN_FLIGHT=() ;; esac
      [ "$status" = 4 ] || { _e2e_error "the API deployment ended with status ${status:-unknown (not finished in 10 minutes)}"; return 1; }
      ;;
    *) E2E_IN_FLIGHT=(); _e2e_error "publish answered $code"; cat "$E2E_LOCK_DIR/publish.txt" >&2; return 1 ;;
  esac
  echo "API published"

  e2e_lock_held || return 1
  token=$(az staticwebapp secrets list -n "$swa" -g "$rg" --subscription "$sub" --query properties.apiKey -o tsv) || return 1
  [ -n "$token" ] || { _e2e_error "could not read $swa's deployment token"; return 1; }
  _e2e_mask "$token"
  echo "uploading $site_dir to $swa"
  e2e_upload_site "$registry" "$rg" "$site_dir" "$token" || { _e2e_error "the site upload failed"; return 1; }
  e2e_lock_held || return 1

  # The upload returns before every edge serves the new files; wait for this build's script.
  script=$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$site_dir/index.html" | head -1)
  [ -n "$script" ] || { _e2e_error "$site_dir/index.html names no script"; return 1; }
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 20 "https://$host/?e2e=$RANDOM" 2> /dev/null | grep -qF "$script"; then
      echo "https://$host serves this build"
      E2E_SITE_URL=$(e2e_site_address "$host" "$(jq -r '.properties.customDomains[0] // empty' <<< "$site")" "$script")
      return 0
    fi
    _e2e_sleep 10
  done
  _e2e_error "https://$host does not serve this build 5 minutes after the upload"
  return 1
}

# e2e_site_address DEFAULT_HOST CUSTOM_HOST SCRIPT
# Prints the address the tests sign in on. The sign-in apps' redirect URIs name the custom domain
# (dev.atlasrelay.org), which a rebuilt site keeps, while a rebuilt site's default hostname is new
# and in none of them (docs/RUNBOOK.md, "Rebuilding a torn-down environment"). A newly bound domain
# can answer the platform's 404 on some requests for a while, so the custom domain counts only once
# it has served this build (SCRIPT) on ten requests in a row, within five minutes. Otherwise, or
# with no custom domain, the default hostname, where Microsoft sign-in needs its own redirect URI.
e2e_site_address() {
  local host=$1 custom=$2 script=$3 ok=0
  if [ -n "$custom" ]; then
    for _ in $(seq 1 60); do
      if curl -fsS --max-time 20 "https://$custom/?e2e=$RANDOM" 2> /dev/null | grep -qF "$script"; then
        ok=$((ok + 1))
        if [ "$ok" -ge 10 ]; then
          echo "https://$custom serves this build; the tests sign in there" >&2
          echo "https://$custom"
          return 0
        fi
      else
        ok=0
      fi
      _e2e_sleep 5
    done
    echo "warning: https://$custom does not serve this build reliably yet, so the tests use https://$host; Microsoft sign-in there needs its redirect URI (scripts/register-signin.sh ${E2E_ENV:-<env>} aad)" >&2
  fi
  echo "https://$host"
}

# ---------- the run ----------

_e2e_terminal() { case "${1:-}" in Succeeded|Failed|Stopped|Degraded) return 0 ;; *) return 1 ;; esac; }

_e2e_output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }

_e2e_execution_status() {
  az rest ${AZ_SUB[@]+"${AZ_SUB[@]}"} --method get --url "$E2E_JOB_URL/executions/$E2E_EXECUTION?api-version=$E2E_API" \
    --query properties.status -o tsv 2> /dev/null || true
}

# On any exit: release the lock, or leave it to a test job that is still running. A deploy still
# in flight is waited for, or cancelled, first.
_e2e_on_exit() {
  local code=$?
  trap - INT TERM HUP
  local settled=true
  [ ${#E2E_IN_FLIGHT[@]} -eq 0 ] || e2e_settle_deploy || settled=false
  if [ "$settled" = false ]; then
    e2e_lock_end leave
  elif [ -n "$E2E_LOCK_PID" ] && [ -n "$E2E_START_SENT" ] && [ -z "${E2E_EXECUTION:-}" ]; then
    # The start request went out but its answer did not come back: a job may have started and be
    # taking the lease over. Leave it to that job, or to lapse within a minute if none started.
    echo "the job may have started without this run learning its name; this run no longer renews the lock, which lapses within 60 s unless that job renews it" >&2
    e2e_lock_end leave
  elif [ -n "$E2E_LOCK_PID" ] && [ -n "${E2E_EXECUTION:-}" ] && ! _e2e_terminal "${E2E_STATUS:-}"; then
    echo "the test job ($E2E_EXECUTION) is still running and keeps the lock until it ends (45 minutes at most); this run no longer renews it" >&2
    e2e_lock_end leave
  else
    # Nothing to release when the holder already stopped; this clears its directory.
    e2e_lock_end release
  fi
  return "$code"
}

# e2e_lock_adopted RUN_ID: true once the test job has marked the lock as renewed by it.
e2e_lock_adopted() {
  [ "$(az storage blob metadata show ${AZ_SUB[@]+"${AZ_SUB[@]}"} --auth-mode login --account-name "$E2E_RESULTS_ACCOUNT" \
    -c "$E2E_LOCK_CONTAINER" -n full-flow --query adopted -o tsv 2> /dev/null)" = "$1" ]
}

# e2e_run, with these set:
#   E2E_ENV E2E_SUBSCRIPTION E2E_RG E2E_SWA E2E_JOB E2E_REGISTRY_NAME E2E_RESULTS_ACCOUNT
#   E2E_RUN_ID E2E_SHA E2E_IMAGE_TAG
#   E2E_SITE_DIR   the built site, e.g. web/dist
#   E2E_API_ZIP    the staged API (e2e_stage_api)
#   E2E_BASE_URL   optional: the address the tests use instead of the one e2e_deploy picks
#                  (e2e_site_address: the custom domain once it serves the build, else the
#                  site's default hostname)
#   E2E_WAIT       false: return once the test job renews the lock itself (default true)
# Sets E2E_SITE_URL (the address e2e_deploy picked), and E2E_IMAGE, E2E_JOB_URL, E2E_EXECUTION and
# E2E_STATUS, which in a workflow it also writes (as image, job_url, execution, status, run_id) to
# GITHUB_OUTPUT. Returns 0 only if the execution
# succeeded (or, with E2E_WAIT=false, took the lock over) and the lock was held throughout.
e2e_run() {
  local blob_url deadline status=""
  E2E_EXECUTION="" E2E_STATUS="" E2E_JOB_URL="" E2E_IMAGE="" E2E_SITE_URL=""
  e2e_check_target "$E2E_ENV" "$E2E_RG" "$E2E_SWA" "$E2E_JOB" || return 1
  for f in "$E2E_SITE_DIR/index.html" "$E2E_API_ZIP"; do
    [ -s "$f" ] || { _e2e_error "$f is missing; build the site and stage the API first"; return 1; }
  done
  [[ $E2E_RESULTS_ACCOUNT =~ ^[a-z0-9]{3,24}$ ]] || { _e2e_error "not a storage account name: $E2E_RESULTS_ACCOUNT"; return 1; }
  # Every az call in the environment's subscription (and so its tenant), whichever az has selected.
  AZ_SUB=(--subscription "$E2E_SUBSCRIPTION")
  blob_url="https://$E2E_RESULTS_ACCOUNT.blob.core.windows.net/$E2E_LOCK_CONTAINER/full-flow"
  E2E_JOB_URL="https://management.azure.com/subscriptions/$E2E_SUBSCRIPTION/resourceGroups/$E2E_RG/providers/Microsoft.App/jobs/$E2E_JOB"
  _e2e_output run_id "$E2E_RUN_ID"
  _e2e_output job_url "$E2E_JOB_URL"

  # The lock this run takes must be the one the job renews: the job definition names it.
  e2e_az_refresh now || return 1
  local job_lock
  job_lock=$(az rest ${AZ_SUB[@]+"${AZ_SUB[@]}"} --method get --url "$E2E_JOB_URL?api-version=$E2E_API" -o json |
    jq -r '[.properties.template.containers[].env[]? | select(.name == "LOCK_CONTAINER_URL") | .value][0] // empty') || return 1
  if [ "${job_lock%/}/full-flow" != "$blob_url" ]; then
    _e2e_error "the job's lock (${job_lock:-none; run scripts/provision.sh}) is not $blob_url; check the settings (E2E_RESULTS_ACCOUNT)"
    return 1
  fi

  # The test image first: building it changes nothing on the environment, so it needs no lock,
  # and a run that waits for the lock waits with its image ready.
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
  e2e_deploy "$E2E_SUBSCRIPTION" "$E2E_ENV" "$E2E_RG" "$E2E_SWA" "$E2E_REGISTRY_NAME" "$E2E_SITE_DIR" "$E2E_API_ZIP" || return 1

  e2e_az_refresh || return 1
  e2e_lock_held || return 1
  E2E_START_SENT=1
  E2E_EXECUTION=$(e2e_start_job "$E2E_JOB_URL" "$E2E_IMAGE" "$E2E_RUN_ID" "$E2E_SHA" "${E2E_BASE_URL:-$E2E_SITE_URL}" "$E2E_LOCK_LEASE") || return 1
  _e2e_output execution "$E2E_EXECUTION"
  echo "started $E2E_EXECUTION (run $E2E_RUN_ID)"

  # The job gives a run 45 minutes; a start can wait a few minutes for capacity.
  deadline=$(( $(date +%s) + 55 * 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    e2e_az_refresh || true
    status=$(_e2e_execution_status)
    _e2e_terminal "$status" && break
    # A run that lost the lock keeps waiting: the job notices too, stops its tests the way Ctrl+C
    # does (the credit return still runs) and fails, and its results are worth reading.
    e2e_lock_held || true
    if [ "${E2E_WAIT:-true}" = false ] && [ "$status" = Running ] && e2e_lock_adopted "$E2E_RUN_ID"; then
      e2e_lock_held || return 1
      E2E_STATUS=$status
      _e2e_output status "$E2E_STATUS"
      echo "the job renews the lock itself now; not waiting for it to end"
      return 0
    fi
    echo "$(date -u +%H:%M:%S) ${status:-pending}"
    _e2e_sleep 20
  done
  if ! _e2e_terminal "$status"; then
    _e2e_error "execution $E2E_EXECUTION did not finish in 55 minutes (last status: ${status:-unknown}); stopping it"
    az rest ${AZ_SUB[@]+"${AZ_SUB[@]}"} --method post --url "$E2E_JOB_URL/executions/$E2E_EXECUTION/stop?api-version=$E2E_API" -o none || true
    # A stop returns before the container exits, and its credit returns may still be running:
    # keep the lock until the execution has ended (5 minutes at most), else leave it to the job.
    for _ in $(seq 1 30); do
      status=$(_e2e_execution_status)
      _e2e_terminal "$status" && break
      _e2e_sleep 10
    done
    _e2e_terminal "$status" || status=Stopping
  fi
  E2E_STATUS=$status
  _e2e_output status "$E2E_STATUS"
  echo "execution $E2E_EXECUTION: $E2E_STATUS"
  e2e_lock_held || return 1
  # Stopping is not final: the exit leaves the lock to the job instead of releasing it.
  _e2e_terminal "$E2E_STATUS" || return 1
  e2e_lock_end release
  echo "released the lock"
  [ "$E2E_STATUS" = Succeeded ]
}
