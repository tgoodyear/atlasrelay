#!/usr/bin/env bash
# One-time (idempotent) provisioning for Atlas Relay.
#
#   ./scripts/bootstrap.sh
#
# Every Azure resource is declared in infra/*.bicep. This script only:
#   1. checks prerequisites and registers the resource providers the templates use,
#   2. runs the subscription-scoped deployment (resource group + everything in it),
#   3. hands the identity/tenant/subscription ids to GitHub so workflows can log in with OIDC.
#
# Requires: az (logged in as an Owner of the subscription), gh (logged in, repo+workflow scopes), jq.
set -euo pipefail

# No subscription is hardcoded. Set SUBSCRIPTION_ID, or the currently selected one is used.
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-$(az account show --query id -o tsv 2>/dev/null || true)}"
[[ -n "$SUBSCRIPTION_ID" ]] || { echo "set SUBSCRIPTION_ID, or run: az login" >&2; exit 1; }
RESOURCE_GROUP="${RESOURCE_GROUP:-internetresearch}"
LOCATION="${LOCATION:-westus2}"
GITHUB_REPO="${GITHUB_REPO:-tgoodyear/atlasrelay}"
# Where Azure sends budget alerts. Must be given explicitly: deriving it from the Azure login
# would quietly reintroduce the operator's personal address, which is what this avoids.
[[ -n "${BUDGET_CONTACT_EMAIL:-}" ]] || {
  echo "set BUDGET_CONTACT_EMAIL to the address that should receive Azure budget alerts, e.g." >&2
  echo "  BUDGET_CONTACT_EMAIL=alerts@example.org $0" >&2
  exit 1
}
export BUDGET_CONTACT_EMAIL

here="$(cd "$(dirname "$0")/.." && pwd)"
SUB=(--subscription "$SUBSCRIPTION_ID")

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

log "Preflight"
for t in az gh jq; do command -v "$t" >/dev/null || die "missing prerequisite: $t"; done
gh auth status >/dev/null 2>&1 || die "gh is not logged in (needs repo + workflow scopes)"
gh repo view "$GITHUB_REPO" --json name >/dev/null || die "cannot access GitHub repo $GITHUB_REPO"
az account show "${SUB[@]}" --query "{name:name, tenant:tenantId, user:user.name}" -o table \
  || die "subscription $SUBSCRIPTION_ID is not visible; run: az login --tenant <tenant-id>"
me="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
if [[ -n "$me" ]]; then
  az role assignment list "${SUB[@]}" --assignee "$me" --scope "/subscriptions/$SUBSCRIPTION_ID" --query "[?roleDefinitionName=='Owner']" -o tsv | grep -q . \
    || die "the signed-in user is not Owner of the subscription (needed for RBAC and locks)"
fi

log "Resource providers"
for rp in Microsoft.Web Microsoft.Storage Microsoft.ManagedIdentity Microsoft.Consumption Microsoft.OperationalInsights Microsoft.Insights Microsoft.AlertsManagement Microsoft.Network; do
  state="$(az provider show -n "$rp" "${SUB[@]}" --query registrationState -o tsv 2>/dev/null || echo Unknown)"
  if [[ "$state" != "Registered" ]]; then
    echo "  registering $rp ..."
    az provider register -n "$rp" "${SUB[@]}" -o none
    until [[ "$(az provider show -n "$rp" "${SUB[@]}" --query registrationState -o tsv)" == "Registered" ]]; do sleep 5; done
  fi
  echo "  $rp: Registered"
done

log "GitHub OIDC subject prefix"
oidc_json="$(gh api "repos/$GITHUB_REPO/actions/oidc/customization/sub")" || die "could not read the repository OIDC settings"
prefix="$(jq -r '.sub_claim_prefix // empty' <<<"$oidc_json")"
immutable="$(jq -r '.use_immutable_subject // false' <<<"$oidc_json")"
if [[ -z "$prefix" ]]; then
  [[ "$immutable" == "true" ]] && die "repository uses immutable OIDC subjects but GitHub returned no prefix"
  prefix="repo:$GITHUB_REPO"
