// Atlas Relay: one environment (prod, dev, ...), deployed as the subscription-scope deployment
// stack atlasrelay-<env> by scripts/bootstrap.sh and scripts/provision.sh, with parameters from
// infra/main.bicepparam (which reads the environment's settings, .azure/<env>/.env).
//
//   app.bicep         storage + tables, static web app (Standard) and its sign-in settings
//   api.bicep         Function App (Flex Consumption) with its managed identity and host storage,
//                     linked to the static web app as its API
//   platform.bicep    Log Analytics + App Insights (App* tables kept 90 days), the monthly budget
//   monitoring.bicep  action group, log search alerts, availability test, workbook
//   identity.bicep    CI managed identity + GitHub federated credential
//   rbac.bicep        CI custom roles (read the site, list its deployment token; publish the API
//                     to the Function App) + assignments
//   dns.bicep         public DNS zone for the domain (prod only)
//   dns-subdomain.bicep  <env>.<domain> CNAME in the prod zone (other environments)
//   testharness.bicep    full-flow test job, private vault, network (other environments)
//   testharness-rbac.bicep  what CI may do with the test job (other environments)
//
// The stack runs with --action-on-unmanage deleteResources (a resource dropped from this template
// is deleted on the next deployment) and --deny-settings-mode denyDelete (nobody deletes a managed
// resource outside the stack). CI deploys no Bicep: it publishes the API package to the Function
// App and uploads the site with the deployment token its role lets it read.
targetScope = 'subscription'

@description('Environment name: 1-6 lowercase letters and digits, e.g. prod or dev (AZURE_ENV_NAME).')
@minLength(1)
@maxLength(6)
param environmentName string

@description('Region for the resource group, storage, identity and monitoring')
param location string = 'westus2'

@description('Static Web Apps is only offered in a handful of regions.')
@allowed([
  'westus2'
  'centralus'
  'eastus2'
  'westeurope'
  'eastasia'
])
param swaLocation string = 'westus2'

@description('Allow pull-request preview environments on the static web app')
@allowed([
  'Enabled'
  'Disabled'
])
param stagingEnvironmentPolicy string = 'Disabled'

@description('GitHub repository (owner/name) that deploys this environment; used for tags')
param githubRepo string = 'tgoodyear/atlasrelay'

@description('''OIDC subject prefix GitHub issues for the repository. Repositories created after
2026-07-15 use the immutable form "repo:OWNER@OWNER-ID/REPO@REPO-ID"; older ones "repo:OWNER/REPO".
scripts/bootstrap.sh reads it from the GitHub API.''')
param githubOidcSubjectPrefix string

@description('Daily ingestion cap for Log Analytics in GB')
param logDailyCapGb string = '0.1'

@description('''Accept the data storage account's key. Off: only Microsoft Entra identities reach the data.
Leave off: the API and operators sign in with Entra ID and nothing reads the key.''')
param storageSharedKeyAccess bool = false

@description('''Link the Function App to the static web app as its API.
Off only to relink a lost identity provider ("Direct requests to the Function App" in
docs/RUNBOOK.md) or to check a new app directly; an unlinked app answers every request as anonymous.''')
param linkApi bool = true

@description('''Object id of the Owner who works on the tables by hand and, outside prod, writes the test
accounts into the test vault (scripts/set-test-users.sh). Empty: nobody has data access.''')
param operatorPrincipalId string = ''

@description('''Client id of the site's own GitHub OAuth app, for sign-in through the site's own
registrations (docs/RUNBOOK.md, "Google and ORCID sign-in"). Empty: built-in GitHub sign-in.''')
param signinGithubClientId string = ''
@secure()
@description('Client secret of that GitHub OAuth app')
param signinGithubClientSecret string = ''
@description('Application (client) id of the site\'s own Microsoft Entra app registration. Empty: none.')
param signinMicrosoftClientId string = ''
@secure()
@description('Client secret of that Entra app registration')
param signinMicrosoftClientSecret string = ''
@description('Client id of the site\'s Google OAuth client. Empty: no Google sign-in.')
param signinGoogleClientId string = ''
@secure()
@description('Client secret of that Google OAuth client')
param signinGoogleClientSecret string = ''
@description('Client id of the site\'s ORCID public API client. Empty: no ORCID sign-in.')
param signinOrcidClientId string = ''
@secure()
@description('Client secret of that ORCID client')
param signinOrcidClientSecret string = ''

@description('Extra app settings for the Function App')
param additionalAppSettings object = {}

@description('Address that receives alerts and budget notifications. Empty skips the action group, the alerts and the budget.')
param alertEmail string = ''

@description('Monthly budget (alerts only) in USD')
param budgetAmount int = 120

@description('First day of the budget period (YYYY-MM-01), fixed once the budget exists. Empty skips the budget.')
param budgetStartDate string = ''

