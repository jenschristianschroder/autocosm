// Workload identities and their data-plane role assignments.
//
// Three separate user-assigned identities, one per runtime mode, so a compromise of the public web
// process does not carry the simulation's write rights. Assignments are scoped to *individual
// tables*, not the storage account, which is the narrowest scope Azure Table data-plane RBAC
// supports.
//
// The resulting privilege matrix is asserted in tests/infra/policy.test.ts. In particular:
//   - `web` has no access at all to the `decisions` table (pending AI work is not observer data)
//   - `think` sees only `decisions` and `control`; an agent's observation is embedded in the
//     decision record, so the thinker never needs to read organisms, structures or memories
//   - only `think` is granted the Azure OpenAI inference role
//   - none of the three can create a table, and none holds a control-plane role on the account

@description('Azure region for the identities.')
param location string

@description('Deterministic prefix shared by every resource in the deployment.')
param namePrefix string

@description('Tags applied to every resource.')
param tags object

@description('Name of the storage account holding the world tables.')
param storageAccountName string

@description('Tables the web app may read but never write.')
param webReadTables array

@description('Tables the web app may write: creation and goal authoring, quotas, idempotency.')
param webWriteTables array

@description('Tables the tick job may write. The simulation is the only authority over world state.')
param tickWriteTables array

@description('Tables the think job may write: claims and proposals only.')
param thinkWriteTables array

@description('Tables the admin inspector may read. Reader across the store, minus the one it writes.')
param adminReadTables array

@description('Tables the admin inspector may write. Narrow: only the control table (runtime settings).')
param adminWriteTables array

@description('Container registry name, for AcrPull. Pull only — no runtime identity may push.')
param containerRegistryName string

@description('Azure OpenAI account name, or empty when the deployment is heuristic-only.')
param azureOpenAiAccountName string = ''

// Built-in role definition IDs. Hard-coded because they are stable Azure GUIDs; resolving them by
// name at deploy time would require a data-plane lookup this template cannot make.
var storageTableDataReader = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '76199698-9eea-4c19-bc75-cec21354c6b6'
)
var storageTableDataContributor = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
)
var acrPull = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var cognitiveServicesOpenAiUser = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
)

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-web'
  location: location
  tags: tags
}

resource tickIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-tick'
  location: location
  tags: tags
}

resource thinkIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-think'
  location: location
  tags: tags
}

// The inspector: read-only across every table, no write role anywhere, and no inference role.
resource adminIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-admin'
  location: location
  tags: tags
}

// One flat list so the table-scoped assignments can be expressed as a single loop. The loop
// expression must be resolvable before the deployment starts, so it carries a symbolic owner and
// role name rather than the principal ids, which are only known once the identities exist.
var grants = concat(
  map(webReadTables, table => { table: table, role: 'reader', owner: 'web' }),
  map(webWriteTables, table => { table: table, role: 'contributor', owner: 'web' }),
  map(tickWriteTables, table => { table: table, role: 'contributor', owner: 'tick' }),
  map(thinkWriteTables, table => { table: table, role: 'contributor', owner: 'think' }),
  map(adminReadTables, table => { table: table, role: 'reader', owner: 'admin' }),
  map(adminWriteTables, table => { table: table, role: 'contributor', owner: 'admin' })
)

resource grantScopes 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = [
  for grant in grants: {
    name: '${storageAccountName}/default/${grant.table}'
  }
]

resource tableGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (grant, index) in grants: {
    scope: grantScopes[index]
    name: guid(resourceGroup().id, storageAccountName, grant.table, grant.owner, grant.role)
    properties: {
      roleDefinitionId: grant.role == 'reader' ? storageTableDataReader : storageTableDataContributor
      principalId: grant.owner == 'web'
        ? webIdentity.properties.principalId
        : (grant.owner == 'tick'
            ? tickIdentity.properties.principalId
            : (grant.owner == 'think'
                ? thinkIdentity.properties.principalId
                : adminIdentity.properties.principalId))
      principalType: 'ServicePrincipal'
    }
  }
]

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: containerRegistryName
}

// Pull only. No runtime identity is given AcrPush, so a compromised workload cannot replace the
// image it and its siblings run.
var pullOwners = ['web', 'tick', 'think', 'admin']

resource registryPulls 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for owner in pullOwners: {
    scope: containerRegistry
    name: guid(containerRegistry.id, owner, acrPull)
    properties: {
      roleDefinitionId: acrPull
      principalId: owner == 'web'
        ? webIdentity.properties.principalId
        : (owner == 'tick'
            ? tickIdentity.properties.principalId
            : (owner == 'think'
                ? thinkIdentity.properties.principalId
                : adminIdentity.properties.principalId))
      principalType: 'ServicePrincipal'
    }
  }
]

resource azureOpenAi 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (azureOpenAiAccountName != '') {
  name: azureOpenAiAccountName
}

// Only the thinker calls a model. The web app and the tick job have no inference rights at all,
// so a bug in either cannot spend model tokens.
resource thinkerInference 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (azureOpenAiAccountName != '') {
  scope: azureOpenAi
  name: guid(resourceGroup().id, azureOpenAiAccountName, thinkIdentity.id, cognitiveServicesOpenAiUser)
  properties: {
    roleDefinitionId: cognitiveServicesOpenAiUser
    principalId: thinkIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output webIdentityId string = webIdentity.id
output webClientId string = webIdentity.properties.clientId
output webPrincipalId string = webIdentity.properties.principalId

output tickIdentityId string = tickIdentity.id
output tickClientId string = tickIdentity.properties.clientId
output tickPrincipalId string = tickIdentity.properties.principalId

output thinkIdentityId string = thinkIdentity.id
output thinkClientId string = thinkIdentity.properties.clientId
output thinkPrincipalId string = thinkIdentity.properties.principalId

output adminIdentityId string = adminIdentity.id
output adminClientId string = adminIdentity.properties.clientId
output adminPrincipalId string = adminIdentity.properties.principalId
