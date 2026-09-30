// What the CI identity may do with the full-flow test harness (non-prod environments only), a
// module of infra/main.bicep. The workflow e2e-dev.yml starts the test job with the image it has
// just built, waits for the execution, reads the job's logs and downloads the results. That is
// all this grants:
//
// - a custom role on the resource group: read the job, start it, read and stop its executions,
//   and query the two Container Apps log tables in the workspace (table-level read, so none of the
//   site's telemetry);
// - Storage Blob Data Reader on the results container.
//
// No role on the Key Vault, control plane or data: CI cannot read, list or change the test
// accounts, open the vault's network, or grant itself access. It cannot change the job's
// definition or identity either. It can start the job with another image, which then runs as the
// test identity; docs/ARCHITECTURE.md says why that is accepted.
targetScope = 'resourceGroup'

@description('Environment name, part of the role name (role names are unique per tenant)')
param environmentName string

@description('Object id of the CI identity')
param principalId string

@description('Name of the results storage account')
param resultsAccountName string

@description('Name of the results container')
param resultsContainerName string

resource runnerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, 'atlasrelay-e2e-runner')
  properties: {
    roleName: 'Atlas Relay e2e runner (${environmentName})'
    description: 'Start the Atlas Relay full-flow test job, follow its executions and read its logs.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.Resources/subscriptions/resourceGroups/read'
          'Microsoft.App/jobs/read'
          'Microsoft.App/jobs/start/action'
          'Microsoft.App/jobs/executions/read'
          'Microsoft.App/jobs/execution/read'
          'Microsoft.App/jobs/stop/action'
          'Microsoft.App/jobs/stop/execution/action'
          // Table-level read: the job's console and system logs, nothing else in the workspace.
          'Microsoft.OperationalInsights/workspaces/read'
          'Microsoft.OperationalInsights/workspaces/query/read'
          'Microsoft.OperationalInsights/workspaces/query/ContainerAppConsoleLogs/read'
          'Microsoft.OperationalInsights/workspaces/query/ContainerAppSystemLogs/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

// On the group, like the role's assignable scope. The group holds one job and one workspace.
resource runnerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, runnerRole.id)
  properties: {
    roleDefinitionId: runnerRole.id
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'GitHub Actions (OIDC) runs the full-flow tests'
  }
}

resource results 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: resultsAccountName

  resource blobs 'blobServices' existing = {
    name: 'default'

    resource container 'containers' existing = {
      name: resultsContainerName
    }
  }
}

var storageBlobDataReader = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

resource readResults 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: results::blobs::container
  name: guid(results::blobs::container.id, principalId, storageBlobDataReader)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReader)
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'GitHub Actions (OIDC) downloads the full-flow test results'
  }
}
