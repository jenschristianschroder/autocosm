// Storage: one account, Table service only, reachable exclusively through a private endpoint.
//
// Every one of the following is a hard invariant asserted by tests/infra/policy.test.ts against
// the compiled ARM JSON, because each is a single-property change away from silently exposing the
// authoritative world:
//
//   publicNetworkAccess      Disabled  — no traffic from outside the VNet, ever
//   networkAcls.defaultAction Deny     — belt and braces if public access is re-enabled
//   networkAcls.bypass       None      — "trusted Azure services" is not a trust boundary here
//   allowSharedKeyAccess     false     — the account keys cannot authorise anything
//   allowBlobPublicAccess    false     — no anonymous container can exist
//   supportsHttpsTrafficOnly true
//   minimumTlsVersion        TLS1_2

@description('Azure region for the storage account.')
param location string

@description('Globally unique storage account name (3-24 lowercase alphanumeric characters).')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Deterministic prefix shared by every resource in the deployment.')
param namePrefix string

@description('Tags applied to every resource.')
param tags object

@description('Subnet that hosts the Table private endpoint.')
param privateEndpointSubnetId string

@description('Private DNS zone for privatelink.table.<storage suffix>.')
param tablePrivateDnsZoneId string

@description('Table names created up front. Workload identities hold data-plane roles only and cannot create tables themselves.')
param tableNames array

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publicNetworkAccess: 'Disabled'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    defaultToOAuthAuthentication: true
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    accessTier: 'Hot'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
    encryption: {
      requireInfrastructureEncryption: false
      keySource: 'Microsoft.Storage'
      services: {
        table: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

// Declaring the tables here rather than creating them at runtime is what makes narrow RBAC
// possible: creating a table is a control-plane write, and no workload identity is granted one.
resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [
  for name in tableNames: {
    parent: tableService
    name: name
  }
]

resource tablePrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${namePrefix}-table'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'table'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: ['table']
        }
      }
    ]
  }
}

resource tableDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: tablePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'table'
        properties: {
          privateDnsZoneId: tablePrivateDnsZoneId
        }
      }
    ]
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
// The ordinary service endpoint, not a SAS URL. It resolves to a private address inside the VNet
// because of the private DNS zone; from anywhere else it resolves but refuses to connect.
output tableEndpoint string = storageAccount.properties.primaryEndpoints.table
