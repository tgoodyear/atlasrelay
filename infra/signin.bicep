// Atlas Relay: the site's own sign-in registrations (resource-group scope), a module of
// infra/main.bicep. See "Sign-in providers" in docs/ARCHITECTURE.md and "Sign-in registrations"
// in docs/RUNBOOK.md.
//
// The client secrets live in a Key Vault, one per environment, written by
// scripts/register-signin.sh and never by a deployment. The static web app reads them with its
// system-assigned identity through Key Vault references in its app settings
// (https://learn.microsoft.com/azure/static-web-apps/key-vault-secrets). The references name the
// secret without a version, so a rotated secret needs no deployment. Client ids are not secret
// and are plain app settings.
targetScope = 'resourceGroup'

@description('Base name used for resources, e.g. atlasrelay-prod')
param baseName string

@description('Region for the vault')
param location string = resourceGroup().location

@description('The static web app that signs people in')
param staticWebAppName string

@description('Object id of the static web app\'s system-assigned identity')
param staticWebAppPrincipalId string

@description('Object id of the Owner who registers the apps and writes their secrets (scripts/register-signin.sh). Empty: nobody.')
param operatorPrincipalId string = ''

@description('Log Analytics workspace that receives the vault\'s audit log')
param workspaceId string

@description('''Client ids of the site's own registrations, keyed github, aad, google, orcid. A provider
with an empty id gets no app settings. Its secret must be in the vault under the name in secretNames.''')
param clientIds object = {}

param tags object = {}

// The vault's secret names, one per provider. scripts/register-signin.sh writes these.
var secretNames = {
  github: 'signin-github-client-secret'
  aad: 'signin-microsoft-client-secret'
  google: 'signin-google-client-secret'
  orcid: 'signin-orcid-client-secret'
}
// The app setting names staticwebapp.config.json reads (web/src/lib/signin.ts, APP_SETTINGS).
var settingNames = {
  github: 'SIGNIN_GITHUB'
  aad: 'SIGNIN_MICROSOFT'
  google: 'SIGNIN_GOOGLE'
  orcid: 'SIGNIN_ORCID'
}

// Purge protection is on: a deleted vault, and the secrets in it, can be recovered for the
// retention period and cannot be purged by anyone before it ends. scripts/lib/env.sh recovers a
// deleted vault of this name before a deployment, so an environment rebuilt within the period
// gets its registrations back. Access is by Azure RBAC only. Public network access stays on:
// Static Web Apps reads the secrets from outside any virtual network.
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  // kvs-atlasrelay-prod-xxxx: Key Vault names are global and 24 characters at most.
  name: take('kvs-${baseName}-${uniqueString(resourceGroup().id, 'signin')}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Who read or wrote which secret, kept with the rest of the environment's logs.
resource vaultAudit 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'audit'
  scope: vault
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        category: 'AuditEvent'
        enabled: true
      }
    ]
  }
}

// Built-in roles. https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/security
var keyVaultSecretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var keyVaultSecretsOfficer = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource siteReadsSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, staticWebAppName, keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUser
    principalId: staticWebAppPrincipalId
    principalType: 'ServicePrincipal'
    description: 'The static web app reads its sign-in client secrets'
  }
}

resource operatorWritesSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  name: guid(vault.id, operatorPrincipalId, keyVaultSecretsOfficer)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsOfficer
    principalId: operatorPrincipalId
    principalType: 'User'
    description: 'Operator: writes the sign-in client secrets (scripts/register-signin.sh)'
  }
}

resource swa 'Microsoft.Web/staticSites@2024-04-01' existing = {
  name: staticWebAppName
}

// Built from the name rather than read from the vault, so that it is known before the vault exists
// and can be used inside the lambdas below (they cannot read a resource's runtime properties).
var vaultUri = 'https://${vault.name}${environment().suffixes.keyvaultDns}/'
var providers = [for p in items(secretNames): p.key]
var configured = filter(providers, p => !empty(clientIds[?p] ?? ''))
var settings = reduce(
  map(configured, p => {
    '${settingNames[p]}_CLIENT_ID': clientIds[p]
    '${settingNames[p]}_CLIENT_SECRET': '@Microsoft.KeyVault(SecretUri=${vaultUri}secrets/${secretNames[p]}/)'
  }),
  {},
  (all, one) => union(all, one)
)

// The site's whole set of app settings: this resource replaces it. Deployed even when empty, so
// that clearing a client id removes its settings. It waits for the role, so the site can read
// the secrets the settings point at as soon as they appear.
resource swaSettings 'Microsoft.Web/staticSites/config@2024-04-01' = {
  parent: swa
  name: 'appsettings'
  properties: settings
  dependsOn: [
    siteReadsSecrets
  ]
}

output vaultName string = vault.name
output providers string = join(configured, ',')
