# shellcheck shell=bash
# Shared by the environment scripts. Source it with ENV_NAME set, the repository root as the
# working directory and a die() function defined.
#
# An environment's settings live in .azure/$ENV_NAME/.env as KEY="value" lines, git-ignored.
# .azure/env.example lists them. Every az call goes to the environment's own subscription
# (AZ_SUB, from AZURE_SUBSCRIPTION_ID), so az's selected subscription never matters.
#
# The name becomes part of resource names (the storage account allows only lowercase letters and
# digits, 24 at most: statlasrelay + name + a 6-character suffix), the stack's name and the
# settings path.
valid_env_name() {
  [[ $1 =~ ^[a-z][a-z0-9]{0,5}$ ]] || {
    echo "error: the environment name must be 1-6 lowercase letters and digits, starting with a letter" >&2
    exit 2
  }
}
valid_env_name "$ENV_NAME"
# The stack commands need az 2.61+ (--action-on-unmanage). grep reads the help to the end: with -q
# it could quit early, and pipefail would count az's SIGPIPE as a failure.
need_stack_az() {
  az stack sub create --help 2> /dev/null | grep -- --action-on-unmanage > /dev/null ||
    die "az $(az version --query '"azure-cli"' -o tsv 2> /dev/null) is too old for deployment stacks; upgrade to 2.61 or later"
}
ENV_FILE=".azure/$ENV_NAME/.env"
# A settings file that doesn't parse stops every script up front, before anything reads a setting
# as empty and falls back to a default.
# shellcheck source=/dev/null
if [ -f "$ENV_FILE" ] && ! (set +u; . "$ENV_FILE") > /dev/null; then
  echo "error: $ENV_FILE doesn't parse; fix it before running anything" >&2
  exit 1
