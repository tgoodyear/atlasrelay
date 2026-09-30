// What CI may do in an environment, and nothing else:
//   - on the resource group: read the static web app and its linked backend, and list the site's
//     deployment token, which the Deploy workflow hands to the upload action;
//   - on the Function App only: read it and publish a package to it.
// The stack deploys every resource (scripts/bootstrap.sh, scripts/provision.sh, run by a
// subscription Owner), so CI needs no deployment, storage, monitoring, DNS, identity or role
// assignment rights. It cannot read or change the Function App's settings or keys either.
targetScope = 'resourceGroup'

@description('Environment name, part of the role names (role names are unique per tenant)')
param environmentName string

@description('Object id of the CI identity')
param principalId string

@description('The Function App CI publishes the API to (api.bicep)')
param functionAppName string

resource ciRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, 'atlasrelay-ci-deployer')
  properties: {
    roleName: 'Atlas Relay CI Deployer (${environmentName})'
    description: 'Read the Atlas Relay static web app and its linked backend, and list its deployment token.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.Resources/subscriptions/resourceGroups/read'
          'Microsoft.Web/staticSites/read'
          // Which Function App serves /api: the Deploy workflow publishes the API there, and
          // refuses to upload the site when there is none.
          'Microsoft.Web/staticSites/linkedBackends/read'
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

resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionAppName
}

// Publishing goes through the app's deployment endpoint (/api/publish on its scm host) with a
// Microsoft Entra token, which that endpoint accepts from holders of sites/publish/Action.
resource apiRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, 'atlasrelay-ci-api-deployer')
  properties: {
    roleName: 'Atlas Relay CI API Deployer (${environmentName})'
    description: 'Read the Atlas Relay Function App and publish a package to it.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.Web/sites/read'
          'Microsoft.Web/sites/publish/Action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource apiAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(functionApp.id, principalId, apiRole.id)
  scope: functionApp
  properties: {
    roleDefinitionId: apiRole.id
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'GitHub Actions (OIDC) publishes the API package'
  }
}

output roleDefinitionId string = ciRole.id
output apiRoleDefinitionId string = apiRole.id
