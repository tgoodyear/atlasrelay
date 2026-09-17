// Owner-only: role assignment for the CI identity and delete locks on the stateful/critical
// resources. Kept out of app.bicep so CI never needs Microsoft.Authorization write permissions.
targetScope = 'resourceGroup'

@description('Object id of the CI identity')
param principalId string

@description('Full resource id of the role definition to assign')
param roleDefinitionId string

@description('Storage account to protect with a CanNotDelete lock')
param storageAccountName string

@description('Static web app to protect with a CanNotDelete lock')
param staticWebAppName string

resource ciAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, roleDefinitionId)
  properties: {
    roleDefinitionId: roleDefinitionId
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'GitHub Actions (OIDC) deploys infra/app.bicep and reads the Static Web App deployment token'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource storageLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: 'no-delete'
  scope: storage
  properties: {
    level: 'CanNotDelete'
    notes: 'Holds all user, project and pledge data. Remove the lock deliberately before deleting.'
  }
}

resource swa 'Microsoft.Web/staticSites@2024-04-01' existing = {
  name: staticWebAppName
}

resource swaLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: 'no-delete'
  scope: swa
  properties: {
    level: 'CanNotDelete'
    notes: 'Production site. Remove the lock deliberately before deleting.'
  }
}
