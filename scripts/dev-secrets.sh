#!/usr/bin/env bash
# Keep a test environment's secrets in a seed vault that outlives it, so the environment can be torn
# down between uses and stood up again with the same test accounts, RIPE Atlas keys and sign-in
# registrations. docs/RUNBOOK.md, "Dev on demand".
#
#   scripts/dev-secrets.sh --env dev --save [--seed-vault VAULT] [--seed-subscription ID] [--ip ADDRESS]
#   scripts/dev-secrets.sh --env dev --restore [--seed-vault VAULT] [--seed-subscription ID] [--ip ADDRESS]
#
#   --env NAME               the environment (never prod)
#   --save                   copy the secrets from the environment's vaults to the seed vault
#   --restore                copy them back into a newly deployed environment
#   --seed-vault VAULT       the seed vault (default: the setting E2E_SEED_VAULT, which this saves)
#   --seed-subscription ID   its subscription (default: the environment's)
#   --ip ADDRESS             this machine's public IPv4 address (default: looked up at api.ipify.org)
#
# What is copied, each as <env>-backup-<name> in the seed vault:
#   - from the test vault (E2E_KEY_VAULT_NAME): the two test accounts with their passwords and TOTP
#     seeds, and the two RIPE Atlas keys with their accounts (scripts/set-test-users.sh,
#     scripts/set-ripe-keys.sh). A restore writes every one the seed vault has.
#   - from the sign-in vault (SIGNIN_KEY_VAULT_NAME): each provider's client id and client secret
#     (scripts/register-signin.sh). A restore writes only those the sign-in vault lacks, so a vault
#     recovered with its secrets, or one with a newer secret, is left as it is.
#
# The seed vault must refuse every network (default action Deny, bypass None, public network access
# Enabled, no address or network rules, no private endpoints), as scripts/set-ripe-keys.sh asks of
# its source vault; this admits this machine's address while it copies and removes it again however
# the script ends. The test vault is opened and closed the same way (scripts/lib/test-vault.sh).
# Values pass through this shell's memory only: never printed, never on a command line or in a file.
#
# Needs: az, curl and jq, signed in as ATLASRELAY_OPERATOR_PRINCIPAL_ID, with read and write access
# to the seed vault's secrets (Key Vault Secrets Officer or Administrator) and permission to change
# its network rules.
set -euo pipefail
usage() { awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 2; }
ENV_NAME="" MODE="" SEED="" SEED_SUB="" IP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME=${2:-}; shift 2 ;;
    --save) MODE=save; shift ;;
    --restore) MODE=restore; shift ;;
    --seed-vault) SEED=${2:-}; shift 2 ;;
    --seed-subscription) SEED_SUB=${2:-}; shift 2 ;;
    --ip) IP=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$ENV_NAME" ] && [ -n "$MODE" ] || usage
die() { echo "error: $*" >&2; exit 1; }
[ "$ENV_NAME" != prod ] || die "prod has no test vault, and its sign-in secrets are not copied anywhere"
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
. scripts/lib/test-vault.sh
az_sub
test_vault_check
SEED=${SEED:-$(aget E2E_SEED_VAULT)}
[ -n "$SEED" ] || die "no seed vault: pass --seed-vault (it is then kept as the setting E2E_SEED_VAULT)"
[[ $SEED =~ ^[A-Za-z0-9-]+$ ]] || die "not a Key Vault name: $SEED"
SIGNIN=$(aget SIGNIN_KEY_VAULT_NAME)
[ "$SEED" != "$KV" ] && [ "$SEED" != "$SIGNIN" ] || die "the seed vault must be outside the environment"
SEED_SUB=${SEED_SUB:-$(aget AZURE_SUBSCRIPTION_ID)}
seed_rg=$(az keyvault show --name "$SEED" --subscription "$SEED_SUB" --query resourceGroup -o tsv) ||
  die "can't find the seed vault $SEED in subscription $SEED_SUB"
# A seed vault inside the environment's own group would go with it.
[ "$(tr 'A-Z' 'a-z' <<< "$seed_rg")" != "$(tr 'A-Z' 'a-z' <<< "$RG")" ] ||
  die "the seed vault $SEED is in $RG, which a teardown deletes; use a vault outside it"
