#!/usr/bin/env bash
# Delete one Atlas Relay environment: its deployment stack with every resource it manages, its
# resource group and custom roles, and its GitHub Environment. The data goes with it, and the
# full-flow test vault is purged so the environment can be bootstrapped again at once. For prod
# that includes the DNS zone: a new zone gets new name servers, and the registrar has to be
# updated before the domain resolves again. Local settings (.azure/<env>/.env) are kept, renamed.
#
#   scripts/teardown.sh <env>
#
# Needs: az 2.61+ and gh, signed in, Owner on the subscription and admin on the repository.
# Asks for the environment's name before deleting anything.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: scripts/teardown.sh <env>" >&2; exit 2; }
ENV_NAME=$1
die() { echo "error: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
need_stack_az
SUBSCRIPTION=$(aget AZURE_SUBSCRIPTION_ID)
[ -n "$SUBSCRIPTION" ] || die "no AZURE_SUBSCRIPTION_ID in $ENV_FILE; can't tell which subscription holds $ENV_NAME"
AZ_SUB=(--subscription "$SUBSCRIPTION")
az account show "${AZ_SUB[@]}" -o none 2> /dev/null || die "run: az login (subscription $SUBSCRIPTION)"
REPO=$(aget ATLASRELAY_GITHUB_REPO)
[ -n "$REPO" ] || REPO=tgoodyear/atlasrelay
gh auth status > /dev/null 2>&1 || die "run: gh auth login"

# What the stack manages, saved before it's detached so an interrupted teardown can be run again
# and pick up where it stopped.
resume="$(dirname "$ENV_FILE")/teardown-$SUBSCRIPTION.ids"
stack=true
if out=$(az stack sub show -n "$STACK" "${AZ_SUB[@]}" -o none 2>&1); then
  ids=$(az stack sub show -n "$STACK" "${AZ_SUB[@]}" --query "resources[].id" -o tsv)
elif ! grep -qiE 'NotFound|could not be found' <<< "$out"; then
  die "can't check the deployment stack $STACK: $out"
elif [ -s "$resume" ]; then
  echo "resuming an interrupted teardown of $ENV_NAME (stack already detached)"
  ids=$(cat "$resume") stack=false
else
  die "no deployment stack $STACK in subscription $SUBSCRIPTION"
fi
groups=$(grep -Ei '^/subscriptions/[^/]+/resourceGroups/[^/]+$' <<< "$ids" | sed 's|.*/||' || true)
# The custom role is declared in the group but stored with the subscription, so it outlives it.
roles=$(grep -i '/providers/Microsoft.Authorization/roleDefinitions/' <<< "$ids" || true)
# A deleted vault stays soft-deleted for a week under its name, which the next bootstrap reuses.
vaults=$(grep -io '/providers/Microsoft.KeyVault/vaults/[^/]*$' <<< "$ids" | sed 's|.*/||' || true)
# Anything managed outside the environment's own group, such as a non-prod environment's CNAME in
# the prod zone, has to be deleted on its own.
others=""
for id in $ids; do
  case "$(tr 'A-Z' 'a-z' <<< "$id")" in
    */providers/microsoft.authorization/roledefinitions/*) continue ;;
  esac
  inside=false
  for g in $groups; do
    case "$(tr 'A-Z' 'a-z' <<< "$id")" in
      "$(tr 'A-Z' 'a-z' <<< "/subscriptions/$SUBSCRIPTION/resourceGroups/$g")"*) inside=true ;;
    esac
  done
  [ "$inside" = true ] || others="$others$id"$'\n'
done
others=$(grep -v '^$' <<< "$others" || true)

echo "This deletes environment $ENV_NAME from subscription $SUBSCRIPTION:"
sed 's/^/  resource group (everything in it) /' <<< "$groups"
[ -z "$roles" ] || sed 's/^/  /' <<< "$roles"
[ -z "$others" ] || sed 's/^/  /' <<< "$others"
echo "and the GitHub Environment $ENV_NAME in $REPO."
[ -z "$vaults" ] || echo "The Key Vault $(tr '\n' ' ' <<< "$vaults")is purged after it is deleted, with the test accounts in it."
[ "$ENV_NAME" != dev ] || echo "The repository variable DEV_ENABLED is removed, so the full-flow test workflow skips."
if [ "$ENV_NAME" = prod ]; then
  zone=$(aget ATLASRELAY_DNS_ZONE)
  [ -z "$zone" ] || echo "The DNS zone $zone goes with the resource group; the domain stops resolving."
  echo "The repository secrets AZURE_CLIENT_ID, AZURE_TENANT_ID and AZURE_SUBSCRIPTION_ID are removed,"
  echo "so the Deploy workflow builds without deploying until prod is bootstrapped again."
fi
read -r -p "Type the environment name to confirm: " answer
[ "$answer" = "$ENV_NAME" ] || die "not confirmed"

if [ "$ENV_NAME" = dev ]; then
  # First, so the full-flow test workflow stops trying to reach an environment that is going away.
  if ! out=$(gh variable delete DEV_ENABLED --repo "$REPO" 2>&1); then
    grep -qiE 'not found|HTTP 404' <<< "$out" || die "can't remove the variable DEV_ENABLED from $REPO: $out"
  fi
fi
if [ "$ENV_NAME" = prod ]; then
  gh variable set AZURE_BOOTSTRAPPED --repo "$REPO" --body false
  # Only the ones that exist; any failure deleting one stops here, since the Deploy workflow
  # decides from these secrets whether to log in.
  present=$(gh secret list --repo "$REPO" --json name --jq '.[].name') || die "can't list the secrets of $REPO"
  for s in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID; do
    grep -Fxq "$s" <<< "$present" || continue
    gh secret delete "$s" --repo "$REPO" || die "can't delete the secret $s from $REPO"
    echo "deleted secret $s"
  done
fi

# Detach, then delete explicitly: the stack's own deleteAll stops at a resource group that also
# holds resources it doesn't manage, such as the Smart Detection rule App Insights creates.
mkdir -p "$(dirname "$resume")"
printf '%s\n' "$ids" > "$resume"
if [ "$stack" = true ]; then
  az stack sub delete -n "$STACK" "${AZ_SUB[@]}" --action-on-unmanage detachAll --yes --only-show-errors
fi
# Each step skips what an earlier, interrupted run already deleted. A lookup that fails for any
# other reason than "not found" stops here.
for id in $others; do
  if ! out=$(az resource show --ids "$id" -o none 2>&1); then
    grep -qiE 'NotFound|could not be found' <<< "$out" || die "can't check $id: $out"
    continue
  fi
  echo "deleting $id"
  az resource delete --ids "$id" -o none
done
for g in $groups; do
  exists=$(az group exists -n "$g" "${AZ_SUB[@]}") || die "can't check resource group $g"
  [ "$exists" = true ] || continue
  echo "deleting resource group $g"
  az group delete -n "$g" "${AZ_SUB[@]}" --yes -o none
done
# A deleted vault shows up in the soft-deleted list after a short delay. Once purged, it leaves the
# resume file, so a teardown run again later does not wait for it.
for v in $vaults; do
  deleted=""
  for _ in $(seq 1 30); do
    deleted=$(az keyvault list-deleted "${AZ_SUB[@]}" --resource-type vault --query "[?name=='$v'].name" -o tsv) ||
      die "can't list deleted vaults"
    [ -z "$deleted" ] || break
    sleep 10
  done
  [ -n "$deleted" ] ||
    die "the Key Vault $v is not listed as deleted yet; run scripts/teardown.sh $ENV_NAME again in a few minutes to purge it"
  echo "purging the deleted Key Vault $v"
  az keyvault purge --name "$v" "${AZ_SUB[@]}" -o none
  grep -iv "/providers/Microsoft.KeyVault/vaults/$v\$" "$resume" > "$resume.tmp" || true
  mv "$resume.tmp" "$resume"
done
for id in $roles; do
  if ! out=$(az resource show --ids "$id" -o none 2>&1); then
    grep -qiE 'NotFound|could not be found' <<< "$out" || die "can't check $id: $out"
    continue
  fi
  echo "deleting $id"
  az resource delete --ids "$id" -o none
done

if ! out=$(gh api -X DELETE "repos/$REPO/environments/$ENV_NAME" 2>&1); then
  grep -q 'HTTP 404' <<< "$out" || die "deleting the GitHub Environment $ENV_NAME: $out"
fi
rm -f "$resume"
if [ -f "$ENV_FILE" ]; then mv "$ENV_FILE" "$ENV_FILE.deleted-$(date -u +%Y%m%dT%H%M%SZ)"; fi
echo "deleted environment $ENV_NAME"
