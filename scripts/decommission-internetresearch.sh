#!/usr/bin/env bash
# One-time removal of the resources the project ran on before the deployment stacks: resource
# group "internetresearch", with swa-internetresearch, swa-internetresearch-dev, their storage
# accounts (CanNotDelete locks), monitoring and the CI identity, plus the custom role
# "Atlas Credit Exchange CI Deployer (internetresearch)", which is stored with the subscription
# and outlives the group. Run it after the new prod environment serves the domain; see
# docs/RUNBOOK.md, "Moving from the internetresearch resource group". Delete this script afterwards.
#
#   scripts/decommission-internetresearch.sh [--subscription ID]
#
# It refuses to run while the atlasrelay.org zone is still in the old group (deleting the group
# would delete the zone and its name servers), or when the atlasrelay-prod stack does not exist.
# It prints everything it will delete and asks for the group's name first.
#
# Needs az, signed in with Owner on the subscription. gh is optional: when signed in, the
# repository secret BUDGET_CONTACT_EMAIL, which only the old infrastructure workflow read, is
# deleted too.
set -euo pipefail
OLD_RG=internetresearch
OLD_ROLE="Atlas Credit Exchange CI Deployer (internetresearch)"
OLD_DEV_SWA=swa-internetresearch-dev
ZONE=atlasrelay.org
REPO=tgoodyear/atlasrelay
SUBSCRIPTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --subscription) SUBSCRIPTION=$2; shift 2 ;;
    *) sed -n '2,19s/^# \{0,1\}//p' "$0" >&2; exit 2 ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."
if [ -z "$SUBSCRIPTION" ] && [ -f .azure/prod/.env ]; then
  SUBSCRIPTION=$(sed -n 's/^AZURE_SUBSCRIPTION_ID="\(.*\)"$/\1/p' .azure/prod/.env)
fi
[ -n "$SUBSCRIPTION" ] || SUBSCRIPTION=$(az account show --query id -o tsv 2> /dev/null || true)
[ -n "$SUBSCRIPTION" ] || die "pass --subscription, or run: az login --tenant <tenant-id>"
SUB=(--subscription "$SUBSCRIPTION")

# A run stopped after the group was deleted resumes with what outlives it: the role and the secret.
rg_exists=$(az group exists -n "$OLD_RG" "${SUB[@]}") || die "can't check resource group $OLD_RG"
[ "$rg_exists" = true ] || echo "resource group $OLD_RG is already gone; finishing the rest"

# The zone must have been moved out first. A zone of the same name elsewhere is the new one.
zones=$(az network dns zone list "${SUB[@]}" --query "[?name=='$ZONE'].resourceGroup" -o tsv) ||
  die "can't list DNS zones"
if grep -qix "$OLD_RG" <<< "$zones"; then
  die "the $ZONE zone is still in $OLD_RG; move it to rg-atlasrelay-prod first (docs/RUNBOOK.md)"
fi
az stack sub show -n atlasrelay-prod "${SUB[@]}" -o none 2> /dev/null ||
  die "no deployment stack atlasrelay-prod in $SUBSCRIPTION; deploy the new environment first"

# The old dev site's CNAME was copied into the moved zone and would point at a deleted site.
old_dev_host=""
[ "$rg_exists" = false ] || old_dev_host=$(az staticwebapp show -n "$OLD_DEV_SWA" -g "$OLD_RG" "${SUB[@]}" --query defaultHostname -o tsv 2> /dev/null || true)
zone_rg=$(head -1 <<< "$zones")
dev_cname=""
if [ -n "$old_dev_host" ] && [ -n "$zone_rg" ]; then
  target=$(az network dns record-set cname show -g "$zone_rg" -z "$ZONE" -n dev "${SUB[@]}" \
    --query CNAMERecord.cname -o tsv 2> /dev/null || true)
  [ "${target%.}" != "${old_dev_host%.}" ] || dev_cname="dev.$ZONE -> $target (in $zone_rg)"
fi

role_ids=$(az role definition list "${SUB[@]}" --custom-role-only true --name "$OLD_ROLE" --query "[].id" -o tsv)
locks=""
[ "$rg_exists" = false ] || locks=$(az lock list -g "$OLD_RG" "${SUB[@]}" --query "[].id" -o tsv)

echo "Subscription $SUBSCRIPTION. This deletes:"
if [ "$rg_exists" = true ]; then
  echo
  echo "Resource group $OLD_RG and everything in it:"
  az resource list -g "$OLD_RG" "${SUB[@]}" --query "sort_by([], &type)[].{name:name, type:type}" -o table
  echo
  echo "Its budget(s):"
  az consumption budget list -g "$OLD_RG" "${SUB[@]}" --query "[].name" -o tsv 2> /dev/null | sed 's/^/  /' || true
  echo
  echo "The delete locks, removed first:"
  if [ -n "$locks" ]; then sed 's/^/  /' <<< "$locks"; else echo "  (none)"; fi
fi
echo
echo "The custom role:"
if [ -n "$role_ids" ]; then sed "s/^/  $OLD_ROLE  /" <<< "$role_ids"; else echo "  (not found)"; fi
if [ -n "$dev_cname" ]; then
  echo
  echo "The stale record $dev_cname"
fi
echo
read -r -p "Type the resource group name ($OLD_RG) to confirm: " answer
[ "$answer" = "$OLD_RG" ] || die "not confirmed"

for id in $locks; do
  echo "removing lock $id"
  az lock delete --ids "$id" -o none
done
if [ -n "$dev_cname" ]; then
  echo "deleting dev.$ZONE"
  az network dns record-set cname delete -g "$zone_rg" -z "$ZONE" -n dev "${SUB[@]}" --yes -o none
fi
if [ "$rg_exists" = true ]; then
  echo "deleting resource group $OLD_RG (this takes a few minutes)"
  az group delete -n "$OLD_RG" "${SUB[@]}" --yes -o none
fi
# Its role assignments went with the group, so the definition can go now.
for id in $role_ids; do
  echo "deleting role definition $id"
  az rest --method delete --url "https://management.azure.com$id?api-version=2022-04-01" -o none
done
if command -v gh > /dev/null && gh auth status > /dev/null 2>&1; then
  gh secret delete BUDGET_CONTACT_EMAIL --repo "$REPO" 2> /dev/null && echo "deleted secret BUDGET_CONTACT_EMAIL" || true
fi
echo "done. Remove scripts/decommission-internetresearch.sh and its RUNBOOK section in a follow-up PR."