aset E2E_SEED_VAULT "$SEED"
if [ -z "$IP" ]; then
  IP=$(curl -fsS --max-time 10 https://api.ipify.org) || die "can't find this machine's public address; pass --ip"
fi
[[ $IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "not an IPv4 address: $IP"

# The names infra/testharness.bicep gives the job, and the sign-in vault's (scripts/register-signin.sh).
TEST_NAMES="e2e-researcher-username e2e-researcher-password e2e-donor-username e2e-donor-password
e2e-researcher-totp e2e-donor-totp ripe-donor-key ripe-donor-account ripe-recipient-key ripe-recipient-account"
SIGNIN_NAMES="signin-github-client-id signin-github-client-secret signin-microsoft-client-id
signin-google-client-id signin-google-client-secret signin-orcid-client-id signin-orcid-client-secret"
PREFIX="$ENV_NAME-backup-"

test_vault_open "$IP"
# test_vault_open's trap closes the test vault. This one closes the seed vault first, and is set
# before the seed vault opens: the add can be interrupted, or fail after Azure has applied it.
on_exit() {
  local status=$?
  seed_vault_close || status=1
  (exit "$status")
  _test_vault_close
}
trap on_exit EXIT
trap 'exit 130' INT TERM
seed_vault_open "$SEED" "$SEED_SUB" "$IP"

# names VAULT SUBSCRIPTION: the secret names a vault holds (never their values).
names() {
  az keyvault secret list --vault-name "$1" --subscription "$2" --query '[].name' -o tsv ||
    die "can't list the secrets in $1"
}
# value VAULT SUBSCRIPTION NAME VAR: read one secret into the variable VAR.
# Its own variable is not named like any caller's, or printf -v would set the local one.
value() {
  local _value
  _value=$(az keyvault secret show --vault-name "$1" --subscription "$2" --name "$3" --query value -o tsv) ||
    die "can't read $1/$3"
  printf -v "$4" '%s' "$_value"
}
# signin_put NAME VALUE: write one secret to the sign-in vault, which admits every network and
# grants the operator Key Vault Secrets Officer (infra/signin.bicep).
signin_put() {
  printf '%s' "$2" | az keyvault secret set --vault-name "$SIGNIN" --name "$1" --file /dev/stdin \
    --encoding utf-8 --tags "restored-from=$SEED" "${AZ_SUB[@]}" -o none --only-show-errors ||
    die "can't write $1 to $SIGNIN"
  echo "  restored $1 in $SIGNIN"
}

ENV_SUB=$(aget AZURE_SUBSCRIPTION_ID)
secret=""
seed_names=$(names "$SEED" "$SEED_SUB")
test_names=$(names "$KV" "$ENV_SUB")
signin_names=""
[ -z "$SIGNIN" ] || signin_names=$(names "$SIGNIN" "$ENV_SUB")
copied=0
if [ "$MODE" = save ]; then
  for n in $TEST_NAMES; do
    grep -Fxq "$n" <<< "$test_names" || { echo "  $KV has no $n"; continue; }
    value "$KV" "$ENV_SUB" "$n" secret
    put_secret_in "$SEED" "$PREFIX$n" "$secret"
    copied=$((copied + 1))
  done
  for n in $SIGNIN_NAMES; do
    grep -Fxq "$n" <<< "$signin_names" || continue
    value "$SIGNIN" "$ENV_SUB" "$n" secret
    put_secret_in "$SEED" "$PREFIX$n" "$secret"
    copied=$((copied + 1))
  done
  unset secret
  echo "saved $copied secrets of $ENV_NAME in $SEED"
else
  for n in $TEST_NAMES; do
    grep -Fxq "$PREFIX$n" <<< "$seed_names" || continue
    value "$SEED" "$SEED_SUB" "$PREFIX$n" secret
    put_secret "$n" "$secret"
    copied=$((copied + 1))
  done
  if [ -n "$SIGNIN" ]; then
    for n in $SIGNIN_NAMES; do
      grep -Fxq "$PREFIX$n" <<< "$seed_names" || continue
      grep -Fxq "$n" <<< "$signin_names" && continue
      value "$SEED" "$SEED_SUB" "$PREFIX$n" secret
      signin_put "$n" "$secret"
      copied=$((copied + 1))
    done
  fi
  unset secret
  echo "restored $copied secrets of $ENV_NAME from $SEED"
  for n in e2e-researcher-password e2e-donor-password ripe-donor-key ripe-recipient-key; do
    grep -Fxq "$PREFIX$n" <<< "$seed_names" ||
      echo "note: $SEED has no $PREFIX$n; store it with scripts/set-test-users.sh or scripts/set-ripe-keys.sh"
  done
fi
