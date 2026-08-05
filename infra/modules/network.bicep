// Network foundation.
//
// Two subnets and nothing else. Container Apps needs a delegated infrastructure subnet, and the
// Storage private endpoint needs a subnet that is *not* delegated. There is deliberately no NAT
// Gateway, Azure Firewall, VPN Gateway or Application Gateway: each is a fixed hourly cost, and
// none is required for a workload whose only inbound path is Container Apps' own ingress and
// whose only outbound Azure dependency is a private endpoint inside this VNet.

@description('Azure region for all network resources.')
param location string

@description('Deterministic prefix shared by every resource in the deployment.')
param namePrefix string

@description('Tags applied to every resource.')
param tags object

@description('Address space for the virtual network.')
param addressSpace string = '10.20.0.0/22'

// Container Apps on a workload-profiles environment requires at least a /27. A /23 is used here
// so replica scale-out and platform-reserved addresses never exhaust the subnet during an
// upgrade, which is the usual cause of a stuck revision.
@description('Address range for the Container Apps infrastructure subnet. Must be /27 or larger.')
param infrastructureSubnetPrefix string = '10.20.0.0/23'

@description('Address range for the private-endpoint subnet.')
param privateEndpointSubnetPrefix string = '10.20.2.0/24'

var infrastructureSubnetName = 'snet-infra'
var privateEndpointSubnetName = 'snet-private-endpoints'

resource networkSecurityGroup 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-${namePrefix}-pe'
  location: location
  tags: tags
  properties: {
    // The private-endpoint subnet holds no compute and originates no traffic. Inbound is limited
    // to the VNet itself; nothing on the internet has any business reaching a private endpoint.
    securityRules: [
      {
        name: 'deny-inbound-internet'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-${namePrefix}'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [addressSpace]
    }
    subnets: [
      {
        name: infrastructureSubnetName
        properties: {
          addressPrefix: infrastructureSubnetPrefix
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: privateEndpointSubnetName
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          networkSecurityGroup: {
            id: networkSecurityGroup.id
          }
          // Required for the private endpoint NIC to receive a stable address in this subnet.
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

// Only the Table service is private-linked. Blob and Queue endpoints are deliberately absent:
// the MVP stores nothing in them, and an unused private endpoint is both a monthly charge and a
// path that would need reviewing.
resource tablePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.table.${environment().suffixes.storage}'
  location: 'global'
  tags: tags
}

resource tableDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: tablePrivateDnsZone
  name: 'link-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

output virtualNetworkId string = virtualNetwork.id
output infrastructureSubnetId string = '${virtualNetwork.id}/subnets/${infrastructureSubnetName}'
output privateEndpointSubnetId string = '${virtualNetwork.id}/subnets/${privateEndpointSubnetName}'
output tablePrivateDnsZoneId string = tablePrivateDnsZone.id
output tablePrivateDnsZoneName string = tablePrivateDnsZone.name
