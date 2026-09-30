#!/usr/bin/env bash
# Stand up (or bring up to date) one Atlas Relay environment and wire this GitHub repository to
# deploy it. Safe to re-run: every step is idempotent.
#
#   scripts/bootstrap.sh <env> [options]
#
#   --subscription ID     Azure subscription (default: the environment's recorded one, else az's
#                         current one)
#   --location REGION     default westus2 (new environments only)
#   --repo OWNER/NAME     GitHub repository that deploys it (default tgoodyear/atlasrelay)
#   --domain NAME         the domain, e.g. atlasrelay.org. prod creates its zone; any other
#                         environment adds <env>.<domain> to the prod zone
#   --alert-email ADDR    where alerts go
#
# Needs: az 2.61+, gh and jq, signed in (az login --tenant ..., gh auth login), Owner on the
# subscription and admin on the GitHub repository.
#
# Everything in Azure is one deployment stack, atlasrelay-<env> (infra/main.bicep): a resource
# removed from the template is deleted on the next deployment, and nothing the stack manages can
# be deleted outside it. The environment's settings live in .azure/<env>/.env (git-ignored).
# scripts/provision.sh redeploys from them, scripts/teardown.sh removes the environment.
set -euo pipefail

usage() { awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 2; }
[ $# -ge 1 ] || usage
ENV_NAME=$1; shift
case "$ENV_NAME" in -*|"") usage ;; esac
SUBSCRIPTION="" LOCATION="" REPO="" DOMAIN="" EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --subscription) SUBSCRIPTION=$2; shift 2 ;;
    --location) LOCATION=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --alert-email) EMAIL=$2; shift 2 ;;
    *) usage ;;
  esac
done

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
for tool in az gh jq; do command -v "$tool" > /dev/null || die "$tool is not installed"; done
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
need_stack_az

step "Checking sign-ins"
az account show -o none 2> /dev/null || die "run: az login --tenant <tenant-id>"
[ -n "$SUBSCRIPTION" ] || SUBSCRIPTION=$(aget AZURE_SUBSCRIPTION_ID)
[ -n "$SUBSCRIPTION" ] || SUBSCRIPTION=$(az account show --query id -o tsv)
recorded=$(aget AZURE_SUBSCRIPTION_ID)
[ -z "$recorded" ] || [ "$recorded" = "$SUBSCRIPTION" ] ||
  die "environment $ENV_NAME is in subscription $recorded; tear it down there first (scripts/teardown.sh $ENV_NAME)"
AZ_SUB=(--subscription "$SUBSCRIPTION")
az account show "${AZ_SUB[@]}" --query "{subscription:name, tenant:tenantId, user:user.name}" -o table ||
  die "subscription $SUBSCRIPTION is not visible; run: az login --tenant <tenant-id>"
me=$(az ad signed-in-user show --query id -o tsv 2> /dev/null || true)
if [ -n "$me" ]; then
  az role assignment list "${AZ_SUB[@]}" --assignee "$me" --scope "/subscriptions/$SUBSCRIPTION" \
    --query "[?roleDefinitionName=='Owner']" -o tsv | grep -q . ||
    die "the signed-in user is not Owner of the subscription (the stack creates a role and its assignment)"
fi
gh auth status > /dev/null 2>&1 || die "run: gh auth login"
[ -n "$REPO" ] || REPO=$(aget ATLASRELAY_GITHUB_REPO)
[ -n "$REPO" ] || REPO=tgoodyear/atlasrelay
gh repo view "$REPO" --json name > /dev/null || die "cannot access GitHub repository $REPO"
echo "environment $ENV_NAME, subscription $SUBSCRIPTION, repository $REPO"

step "Registering resource providers"
for ns in Microsoft.Web Microsoft.Storage Microsoft.ManagedIdentity Microsoft.Consumption \
  Microsoft.OperationalInsights Microsoft.Insights Microsoft.AlertsManagement Microsoft.Network; do
  [ "$(az provider show -n "$ns" "${AZ_SUB[@]}" --query registrationState -o tsv 2> /dev/null)" = Registered ] ||
    az provider register -n "$ns" "${AZ_SUB[@]}" --wait -o none
  echo "  $ns: Registered"
done

step "GitHub OIDC subject prefix"
oidc_json=$(gh api "repos/$REPO/actions/oidc/customization/sub") || die "could not read the repository OIDC settings"
prefix=$(jq -r '.sub_claim_prefix // empty' <<< "$oidc_json")
immutable=$(jq -r '.use_immutable_subject // false' <<< "$oidc_json")
if [ -z "$prefix" ]; then
  [ "$immutable" != true ] || die "repository uses immutable OIDC subjects but GitHub returned no prefix"
  prefix="repo:$REPO"
