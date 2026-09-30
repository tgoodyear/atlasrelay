// Full-flow test harness (non-prod environments only), a module of infra/main.bicep.
//
// The Container Apps job caj-atlasrelay-<env>-e2e runs the Playwright suite in e2e-real/ against
// the environment's site. It signs two test accounts in through the real Microsoft sign-in page,
// with passwords it reads from a Key Vault that has no public network access: the job reaches the
// vault through a private endpoint in this virtual network, as the test identity. The results
// (a JSON summary, the Playwright report, screenshots and traces, redacted) go to a blob container
// that only identities can read. The CI identity starts the job and reads the results; it has no
// role on the vault. docs/RUNBOOK.md, "Full-flow tests on dev".
//
//   vnet-atlasrelay-<env>          snet-cae (delegated to the Container Apps environment),
//                                  snet-pe (private endpoints)
//   privatelink.vaultcore.azure.net, linked to the network
//   kv-atlasrelay-<env>-<suffix>   RBAC, public network access disabled, private endpoint (the
//                                  suffix fills the name to 24 characters: 6 for dev)
//   id-atlasrelay-<env>-e2e        Key Vault Secrets User on the vault, Blob Data Contributor on
//                                  the results container
//   stare2e<env><6>/results        test results; Entra ID only, no shared keys
//   cae-atlasrelay-<env>           workload-profiles environment (Consumption), in snet-cae
//   caj-atlasrelay-<env>-e2e       manual job, one replica, 20 minutes, no retry
targetScope = 'resourceGroup'

@description('Environment name, e.g. dev')
param environmentName string

param location string = resourceGroup().location

@description('The site the tests run against, e.g. https://dev.atlasrelay.org')
param baseUrl string

@description('Resource id of the environment\'s Log Analytics workspace; the job\'s console and system logs go there')
param workspaceId string

@description('''Image the job runs when started without an override. The workflow e2e-dev.yml starts
every run with the image it has just built, pinned by digest, so this only matters for a start
from the portal.''')
param image string = 'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'

@description('Object id of the person who writes the test accounts into the vault (scripts/set-test-users.sh). Empty: nobody gets write access.')
param operatorPrincipalId string = ''

param tags object = {}

var baseName = 'atlasrelay-${environmentName}'
var suffix = uniqueString(subscription().id, environmentName)
// scripts/set-test-users.sh writes these names, and e2e-real/run.mjs reads them.
var secretNames = {
  researcherUsername: 'e2e-researcher-username'
  researcherPassword: 'e2e-researcher-password'
  researcherTotp: 'e2e-researcher-totp'
  donorUsername: 'e2e-donor-username'
  donorPassword: 'e2e-donor-password'
  donorTotp: 'e2e-donor-totp'
}
var resultsContainer = 'results'

// ---------- network ----------

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-${baseName}'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: ['10.60.0.0/24']
    }
    subnets: [
      {
        // A workload-profiles environment needs a /27 or larger, delegated to it.
        name: 'snet-cae'
        properties: {
          addressPrefix: '10.60.0.0/27'
          delegations: [
            {
              name: 'containerapps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
          // The job signs in at login.microsoftonline.com and loads the site, both on the internet.
          defaultOutboundAccess: true
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '10.60.0.32/28'
          privateEndpointNetworkPolicies: 'Disabled'
          defaultOutboundAccess: false
        }
      }
    ]
  }
}

resource vaultZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
  tags: tags
}

resource vaultZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: vaultZone
  name: vnet.name
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

// ---------- vault ----------

// Soft delete is always on; retention is the 7-day minimum. Purge protection stays off (it cannot
// be switched off once on): the vault holds only test-account passwords, which can be reset in
// the test tenant, and the vault's name is fixed per environment, so scripts/teardown.sh purges the
// deleted vault to let the environment be bootstrapped again the same day. Against accidental
// deletion the stack's deny settings already apply.
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kv-${baseName}-${suffix}', 24)
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
    // scripts/set-test-users.sh opens it to the operator's address for the few seconds it writes,
    // then closes it again. The next deployment closes it too.
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource vaultEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${baseName}-kv'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/snet-pe'
    }
    privateLinkServiceConnections: [
      {
        name: 'vault'
        properties: {
          privateLinkServiceId: vault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource vaultEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: vaultEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: vaultZone.id
        }
      }
    ]
  }
}

