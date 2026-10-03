// The CanNotDelete management lock on prod's resource group. Table Storage has no soft delete, so
// this keeps the site's data from going with a stray group or account delete. It was put on by hand
// on 2026-10-02 and is declared here with the same name, level and notes, so the stack adopts it.
//
// It blocks every delete in the group, the stack's own included: a deployment that drops a
// resource from the templates fails while the lock is on. docs/RUNBOOK.md, "Changing
// infrastructure", has the steps (remove the lock, deploy without it, deploy again).
targetScope = 'resourceGroup'

@description('Name of the lock')
param name string

@description('Why the lock is there, shown with it in the portal and by az lock list')
param notes string

resource lock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: name
  properties: {
    level: 'CanNotDelete'
    notes: notes
  }
}