@description('''The domain, e.g. atlasrelay.org. In prod the stack owns the public zone of that name;
in any other environment it adds <env>.<domain> to the prod zone. Empty skips DNS.''')
param dnsZoneName string = ''

@description('Resource group of the prod zone, used by the other environments for their CNAME')
param dnsZoneResourceGroup string = 'rg-atlasrelay-prod'

@description('TTL in seconds for the records this environment writes')
param dnsTtl int = 3600

@description('TXT values published at the apex, keyed by zone name (site-verification tokens)')
param dnsApexTxtValues object = {}

@description('''The apex domain-validation token Static Web Apps issued to this site, recorded by
scripts/bind-custom-domain.sh. Published at the apex (prod only). Empty until the apex is bound.''')
param swaApexToken string = ''

@description('''Deploy the full-flow test harness (testharness.bicep): a Container Apps job that signs
test accounts into the site, with their passwords in a private Key Vault. Never in prod, whatever
this says; main.bicepparam sets it for every other environment.''')
param testHarness bool = toLower(environmentName) != 'prod'

// The providers the site's own registrations cover, as scripts/lib/env.sh (signin_providers) works
// them out: none, or GitHub and Microsoft plus Google and ORCID where their pairs are set. The API
// accepts exactly these (GitHub and Microsoft when none).
var signinGoogle = !empty(signinGoogleClientId) && !empty(signinGoogleClientSecret)
var signinOrcid = !empty(signinOrcidClientId) && !empty(signinOrcidClientSecret)
var signinProviders = join(concat(['github', 'aad'], signinGoogle ? ['google'] : [], signinOrcid ? ['orcid'] : []), ',')

var env = toLower(environmentName)
var isProd = env == 'prod'
var harness = testHarness && !isProd
var baseName = 'atlasrelay-${env}'
var tags = {
  project: 'atlasrelay'
  environment: env
  repo: githubRepo
}
// The availability test requests the domain once the apex is bound (its token is recorded), and
// the site's own hostname before that. Only prod has one.
var apexBound = !empty(dnsZoneName) && !empty(swaApexToken)
// The hostname the site is reached on: the domain once the apex is bound, else the site's own.
var siteHostname = isProd && apexBound
  ? dnsZoneName
  : (!isProd && !empty(dnsZoneName) ? '${env}.${dnsZoneName}' : app.outputs.staticWebAppHostname)

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${baseName}'
  location: location
  tags: tags
}

// ---------- CI identity ----------

module identity 'identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    identityName: 'id-${baseName}-ci'
    location: location
    githubOidcSubjectPrefix: githubOidcSubjectPrefix
    githubEnvironment: env
    tags: tags
  }
}

// ---------- monitoring + budget ----------

module platform 'platform.bicep' = {
  name: 'platform'
  scope: rg
  params: {
    baseName: baseName
    location: location
    logDailyCapGb: logDailyCapGb
    budgetName: 'budget-${baseName}'
    budgetAmount: budgetAmount
    budgetStartDate: budgetStartDate
    alertEmail: alertEmail
    tags: tags
  }
}

// Alerts, the availability test and the workbook. A module of main.bicep rather than of
// platform.bicep because the availability test requests the site, and the Function App's app
// settings need the App Insights component first.
module monitoring 'monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    baseName: baseName
    location: location
    tags: tags
    workspaceId: platform.outputs.workspaceId
    appInsightsId: platform.outputs.appInsightsId
    alertEmail: alertEmail
    availabilityTestUrl: !isProd ? '' : (apexBound ? 'https://${dnsZoneName}/' : 'https://${app.outputs.staticWebAppHostname}/')
  }
}

// ---------- application resources ----------

module app 'app.bicep' = {
  name: 'app'
  scope: rg
  params: {
    baseName: baseName
    storageName: 'statlasrelay${env}${take(uniqueString(subscription().id, env), 6)}'
    location: location
    swaLocation: swaLocation
    stagingEnvironmentPolicy: stagingEnvironmentPolicy
    storageSharedKeyAccess: storageSharedKeyAccess
    operatorPrincipalId: operatorPrincipalId
    tags: tags
    githubClientId: signinGithubClientId
    githubClientSecret: signinGithubClientSecret
    microsoftClientId: signinMicrosoftClientId
    microsoftClientSecret: signinMicrosoftClientSecret
    googleClientId: signinGoogleClientId
    googleClientSecret: signinGoogleClientSecret
    orcidClientId: signinOrcidClientId
    orcidClientSecret: signinOrcidClientSecret
  }
}

// In the site's region: a linked backend is registered with the site's region.
module api 'api.bicep' = {
  name: 'api'
  scope: rg
  params: {
    baseName: baseName
    functionAppName: 'func-${baseName}-${take(uniqueString(subscription().id, env, 'api'), 6)}'
    hostStorageName: 'stfnatlasrelay${env}${take(uniqueString(subscription().id, env, 'api'), 4)}'
    location: swaLocation
    staticWebAppName: app.outputs.staticWebAppName
    dataStorageName: app.outputs.storageAccountName
    dataTableEndpoint: app.outputs.tableEndpoint
    dataTableNames: app.outputs.tableNames
    linkApi: linkApi
    appInsightsConnectionString: platform.outputs.appInsightsConnectionString
    additionalAppSettings: additionalAppSettings
    signinProviders: signinProviders
    tags: tags
  }
}

