#!/usr/bin/env bash
# One-time (idempotent) provisioning for Atlas Credit Exchange.
#
#   ./scripts/bootstrap.sh
#
# Requires: az (logged in), gh (logged in), jq. Override any variable via env.
set -euo pipefail

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-25bf257c-c94e-4d61-bba3-edc635f46602}"
RESOURCE_GROUP="${RESOURCE_GROUP:-internetresearch}"
LOCATION="${LOCATION:-eastus2}"
GITHUB_REPO="${GITHUB_REPO:-tgoodyear/internetresearch}"
APP_NAME="${APP_NAME:-gh-internetresearch-infra}"
export BUDGET_CONTACT_EMAIL="${BUDGET_CONTACT_EMAIL:-trevor.goodyear@gmail.com}"
export BUDGET_START_DATE="${BUDGET_START_DATE:-$(date -u +%Y-%m-01)}"

here="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "Selecting subscription $SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID"
TENANT_ID="$(az account show --query tenantId -o tsv)"

log "Resource group $RESOURCE_GROUP ($LOCATION)"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags project=atlas-credit-exchange -o none

log "Deploying infra/main.bicep"
deployment_json="$(az deployment group create \
  --name "bootstrap-$(date -u +%Y%m%d%H%M%S)" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$here/infra/main.bicep" \
  --parameters "$here/infra/main.bicepparam" \
  --query properties.outputs -o json)"
SWA_NAME="$(jq -r .staticWebAppName.value <<<"$deployment_json")"
SWA_HOST="$(jq -r .staticWebAppHostname.value <<<"$deployment_json")"
STORAGE_NAME="$(jq -r .storageAccountName.value <<<"$deployment_json")"
echo "  static web app: $SWA_NAME  (https://$SWA_HOST)"
echo "  storage:        $STORAGE_NAME"

log "Refreshing SWA app settings (storage connection string)"
CONN="$(az storage account show-connection-string --name "$STORAGE_NAME" --resource-group "$RESOURCE_GROUP" --query connectionString -o tsv)"
az staticwebapp appsettings set --name "$SWA_NAME" --resource-group "$RESOURCE_GROUP" \
  --setting-names "TABLES_CONNECTION_STRING=$CONN" "ATLAS_API_BASE=https://atlas.ripe.net/api/v2" -o none

log "SWA deployment token -> GitHub secret AZURE_STATIC_WEB_APPS_API_TOKEN"
DEPLOY_TOKEN="$(az staticwebapp secrets list --name "$SWA_NAME" --resource-group "$RESOURCE_GROUP" --query properties.apiKey -o tsv)"
gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo "$GITHUB_REPO" --body "$DEPLOY_TOKEN"

log "Entra app for GitHub OIDC ($APP_NAME)"
APP_ID="$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv)"
if [[ -z "$APP_ID" ]]; then
  APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"
fi
if ! az ad sp show --id "$APP_ID" -o none 2>/dev/null; then
  az ad sp create --id "$APP_ID" -o none
fi
SP_OBJECT_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"

add_fic() {
  local name="$1" subject="$2"
  if ! az ad app federated-credential list --id "$APP_ID" --query "[?name=='$name']" -o tsv | grep -q .; then
    az ad app federated-credential create --id "$APP_ID" --parameters "$(cat <<JSON
{"name":"$name","issuer":"https://token.actions.githubusercontent.com","subject":"$subject","audiences":["api://AzureADTokenExchange"]}
JSON
)" -o none
  fi
}
add_fic "main-branch" "repo:$GITHUB_REPO:ref:refs/heads/main"
add_fic "pull-requests" "repo:$GITHUB_REPO:pull_request"

log "Contributor on the resource group"
RG_ID="$(az group show --name "$RESOURCE_GROUP" --query id -o tsv)"
az role assignment create --assignee-object-id "$SP_OBJECT_ID" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "$RG_ID" -o none 2>/dev/null || true

log "GitHub secrets for OIDC login"
gh secret set AZURE_CLIENT_ID --repo "$GITHUB_REPO" --body "$APP_ID"
gh secret set AZURE_TENANT_ID --repo "$GITHUB_REPO" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPO" --body "$SUBSCRIPTION_ID"
gh variable set BUDGET_CONTACT_EMAIL --repo "$GITHUB_REPO" --body "$BUDGET_CONTACT_EMAIL"

log "Done"
echo "Site: https://$SWA_HOST"
echo "Next: merge to main or run the 'Deploy' workflow: gh workflow run deploy.yml --repo $GITHUB_REPO"
