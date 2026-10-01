# shellcheck shell=bash
# Shared by scripts/set-test-users.sh and scripts/set-ripe-keys.sh: write secrets into an
# environment's test vault (infra/testharness.bicep), which has no public network access.
#
# Source it after scripts/lib/env.sh, with ENV_NAME set, die() defined and az_sub run. Then:
#
#   test_vault_check            the harness exists and the signed-in user is the operator
#   test_vault_open [ADDRESS]   admit this machine's address (default: looked up at api.ipify.org),
#                               and close the vault again however the script ends
#   put_secret NAME VALUE       store one secret
#
# While open, the vault admits that one address and no other. The trap set by test_vault_open
# disables public access, removes every address rule and checks both, whether the script succeeded,
# failed or was interrupted. Values go to Key Vault's REST API on curl's standard input: never on a
# command line, in a file or in the shell history.

test_vault_check() {
  local tool operator me
  for tool in az curl jq; do command -v "$tool" > /dev/null || die "$tool is not installed"; done
  [ -s "$ENV_FILE" ] || die "no settings for $ENV_NAME; run scripts/bootstrap.sh $ENV_NAME first"
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
}

# Every address rule on the vault. The template declares none, so any rule found is removed.
_test_vault_ip_rules() {
  az keyvault show -n "$KV" -g "$RG" "${AZ_SUB[@]}" --query "properties.networkAcls.ipRules[].value" -o tsv
}
_test_vault_remove_ip_rules() {
  local rule
  for rule in $(_test_vault_ip_rules); do
    az keyvault network-rule remove -n "$KV" -g "$RG" "${AZ_SUB[@]}" --ip-address "$rule" -o none || return 1
  done
}

_test_vault_close() {
  local status=$? state rules
  trap - EXIT INT TERM
  echo "closing $KV"
  az keyvault update -n "$KV" -g "$RG" "${AZ_SUB[@]}" --public-network-access Disabled -o none || true
  _test_vault_remove_ip_rules || true
  state=$(az keyvault show -n "$KV" -g "$RG" "${AZ_SUB[@]}" --query properties.publicNetworkAccess -o tsv 2> /dev/null || true)
  rules=$(_test_vault_ip_rules 2> /dev/null || echo unknown)
  if [ "$state" = Disabled ] && [ -z "$rules" ]; then
    echo "$KV: public network access disabled, no address rules"
  else
    echo "WARNING: $KV is not closed (public network access: ${state:-unknown}; address rules: ${rules:-none})." >&2
    echo "Run scripts/provision.sh $ENV_NAME, which closes it." >&2
    status=1
  fi
  exit "$status"
}

test_vault_open() {
  local ip=${1:-}
  if [ -z "$ip" ]; then
    ip=$(curl -fsS --max-time 10 https://api.ipify.org) || die "can't find this machine's public address; pass --ip"
  fi
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "not an IPv4 address: $ip"
  trap _test_vault_close EXIT
  trap 'exit 130' INT TERM
  # A rule left behind by an earlier run that could not clean up would admit that address too.
  _test_vault_remove_ip_rules || die "can't remove the address rules already on $KV"
  echo "opening $KV to $ip for this run"
  az keyvault network-rule add -n "$KV" -g "$RG" "${AZ_SUB[@]}" --ip-address "$ip/32" -o none
  az keyvault update -n "$KV" -g "$RG" "${AZ_SUB[@]}" --public-network-access Enabled \
    --default-action Deny --bypass None -o none
  [ "$(_test_vault_ip_rules)" = "$ip/32" ] || [ "$(_test_vault_ip_rules)" = "$ip" ] || die "$KV admits other addresses than $ip"
  TEST_VAULT_TOKEN=$(az account get-access-token --tenant "$(aget AZURE_TENANT_ID)" --resource https://vault.azure.net \
    --query accessToken -o tsv) || die "can't get a Key Vault token"
}

# put_secret NAME VALUE. The value reaches curl through a pipe from printf (a shell builtin), and
# the token through a header file on a file descriptor. The response echoes the value back, so it
# is kept only long enough to read the status. A new network rule or role assignment can take a
# minute or two to apply, so a 403 is retried.
put_secret() {
  local name=$1 value=$2 attempt resp code
  [ -n "$value" ] || die "refusing to store an empty $name"
  for attempt in $(seq 1 18); do
    resp=$(printf '%s' "$value" | jq -Rs '{value: ., contentType: "text/plain"}' |
      curl -sS -X PUT --data-binary @- \
        -H @<(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$TEST_VAULT_TOKEN") \
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
