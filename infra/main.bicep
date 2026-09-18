// Atlas Credit Exchange – subscription-scoped entry point, run once by a subscription Owner
// (scripts/bootstrap.sh). Everything Azure is declared here or in the modules below:
//
//   identity.bicep  CI managed identity + GitHub federated credential(s)          (Owner-only)
//   platform.bicep  Log Analytics + App Insights, monthly budget                    (Owner-only)
//   dns.bicep       public DNS zone for the project domain                          (Owner-only)
//   rbac.bicep      least-privilege role assignment for CI, delete locks           (Owner-only)
//   app.bicep       storage + tables, static web app + app settings                 (CI deploys this)
//
// Deploy with scripts/bootstrap.sh (it supplies the GitHub OIDC subject prefix and the budget start
// date that main.bicepparam requires from the environment).
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

@description('Allow pull-request preview environments on the static web app')
@allowed([
  'Enabled'
  'Disabled'
])
param stagingEnvironmentPolicy string = 'Disabled'

@description('Application Insights + Log Analytics for API logs (free tier, daily cap enforced)')
param enableApplicationInsights bool = true

@description('Daily ingestion cap for Log Analytics in GB')
param logDailyCapGb string = '0.1'

@description('Which storage key the API uses (0 = key1, 1 = key2)')
@allowed([
  0
  1
])
param storageKeyIndex int = 0

@description('Extra app settings merged into the managed-functions configuration')
param additionalAppSettings object = {}

@description('Public DNS zone to create, e.g. atlasrelay.org. Empty string skips DNS entirely.')
param dnsZoneName string = ''

@description('''
Default hostname of the dev static web app, which gets dev.<zone>. Empty leaves that record
uncreated. The dev instance is deployed separately by infra/dev.bicepparam against app.bicep, and
its hostname is not an output of this deployment, so it has to be passed in:
  az staticwebapp show -n swa-<baseName>-dev -g <rg> --query defaultHostname -o tsv
then supplied to the Owner-only subscription deployment. Leave it empty when no dev instance
exists; a stale value here would point dev.<zone> at a site that is gone.
''')
param devStaticWebAppDefaultHostname string = ''

@description('Extra apex TXT values (e.g. the Static Web Apps domain-validation token)')
param dnsApexTxtValues array = []

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

// Least-privilege role for CI: only what deploying app.bicep needs, inside this group.
// No identity, RBAC, locks, monitoring or budget write access; no key regeneration or deletes.
resource ciRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, rg.id, 'atlas-credit-exchange-ci-deployer')
  properties: {
    roleName: 'Atlas Credit Exchange CI Deployer (${resourceGroupName})'
    description: 'Deploy infra/app.bicep (static site, storage) and read the Static Web App deployment token.'
    type: 'CustomRole'
    assignableScopes: [rg.id]
    permissions: [
      {
        actions: [
          '*/read'
          'Microsoft.Resources/deployments/*'
          'Microsoft.Web/staticSites/*'
          'Microsoft.Storage/storageAccounts/*'
        ]
        notActions: [
          'Microsoft.Web/staticSites/delete'
          'Microsoft.Web/staticSites/createinvitation/action'
          'Microsoft.Web/staticSites/authproviders/users/write'
          'Microsoft.Web/staticSites/authproviders/users/delete'
          'Microsoft.Web/staticSites/resetapikey/action'
          'Microsoft.Storage/storageAccounts/delete'
          'Microsoft.Storage/storageAccounts/regeneratekey/action'
          'Microsoft.Storage/storageAccounts/rotateKey/action'
        ]
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

// ---------- monitoring + budget (Owner-only) ----------

module platform 'platform.bicep' = {
  name: 'platform'
  scope: rg
  params: {
    baseName: baseName
    location: location
    enableApplicationInsights: enableApplicationInsights
    logDailyCapGb: logDailyCapGb
    budgetAmount: budgetAmount
    budgetContactEmail: budgetContactEmail
    budgetStartDate: budgetStartDate
    tags: tags
  }
}

// ---------- application resources (also deployed by CI from infra/app.bicepparam) ----------

module app 'app.bicep' = {
  name: 'app'
  scope: rg
  params: {
    baseName: baseName
    location: location
    swaLocation: swaLocation
    swaSku: swaSku
    stagingEnvironmentPolicy: stagingEnvironmentPolicy
    enableApplicationInsights: enableApplicationInsights
    appInsightsName: enableApplicationInsights ? platform.outputs.appInsightsName : 'appi-${baseName}'
    storageKeyIndex: storageKeyIndex
    additionalAppSettings: additionalAppSettings
    tags: tags
  }
}

// ---------- DNS (Owner-only; CI has no Microsoft.Network permissions) ----------

module dns 'dns.bicep' = if (!empty(dnsZoneName)) {
  name: 'dns'
  scope: rg
  params: {
    zoneName: dnsZoneName
    staticWebAppDefaultHostname: app.outputs.staticWebAppHostname
    devStaticWebAppDefaultHostname: devStaticWebAppDefaultHostname
    staticWebAppInboundIp: app.outputs.staticWebAppInboundIp
    apexTxtValues: dnsApexTxtValues
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
    staticWebAppName: app.outputs.staticWebAppName
  }
}

output resourceGroupName string = rg.name
output storageAccountName string = app.outputs.storageAccountName
output staticWebAppName string = app.outputs.staticWebAppName
output staticWebAppHostname string = app.outputs.staticWebAppHostname
output ciClientId string = identity.outputs.clientId
output ciPrincipalId string = identity.outputs.principalId
output ciRoleDefinitionId string = ciRole.id
output appInsightsName string = platform.outputs.appInsightsName
output dnsZoneName string = empty(dnsZoneName) ? '' : dns!.outputs.zoneName
output dnsNameServers array = empty(dnsZoneName) ? [] : dns!.outputs.nameServers
output tenantId string = tenant().tenantId
output subscriptionId string = subscription().subscriptionId
