// Autocosm foundation.
//
// Everything that must exist before there is an image to run: network, private storage, registry,
// logs, the Container Apps environment, and the three workload identities with their narrowly
// scoped data-plane roles.
//
// Deployment is deliberately split in two. `foundation.bicep` creates the registry; the image is
// then built into that registry; only then can `app.bicep` create Container Apps that reference
// the image. Collapsing the two would make the registry depend on an image that depends on the
// registry.
//
//   az deployment group create -g <rg> --template-file infra/foundation.bicep \
//     --parameters namePrefix=autocosm
//
// No secret is accepted as a parameter and no secret is produced as an output.

targetScope = 'resourceGroup'

@description('Deterministic prefix for every resource name. Lowercase letters and digits.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'autocosm'

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Environment label, used only for tagging.')
@allowed(['dev', 'test', 'prod'])
param environmentName string = 'prod'

@description('Optional existing Azure OpenAI account name in this resource group. Leave empty to run the world on the deterministic heuristic provider.')
param azureOpenAiAccountName string = ''

// Azure requires globally unique names for storage accounts and registries, but a redeployment
// must land on the same resources, so the suffix is derived from the resource group rather than
// from anything random.
var uniqueSuffix = take(uniqueString(resourceGroup().id), 8)
var storageAccountName = take('st${namePrefix}${uniqueSuffix}', 24)
var containerRegistryName = take('cr${namePrefix}${uniqueSuffix}', 50)

var tags = {
  application: 'autocosm'
  environment: environmentName
  managedBy: 'bicep'
}

// Must match TABLE_NAMES in packages/storage/src/azure-repository.ts. tests/infra/policy.test.ts
// imports that constant and fails if the two ever drift.
var allTables = [
  'worlds'
  'regions'
  'agents'
  'lineages'
  'lineagenodes'
  'organisms'
  'structures'
  'materials'
  'resources'
  'memories'
  'signals'
  'goals'
  'events'
  'decisions'
  'control'
]

// The observer boundary, expressed as permissions. The web app can read the parts of the world an
// observer is allowed to see, and can write only the two authoring artefacts plus its own quota
// and idempotency bookkeeping. It cannot write an organism, a structure or an event, so even a
// remote code execution in the public process cannot fabricate world state.
var webReadTables = [
  'worlds'
  'regions'
  'lineagenodes'
  'organisms'
  'structures'
  'materials'
  'resources'
  'memories'
  'signals'
  'events'
]
var webWriteTables = [
  'agents'
  'lineages'
  'goals'
  'control'
]

// The tick job is the sole authority over world state, so it writes everything.
var tickWriteTables = allTables

// The thinker receives an agent's permitted observation already embedded in the decision record,
// so it needs no access to the world itself — only to the queue it drains and the quota it must
// respect.
var thinkWriteTables = [
  'decisions'
  'control'
]

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    namePrefix: namePrefix
    storageAccountName: storageAccountName
    tags: tags
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    tablePrivateDnsZoneId: network.outputs.tablePrivateDnsZoneId
    tableNames: allTables
  }
}

module platform 'modules/platform.bicep' = {
  name: 'platform'
  params: {
    location: location
    namePrefix: namePrefix
    containerRegistryName: containerRegistryName
    tags: tags
    infrastructureSubnetId: network.outputs.infrastructureSubnetId
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    storageAccountName: storage.outputs.storageAccountName
    webReadTables: webReadTables
    webWriteTables: webWriteTables
    tickWriteTables: tickWriteTables
    thinkWriteTables: thinkWriteTables
    containerRegistryName: platform.outputs.containerRegistryName
    azureOpenAiAccountName: azureOpenAiAccountName
  }
}

@description('Login server for the container registry, e.g. crautocosmabc12345.azurecr.io.')
output registryLoginServer string = platform.outputs.containerRegistryLoginServer

@description('Container registry resource name, for `az acr build --registry`.')
output registryName string = platform.outputs.containerRegistryName

@description('Table service endpoint. Resolves to a private address inside the VNet. Not a SAS URL.')
output tableEndpoint string = storage.outputs.tableEndpoint

@description('Storage account name. No key or connection string is emitted.')
output storageAccountName string = storage.outputs.storageAccountName

@description('Container Apps environment resource id, consumed by app.bicep.')
output environmentId string = platform.outputs.environmentId

@description('Default ingress domain for the environment.')
output environmentDefaultDomain string = platform.outputs.environmentDefaultDomain

@description('Client id of the web workload identity, set as AZURE_CLIENT_ID on the web app.')
output webClientId string = identity.outputs.webClientId

@description('Client id of the tick workload identity.')
output tickClientId string = identity.outputs.tickClientId

@description('Client id of the think workload identity.')
output thinkClientId string = identity.outputs.thinkClientId
