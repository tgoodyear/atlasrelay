#!/usr/bin/env bash
# Copy the two RIPE Atlas API keys the real-transfer tests use into an environment's test vault
# (infra/testharness.bicep), each with the RIPE NCC Access email of its account. docs/RUNBOOK.md,
# "Full-flow tests on dev".
#
#   scripts/set-ripe-keys.sh <env> --from-vault VAULT --donor SECRET --recipient SECRET
#                            [--from-subscription ID] [--ip ADDRESS] [--yes]
#
#   --from-vault VAULT        the Key Vault the keys are in now; you need to be able to read it. It
#                             should refuse every network: the script admits this machine's address
#                             while it reads, and removes it again
#   --donor SECRET            the secret holding the key of the account with credits: the donor
#                             pastes it into the pledge form
#   --recipient SECRET        the secret holding the key of the researcher's account: it receives
#                             the credits, and the tests send them back with it
#   --from-subscription ID    the source vault's subscription (default: the environment's)
#   --ip ADDRESS              this machine's public IPv4 address (default: looked up at api.ipify.org)
#   --yes                     store without asking to confirm which account gets which role
#
# Each source secret names its account in the tag ripe-user (the RIPE NCC Access email). The
# script shows which secret and account each role gets, asks before writing, and stores:
#
#   ripe-donor-key, ripe-donor-account           from --donor
#   ripe-recipient-key, ripe-recipient-account   from --recipient
#
# Both keys need "Transfer credits to another user" and "Get information about your credits".
#
# A key goes from the source vault to the test vault through this shell's memory: az writes the
# value into a variable, never to the terminal, a file or a command line, and put_secret
# (scripts/lib/test-vault.sh) pipes it to Key Vault. As with scripts/set-test-users.sh, the test
# vault admits this machine's address only while the script writes, and closes however it ends.
#
# Needs: az, curl and jq, signed in as the Owner recorded as ATLASRELAY_OPERATOR_PRINCIPAL_ID.
set -euo pipefail
usage() { awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 2; }
[ $# -ge 1 ] || usage
ENV_NAME=$1; shift
case "$ENV_NAME" in -*|"") usage ;; esac
IP="" FROM_VAULT="" FROM_SUB="" DONOR="" RECIPIENT="" YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --from-vault) FROM_VAULT=${2:-}; shift 2 ;;
    --from-subscription) FROM_SUB=${2:-}; shift 2 ;;
    --donor) DONOR=${2:-}; shift 2 ;;
    --recipient) RECIPIENT=${2:-}; shift 2 ;;
    --ip) IP=${2:-}; shift 2 ;;
    --yes) YES=true; shift ;;
    *) usage ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
[ -n "$FROM_VAULT" ] && [ -n "$DONOR" ] && [ -n "$RECIPIENT" ] || usage
for name in "$FROM_VAULT" "$DONOR" "$RECIPIENT"; do
  [[ $name =~ ^[A-Za-z0-9-]+$ ]] || die "not a Key Vault or secret name: $name"
