#!/usr/bin/env bash
# Build the full-flow test image from this working tree and run the test job with it, from your own
# machine: the same steps as .github/workflows/e2e-dev.yml, for a branch that is not on main yet.
# docs/RUNBOOK.md, "Full-flow tests on dev".
#
#   scripts/run-e2e.sh <env> [--no-wait] [--base-url URL]
#
#   --no-wait        start the job and return, without waiting for it to finish
#   --base-url URL   test this address instead of the job's own, e.g. the site's default
#                    azurestaticapps.net hostname while a new custom domain is still settling
#
# The image is built in the environment's registry with ACR Tasks from the files in this working
# tree, committed or not, and tagged local-<commit>-<time>. The run's results go to the results
# container under runs/local-<time>/, as a workflow run's do.
#
# Needs: az and jq, signed in as an Owner of the environment's subscription. Run
# scripts/provision.sh <env> first when the templates have changed (the registry, the job's
# variables).
set -euo pipefail
usage() { awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 2; }
[ $# -ge 1 ] || usage
ENV_NAME=$1; shift
case "$ENV_NAME" in -*|"") usage ;; esac
WAIT=true
BASE_URL_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-wait) WAIT=false; shift ;;
    --base-url) [ $# -ge 2 ] || usage; BASE_URL_OVERRIDE=$2; shift 2 ;;
    *) usage ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
for tool in az jq git; do command -v "$tool" > /dev/null || die "$tool is not installed"; done
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
. scripts/lib/e2e-job.sh
[ -s "$ENV_FILE" ] || die "no settings for $ENV_NAME; run scripts/bootstrap.sh $ENV_NAME first"
az_sub
az account show "${AZ_SUB[@]}" -o none 2> /dev/null ||
  die "run: az login (the environment is in subscription $(aget AZURE_SUBSCRIPTION_ID))"
RG=$(aget AZURE_RESOURCE_GROUP)
JOB=$(aget E2E_JOB_NAME)
REGISTRY=$(aget E2E_REGISTRY)
[ -n "$JOB" ] || die "$ENV_NAME has no test job (E2E_JOB_NAME is empty)"
[ -n "$REGISTRY" ] || die "$ENV_NAME has no test registry (E2E_REGISTRY is empty); run scripts/provision.sh $ENV_NAME"

sha=$(git rev-parse HEAD)
stamp=$(date -u +%Y%m%d-%H%M%S)
[ -z "$(git status --porcelain -- e2e-real web/e2e/ui.ts)" ] ||
  echo "note: e2e-real/ or web/e2e/ui.ts has uncommitted changes; the image includes them"

echo "building the test image in $REGISTRY"
image=$(e2e_build_image "$REGISTRY" "$RG" "local-${sha:0:12}-$stamp")
echo "built $image"

job_url="https://management.azure.com/subscriptions/$(aget AZURE_SUBSCRIPTION_ID)/resourceGroups/$RG/providers/Microsoft.App/jobs/$JOB"
run_id="local-$stamp"
execution=$(e2e_start_job "$job_url" "$image" "$run_id" "$sha" "$BASE_URL_OVERRIDE")
echo "started $execution (run $run_id)"
echo "results: storage account $(aget E2E_RESULTS_ACCOUNT), container $(aget E2E_RESULTS_CONTAINER), runs/$run_id/"
[ "$WAIT" = true ] || exit 0

# The job gives a run 20 minutes; a start can wait a few minutes for capacity.
deadline=$(( $(date +%s) + 30 * 60 ))
status=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  status=$(az rest --method get --url "$job_url/executions/$execution?api-version=$E2E_API" --query properties.status -o tsv 2> /dev/null || true)
  case "$status" in
    Succeeded|Failed|Stopped|Degraded) break ;;
  esac
  echo "$(date -u +%H:%M:%S) ${status:-pending}"
  sleep 20
done
echo "execution $execution: ${status:-unknown}"
[ "$status" = Succeeded ]
