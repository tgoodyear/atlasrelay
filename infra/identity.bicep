// CI identity for GitHub Actions: a user-assigned managed identity with a federated credential.
// It trusts only jobs that run in the repository's GitHub Environment named after this
// environment (the Deploy workflow's deploy job uses "prod"), and scripts/bootstrap.sh restricts
// that GitHub Environment to the main branch. The CI role has no ManagedIdentity write
// permission, so a compromised workflow run cannot re-federate this identity elsewhere.
targetScope = 'resourceGroup'

param identityName string
param location string = resourceGroup().location

@description('GitHub OIDC subject prefix, e.g. repo:OWNER@OWNER-ID/REPO@REPO-ID')
param githubOidcSubjectPrefix string

@description('GitHub Environment whose jobs may use this identity, e.g. prod')
param githubEnvironment string

param tags object = {}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource ficEnvironment 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'github-${githubEnvironment}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: '${githubOidcSubjectPrefix}:environment:${githubEnvironment}'
    audiences: ['api://AzureADTokenExchange']
  }
}

output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId
output identityId string = identity.id
