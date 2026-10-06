// Atlas Relay: the operator's Key Vault Secrets Officer role on the sign-in vault (resource-group
// scope), a module of infra/signin.bicep.
//
// A module of its own so that scripts/lib/env.sh can deploy it alone, for a vault recovered after a
// teardown: a recovered vault comes back without its role assignments, and the operator has to
// read it before the stack can be deployed (docs/RUNBOOK.md, "Rebuilding a torn-down
// environment"). Both deployments give the assignment the same name, so the stack's next
// deployment takes over the one the script made instead of colliding with it.
targetScope = 'resourceGroup'

@description('The sign-in vault (signin.bicep)')
param vaultName string

@description('Object id of the operator who registers the apps and writes their secrets (scripts/register-signin.sh)')
param operatorPrincipalId string

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

// Built-in role. https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/security
var keyVaultSecretsOfficer = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

// The name was guid(vault.id, operatorPrincipalId, keyVaultSecretsOfficer) in signin.bicep before
// this module existed; it must not change, or a deployment would try to add a second assignment
// of the same role at the same scope, which Azure refuses.
resource operatorWritesSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorPrincipalId, keyVaultSecretsOfficer)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsOfficer
    principalId: operatorPrincipalId
    principalType: 'User'
    description: 'Operator: writes the sign-in client secrets (scripts/register-signin.sh)'
  }
}
