// Atlas Relay: application resources (resource-group scope), a module of infra/main.bicep.
// Storage with the tables the API uses, and the static web app. The API itself, a Function App
// linked to the site, is in api.bicep.
targetScope = 'resourceGroup'

@description('Base name used for resources, e.g. atlasrelay-prod')
param baseName string

@description('Storage account name: 3-24 lowercase letters and digits, unique in Azure')
@minLength(3)
@maxLength(24)
param storageName string

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

@description('Allow pull-request preview environments. Off: only production is deployed.')
@allowed([
  'Enabled'
  'Disabled'
])
param stagingEnvironmentPolicy string = 'Disabled'

@description('''Accept the storage account key. Off: only Microsoft Entra identities can reach the data.
Leave off: the API and operators sign in with Entra ID and nothing reads the key.''')
param storageSharedKeyAccess bool = false

@description('Object id of the Owner who works on the tables by hand (moderation, exports). Empty: nobody.')
param operatorPrincipalId string = ''

@description('Tags applied to every resource')
param tags object = {}

// The site's own sign-in registrations (docs/RUNBOOK.md, "Google and ORCID sign-in"). A provider
// whose id or secret is empty gets no settings. Which providers the site offers is decided by the
// build (web/src/lib/signin.ts), which names these settings in staticwebapp.config.json.
@description('Client id of the site\'s own GitHub OAuth app. Empty: none.')
param githubClientId string = ''
@secure()
@description('Client secret of that GitHub OAuth app')
param githubClientSecret string = ''
@description('Application (client) id of the site\'s own Microsoft Entra app registration. Empty: none.')
param microsoftClientId string = ''
@secure()
@description('Client secret of that Entra app registration')
param microsoftClientSecret string = ''
@description('Client id of the site\'s Google OAuth client. Empty: none.')
param googleClientId string = ''
@secure()
@description('Client secret of that Google OAuth client')
param googleClientSecret string = ''
@description('Client id of the site\'s ORCID public API client (APP-...). Empty: none.')
param orcidClientId string = ''
@secure()
@description('Client secret of that ORCID client')
param orcidClientSecret string = ''

var swaName = 'swa-${baseName}'
var tableNames = [
  'users'
  'projects'
  'pledges'
  // One row per (project, donor) holding that donor's single live-pledge slot. Creating a row is
  // the only atomic operation Table Storage offers, and it is what stops two concurrent requests
  // both transferring credits.
  'claims'
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
    // The API signs in with its managed identity (api.bicep) and operators with their own
    // account, so nothing needs the key.
    allowSharedKeyAccess: storageSharedKeyAccess
    defaultToOAuthAuthentication: true
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

// Storage Table Data Contributor, for the Owner who closes a project or exports data by hand
// (docs/RUNBOOK.md, Operations). Owner on the subscription grants no data access on its own.
var tableDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')

resource operatorTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  name: guid(storage.id, operatorPrincipalId, tableDataContributor)
  scope: storage
  properties: {
    roleDefinitionId: tableDataContributor
    principalId: operatorPrincipalId
    principalType: 'User'
    description: 'Operator: read and change table rows by hand (moderation, exports)'
  }
}

// ---------- web ----------

// Standard, because only Standard can link a Function App as the API (api.bicep).
resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: swaName
  location: swaLocation
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: stagingEnvironmentPolicy
    // No repository link: our own GitHub Actions workflow deploys with the deployment token,
    // which avoids Azure generating and committing a workflow file.
  }
}

// The site's only app settings are the sign-in registrations above; the API reads its settings
// from the Function App. Deployed even when empty, so that clearing a registration's settings
// removes them from the site. This writes the whole set: nothing else may add site settings.
var signinSettings = union(
  empty(githubClientId) || empty(githubClientSecret) ? {} : {
    SIGNIN_GITHUB_CLIENT_ID: githubClientId
    SIGNIN_GITHUB_CLIENT_SECRET: githubClientSecret
  },
  empty(microsoftClientId) || empty(microsoftClientSecret) ? {} : {
    SIGNIN_MICROSOFT_CLIENT_ID: microsoftClientId
    SIGNIN_MICROSOFT_CLIENT_SECRET: microsoftClientSecret
  },
  empty(googleClientId) || empty(googleClientSecret) ? {} : {
    SIGNIN_GOOGLE_CLIENT_ID: googleClientId
    SIGNIN_GOOGLE_CLIENT_SECRET: googleClientSecret
  },
  empty(orcidClientId) || empty(orcidClientSecret) ? {} : {
    SIGNIN_ORCID_CLIENT_ID: orcidClientId
    SIGNIN_ORCID_CLIENT_SECRET: orcidClientSecret
  }
)

resource swaSettings 'Microsoft.Web/staticSites/config@2024-04-01' = {
  parent: swa
  name: 'appsettings'
  properties: signinSettings
}

// Custom domains are not declared here. Static Web Apps validates a binding against public DNS,
// after the registrar delegates the zone, which happens between deployments; the apex also needs
// a token the service issues only once the binding is requested. scripts/bind-custom-domain.sh
// makes the bindings and records the apex token as a setting, and dns.bicep publishes it.

output storageAccountName string = storage.name
output tableEndpoint string = storage.properties.primaryEndpoints.table
output tableNames string[] = tableNames
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
