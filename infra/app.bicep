// Atlas Credit Exchange – application resources (resource-group scope).
// Deployed by main.bicep (bootstrap) and by the Infrastructure workflow on every merge to main
// with the CI identity, whose custom role covers only deployments, static sites and storage.
// Monitoring and the budget live in platform.bicep (Owner-only) and are referenced here read-only.
targetScope = 'resourceGroup'

@description('Base name used for resources')
@minLength(3)
@maxLength(20)
param baseName string = 'internetresearch'

@description('Region for the storage account')
param location string = resourceGroup().location

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

@description('Allow pull-request preview environments. Off: only production is deployed.')
@allowed([
  'Enabled'
  'Disabled'
])
param stagingEnvironmentPolicy string = 'Disabled'

@description('Wire APPLICATIONINSIGHTS_CONNECTION_STRING from the App Insights resource created by platform.bicep')
param enableApplicationInsights bool = true

@description('Name of the App Insights resource created by platform.bicep')
param appInsightsName string = 'appi-${baseName}'

@description('Which storage key the API uses (0 = key1, 1 = key2). Flip during key rotation for zero downtime.')
@allowed([
  0
  1
])
param storageKeyIndex int = 0

@description('Extra app settings merged into the managed-functions configuration. Bicep is the only writer of app settings.')
param additionalAppSettings object = {}

@description('Tags applied to every resource')
param tags object = {}

var suffix = toLower(uniqueString(resourceGroup().id))
var storageName = toLower(take('st${replace(baseName, '-', '')}${suffix}', 24))
var swaName = 'swa-${baseName}'
var tableNames = [
  'users'
  'projects'
  'pledges'
]

// ---------- data ----------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    // Managed SWA functions have no managed identity, so the API authenticates with a key.
    allowSharedKeyAccess: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [
  for t in tableNames: {
    parent: tableService
    name: t
  }
]

// ---------- monitoring (created by platform.bicep; read-only here) ----------

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = if (enableApplicationInsights) {
  name: appInsightsName
}

// ---------- web + api ----------

resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: swaName
  location: swaLocation
  tags: tags
  sku: {
    name: swaSku
    tier: swaSku
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: stagingEnvironmentPolicy
    // No repository link: our own GitHub Actions workflow deploys with the deployment token,
    // which avoids Azure generating and committing a workflow file.
  }
}

// App settings for the managed Functions API. This resource REPLACES the whole settings map,
// so every setting must be declared here (or passed via additionalAppSettings).
var baseAppSettings = {
  TABLES_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[storageKeyIndex].value};EndpointSuffix=${environment().suffixes.storage}'
  ATLAS_API_BASE: 'https://atlas.ripe.net/api/v2'
}
var monitoringAppSettings = enableApplicationInsights
  ? {
      APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights!.properties.ConnectionString
    }
  : {}

resource swaSettings 'Microsoft.Web/staticSites/config@2024-04-01' = {
  parent: swa
  name: 'appsettings'
  properties: union(baseAppSettings, monitoringAppSettings, additionalAppSettings)
}

output storageAccountName string = storage.name
output staticWebAppName string = swa.name
output staticWebAppHostname string = swa.properties.defaultHostname
// Address the platform serves this site on, used for the apex A record (Azure DNS alias records
// cannot target a static site, so the apex needs a real address). Read through reference()
// because the Bicep type for staticSites does not declare stableInboundIP, though the API
// returns it; contains() keeps a first-ever deployment working before one is assigned.
// The symbol form (swa.properties.stableInboundIP) fails type checking because the property is
// absent from the Bicep type, so reference() is deliberate here.
#disable-next-line use-resource-symbol-reference
var swaRuntime = reference(swa.id, '2024-04-01')
output staticWebAppInboundIp string = contains(swaRuntime, 'stableInboundIP') ? string(swaRuntime.stableInboundIP) : ''
