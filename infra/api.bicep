// Atlas Relay: the API (resource-group scope), a module of infra/main.bicep.
//
// A Function App on the Flex Consumption plan, linked to the static web app as its backend, so
// the site serves it at /api. It signs in to storage with a user-assigned managed identity:
//   - its own host storage account (Functions runtime state and the deployment package), and
//   - the four tables in the data account (app.bicep), one role assignment per table.
// No storage account the app uses accepts shared keys, so no key exists anywhere in its settings.
//
// Linking puts an identity provider named "Azure Static Web Apps (Linked)" on the Function App,
// which refuses any request the site did not send. Until the link exists (linkApi false, only
// while an environment moves off managed functions) the app is public, so it ignores the
// x-ms-client-principal header and treats every request as anonymous (api/src/lib/auth.ts).
targetScope = 'resourceGroup'

@description('Base name used for resources, e.g. atlasrelay-prod')
param baseName string

@description('Function App name, unique in Azure (it is part of the app\'s hostname), at most 32 characters')
@maxLength(32)
param functionAppName string

@description('Host storage account name: 3-24 lowercase letters and digits, unique in Azure')
@minLength(3)
@maxLength(24)
param hostStorageName string

param location string = resourceGroup().location

@description('The static web app this API is linked to (app.bicep)')
param staticWebAppName string

@description('Data storage account (app.bicep) and its tables')
param dataStorageName string
param dataTableEndpoint string
param dataTableNames string[]

@description('''Link the Function App to the static web app. Off only while checking a new app
directly before it takes over /api; an unlinked app answers every request as anonymous.''')
param linkApi bool = true

@description('App Insights connection string. Empty leaves telemetry off.')
param appInsightsConnectionString string = ''

@description('Extra app settings for the Function App. Bicep is the only writer of its app settings.')
param additionalAppSettings object = {}

param tags object = {}

// Built-in roles. https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/storage
var blobDataOwner = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
var tableDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')

var deploymentContainerName = 'deployments'

// ---------- identity ----------

// User-assigned rather than system-assigned so its role assignments exist before the app does:
// the host reads its storage as it starts, and an app created first would fail until they landed.
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${baseName}-api'
  location: location
  tags: tags
}

// ---------- host storage ----------

// Separate from the data account, so the roles the Functions host needs (blob owner, table
// contributor for its diagnostic events) never reach the tables that hold user data.
resource hostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: hostStorageName
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
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource hostBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: hostStorage
  name: 'default'
}

// Flex Consumption runs the app from a package in this container.
resource deployments 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: hostBlobs
  name: deploymentContainerName
}

// What the Functions host needs from AzureWebJobsStorage, per
// https://learn.microsoft.com/azure/azure-functions/manage-connections (host-required storage):
// Storage Blob Data Owner, and Storage Table Data Contributor for the diagnostic events it writes
// when it cannot start. Blob Data Owner also covers the deployment container. The API has only
// HTTP triggers, so no queue role.
resource hostBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, apiIdentity.id, blobDataOwner)
  scope: hostStorage
  properties: {
    roleDefinitionId: blobDataOwner
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Functions host storage and the deployment package'
  }
}

resource hostTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, apiIdentity.id, tableDataContributor)
  scope: hostStorage
  properties: {
    roleDefinitionId: tableDataContributor
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'Functions host diagnostic events'
  }
}

// ---------- data access ----------

resource dataStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: dataStorageName

  resource tableService 'tableServices' existing = {
    name: 'default'
  }
}

resource dataTables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = [
  for t in dataTableNames: {
    parent: dataStorage::tableService
    name: t
  }
]

// Rows in the API's four tables, and nothing else in the account: no other table, and no blobs,
// queues or files. The API does not create tables in Azure; Bicep does (app.bicep).
resource apiTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (t, i) in dataTableNames: {
    name: guid(dataTables[i].id, apiIdentity.id, tableDataContributor)
    scope: dataTables[i]
    properties: {
      roleDefinitionId: tableDataContributor
      principalId: apiIdentity.properties.principalId
      principalType: 'ServicePrincipal'
      description: 'API: rows in the ${t} table'
    }
  }
]

// ---------- Function App ----------

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'plan-${baseName}-api'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${apiIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      minTlsVersion: '1.2'
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${hostStorage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: apiIdentity.id
          }
        }
      }
      // On demand only: no always-ready instances, so an idle API costs nothing. The ceiling
      // bounds what a flood of requests can cost.
      scaleAndConcurrency: {
        maximumInstanceCount: 10
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
  }
  dependsOn: [
    deployments
    hostBlobOwner
    hostTables
  ]
}

// Deployments authenticate with Microsoft Entra only (the CI role in rbac.bicep); no publishing
// password exists.
resource ftpCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: functionApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource scmCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: functionApp
  name: 'scm'
  properties: {
    allow: false
  }
}

// ---------- link ----------

resource swa 'Microsoft.Web/staticSites@2024-04-01' existing = {
  name: staticWebAppName
}

// Named after the Function App, as `az staticwebapp backends link` names it. The site then
// proxies /api/* to the app with the signed-in user's x-ms-client-principal, and the route rules
// in staticwebapp.config.json apply before the request leaves the site.
resource link 'Microsoft.Web/staticSites/linkedBackends@2024-04-01' = if (linkApi) {
  parent: swa
  name: functionApp.name
  properties: {
    backendResourceId: functionApp.id
    region: location
  }
}

// ---------- app settings ----------

var baseAppSettings = {
  // Host storage by identity: https://learn.microsoft.com/azure/azure-functions/manage-connections
  AzureWebJobsStorage__accountName: hostStorage.name
  AzureWebJobsStorage__credential: 'managedidentity'
  AzureWebJobsStorage__clientId: apiIdentity.properties.clientId
  // The API's own storage client (api/src/lib/tables.ts).
  TABLES_ENDPOINT: dataTableEndpoint
  AZURE_CLIENT_ID: apiIdentity.properties.clientId
  ATLAS_API_BASE: 'https://atlas.ripe.net/api/v2'
}
var monitoringAppSettings = empty(appInsightsConnectionString)
  ? {}
  : {
      APPLICATIONINSIGHTS_CONNECTION_STRING: appInsightsConnectionString
    }
var unlinkedAppSettings = linkApi ? {} : { IGNORE_CLIENT_PRINCIPAL: '1' }

// This resource REPLACES the whole settings map, so every setting is declared here (or passed in
// additionalAppSettings). It waits for the link: on the deployment that links the app, the header
// is honoured only once the identity provider in front of the app is in place.
resource appSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: union(baseAppSettings, monitoringAppSettings, unlinkedAppSettings, additionalAppSettings)
  dependsOn: [
    link
    apiTables
  ]
}

output functionAppName string = functionApp.name
output functionAppId string = functionApp.id
output functionAppHostname string = functionApp.properties.defaultHostName
output hostStorageAccountName string = hostStorage.name
output identityClientId string = apiIdentity.properties.clientId
