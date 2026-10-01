#!/usr/bin/env bash
# Store the two full-flow test accounts in an environment's Key Vault (infra/testharness.bicep),
# where the test job reads them. docs/RUNBOOK.md, "Full-flow tests on dev".
#
#   scripts/set-test-users.sh <env> [--ip ADDRESS]
#
#   --ip ADDRESS   this machine's public IPv4 address (default: looked up at api.ipify.org)
#
# Reads E2E_RESEARCHER_USERNAME, E2E_RESEARCHER_PASSWORD, E2E_DONOR_USERNAME and E2E_DONOR_PASSWORD
# from the environment and asks for any that are unset, passwords without echo. E2E_RESEARCHER_TOTP
# and E2E_DONOR_TOTP, when set, store a TOTP seed for that account too.
#
# The vault has no public network access. While this writes, it admits this machine's address and
# no other, and it closes again when the script ends, whether it succeeded, failed or was
# interrupted. The values go to Key Vault's REST API on curl's standard input: never on a command
# line, in a file or in the shell history.
#
# Needs: az, curl and jq, signed in as the Owner scripts/bootstrap.sh recorded as
# ATLASRELAY_OPERATOR_PRINCIPAL_ID (Key Vault Secrets Officer on the vault). scripts/lib/test-vault.sh
# opens, writes and closes the vault. The RIPE Atlas keys for the real-transfer tests go in with
# scripts/set-ripe-keys.sh.
set -euo pipefail
usage() { awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 2; }
[ $# -ge 1 ] || usage
ENV_NAME=$1; shift
case "$ENV_NAME" in -*|"") usage ;; esac
IP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) IP=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
. scripts/lib/test-vault.sh
az_sub
test_vault_check

# ---------- the accounts ----------

# ask VAR PROMPT SECRET: keep the variable's value, or ask for it (without echo when SECRET=true).
ask() {
  local var=$1 prompt=$2 secret=$3 value
  value=${!var:-}
  if [ -z "$value" ]; then
    [ -t 0 ] || die "$var is unset, and there is no terminal to ask on"
    if [ "$secret" = true ]; then
      read -r -s -p "$prompt: " value
      echo >&2
    else
      read -r -p "$prompt: " value
    fi
  fi
  [ -n "$value" ] || die "$var is empty"
  printf -v "$var" '%s' "$value"
}
ask E2E_RESEARCHER_USERNAME "Researcher account (user@tenant.onmicrosoft.com)" false
ask E2E_RESEARCHER_PASSWORD "Researcher password" true
ask E2E_DONOR_USERNAME "Donor account (user@tenant.onmicrosoft.com)" false
ask E2E_DONOR_PASSWORD "Donor password" true
[ "$E2E_RESEARCHER_USERNAME" != "$E2E_DONOR_USERNAME" ] || die "the researcher and the donor must be two accounts"

test_vault_open "$IP"

# The names infra/testharness.bicep gives the job.
put_secret e2e-researcher-username "$E2E_RESEARCHER_USERNAME"
put_secret e2e-researcher-password "$E2E_RESEARCHER_PASSWORD"
put_secret e2e-donor-username "$E2E_DONOR_USERNAME"
put_secret e2e-donor-password "$E2E_DONOR_PASSWORD"
[ -z "${E2E_RESEARCHER_TOTP:-}" ] || put_secret e2e-researcher-totp "$E2E_RESEARCHER_TOTP"
[ -z "${E2E_DONOR_TOTP:-}" ] || put_secret e2e-donor-totp "$E2E_DONOR_TOTP"
echo "stored the test accounts in $KV"
