# shellcheck shell=bash
# Build the full-flow test image and start the test job with it. Used by
# .github/workflows/e2e-dev.yml and scripts/run-e2e.sh. Needs az (signed in) and jq, with the
# repository root as the working directory. The az acr calls take AZ_SUB (scripts/lib/env.sh) when
# it is set, and az's selected subscription otherwise.

# The Container Apps API version both callers use.
E2E_API=2025-07-01

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

# e2e_start_job JOB_URL IMAGE RUN_ID GIT_SHA
# Starts the job with its own container definition, the image swapped for IMAGE and a run id the
# results are filed under. Everything else (the variables naming the vault and the secrets, CPU,
# memory, the registry) comes from the job as Bicep declared it. Prints the execution's name.
e2e_start_job() {
  local job_url=$1 image=$2 run_id=$3 sha=$4 base_url=${5:-} body execution
  body=$(az rest --method get --url "$job_url?api-version=$E2E_API" -o json |
    jq -c --arg image "$image" --arg run "$run_id" --arg sha "$sha" --arg base "$base_url" '
      def setenv($n; $v): (.env // []) | map(select(.name != $n)) + [{name: $n, value: $v}];
      {containers: [.properties.template.containers[]
        | .image = $image
        | .env = (setenv("E2E_RUN_ID"; $run))
        | .env = (setenv("E2E_IMAGE"; $image))
        | .env = (setenv("E2E_GIT_SHA"; $sha))
        | if $base != "" then .env = (setenv("BASE_URL"; $base)) else . end]}') || return 1
  execution=$(az rest --method post --url "$job_url/start?api-version=$E2E_API" --body "$body" --query name -o tsv) || return 1
  [ -n "$execution" ] || { echo "error: the job did not return an execution name" >&2; return 1; }
  printf '%s\n' "$execution"
}
