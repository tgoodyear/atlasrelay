// Atlas Credit Exchange – application resources (resource-group scope).
// Deployed by main.bicep (bootstrap) and by the Infrastructure workflow on every merge to main.
// Contains nothing that needs Microsoft.Authorization or Microsoft.ManagedIdentity write access.
targetScope = 'resourceGroup'

@description('Base name used for resources')
@minLength(3)
@maxLength(20)
param baseName string = 'internetresearch'

@description('Region for storage and monitoring')
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

@description('Application Insights + Log Analytics for API logs (free tier, daily cap enforced)')
param enableApplicationInsights bool = true

@description('Daily ingestion cap for Log Analytics in GB (0.1 GB/day ≈ 3 GB/month, inside the 5 GB free allowance)')
param logDailyCapGb string = '0.1'

@description('Extra app settings merged into the managed-functions configuration. Bicep is the only writer of app settings.')
param additionalAppSettings object = {}

@description('Monthly budget (alerts only) in USD for the resource group')
param budgetAmount int = 120

@description('Email that receives budget alerts')
param budgetContactEmail string

@description('First day of the budget period (YYYY-MM-01). Must be the current month on first creation; reuse the existing value afterwards.')
param budgetStartDate string

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

// ---------- monitoring (optional, free tier) ----------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (enableApplicationInsights) {
  name: 'log-${baseName}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json(logDailyCapGb)
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = if (enableApplicationInsights) {
  name: 'appi-${baseName}'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    IngestionMode: 'LogAnalytics'
    RetentionInDays: 30
    DisableLocalAuth: false
  }
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
  TABLES_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
  ATLAS_API_BASE: 'https://atlas.ripe.net/api/v2'
}
// appInsights is conditional; the ternary guards the reference, "!" tells Bicep it is non-null there.
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

// ---------- cost guardrail (alerts only; the subscription spending limit is the hard stop) ----------

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${baseName}-monthly'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      actual50: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [budgetContactEmail]
      }
      actual80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [budgetContactEmail]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [budgetContactEmail]
      }
    }
  }
}

output storageAccountName string = storage.name
output staticWebAppName string = swa.name
output staticWebAppHostname string = swa.properties.defaultHostname
output appInsightsName string = enableApplicationInsights ? appInsights!.name : ''