// ---------- identity and results ----------

resource testIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${baseName}-e2e'
  location: location
  tags: tags
}

resource results 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stare2e${environmentName}${take(suffix, 6)}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Entra ID only. The workflow downloads from a GitHub-hosted runner, so the endpoint is public.
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
  }

  resource blobs 'blobServices' = {
    name: 'default'

    resource container 'containers' = {
      name: resultsContainer
      properties: {
        publicAccess: 'None'
      }
    }
  }

  resource lifecycle 'managementPolicies' = {
    name: 'default'
    properties: {
      policy: {
        rules: [
          {
            name: 'expire-runs'
            enabled: true
            type: 'Lifecycle'
            definition: {
              filters: {
                blobTypes: ['blockBlob']
                prefixMatch: ['${resultsContainer}/runs/']
              }
              actions: {
                baseBlob: {
                  delete: {
                    daysAfterModificationGreaterThan: 30
                  }
                }
              }
            }
          }
        ]
      }
    }
  }
}

var roles = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

resource testReadsSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, testIdentity.id, roles.keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
    principalId: testIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'The full-flow test job reads the test accounts'
  }
}

resource operatorWritesSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  scope: vault
  name: guid(vault.id, operatorPrincipalId, roles.keyVaultSecretsOfficer)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
    principalId: operatorPrincipalId
    description: 'scripts/set-test-users.sh writes the test accounts'
  }
}

resource testWritesResults 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: results::blobs::container
  name: guid(results::blobs::container.id, testIdentity.id, roles.storageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    principalId: testIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'The full-flow test job uploads its results'
  }
}

// ---------- container apps ----------

resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${baseName}'
  location: location
  tags: tags
  properties: {
    // Consumption only: no dedicated profile, so nothing is billed while no job runs.
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: {
      infrastructureSubnetId: '${vnet.id}/subnets/snet-cae'
      // No app in the environment takes requests; internal keeps it off the internet.
      internal: true
    }
    // Logs go through the diagnostic setting below, not the workspace's shared key.
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    zoneRedundant: false
  }
}

resource caeLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: cae
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'ContainerAppConsoleLogs'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs'
        enabled: true
      }
    ]
  }
}

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-${baseName}-e2e'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${testIdentity.id}': {}
    }
  }
  properties: {
    environmentId: cae.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      // The suite takes a few minutes; a hung sign-in page should not hold a replica for longer.
      replicaTimeout: 1200
      // A failed run is reported, not repeated: a retry would sign in and write to the site again.
      replicaRetryLimit: 0
    }
    template: {
      containers: [
        {
          name: 'e2e'
          image: image
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            { name: 'BASE_URL', value: baseUrl }
            { name: 'KEY_VAULT_URI', value: vault.properties.vaultUri }
            // Selects the test identity at the managed identity endpoint.
            { name: 'AZURE_CLIENT_ID', value: testIdentity.properties.clientId }
            { name: 'RESULTS_CONTAINER_URL', value: '${results.properties.primaryEndpoints.blob}${resultsContainer}' }
            { name: 'E2E_RESEARCHER_USERNAME_SECRET', value: secretNames.researcherUsername }
            { name: 'E2E_RESEARCHER_PASSWORD_SECRET', value: secretNames.researcherPassword }
            { name: 'E2E_RESEARCHER_TOTP_SECRET', value: secretNames.researcherTotp }
            { name: 'E2E_DONOR_USERNAME_SECRET', value: secretNames.donorUsername }
            { name: 'E2E_DONOR_PASSWORD_SECRET', value: secretNames.donorPassword }
            { name: 'E2E_DONOR_TOTP_SECRET', value: secretNames.donorTotp }
          ]
        }
      ]
    }
  }
  dependsOn: [
    // The first run must find the vault's private DNS record and both role assignments.
    vaultEndpointDns
    vaultZoneLink
    testReadsSecrets
    testWritesResults
  ]
}

output jobName string = job.name
output vaultName string = vault.name
output resultsAccountName string = results.name
output resultsContainerName string = resultsContainer
output resultsContainerId string = results::blobs::container.id