// ---------- CI role ----------

module rbac 'rbac.bicep' = {
  name: 'rbac'
  scope: rg
  params: {
    environmentName: env
    principalId: identity.outputs.principalId
    functionAppName: api.outputs.functionAppName
  }
}

// ---------- DNS ----------

module dns 'dns.bicep' = if (isProd && !empty(dnsZoneName)) {
  name: 'dns'
  scope: rg
  params: {
    zoneName: dnsZoneName
    ttl: dnsTtl
    staticWebAppDefaultHostname: app.outputs.staticWebAppHostname
    staticWebAppInboundIp: app.outputs.staticWebAppInboundIp
    apexTxtValues: concat(dnsApexTxtValues[?dnsZoneName] ?? [], empty(swaApexToken) ? [] : [swaApexToken])
    tags: tags
  }
}

module subdomain 'dns-subdomain.bicep' = if (!isProd && !empty(dnsZoneName)) {
  name: 'dns-subdomain'
  scope: resourceGroup(dnsZoneResourceGroup)
  params: {
    zoneName: dnsZoneName
    recordName: env
    target: app.outputs.staticWebAppHostname
    ttl: dnsTtl
  }
}

// ---------- full-flow test harness (not prod) ----------

module testharness 'testharness.bicep' = if (harness) {
  name: 'testharness'
  scope: rg
  params: {
    environmentName: env
    location: location
    // The site's own azurestaticapps.net hostname, not <env>.<domain>: it serves as soon as the site
    // exists, while a newly bound custom domain answered the platform's 404 on some requests for
    // hours (2026-10-01), which no test run should depend on.
    baseUrl: 'https://${app.outputs.staticWebAppHostname}'
    workspaceId: platform.outputs.workspaceId
    operatorPrincipalId: operatorPrincipalId
    tags: tags
  }
}

module testharnessRbac 'testharness-rbac.bicep' = if (harness) {
  name: 'testharness-rbac'
  scope: rg
  params: {
    environmentName: env
    principalId: identity.outputs.principalId
    resultsAccountName: testharness!.outputs.resultsAccountName
    resultsContainerName: testharness!.outputs.resultsContainerName
    locksContainerName: testharness!.outputs.locksContainerName
    registryName: testharness!.outputs.registryName
  }
}

// Output names are upper case: scripts/lib/env.sh saves them as settings under these names.
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_SUBSCRIPTION_ID string = subscription().subscriptionId
output CI_CLIENT_ID string = identity.outputs.clientId
output CI_PRINCIPAL_ID string = identity.outputs.principalId
output SWA_NAME string = app.outputs.staticWebAppName
output SWA_HOSTNAME string = app.outputs.staticWebAppHostname
output STORAGE_ACCOUNT string = app.outputs.storageAccountName
output FUNCTION_APP_NAME string = api.outputs.functionAppName
output FUNCTION_APP_HOSTNAME string = api.outputs.functionAppHostname
output FUNCTION_STORAGE_ACCOUNT string = api.outputs.hostStorageAccountName
output LOG_ANALYTICS_WORKSPACE string = platform.outputs.workspaceName
output APPINSIGHTS_NAME string = platform.outputs.appInsightsName
// Compiled into the browser bundle by the Deploy workflow (scripts/bootstrap.sh copies it to the
// repository variable APPINSIGHTS_CONNECTION_STRING). It names the ingestion endpoint and the
// instrumentation key; it is not a credential and is public once the site ships it.
output APPLICATIONINSIGHTS_CONNECTION_STRING string = platform.outputs.appInsightsConnectionString
output SITE_HOSTNAME string = siteHostname
// Set these as the domain's name servers at the registrar (prod only).
output NAME_SERVERS string = isProd && !empty(dnsZoneName) ? join(dns!.outputs.nameServers, ' ') : ''
// The full-flow test harness; empty when it is not deployed. scripts/bootstrap.sh copies them to
// the GitHub Environment's variables for e2e-dev.yml.
output E2E_JOB_NAME string = harness ? testharness!.outputs.jobName : ''
output E2E_KEY_VAULT_NAME string = harness ? testharness!.outputs.vaultName : ''
output E2E_RESULTS_ACCOUNT string = harness ? testharness!.outputs.resultsAccountName : ''
output E2E_RESULTS_CONTAINER string = harness ? testharness!.outputs.resultsContainerName : ''
output E2E_LOG_WORKSPACE_ID string = harness ? platform.outputs.workspaceCustomerId : ''
output E2E_REGISTRY string = harness ? testharness!.outputs.registryName : ''
