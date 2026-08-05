// Container platform: registry, logs, and the Container Apps environment.
//
// The environment uses a workload-profiles environment with only the Consumption profile. That
// keeps the platform bill proportional to actual replica seconds — a dedicated profile reserves
// capacity whether or not anything is running, which for a world that spends most of each minute
// idle would dominate the cost.

@description('Azure region.')
param location string

@description('Deterministic prefix shared by every resource in the deployment.')
param namePrefix string

@description('Globally unique container registry name (5-50 alphanumeric characters).')
@minLength(5)
@maxLength(50)
param containerRegistryName string

@description('Tags applied to every resource.')
param tags object

@description('Subnet delegated to Microsoft.App/environments.')
param infrastructureSubnetId string

@description('Days to retain workspace logs. Kept short; these are operational logs, not an audit store.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

@description('Daily ingestion cap in GB. A runaway log loop is a cost incident, so it is bounded.')
param logDailyQuotaGb int = 1

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${namePrefix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
    workspaceCapping: {
      dailyQuotaGb: logDailyQuotaGb
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: containerRegistryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    // Runtime identities authenticate with Entra and AcrPull. The admin user is a shared
    // username/password pair, which is exactly the kind of credential this deployment avoids.
    adminUserEnabled: false
    anonymousPullEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
    // Quarantine, content-trust and retention policies are Premium-tier features; a Basic
    // registry rejects any attempt to configure them (SkuNotSupported). Untagged-manifest
    // cleanup is therefore left to manual/out-of-band pruning rather than a registry policy,
    // which keeps the registry on the low-cost Basic tier the cost model depends on.
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${namePrefix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        // Ingestion uses the workspace shared key, which is a platform-managed wiring detail of
        // Container Apps and is not an Azure Storage credential. It is read from the workspace at
        // deploy time and never emitted as an output.
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      // The environment keeps a public ingress address so `world-web` is reachable without a
      // gateway; individual apps still choose whether they expose ingress at all, and the jobs
      // do not.
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

output logAnalyticsId string = logAnalytics.id
output logAnalyticsCustomerId string = logAnalytics.properties.customerId
output containerRegistryId string = containerRegistry.id
output containerRegistryName string = containerRegistry.name
output containerRegistryLoginServer string = containerRegistry.properties.loginServer
output environmentId string = containerAppsEnvironment.id
output environmentName string = containerAppsEnvironment.name
output environmentDefaultDomain string = containerAppsEnvironment.properties.defaultDomain
