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
  command -v jq > /dev/null || die "jq is not installed"
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
# be deleted by hand; the next ordinary deployment puts them back. ACTION_ON_UNMANAGE=detachAll
# keeps a resource that was dropped from the templates instead of deleting it, for one deployment.
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
    --action-on-unmanage "${ACTION_ON_UNMANAGE:-deleteResources}" \
    --deny-settings-mode "${DENY_SETTINGS_MODE:-denyDelete}" \
    --description "Atlas Relay $ENV_NAME (scripts/bootstrap.sh, scripts/provision.sh)" \
    --yes --only-show-errors -o none
)
# The template's outputs become settings (SWA_NAME, CI_CLIENT_ID, ...). jq reads each output as a
# name and value pair. The stack can return output names with their case changed; main.bicep
# declares them all in upper case, so that is the name saved, and a differently cased copy from an
# earlier run is dropped. A failed read fails the step, so stale settings aren't kept.
save_outputs() {
  local out k v raw
  out=$(az stack sub show -n "$STACK" "${AZ_SUB[@]}" --query outputs -o json) || return 1
  out=$(jq -r 'to_entries[] | [.key, (.key | ascii_upcase), (.value.value // "" | tostring)] | @tsv' <<< "$out") ||
    return 1
  while IFS=$'\t' read -r raw k v; do
    [ -n "$k" ] || continue
    aset "$k" "$v" || return 1
    [ "$raw" = "$k" ] || adel "$raw" || return 1
  done <<< "$out"
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
  elif grep -qiE 'NotFound|"code": *"404"|does not exist|could not be found' <<< "$out"; then
    aset ATLASRELAY_BUDGET_START "$(date -u +%Y-%m-01)"
  else
    echo "error: can't read budget-atlasrelay-$ENV_NAME: $out" >&2
    return 1
  fi
}
# The sign-in providers the environment's own registrations cover, as the site's build takes them
# (VITE_SIGNIN_PROVIDERS, web/src/lib/signin.ts): empty for the built-in GitHub and Microsoft
# sign-in, else a list such as github,aad,google,orcid. Each registration is a client id and a
# secret, set together. Any registration of the site's own turns Static Web Apps' built-in
# providers off, so Google or ORCID needs GitHub and Microsoft registrations too; a set that would
# lose them is refused here, before anything is deployed.
signin_providers() {
  local p name id secret providers=""
  for p in GITHUB:github MICROSOFT:aad GOOGLE:google ORCID:orcid; do
    name=${p#*:}; p=${p%%:*}
    id=$(aget "ATLASRELAY_${p}_CLIENT_ID") || return 1
    secret=$(aget "ATLASRELAY_${p}_CLIENT_SECRET") || return 1
    if [ -n "$id" ] && [ -n "$secret" ]; then
      providers="${providers:+$providers,}$name"
    elif [ -n "$id$secret" ]; then
      echo "error: set both ATLASRELAY_${p}_CLIENT_ID and ATLASRELAY_${p}_CLIENT_SECRET, or neither" >&2
      return 1
    fi
  done
  if [ -n "$providers" ] && [[ ",$providers," != *,github,aad,* ]]; then
    echo "error: sign-in through the site's own registrations ($providers) turns the built-in GitHub and Microsoft sign-in off; set ATLASRELAY_GITHUB_CLIENT_ID/SECRET and ATLASRELAY_MICROSOFT_CLIENT_ID/SECRET too (docs/RUNBOOK.md, \"Google and ORCID sign-in\")" >&2
    return 1
  fi
  echo "$providers"
}
# A new custom role can take a minute or two to replicate before it can be assigned
# (RoleDefinitionDoesNotExist). The deployment is idempotent, so retry.
provision() {
  local attempt
  case "${ACTION_ON_UNMANAGE:-deleteResources}" in
    deleteResources|detachAll) ;;
    *) die "ACTION_ON_UNMANAGE must be deleteResources or detachAll" ;;
  esac
  sync_budget_start || die "could not work out the budget's start date"
  local providers previous p
  providers=$(signin_providers) || die "the sign-in settings are incomplete"
  # Removing a registration's settings breaks sign-in with it, and with GitHub and Microsoft too
  # when it is one of theirs, for as long as the live site's build still names it. The site has to
  # go first (docs/RUNBOOK.md, "Turning them off"); SIGNIN_REMOVAL_OK=1 says it has.
  previous=$(aget SIGNIN_PROVIDERS) || die "could not read SIGNIN_PROVIDERS"
  for p in ${previous//,/ }; do
    if [[ ",$providers," != *",$p,"* ]] && [ "${SIGNIN_REMOVAL_OK:-}" != 1 ]; then
      die "this removes the $p sign-in settings, which the last deployment had. First deploy a site build whose VITE_SIGNIN_PROVIDERS leaves $p out (empty, for github or aad) (docs/RUNBOOK.md, \"Turning them off\"), then run again with SIGNIN_REMOVAL_OK=1"
    fi
  done
  for attempt in 1 2 3; do
    if deploy_stack && save_outputs; then
      # What the site's build needs to offer exactly these providers. It changes nothing on its
      # own: the Deploy workflow reads it from the repository variable SIGNIN_PROVIDERS.
      aset SIGNIN_PROVIDERS "$providers" || die "could not save SIGNIN_PROVIDERS"
      return 0
    fi
    [ "$attempt" = 3 ] && die "provisioning failed three times"
    echo "retrying in 60s"
    sleep 60
  done
}