done
[ "$DONOR" != "$RECIPIENT" ] || die "--donor and --recipient must be two different secrets"
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
. scripts/lib/test-vault.sh
az_sub
test_vault_check
FROM_SUB=${FROM_SUB:-$(aget AZURE_SUBSCRIPTION_ID)}
if [ -z "$IP" ]; then
  IP=$(curl -fsS --max-time 10 https://api.ipify.org) || die "can't find this machine's public address; pass --ip"
fi
[[ $IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "not an IPv4 address: $IP"

# ---------- the source vault ----------

# The source vault refuses every network. Admit this machine's address only while reading from it,
# and remove the rule again on the way out, whatever happens.
# Fails when the rule is still there, so `set -e` stops the script with the EXIT trap still set,
# which tries again.
source_close() {
  if az keyvault network-rule remove --name "$FROM_VAULT" --subscription "$FROM_SUB" \
    --ip-address "$IP/32" -o none 2> /dev/null; then
    return 0
  fi
  echo "WARNING: could not remove $IP/32 from $FROM_VAULT's network rules; remove it by hand" >&2
  return 1
}
# The traps go first: the add can be interrupted, or fail after Azure has applied it.
trap source_close EXIT
trap 'exit 130' INT TERM
echo "opening $FROM_VAULT to $IP while reading the keys"
az keyvault network-rule add --name "$FROM_VAULT" --subscription "$FROM_SUB" --ip-address "$IP/32" -o none ||
  die "can't add a network rule to $FROM_VAULT"
# A new rule takes a moment to apply.
for _ in $(seq 1 18); do
  az keyvault secret list --vault-name "$FROM_VAULT" --subscription "$FROM_SUB" --query "[0].name" -o none 2> /dev/null && break
  sleep 10
done

# ---------- which account is which ----------

# account SECRET: the ripe-user tag of a source secret. `secret list` returns names and tags only.
account() {
  local email
  email=$(az keyvault secret list --vault-name "$FROM_VAULT" --subscription "$FROM_SUB" \
    --query "[?name=='$1'].tags.\"ripe-user\" | [0]" -o tsv) || die "can't list the secrets in $FROM_VAULT"
  [ -n "$email" ] || die "$FROM_VAULT has no secret $1 with a ripe-user tag"
  [[ $email =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "the ripe-user tag of $1 is not an email address"
  printf '%s\n' "$email"
}
DONOR_ACCOUNT=$(account "$DONOR")
RECIPIENT_ACCOUNT=$(account "$RECIPIENT")
# Compared in lower case, with tr: macOS ships bash 3.2, which has no ${VAR,,}.
[ "$(tr '[:upper:]' '[:lower:]' <<< "$DONOR_ACCOUNT")" != "$(tr '[:upper:]' '[:lower:]' <<< "$RECIPIENT_ACCOUNT")" ] || die "$DONOR and $RECIPIENT are keys of the same RIPE Atlas account"

echo "donor     (pays through the pledge form): $FROM_VAULT/$DONOR, RIPE account $DONOR_ACCOUNT"
echo "recipient (the researcher's account):     $FROM_VAULT/$RECIPIENT, RIPE account $RECIPIENT_ACCOUNT"
if [ "$YES" != true ]; then
  [ -t 0 ] || die "no terminal to confirm on; pass --yes"
  read -r -p "Store them in $KV with these roles? [y/N] " answer
  [[ $answer =~ ^[Yy]$ ]] || die "nothing stored"
fi

# ---------- the keys ----------

# key SECRET VAR: read a source secret's value into the variable VAR, checking it looks like a key.
key() {
  local value
  value=$(az keyvault secret show --vault-name "$FROM_VAULT" --name "$1" --subscription "$FROM_SUB" \
    --query value -o tsv) || die "can't read $FROM_VAULT/$1"
  [[ $value =~ ^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$ ]] || die "$FROM_VAULT/$1 does not hold a RIPE Atlas key (a UUID)"
  printf -v "$2" '%s' "$value"
}
key "$DONOR" DONOR_KEY
key "$RECIPIENT" RECIPIENT_KEY
[ "$DONOR_KEY" != "$RECIPIENT_KEY" ] || die "$DONOR and $RECIPIENT hold the same key"

# Done with the source vault: close it before opening the test vault, whose trap replaces this one.
source_close
trap - EXIT INT TERM
echo "closed $FROM_VAULT again"

test_vault_open "$IP"

# The names infra/testharness.bicep gives the job.
put_secret ripe-donor-key "$DONOR_KEY"
put_secret ripe-donor-account "$DONOR_ACCOUNT"
put_secret ripe-recipient-key "$RECIPIENT_KEY"
put_secret ripe-recipient-account "$RECIPIENT_ACCOUNT"
unset DONOR_KEY RECIPIENT_KEY
echo "stored the RIPE Atlas keys in $KV"
