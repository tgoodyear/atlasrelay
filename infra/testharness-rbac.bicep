// What the CI identity may do with the full-flow test harness (non-prod environments only), a
// module of infra/main.bicep. The workflow e2e-dev.yml builds the test image in the environment's
// registry, starts the test job with it, waits for the execution, reads the job's logs and
// downloads the results. That is all this grants:
//
// - a custom role on the registry: read it, upload a build context, queue a build or a run (ACR
//   Tasks), read its status, output image and log, and cancel it. No push or pull of its own, no
//   registry settings, no tokens. Besides the test image, the workflow uses it to run the Static
//   Web Apps upload client, and cancels that run when it stops early;
// - a custom role on the resource group: read the job, start it, read and stop its executions,
//   and query the two Container Apps log tables in the workspace (table-level read, so none of the
//   site's telemetry);
// - Storage Blob Data Reader on the results container;
// - Storage Blob Data Contributor on the locks container, to take, renew and release the lease
//   that keeps one run at a time on the environment. The container holds that one blob.
//
// The workflow also deploys the commit's site and API to the environment before it tests them;
// the roles in rbac.bicep, which every environment's CI identity has, cover the API and the
// site's deployment token, and the builder role covers the run that uploads the site.
//
// No role on the Key Vault, control plane or data: CI cannot read, list or change the test
// accounts or RIPE Atlas keys, open the vault's network, or grant itself access. It cannot change
// the job's definition or identity either. It can build any image and start the job with it, and
// that image then runs as the test identity; docs/ARCHITECTURE.md says why that is accepted.
targetScope = 'resourceGroup'

@description('Environment name, part of the role name (role names are unique per tenant)')
param environmentName string

@description('Object id of the CI identity')
param principalId string

@description('Name of the results storage account')
param resultsAccountName string

@description('Name of the results container')
param resultsContainerName string

@description('Name of the container that holds the full-flow lock')
param locksContainerName string

@description('Name of the container registry that holds the test image')
param registryName string

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: registryName
}

resource builderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, 'atlasrelay-e2e-image-builder')
  properties: {
    roleName: 'Atlas Relay e2e image builder (${environmentName})'
    description: 'Build the Atlas Relay full-flow test image and run the site upload in the registry with ACR Tasks, and read or cancel those runs.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.ContainerRegistry/registries/read'
          'Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action'
          'Microsoft.ContainerRegistry/registries/scheduleRun/action'
          'Microsoft.ContainerRegistry/registries/runs/read'
          'Microsoft.ContainerRegistry/registries/runs/listLogSasUrl/action'
          'Microsoft.ContainerRegistry/registries/runs/cancel/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

// On the registry only.
resource builderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, principalId, builderRole.id)
  properties: {
    roleDefinitionId: builderRole.id
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'GitHub Actions (OIDC) builds the full-flow test image'
  }
}

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

    resource locks 'containers' existing = {
      name: locksContainerName
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

var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource holdLock 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: results::blobs::locks
  name: guid(results::blobs::locks.id, principalId, storageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributor)
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'GitHub Actions (OIDC) takes, renews and releases the full-flow lock'
  }
}
