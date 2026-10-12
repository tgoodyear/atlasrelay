#!/usr/bin/env bash
# Take a test environment (dev) down between uses: save its secrets in the seed vault, then delete
# it with scripts/teardown.sh. scripts/dev-up.sh stands it up again. docs/RUNBOOK.md, "Dev on demand".
#
#   scripts/dev-down.sh [--env NAME] [--seed-vault VAULT] [--seed-subscription ID] [--ip ADDRESS]
#
#   --env NAME               the environment (default dev; never prod)
#   --seed-vault VAULT       a Key Vault outside the environment that refuses every network
#                            (default: the setting E2E_SEED_VAULT)
#   --seed-subscription ID   the seed vault's subscription (default: the environment's)
#   --ip ADDRESS             this machine's public IPv4 address (default: looked up at api.ipify.org)
#
# scripts/dev-secrets.sh --save copies the test accounts, the RIPE Atlas keys and the sign-in
# client ids and secrets to the seed vault. Only if that succeeds does scripts/teardown.sh run; it
# asks for the environment's name before deleting anything, and removes DEV_ENABLED first, so the
# full-flow test workflow skips until scripts/dev-up.sh sets it again. Settings are kept, renamed,
# and scripts/dev-up.sh reads them back.
set -euo pipefail
usage() { awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 2; }
ENV_NAME=dev ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME=${2:-}; shift 2 ;;
    --seed-vault|--seed-subscription|--ip) [ $# -ge 2 ] || usage; ARGS+=("$1" "$2"); shift 2 ;;
    *) usage ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
[ "$ENV_NAME" != prod ] || die "prod is never torn down between uses"
cd "$(dirname "$0")/.."
scripts/dev-secrets.sh --env "$ENV_NAME" --save ${ARGS[@]+"${ARGS[@]}"}
scripts/teardown.sh "$ENV_NAME"
