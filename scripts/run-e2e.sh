#!/usr/bin/env bash
# Put this working tree's build on a test environment (dev) and run the full-flow tests against
# it, from your own machine: the same steps as .github/workflows/e2e-dev.yml, for a branch that is
# not on main yet. docs/RUNBOOK.md, "Full-flow tests on dev".
#
#   scripts/run-e2e.sh <env> [--no-wait] [--base-url URL]
#
#   --no-wait        return once the test job is running, without waiting for it to finish
#   --base-url URL   test this address instead of the job's own, e.g. the site's default
#                    azurestaticapps.net hostname while a new custom domain is still settling
#
# It builds the site and the API (npm ci, npm run build) and the test image (in the environment's
# registry, with ACR Tasks, tagged local-<commit>-<time>) from the files in this working tree,
# committed or not. Then it takes the lock every run on the environment shares, waiting up to 45
# minutes for a run that holds it; deploys the API and the site; starts the test job; waits for
# it; and releases the lock. The run's results go to the results container under
# runs/local-<time>/, as a workflow run's do. Never prod: it refuses an environment without the
# test harness, and checks every resource it deploys to is the environment's own.
#
# Needs: az, jq, git, curl, zip and node 22, signed in to Azure as an Owner of the environment's
# subscription. Run scripts/provision.sh <env> first when the templates have changed (the
# registry, the job's variables, the locks container).
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
for tool in az jq git curl zip node npm; do command -v "$tool" > /dev/null || die "$tool is not installed"; done
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
. scripts/lib/e2e-job.sh
[ "$ENV_NAME" != prod ] || die "the full-flow tests deploy the working tree to a test environment; prod is never one"
[ -s "$ENV_FILE" ] || die "no settings for $ENV_NAME; run scripts/bootstrap.sh $ENV_NAME first"
az_sub
az account show "${AZ_SUB[@]}" -o none 2> /dev/null ||
  die "run: az login (the environment is in subscription $(aget AZURE_SUBSCRIPTION_ID))"
E2E_ENV=$ENV_NAME
E2E_SUBSCRIPTION=$(aget AZURE_SUBSCRIPTION_ID)
E2E_RG=$(aget AZURE_RESOURCE_GROUP)
E2E_SWA=$(aget SWA_NAME)
E2E_JOB=$(aget E2E_JOB_NAME)
E2E_REGISTRY_NAME=$(aget E2E_REGISTRY)
E2E_RESULTS_ACCOUNT=$(aget E2E_RESULTS_ACCOUNT)
[ -n "$E2E_JOB" ] || die "$ENV_NAME has no test job (E2E_JOB_NAME is empty)"
[ -n "$E2E_REGISTRY_NAME" ] || die "$ENV_NAME has no test registry (E2E_REGISTRY is empty); run scripts/provision.sh $ENV_NAME"
# The names before any build: a wrong environment stops here, not after the build.
e2e_check_target "$E2E_ENV" "$E2E_RG" "$E2E_SWA" "$E2E_JOB" || exit 1

E2E_SHA=$(git rev-parse HEAD)
stamp=$(date -u +%Y%m%d-%H%M%S)
E2E_RUN_ID="local-$stamp"
E2E_IMAGE_TAG="local-${E2E_SHA:0:12}-$stamp"
[ -z "$(git status --porcelain)" ] ||
  echo "note: the working tree has uncommitted changes; the build and the image include them"

echo "building the site and the API"
npm ci --no-audit --no-fund
npm run build
e2e_stage_api
E2E_SITE_DIR=web/dist
E2E_API_ZIP=api.zip
E2E_BASE_URL=$BASE_URL_OVERRIDE
E2E_WAIT=$WAIT

echo "results: storage account $E2E_RESULTS_ACCOUNT, container $(aget E2E_RESULTS_CONTAINER), runs/$E2E_RUN_ID/"
e2e_run