fi
if [[ "$immutable" == "true" && "$prefix" != repo:*@*/*@* ]]; then
  die "unexpected OIDC subject prefix '$prefix' (expected repo:OWNER@ID/REPO@ID)"
fi
export GITHUB_OIDC_SUBJECT_PREFIX="$prefix"
echo "  $GITHUB_OIDC_SUBJECT_PREFIX"

log "Shared parameters"
"$here/scripts/check-params.sh"

log "Budget period start"
export BUDGET_START_DATE="$("$here/scripts/budget-start-date.sh" "$SUBSCRIPTION_ID" "$RESOURCE_GROUP")"
echo "  $BUDGET_START_DATE"

log "Deploying infra/main.bicep (subscription scope)"
deploy() {
  az deployment sub create \
    --name "bootstrap-$(date -u +%Y%m%d%H%M%S)" \
    --location "$LOCATION" \
    --template-file "$here/infra/main.bicep" \
    --parameters "$here/infra/main.bicepparam" \
    --parameters resourceGroupName="$RESOURCE_GROUP" location="$LOCATION" githubRepo="$GITHUB_REPO" \
    "${SUB[@]}" \
    --query properties.outputs -o json
}
# A brand-new custom role can take a little while to replicate before it can be assigned
# (RoleDefinitionDoesNotExist). The deployment is idempotent, so retry once after a pause.
if ! outputs="$(deploy)"; then
  echo "  deployment failed; retrying once in 45 s (custom role replication lag is the usual cause)"
  sleep 45
  outputs="$(deploy)"
fi

val() { jq -r ".$1.value" <<<"$outputs"; }
SWA_NAME="$(val staticWebAppName)"
SWA_HOST="$(val staticWebAppHostname)"
STORAGE_NAME="$(val storageAccountName)"
CI_CLIENT_ID="$(val ciClientId)"
CI_PRINCIPAL_ID="$(val ciPrincipalId)"
TENANT_ID="$(val tenantId)"
echo "  resource group: $RESOURCE_GROUP"
echo "  static web app: $SWA_NAME  (https://$SWA_HOST)"
echo "  storage:        $STORAGE_NAME"
echo "  ci identity:    $CI_CLIENT_ID"

log "Waiting for the CI role assignment to be visible"
rg_id="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP"
assigned=""
for _ in $(seq 1 24); do
  # Filter by principalId in the query: works on every az version and needs no Graph lookup.
  assigned="$(az role assignment list "${SUB[@]}" --scope "$rg_id" --query "[?principalId=='$CI_PRINCIPAL_ID'].id | [0]" -o tsv)"
  [[ -n "$assigned" ]] && { echo "  assigned: $assigned"; break; }
  sleep 5
done
[[ -n "$assigned" ]] || echo "  warning: role assignment not visible yet; the first workflow run may need a retry"

log "GitHub secrets/variables for OIDC login ($GITHUB_REPO)"
gh secret set AZURE_CLIENT_ID --repo "$GITHUB_REPO" --body "$CI_CLIENT_ID"
gh secret set AZURE_TENANT_ID --repo "$GITHUB_REPO" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPO" --body "$SUBSCRIPTION_ID"
# A secret, not a variable: repository variables are world-readable on a public repo.
gh secret set BUDGET_CONTACT_EMAIL --repo "$GITHUB_REPO" --body "$BUDGET_CONTACT_EMAIL"
# Tells the workflows that Azure exists, so a missing secret becomes a failed run instead of a silent skip.
gh variable set AZURE_BOOTSTRAPPED --repo "$GITHUB_REPO" --body "true"

log "Done"
echo "Site: https://$SWA_HOST"
echo "Next: merge to main, or run: gh workflow run deploy.yml --repo $GITHUB_REPO"
echo "Note: Azure role assignments can take a few minutes to propagate; re-run a failed first workflow."
