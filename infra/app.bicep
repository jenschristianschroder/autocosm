// Autocosm applications.
//
// One public Container App and two scheduled Jobs, all from the same image, distinguished only by
// the argument passed to the entrypoint. Deployed after the image exists in the registry created
// by foundation.bicep.
//
//   az deployment group create -g <rg> --template-file infra/app.bicep \
//     --parameters namePrefix=autocosm containerImage=<registry>/autocosm:<sha>
//
// Shape of the cost: the web app scales to zero, both jobs are scheduled rather than resident, and
// each job exits as soon as its bounded work is done. Nothing here runs continuously.

targetScope = 'resourceGroup'

@description('Deterministic prefix for every resource name; must match the foundation deployment.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'autocosm'

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Environment label, used only for tagging.')
@allowed(['dev', 'test', 'prod'])
param environmentName string = 'prod'

@description('Fully qualified image reference, e.g. crautocosmabc12345.azurecr.io/autocosm:<sha>.')
param containerImage string

@description('Stable identifier of the world this deployment advances.')
param worldId string = 'autocosm'

@description('Seed for world generation. Changing it after first tick has no effect: the world already exists.')
param worldSeed int = 4242424

@description('Simulated ticks advanced per wall-clock minute.')
@minValue(1)
@maxValue(240)
param ticksPerMinute int = 4

@description('Hard ceiling on ticks in one job execution, so a long outage cannot produce an unbounded catch-up run.')
@minValue(1)
@maxValue(2000)
param maxTicksPerRun int = 60

@description('Cron schedule for the tick job. Once a minute is the intended cadence.')
param tickCron string = '*/1 * * * *'

@description('Cron schedule for the think job. Less frequent than the tick because model calls cost money.')
param thinkCron string = '*/5 * * * *'

@description('Decision provider. `heuristic` needs no Azure OpenAI deployment at all.')
@allowed(['heuristic', 'azure-openai'])
param decisionProvider string = 'heuristic'

@description('Azure OpenAI endpoint. A configuration value, never a secret. Empty when heuristic-only.')
param azureOpenAiEndpoint string = ''

@description('Azure OpenAI deployment name. A configuration value, never a secret.')
param azureOpenAiDeployment string = ''

@description('Ceiling on model-backed decisions per think execution.')
@minValue(1)
@maxValue(200)
param maxDecisionsPerRun int = 12

@description('Ceiling on model-backed decisions per day across the whole world.')
@minValue(1)
@maxValue(20000)
param maxDecisionsPerDay int = 600

@description('Maximum completion tokens per decision.')
@minValue(64)
@maxValue(4096)
param maxCompletionTokens int = 320

@description('Maximum replicas for the web app. Snapshots are cached, so a small number absorbs a lot of readers.')
@minValue(1)
@maxValue(10)
param webMaxReplicas int = 3

@description('New lineages one anonymous creator may author per day.')
@minValue(1)
@maxValue(50)
param maxAgentsPerCreatorPerDay int = 3

@description('Broad goals one anonymous creator may submit per day.')
@minValue(1)
@maxValue(200)
param maxGoalsPerCreatorPerDay int = 6

@description('''
Key used to sign the anonymous creator cookie. When empty, a stable value is derived from the
resource group and subscription so creator identities survive a redeployment. Supply your own from
a GitHub environment secret if you would rather it not be derivable by anyone with ARM read access.
Either way this is prototype identity, not account ownership — see docs/security.md.
''')
@secure()
param creatorSigningKey string = ''

var tags = {
  application: 'autocosm'
  environment: environmentName
  managedBy: 'bicep'
}

// Recomputed exactly as in foundation.bicep so this template can be deployed independently.
var uniqueSuffix = take(uniqueString(resourceGroup().id), 8)
var storageAccountName = take('st${namePrefix}${uniqueSuffix}', 24)
var containerRegistryName = take('cr${namePrefix}${uniqueSuffix}', 50)

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: containerRegistryName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: 'cae-${namePrefix}'
}

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-${namePrefix}-web'
}

resource tickIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-${namePrefix}-tick'
}

resource thinkIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-${namePrefix}-think'
}

// The ordinary table service endpoint. Inside the VNet, private DNS resolves it to the private
// endpoint; there is no SAS, no key and no connection string anywhere in this template.
var tableEndpoint = storageAccount.properties.primaryEndpoints.table
var registryServer = containerRegistry.properties.loginServer

// Deriving the fallback from the resource group means the cookie survives a redeployment, which
// `newGuid()` would not, and keeps it out of source control, which a literal would not. It is
// still prototype identity: anyone with ARM read access to this group can recompute it. See
// docs/security.md.
var signingKey = empty(creatorSigningKey)
  ? '${uniqueString(resourceGroup().id, 'autocosm-creator-1')}${uniqueString(subscription().subscriptionId, namePrefix, 'autocosm-creator-2')}'
  : creatorSigningKey

