// What CI may do in an environment: read the static web app and list its deployment token, which
// the Deploy workflow hands to the upload action. Nothing else. The stack deploys every resource
// (scripts/bootstrap.sh, scripts/provision.sh, run by a subscription Owner), so CI needs no
// deployment, storage, monitoring, DNS, identity or role assignment rights.
targetScope = 'resourceGroup'

@description('Environment name, part of the role name (role names are unique per tenant)')
param environmentName string

@description('Object id of the CI identity')
param principalId string

resource ciRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, 'atlasrelay-ci-deployer')
  properties: {
    roleName: 'Atlas Relay CI Deployer (${environmentName})'
    description: 'Read the Atlas Relay static web app and list its deployment token.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.Resources/subscriptions/resourceGroups/read'
          'Microsoft.Web/staticSites/read'
          // az staticwebapp secrets list
          'Microsoft.Web/staticSites/listSecrets/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

// Assigned on the group, like the role's assignable scope: azure/login selects the subscription
// after signing in, which needs an assignment it can see from there. The group holds one static
// web app, and the role grants nothing on anything else in it.
resource ciAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, ciRole.id)
  properties: {
    roleDefinitionId: ciRole.id
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'GitHub Actions (OIDC) reads the Static Web App deployment token'
  }
}

output roleDefinitionId string = ciRole.id
