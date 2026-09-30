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
# ATLASRELAY_OPERATOR_PRINCIPAL_ID (Key Vault Secrets Officer on the vault).
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
for tool in az curl jq; do command -v "$tool" > /dev/null || die "$tool is not installed"; done
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
[ -s "$ENV_FILE" ] || die "no settings for $ENV_NAME; run scripts/bootstrap.sh $ENV_NAME first"
az_sub
az account show "${AZ_SUB[@]}" -o none 2> /dev/null ||
  die "run: az login (the environment is in subscription $(aget AZURE_SUBSCRIPTION_ID))"
KV=$(aget E2E_KEY_VAULT_NAME)
RG=$(aget AZURE_RESOURCE_GROUP)
[ -n "$KV" ] || die "$ENV_NAME has no test vault (E2E_KEY_VAULT_NAME is empty); the harness is not deployed there"

operator=$(aget ATLASRELAY_OPERATOR_PRINCIPAL_ID)
me=$(az ad signed-in-user show --query id -o tsv 2> /dev/null || true)
if [ -n "$me" ] && [ "$me" != "$operator" ]; then
  die "only ATLASRELAY_OPERATOR_PRINCIPAL_ID ($operator) may write to the vault. To make it you:
  scripts/settings.sh $ENV_NAME ATLASRELAY_OPERATOR_PRINCIPAL_ID $me && scripts/provision.sh $ENV_NAME"
fi

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

if [ -z "$IP" ]; then
  IP=$(curl -fsS --max-time 10 https://api.ipify.org) || die "can't find this machine's public address; pass --ip"
fi
[[ $IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "not an IPv4 address: $IP"

# ---------- open the vault to this address, and close it on the way out ----------

close() {
  local status=$? state
  trap - EXIT INT TERM
  echo "closing $KV"
  az keyvault network-rule remove -n "$KV" -g "$RG" "${AZ_SUB[@]}" --ip-address "$IP/32" -o none 2> /dev/null || true
  az keyvault update -n "$KV" -g "$RG" "${AZ_SUB[@]}" --public-network-access Disabled -o none || true
  state=$(az keyvault show -n "$KV" -g "$RG" "${AZ_SUB[@]}" --query properties.publicNetworkAccess -o tsv 2> /dev/null || true)
  if [ "$state" = Disabled ]; then
    echo "$KV: public network access disabled"
  else
    echo "WARNING: $KV may still admit $IP. Run scripts/provision.sh $ENV_NAME, which closes it." >&2
    status=1
  fi
  exit "$status"
}
trap close EXIT
trap 'exit 130' INT TERM

echo "opening $KV to $IP for this run"
az keyvault network-rule add -n "$KV" -g "$RG" "${AZ_SUB[@]}" --ip-address "$IP/32" -o none
az keyvault update -n "$KV" -g "$RG" "${AZ_SUB[@]}" --public-network-access Enabled \
  --default-action Deny --bypass None -o none

token=$(az account get-access-token --tenant "$(aget AZURE_TENANT_ID)" --resource https://vault.azure.net \
  --query accessToken -o tsv) || die "can't get a Key Vault token"

# put_secret NAME VALUE. The value reaches curl through a pipe from printf (a shell builtin), and
# the token through a header file on a file descriptor. The response echoes the value back, so it
# is kept only long enough to read the status. A new network rule or role assignment can take a
# minute or two to apply, so a 403 is retried.
put_secret() {
  local name=$1 value=$2 attempt resp code
  for attempt in $(seq 1 18); do
    resp=$(printf '%s' "$value" | jq -Rs '{value: ., contentType: "text/plain"}' |
      curl -sS -X PUT --data-binary @- \
        -H @<(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$token") \
        -w '\n%{http_code}' "https://$KV.vault.azure.net/secrets/$name?api-version=7.4") || resp=$'\n000'
    code=${resp##*$'\n'}
    case "$code" in
      2??) echo "  stored $name"; return 0 ;;
      403|000) ;;
      *) die "storing $name: HTTP $code $(jq -r '.error.code // empty' <<< "${resp%$'\n'*}" 2> /dev/null)" ;;
    esac
    echo "  $name: HTTP $code $(jq -r '.error.code // empty' <<< "${resp%$'\n'*}" 2> /dev/null), retrying ($attempt/18)"
    sleep 10
  done
  die "could not store $name"
}

# The names infra/testharness.bicep gives the job.
put_secret e2e-researcher-username "$E2E_RESEARCHER_USERNAME"
put_secret e2e-researcher-password "$E2E_RESEARCHER_PASSWORD"
put_secret e2e-donor-username "$E2E_DONOR_USERNAME"
put_secret e2e-donor-password "$E2E_DONOR_PASSWORD"
[ -z "${E2E_RESEARCHER_TOTP:-}" ] || put_secret e2e-researcher-totp "$E2E_RESEARCHER_TOTP"
[ -z "${E2E_DONOR_TOTP:-}" ] || put_secret e2e-donor-totp "$E2E_DONOR_TOTP"
echo "stored the test accounts in $KV"
