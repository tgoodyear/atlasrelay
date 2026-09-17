// CI identity for GitHub Actions: a user-assigned managed identity with federated credentials.
// Deployed only from main.bicep (subscription Owner). The CI role has no ManagedIdentity write
// permission, so a compromised workflow run cannot re-federate this identity elsewhere.
targetScope = 'resourceGroup'

param identityName string
param location string = resourceGroup().location

@description('GitHub OIDC subject prefix, e.g. repo:OWNER@OWNER-ID/REPO@REPO-ID')
param githubOidcSubjectPrefix string

param enablePullRequestFederation bool = false
param tags object = {}

var githubIssuer = 'https://token.actions.githubusercontent.com'
var githubAudience = 'api://AzureADTokenExchange'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

// Federated credentials on one identity must be written sequentially (dependsOn below).
resource ficMain 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'github-main'
  properties: {
    issuer: githubIssuer
    subject: '${githubOidcSubjectPrefix}:ref:refs/heads/main'
    audiences: [githubAudience]
  }
}

resource ficPullRequest 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (enablePullRequestFederation) {
  parent: identity
  name: 'github-pull-request'
  properties: {
    issuer: githubIssuer
    subject: '${githubOidcSubjectPrefix}:pull_request'
    audiences: [githubAudience]
  }
  dependsOn: [ficMain]
}

output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId
output identityId string = identity.id
