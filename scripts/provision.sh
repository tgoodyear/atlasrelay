#!/usr/bin/env bash
# Deploy an existing environment's stack from its current settings, without the rest of
# bootstrap (no GitHub steps). Use it after changing a setting or a template:
#
#   scripts/settings.sh prod ATLASRELAY_DNS_TTL 300
#   scripts/provision.sh prod
#
# Needs az 2.61+, signed in with Owner on the environment's subscription.
# ACTION_ON_UNMANAGE=detachAll leaves a resource dropped from the templates in place instead of
# deleting it, for that one deployment (docs/RUNBOOK.md, moving off managed functions).
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/provision.sh <env>" >&2; exit 2; }
ENV_NAME=$1
die() { echo "error: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
need_stack_az
[ -s "$ENV_FILE" ] || die "no settings for $ENV_NAME; run scripts/bootstrap.sh $ENV_NAME first"
az_sub
az account show "${AZ_SUB[@]}" -o none 2> /dev/null ||
  die "run: az login (the environment is in subscription $(aget AZURE_SUBSCRIPTION_ID))"
provision
echo "deployed stack $STACK"
