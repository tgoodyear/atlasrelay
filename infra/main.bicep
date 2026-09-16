// Atlas Credit Exchange – all resources for one environment.
// Scope: resource group. Deploy with `az deployment group create`.
targetScope = 'resourceGroup'

@description('Base name used for resources')
@minLength(3)
@maxLength(20)
param baseName string = 'internetresearch'

@description('Region for the storage account. The static web app uses swaLocation.')
param location string = resourceGroup().location

@description('Static Web Apps is only offered in a handful of regions.')
@allowed([
  'westus2'
  'centralus'
  'eastus2'
  'westeurope'
  'eastasia'
])
param swaLocation string = 'eastus2'

@description('Free or Standard. Standard ($9/mo) unlocks custom OIDC providers.')
@allowed([
  'Free'
  'Standard'
])
param swaSku string = 'Free'

@description('Monthly budget cap in USD for the resource group')
param budgetAmount int = 120

@description('Email that receives budget alerts')
param budgetContactEmail string

@description('First day of the budget period (YYYY-MM-01). Must be current or future month start.')
param budgetStartDate string

var suffix = toLower(uniqueString(resourceGroup().id))
var storageName = toLower(take('st${replace(baseName, '-', '')}${suffix}', 24))
var swaName = 'swa-${baseName}'
var tableNames = [
  'users'
  'projects'
  'pledges'
]

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: true // managed SWA functions cannot use managed identity
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-01-01' = {
  parent: storage
  name: 'default'
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = [
  for t in tableNames: {
    parent: tableService
    name: t
  }
]

resource swa 'Microsoft.Web/staticSites@2022-09-01' = {
  name: swaName
  location: swaLocation
  sku: {
    name: swaSku
    tier: swaSku
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
    // Deployments come from our own GitHub Actions workflow using the deployment token,
    // so no repository link is configured here (avoids Azure generating a workflow file).
  }
  tags: {
    project: 'atlas-credit-exchange'
  }
}

// Storage connection string for the managed API. listKeys runs at deployment time.
resource swaSettings 'Microsoft.Web/staticSites/config@2022-09-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    TABLES_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    ATLAS_API_BASE: 'https://atlas.ripe.net/api/v2'
  }
}

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
      at50: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [budgetContactEmail]
      }
      at80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [budgetContactEmail]
      }
      at100Forecast: {
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
