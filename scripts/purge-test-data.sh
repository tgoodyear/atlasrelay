#!/usr/bin/env bash
# Delete what the full-flow test accounts left in a test environment's tables: their projects, the
# pledges and claim rows under them, and their pledges on anyone else's project. For the residue of
# runs from before the tests deleted their own projects (docs/RUNBOOK.md, "Full-flow tests on dev").
#
#   scripts/purge-test-data.sh <env> [--apply] [--account ID]...
#
#   --apply        delete; without it, print what would be deleted and change nothing
#   --account ID   purge this account id (the Static Web Apps user id) instead of the test
#                  accounts the script finds from the projects the tests posted; repeatable
#
# Never prod: the script refuses it, and so does scripts/purge-test-data.mjs, which does the work.
# Needs az, signed in as the Owner scripts/bootstrap.sh recorded as ATLASRELAY_OPERATOR_PRINCIPAL_ID
# (Storage Table Data Contributor on the data account), and node with the repository's packages
# installed (npm ci at the root).
set -euo pipefail
usage() { awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 2; }
[ $# -ge 1 ] || usage
ENV_NAME=$1; shift
case "$ENV_NAME" in -*|"") usage ;; esac
die() { echo "error: $*" >&2; exit 1; }
[ "$ENV_NAME" != prod ] || die "refusing to purge prod: this is for test environments only"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) args+=(--apply); shift ;;
    --account) [ -n "${2:-}" ] || usage; args+=(--account "$2"); shift 2 ;;
    *) usage ;;
  esac
done
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
account=$(aget STORAGE_ACCOUNT)
[ -n "$account" ] || die "no STORAGE_ACCOUNT in $ENV_FILE; run scripts/provision.sh $ENV_NAME first"
[ -d node_modules/@azure/data-tables ] || die "run npm ci at the repository root first"
az account show > /dev/null 2>&1 || die "az is not signed in; run az login"
PURGE_ENV=$ENV_NAME PURGE_STORAGE_ACCOUNT=$account PURGE_TENANT_ID=$(aget AZURE_TENANT_ID) \
  node scripts/purge-test-data.mjs ${args[@]+"${args[@]}"}