fi
valid_key() {
  [[ $1 =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "error: invalid setting name: $1" >&2; exit 2; }
}
# Read one setting (empty when unset). Only the file counts: the caller's variable of the same
# name is cleared.
# shellcheck source=/dev/null
aget() {
  valid_key "$1"
  (set +u; unset "$1"; set -a
   if [ -f "$ENV_FILE" ]; then
     . "$ENV_FILE" || { echo "error: can't read $ENV_FILE" >&2; exit 1; }
   fi
   printf '%s\n' "${!1:-}")
}
# Write one setting, quoted so the file can be sourced.
aset() {
  valid_key "$1"
  [[ $2 != *$'\n'* ]] || { echo "error: $1: values can't contain newlines" >&2; return 1; }
  local v=$2 tmp
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  v=${v//\\/\\\\}; v=${v//\"/\\\"}; v=${v//\$/\\\$}; v=${v//\`/\\\`}
  tmp=$(mktemp)
  # grep's 1 means "no other lines"; anything above is a read error, and writing the file back
  # would lose every other setting.
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || [ $? -eq 1 ] ||
    { rm -f "$tmp"; echo "error: can't read $ENV_FILE" >&2; return 1; }
  printf '%s="%s"\n' "$1" "$v" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}
# Remove one setting.
adel() {
  valid_key "$1"
  [ -f "$ENV_FILE" ] || return 0
  local tmp
  tmp=$(mktemp)
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || [ $? -eq 1 ] ||
    { rm -f "$tmp"; echo "error: can't read $ENV_FILE" >&2; return 1; }
  mv "$tmp" "$ENV_FILE"
}

# One deployment stack per environment, at subscription scope (it holds the resource group).
STACK="atlasrelay-$ENV_NAME"
# The subscription every az call in these scripts targets. Set after the settings are read.
az_sub() { AZ_SUB=(--subscription "$(aget AZURE_SUBSCRIPTION_ID)"); }
stack_location() { local l; l=$(aget AZURE_LOCATION) || return 1; echo "${l:-westus2}"; }
# DENY_SETTINGS_MODE=none lifts the deny assignments for one deployment, so a managed resource can
# be deleted by hand; the next ordinary deployment puts them back.
deploy_stack() (
  # Export exactly the settings infra/main.bicepparam reads, when they have a value; an unset one
  # takes its default there. Each is read on its own (aget), so the settings file never sets this
  # script's own variables, and a variable left in the caller's shell can't stand in for a
  # setting the file doesn't have.
  local k v
  for k in $(grep -o "readEnvironmentVariable('[A-Za-z0-9_]*'" infra/main.bicepparam | cut -d"'" -f2); do
    unset "$k"
    v=$(aget "$k") || exit 1
    [ -z "$v" ] || export "$k=$v"
  done
  export AZURE_ENV_NAME=$ENV_NAME
  local location
  location=$(stack_location) || exit 1
  az stack sub create --name "$STACK" --location "$location" "${AZ_SUB[@]}" \
    --parameters infra/main.bicepparam \
    --action-on-unmanage deleteResources \
    --deny-settings-mode "${DENY_SETTINGS_MODE:-denyDelete}" \
    --description "Atlas Relay $ENV_NAME (scripts/bootstrap.sh, scripts/provision.sh)" \
    --yes --only-show-errors -o none
)
# The template's outputs become settings (SWA_NAME, CI_CLIENT_ID, ...). One query reads the names
# and the values from the same object, so they pair up in order. The stack can return output
# names with their case changed; main.bicep declares them all in upper case, so that is the name
# saved, and a differently cased copy from an earlier run is dropped.
save_outputs() {
  local out k v raw
  out=$(az stack sub show -n "$STACK" "${AZ_SUB[@]}" \
    --query "[keys(outputs), values(outputs)[].value]" -o tsv) || return 1
  while IFS=$'\t' read -r raw k v; do
    [ -n "$k" ] || continue
    aset "$k" "$v" || return 1
    [ "$raw" = "$k" ] || adel "$raw" || return 1
  done < <(awk -F'\t' 'NR == 1 { n = split($0, k, "\t") }
      NR == 2 { split($0, v, "\t"); for (i = 1; i <= n; i++) print k[i] "\t" toupper(k[i]) "\t" v[i] }' <<< "$out")
}
# The budget exists only with an alert address. Azure accepts only the current month as the start
# of a new budget and never lets it change afterwards, so ATLASRELAY_BUDGET_START follows the
# budget: its own start date while it exists, the current month when it is about to be created
# (again). Any error other than "not found" stops here, so a deployment never re-bases a period.
sync_budget_start() {
  [ -n "$(aget ATLASRELAY_ALERT_EMAIL)" ] || return 0
  local url out
  url="https://management.azure.com/subscriptions/$(aget AZURE_SUBSCRIPTION_ID)/resourceGroups/rg-atlasrelay-$ENV_NAME/providers/Microsoft.Consumption/budgets/budget-atlasrelay-$ENV_NAME?api-version=2023-11-01"
  if out=$(az rest --method get --url "$url" --query properties.timePeriod.startDate -o tsv 2>&1); then
    [ -n "$out" ] || { echo "error: budget-atlasrelay-$ENV_NAME has no start date" >&2; return 1; }
    aset ATLASRELAY_BUDGET_START "${out:0:10}"
  elif grep -qiE 'NotFound|could not be found' <<< "$out"; then
    aset ATLASRELAY_BUDGET_START "$(date -u +%Y-%m-01)"
  else
    echo "error: can't read budget-atlasrelay-$ENV_NAME: $out" >&2
    return 1
  fi
}
# A new custom role can take a minute or two to replicate before it can be assigned
# (RoleDefinitionDoesNotExist). The deployment is idempotent, so retry.
provision() {
  local attempt
  sync_budget_start || die "could not work out the budget's start date"
  for attempt in 1 2 3; do
    deploy_stack && save_outputs && return 0
    [ "$attempt" = 3 ] && die "provisioning failed three times"
    echo "retrying in 60s"
    sleep 60
  done
}
