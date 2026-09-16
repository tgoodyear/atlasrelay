// Atlas Credit Exchange – subscription-scoped entry point, run once by a subscription Owner
// (scripts/bootstrap.sh). Everything Azure is declared here or in the modules below:
//
//   identity.bicep  CI managed identity + GitHub federated credential(s)      (Owner-only)
//   rbac.bicep      least-privilege role assignment for CI, storage delete lock (Owner-only)
//   app.bicep       storage, static web app, app settings, App Insights, budget (CI deploys this)
//
// Deploy:
//   az deployment sub create --location <region> --template-file infra/main.bicep --parameters infra/main.bicepparam
targetScope = 'subscription'

@description('Resource group that holds every resource')
param resourceGroupName string = 'internetresearch'

@description('Region for the resource group, storage, identity and monitoring')
param location string = 'westus2'

@description('Base name used for resources')
@minLength(3)
@maxLength(20)
param baseName string = 'internetresearch'

@description('Static Web Apps is only offered in a handful of regions.')
@allowed([
  'westus2'
  'centralus'
  'eastus2'
  'westeurope'
  'eastasia'
])
param swaLocation string = 'westus2'

@description('Free or Standard. Standard ($9/mo) unlocks custom OIDC providers.')
@allowed([
  'Free'
  'Standard'
])
param swaSku string = 'Free'

@description('GitHub repository (owner/name); used for tags and documentation')
param githubRepo string = 'tgoodyear/internetresearch'

@description('''OIDC subject prefix GitHub issues for this repository. Repositories created after
2026-07-15 use the immutable form "repo:OWNER@OWNER-ID/REPO@REPO-ID"; older ones use "repo:OWNER/REPO".
Read it with: gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix''')
param githubOidcSubjectPrefix string

@description('Also trust pull_request runs (they would share production data). Off by default.')
param enablePullRequestFederation bool = false

@description('Application Insights + Log Analytics for API logs (free tier, daily cap enforced)')
param enableApplicationInsights bool = true

@description('Monthly budget (alerts only) in USD for the resource group')
param budgetAmount int = 120

@description('Email that receives budget alerts')
param budgetContactEmail string

@description('First day of the budget period (YYYY-MM-01). Must be the current month on first creation; reuse the existing value afterwards.')
param budgetStartDate string

@description('Tags applied to every resource')
param tags object = {
  project: 'atlas-credit-exchange'
  repo: githubRepo
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

// ---------- CI identity (Owner-only; CI cannot modify its own trust) ----------

module identity 'identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    identityName: 'id-${baseName}-ci'
    location: location
    githubOidcSubjectPrefix: githubOidcSubjectPrefix
    enablePullRequestFederation: enablePullRequestFederation
    tags: tags
  }
}

// Least-privilege role for CI: only the resource types app.bicep deploys, inside this group.
resource ciRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, rg.id, 'atlas-credit-exchange-ci-deployer')
  properties: {
    roleName: 'Atlas Credit Exchange CI Deployer (${resourceGroupName})'
    description: 'Deploy infra/app.bicep and read the Static Web App deployment token. No RBAC, no identity, no locks.'
    type: 'CustomRole'
    assignableScopes: [rg.id]
    permissions: [
      {
        actions: [
          '*/read'
          'Microsoft.Resources/deployments/*'
          'Microsoft.Web/staticSites/*'
          'Microsoft.Storage/storageAccounts/*'
          'Microsoft.OperationalInsights/workspaces/*'
          'Microsoft.Insights/components/*'
          'Microsoft.Insights/actionGroups/*'
          'Microsoft.AlertsManagement/smartDetectorAlertRules/*'
          'Microsoft.Consumption/budgets/*'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

// ---------- application resources ----------

module app 'app.bicep' = {
  name: 'app'
  scope: rg
  params: {
    baseName: baseName
    location: location
    swaLocation: swaLocation
    swaSku: swaSku
    enableApplicationInsights: enableApplicationInsights
    budgetAmount: budgetAmount
    budgetContactEmail: budgetContactEmail
    budgetStartDate: budgetStartDate
    tags: tags
  }
}

// ---------- RBAC + locks (Owner-only) ----------

module rbac 'rbac.bicep' = {
  name: 'rbac'
  scope: rg
  params: {
    principalId: identity.outputs.principalId
    roleDefinitionId: ciRole.id
    storageAccountName: app.outputs.storageAccountName
  }
}

output resourceGroupName string = rg.name
output storageAccountName string = app.outputs.storageAccountName
output staticWebAppName string = app.outputs.staticWebAppName
output staticWebAppHostname string = app.outputs.staticWebAppHostname
output ciClientId string = identity.outputs.clientId
output ciPrincipalId string = identity.outputs.principalId
output ciRoleDefinitionId string = ciRole.id
output tenantId string = tenant().tenantId
output subscriptionId string = subscription().subscriptionId
