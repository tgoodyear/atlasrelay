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
# The sign-in providers' setting names and vault secret names (infra/signin.bicep).
SIGNIN_PROVIDER_KEYS="GITHUB:github MICROSOFT:aad GOOGLE:google ORCID:orcid"
signin_secret_name() {
  case $1 in
    github) echo signin-github-client-secret ;;
    aad) echo signin-microsoft-client-secret ;;
    google) echo signin-google-client-secret ;;
    orcid) echo signin-orcid-client-secret ;;
    *) return 1 ;;
  esac
}
# The sign-in providers the environment's own registrations cover, as the site's build takes them
# (VITE_SIGNIN_PROVIDERS, web/src/lib/signin.ts): empty for the built-in GitHub and Microsoft
# sign-in, else a list such as github,aad,google,orcid. A registration is a client id in the
# settings (ATLASRELAY_<PROVIDER>_CLIENT_ID) and its secret in the environment's sign-in vault,
# which scripts/register-signin.sh writes. Any registration of the site's own turns Static Web
# Apps' built-in providers off, so Google or ORCID needs GitHub and Microsoft registrations too; a
# set that would lose them is refused here, before anything is deployed. When the vault exists,
# each client id needs its secret there (names are listed, never values).
signin_providers() {
  local p name id providers="" vault secrets=""
  vault=$(aget SIGNIN_KEY_VAULT_NAME) || return 1
  for p in $SIGNIN_PROVIDER_KEYS; do
    name=${p#*:}; p=${p%%:*}
    id=$(aget "ATLASRELAY_${p}_CLIENT_ID") || return 1
    [ -n "$id" ] && providers="${providers:+$providers,}$name"
  done
  if [ -n "$providers" ] && [[ ",$providers," != *,github,aad,* ]]; then
    echo "error: sign-in through the site's own registrations ($providers) turns the built-in GitHub and Microsoft sign-in off; register GitHub and Microsoft too (scripts/register-signin.sh, docs/RUNBOOK.md \"Sign-in registrations\")" >&2
    return 1
  fi
  if [ -n "$providers" ]; then
    [ -n "$vault" ] || { echo "error: no sign-in vault yet; run scripts/register-signin.sh $ENV_NAME" >&2; return 1; }
    secrets=$(az keyvault secret list --vault-name "$vault" "${AZ_SUB[@]}" --query '[].name' -o tsv) ||
      { echo "error: can't list the secrets in $vault" >&2; return 1; }
    for name in ${providers//,/ }; do
      # Microsoft has no secret: the site signs in with its managed identity.
      [ "$name" = aad ] && continue
      grep -qx "$(signin_secret_name "$name")" <<< "$secrets" ||
        { echo "error: $name has a client id but no secret in $vault; run scripts/register-signin.sh $ENV_NAME $name" >&2; return 1; }
    done
  fi
  echo "$providers"
}
# Client ids are kept in the sign-in vault as well as the settings file (signin-<provider>-client-id,
# written by scripts/register-signin.sh), so a fresh copy of the settings, in another worktree or on
# another machine, does not deploy the site without its registrations. A client id missing from
# the file is taken from the vault; one that differs is reported and the file's value is kept. One
# set to empty in the file stays empty: that is how a provider is turned off (docs/RUNBOOK.md,
# "Turning them off"). A vault that can't be read stops the deployment rather than deploying the
# site without registrations it has.
sync_client_ids() {
  local vault p key tag file stored err
  vault=$(aget SIGNIN_KEY_VAULT_NAME) || return 1
  [ -n "$vault" ] || return 0
  for p in $SIGNIN_PROVIDER_KEYS; do
    key="ATLASRELAY_${p%%:*}_CLIENT_ID"
    tag=$(tr 'A-Z' 'a-z' <<< "${p%%:*}")
    file=$(aget "$key") || return 1
    if [ -z "$file" ] && [ -f "$ENV_FILE" ] && grep -q "^$key=" "$ENV_FILE"; then
      continue
    fi
    err=$(mktemp)
    if ! stored=$(az keyvault secret show --vault-name "$vault" --name "signin-$tag-client-id" "${AZ_SUB[@]}" \
      --query value -o tsv 2> "$err"); then
      if grep -q 'SecretNotFound' "$err"; then rm -f "$err"; continue; fi
      echo "error: can't read signin-$tag-client-id from $vault: $(cat "$err")" >&2
      rm -f "$err"
      return 1
    fi
    rm -f "$err"
    [ -n "$stored" ] || continue
    if [ -z "$file" ]; then
      aset "$key" "$stored" || return 1
      echo "took $key from $vault"
    elif [ "$file" != "$stored" ]; then
      echo "warning: $key is $file here but $stored in $vault; keeping $file. Run scripts/register-signin.sh $ENV_NAME to settle it." >&2
    fi
  done
}
# A sign-in vault deleted with its environment stays recoverable, with its secrets, for its
# retention period, and its name cannot be reused until then (purge protection, signin.bicep).
# Recover it before a deployment that would create it again.
recover_signin_vault() {
  local vault
  # By its name's prefix: the settings file of a torn-down environment is renamed, so it may not
  # have the name any more. Only one sign-in vault per environment can exist, deleted or not.
  vault=$(az keyvault list-deleted "${AZ_SUB[@]}" --resource-type vault \
    --query "[?starts_with(name, 'kvs-atlasrelay-$ENV_NAME-')].name | [0]" -o tsv) || return 1
  [ -n "$vault" ] || return 0
  echo "recovering the deleted sign-in vault $vault"
  # A vault comes back into the group it was deleted from, which a teardown removed too. The
  # deployment that follows takes the group over and tags it.
  if [ "$(az group exists -n "rg-atlasrelay-$ENV_NAME" "${AZ_SUB[@]}")" != true ]; then
    az group create -n "rg-atlasrelay-$ENV_NAME" -l "$(stack_location)" "${AZ_SUB[@]}" -o none || return 1
  fi
  az keyvault recover --name "$vault" "${AZ_SUB[@]}" -o none || return 1
  # The settings of a torn-down environment are renamed away, so record the vault's name again:
  # sync_client_ids reads the client ids from it next.
  [ -n "$(aget SIGNIN_KEY_VAULT_NAME)" ] || aset SIGNIN_KEY_VAULT_NAME "$vault"
}
# The sign-in providers the deployed site has app settings for, from Azure (names only; the values
# are dropped here). Empty when the site does not exist yet.
live_signin_providers() {
  local site names
  site="/subscriptions/$(aget AZURE_SUBSCRIPTION_ID)/resourceGroups/rg-atlasrelay-$ENV_NAME/providers/Microsoft.Web/staticSites/swa-atlasrelay-$ENV_NAME" || return 1
  # Only "not found" means there is nothing to protect; any other error stops the deployment.
  if ! names=$(az rest --method post --url "$site/listAppSettings?api-version=2024-04-01" --query 'keys(properties)' -o tsv 2>&1); then
    grep -qiE 'ResourceNotFound|ResourceGroupNotFound|"code": *"NotFound"|could not be found' <<< "$names" && return 0
    echo "error: can't list the app settings of swa-atlasrelay-$ENV_NAME: $names" >&2
    return 1
  fi
  grep -q '^SIGNIN_GITHUB_CLIENT_ID$' <<< "$names" && echo -n github,
  grep -q '^SIGNIN_MICROSOFT_CLIENT_ID$' <<< "$names" && echo -n aad,
  grep -q '^SIGNIN_GOOGLE_CLIENT_ID$' <<< "$names" && echo -n google,
  grep -q '^SIGNIN_ORCID_CLIENT_ID$' <<< "$names" && echo -n orcid,
  echo
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
  recover_signin_vault || die "could not recover the deleted sign-in vault"
  sync_client_ids || die "could not read the client ids from the sign-in vault"
  local providers previous p
  providers=$(signin_providers) || die "the sign-in settings are incomplete"
  # Removing a registration's settings breaks sign-in with it, and with GitHub and Microsoft too
  # when it is one of theirs, for as long as the live site's build still names it. The site has to
  # go first (docs/RUNBOOK.md, "Turning them off"); SIGNIN_REMOVAL_OK=1 says it has. What counts
  # is what the site has now, read from Azure, not this settings file, which may be an old copy.
  previous=$(live_signin_providers) || die "could not read the site's sign-in settings from Azure"
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