// ------------------------------------------------------------------------------------------------
// world-web — the only externally reachable component.
// ------------------------------------------------------------------------------------------------
resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${namePrefix}-web'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${webIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        // The browser is served from this same origin, so no cross-origin policy is needed and
        // none is configured. Adding one would only widen the surface.
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registryServer
          identity: webIdentity.id
        }
      ]
      secrets: [
        {
          name: 'creator-signing-key'
          value: signingKey
        }
      ]
      maxInactiveRevisions: 2
    }
    template: {
      containers: [
        {
          name: 'web'
          image: containerImage
          args: ['web']
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AUTOCOSM_MODE', value: 'web' }
            { name: 'AUTOCOSM_WORLD_ID', value: worldId }
            { name: 'AUTOCOSM_WORLD_SEED', value: string(worldSeed) }
            { name: 'AUTOCOSM_STORAGE_DRIVER', value: 'azureTables' }
            { name: 'AUTOCOSM_LOG_LEVEL', value: 'info' }
            { name: 'AZURE_TABLE_ENDPOINT', value: tableEndpoint }
            { name: 'AZURE_CLIENT_ID', value: webIdentity.properties.clientId }
            { name: 'AUTOCOSM_DECISION_PROVIDER', value: decisionProvider }
            { name: 'AUTOCOSM_MAX_AGENTS_PER_DAY', value: string(maxAgentsPerCreatorPerDay) }
            { name: 'AUTOCOSM_MAX_GOALS_PER_DAY', value: string(maxGoalsPerCreatorPerDay) }
            { name: 'AUTOCOSM_SNAPSHOT_CACHE_SECONDS', value: '2' }
            { name: 'AUTOCOSM_RATE_LIMIT_PER_MINUTE', value: '240' }
            { name: 'AUTOCOSM_CREATOR_SIGNING_KEY', secretRef: 'creator-signing-key' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/v1/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/v1/readiness'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        // Scale to zero. Nobody is watching most of the time, and the world advances in the tick
        // job regardless of whether anyone has the page open.
        minReplicas: 0
        maxReplicas: webMaxReplicas
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '40'
              }
            }
          }
        ]
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// world-tick — advances authoritative state. No ingress.
// ------------------------------------------------------------------------------------------------
resource tick 'Microsoft.App/jobs@2024-03-01' = {
  name: 'cj-${namePrefix}-tick'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${tickIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      // Comfortably longer than AUTOCOSM_TICK_BUDGET_MS so the process finishes its own bounded
      // work and exits, rather than being killed mid-write.
      replicaTimeout: 240
      // A retry would re-run a tick that may already have committed. The tick is idempotent by
      // deterministic id and watermark, but the cheaper and clearer answer is to let the next
      // scheduled execution catch up.
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: tickCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registryServer
          identity: tickIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'tick'
          image: containerImage
          args: ['tick']
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AUTOCOSM_MODE', value: 'tick' }
            { name: 'AUTOCOSM_WORLD_ID', value: worldId }
            { name: 'AUTOCOSM_WORLD_SEED', value: string(worldSeed) }
            { name: 'AUTOCOSM_STORAGE_DRIVER', value: 'azureTables' }
            { name: 'AUTOCOSM_LOG_LEVEL', value: 'info' }
            { name: 'AZURE_TABLE_ENDPOINT', value: tableEndpoint }
            { name: 'AZURE_CLIENT_ID', value: tickIdentity.properties.clientId }
            { name: 'AUTOCOSM_TICKS_PER_MINUTE', value: string(ticksPerMinute) }
            { name: 'AUTOCOSM_MAX_TICKS_PER_RUN', value: string(maxTicksPerRun) }
            { name: 'AUTOCOSM_TICK_BUDGET_MS', value: '45000' }
            { name: 'AUTOCOSM_TICK_LEASE_MS', value: '90000' }
            { name: 'AUTOCOSM_SEED_IF_MISSING', value: 'true' }
          ]
        }
      ]
    }
  }
}

// ------------------------------------------------------------------------------------------------
// agent-think — drains the decision queue. No ingress. Exits immediately when nothing is claimable.
// ------------------------------------------------------------------------------------------------
resource think 'Microsoft.App/jobs@2024-03-01' = {
  name: 'cj-${namePrefix}-think'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${thinkIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 300
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: thinkCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registryServer
          identity: thinkIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'think'
          image: containerImage
          args: ['think']
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          // The two Azure OpenAI variables are always declared and may be empty: the app config
          // treats a blank variable as unset, so an empty value here means "heuristic only"
          // rather than "misconfigured endpoint".
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AUTOCOSM_MODE', value: 'think' }
            { name: 'AUTOCOSM_WORLD_ID', value: worldId }
            { name: 'AUTOCOSM_STORAGE_DRIVER', value: 'azureTables' }
            { name: 'AUTOCOSM_LOG_LEVEL', value: 'info' }
            { name: 'AZURE_TABLE_ENDPOINT', value: tableEndpoint }
            { name: 'AZURE_CLIENT_ID', value: thinkIdentity.properties.clientId }
            { name: 'AUTOCOSM_DECISION_PROVIDER', value: decisionProvider }
            { name: 'AUTOCOSM_MAX_DECISIONS_PER_RUN', value: string(maxDecisionsPerRun) }
            { name: 'AUTOCOSM_MAX_DECISIONS_PER_DAY', value: string(maxDecisionsPerDay) }
            { name: 'AUTOCOSM_MAX_COMPLETION_TOKENS', value: string(maxCompletionTokens) }
            { name: 'AUTOCOSM_THINK_BUDGET_MS', value: '50000' }
            { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAiEndpoint }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: azureOpenAiDeployment }
          ]
        }
      ]
    }
  }
}

@description('Public hostname of the observatory.')
output webFqdn string = web.properties.configuration.ingress.fqdn

@description('Public URL of the observatory.')
output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'

@description('Name of the scheduled tick job, for `az containerapp job start`.')
output tickJobName string = tick.name

@description('Name of the scheduled think job, for `az containerapp job start`.')
output thinkJobName string = think.name