fi
if [ "$immutable" = true ] && [[ $prefix != repo:*@*/*@* ]]; then
  die "unexpected OIDC subject prefix '$prefix' (expected repo:OWNER@ID/REPO@ID)"
fi
echo "  $prefix"

step "Writing settings to $ENV_FILE"
aset AZURE_ENV_NAME "$ENV_NAME"
aset AZURE_SUBSCRIPTION_ID "$SUBSCRIPTION"
[ -n "$(aget AZURE_LOCATION)" ] || aset AZURE_LOCATION "${LOCATION:-westus2}"
aset ATLASRELAY_GITHUB_REPO "$REPO"
aset ATLASRELAY_GITHUB_OIDC_SUBJECT_PREFIX "$prefix"
[ -z "$DOMAIN" ] || aset ATLASRELAY_DNS_ZONE "$DOMAIN"
if [ -n "$EMAIL" ]; then
  aset ATLASRELAY_ALERT_EMAIL "$EMAIL"
  # A budget's start date can never change: set it once.
  [ -n "$(aget ATLASRELAY_BUDGET_START)" ] || aset ATLASRELAY_BUDGET_START "$(date -u +%Y-%m-01)"
fi
[ -n "$(aget ATLASRELAY_ALERT_EMAIL)" ] || echo "  no --alert-email: the stack deploys no action group and no alerts"

step "Deploying stack $STACK"
provision
echo "  resource group:  $(aget AZURE_RESOURCE_GROUP)"
echo "  static web app:  $(aget SWA_NAME)  (https://$(aget SWA_HOSTNAME))"
echo "  storage:         $(aget STORAGE_ACCOUNT)"
echo "  ci identity:     $(aget CI_CLIENT_ID)"

step "Waiting for the CI role assignment to be visible"
rg_id="/subscriptions/$SUBSCRIPTION/resourceGroups/$(aget AZURE_RESOURCE_GROUP)"
principal=$(aget CI_PRINCIPAL_ID)
assigned=""
for _ in $(seq 1 24); do
  assigned=$(az role assignment list "${AZ_SUB[@]}" --scope "$rg_id" --query "[?principalId=='$principal'].id | [0]" -o tsv)
  [ -n "$assigned" ] && { echo "  assigned: $assigned"; break; }
  sleep 5
done
[ -n "$assigned" ] || echo "  warning: role assignment not visible yet; the first workflow run may need a retry"

step "GitHub Environment '$ENV_NAME' in $REPO"
# The CI identity trusts jobs in this GitHub Environment, and only main may use it.
gh api -X PUT "repos/$REPO/environments/$ENV_NAME" --input - > /dev/null << 'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
# Exactly one policy may exist: the branch main. Anything else (another branch pattern, or a tag
# named main) would let other refs use the identity.
policies="repos/$REPO/environments/$ENV_NAME/deployment-branch-policies"
has_main=false
while read -r id name type; do
  [ -n "$id" ] || continue
  if [ "$name" = main ] && [ "$type" = branch ] && [ "$has_main" = false ]; then
    has_main=true
  else
    echo "  removing deployment policy $type $name"
    gh api -X DELETE "$policies/$id" > /dev/null
  fi
done <<< "$(gh api "$policies" --paginate --jq '.branch_policies[] | "\(.id) \(.name) \(.type // "branch")"')"
[ "$has_main" = true ] || gh api -X POST "$policies" -f name=main -f type=branch > /dev/null
echo "  deployments restricted to main"

if [ "$ENV_NAME" = prod ]; then
  step "Repository secrets and variables for the Deploy workflow"
  # Identifiers, not credentials. The Deploy workflow reads them as secrets.
  gh secret set AZURE_CLIENT_ID --repo "$REPO" --body "$(aget CI_CLIENT_ID)"
  gh secret set AZURE_TENANT_ID --repo "$REPO" --body "$(aget AZURE_TENANT_ID)"
  gh secret set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUBSCRIPTION"
  # Tells the workflow Azure exists, so a missing secret fails the run instead of skipping it.
  gh variable set AZURE_BOOTSTRAPPED --repo "$REPO" --body true
  # Compiled into the browser bundle (web/src/lib/telemetry.ts). A variable, not a secret: the
  # connection string is public once the site ships it.
  gh variable set APPINSIGHTS_CONNECTION_STRING --repo "$REPO" --body "$(aget APPLICATIONINSIGHTS_CONNECTION_STRING)"
else
  echo
  echo "The Deploy workflow uploads to prod only. To deploy $ENV_NAME, upload the build with the"
  echo "site's token: az staticwebapp secrets list -n $(aget SWA_NAME) -g $(aget AZURE_RESOURCE_GROUP) --subscription $SUBSCRIPTION"
fi

step "Done"
echo "Site: https://$(aget SWA_HOSTNAME)"
domain=$(aget ATLASRELAY_DNS_ZONE)
if [ -n "$domain" ] && [ "$ENV_NAME" = prod ]; then
  echo "Zone $domain name servers: $(aget NAME_SERVERS)"
  echo "Once the registrar delegates $domain to them: scripts/bind-custom-domain.sh $ENV_NAME"
elif [ -n "$domain" ]; then
  echo "Once $ENV_NAME.$domain resolves: scripts/bind-custom-domain.sh $ENV_NAME"
fi
[ "$ENV_NAME" != prod ] || echo "Deploy the app: gh workflow run deploy.yml --repo $REPO --ref main"
