# Operations

Everything in this document is written to be run. Nothing here has been executed against a real
Azure subscription — no resources were created and no money was spent — so treat the deployment
section as a validated definition plus exact commands rather than as a field-tested runbook.

---

## 1. Deployment

### Prerequisites

- An Azure subscription and a resource group you can deploy to.
- Azure CLI 2.60+ with the Bicep CLI (`az bicep install`).
- `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.Storage`, `Microsoft.Network` and
  `Microsoft.OperationalInsights` registered on the subscription.
- Permission to create role assignments in the resource group (Owner or User Access Administrator).
  The foundation creates data-plane role assignments; without this right it will fail partway.

### Step 0 — validate locally, before touching Azure

```bash
npm run infra:build
```

Compiles `foundation.bicep` and `app.bicep` to `infra/.build/*.json` and runs 48 policy assertions
against the generated ARM. If this fails, do not deploy.

### Step 1 — the foundation

```bash
az group create -n rg-autocosm -l eastus

az deployment group create \
  --resource-group rg-autocosm \
  --name autocosm-foundation \
  --template-file infra/foundation.bicep \
  --parameters namePrefix=autocosm environmentName=prod
```

Creates: VNet + two subnets + NSG, private DNS zone and link, the storage account with all 15 tables
and its Table private endpoint, Log Analytics, ACR Basic, the Container Apps environment, and the
three managed identities with their table-scoped role assignments.

Expect 8–12 minutes, dominated by the Container Apps environment.

Capture the outputs:

```bash
az deployment group show -g rg-autocosm -n autocosm-foundation \
  --query properties.outputs -o json
```

You get `registryLoginServer`, `registryName`, `tableEndpoint`, `storageAccountName`,
`environmentId`, `environmentDefaultDomain`, `webClientId`, `tickClientId`, `thinkClientId`. None is
a secret.

### Step 2 — build the image inside Azure

```bash
az acr build \
  --registry <registryName> \
  --image autocosm:$(git rev-parse --short HEAD) \
  --file Dockerfile .
```

`az acr build` runs the build on ACR Tasks, so you need neither local Docker nor a registry
password. The registry has `adminUserEnabled: false` and `anonymousPullEnabled: false`; the build
authenticates with your own Entra token and the runtime identities pull with `AcrPull`.

### Step 3 — the applications

```bash
az deployment group create \
  --resource-group rg-autocosm \
  --name autocosm-app \
  --template-file infra/app.bicep \
  --parameters \
      namePrefix=autocosm \
      containerImage=<registryLoginServer>/autocosm:<sha> \
      decisionProvider=heuristic
```

Creates `ca-autocosm-web` (external ingress, `minReplicas: 0`), `cj-autocosm-tick` (cron
`*/1 * * * *`) and `cj-autocosm-think` (cron `*/5 * * * *`). Both jobs have `parallelism: 1`,
`replicaCompletionCount: 1`, `replicaRetryLimit: 0` and no ingress.

### Step 4 — verify

```bash
URL=$(az deployment group show -g rg-autocosm -n autocosm-app \
        --query properties.outputs.webUrl.value -o tsv)

curl -fsS "$URL/api/v1/health"
curl -sS  "$URL/api/v1/readiness"     # 503 until the first tick has seeded the world
curl -fsS "$URL/api/v1/world" | jq '{tick, agents: (.agents|length), heuristicOnly, aiDegraded}'
```

`/api/v1/health` answers as soon as the process is up. `/api/v1/readiness` additionally pings Table
storage and checks the world exists, returning **503** with `{status: "notReady"}` until the first
tick has seeded it — which is the correct answer for a readiness probe, and is what the Container
App's own readiness probe uses.

The first tick job fires within a minute and seeds the world if it is absent
(`AUTOCOSM_SEED_IF_MISSING=true`). To not wait:

```bash
az containerapp job start -g rg-autocosm -n cj-autocosm-tick
```

### Enabling Azure OpenAI (optional)

The world runs completely without it. To turn it on:

1. Create an Azure OpenAI account **in the same resource group** and deploy a chat model.
2. Redeploy the foundation with `azureOpenAiAccountName=<accountName>` so the think identity gets
   the Cognitive Services OpenAI User role on it.
3. Redeploy the app with `decisionProvider=azure-openai`, `azureOpenAiEndpoint=https://<account>.openai.azure.com`,
   `azureOpenAiDeployment=<deploymentName>`.

Endpoint and deployment name are configuration, never secrets. Authentication is the think
workload's managed identity. There is no API-key parameter anywhere, by design.

### CI/CD

`.github/workflows/ci.yml` runs the whole thing on `main`: lint → typecheck → test → build → Bicep
validate + policy assertions → `azure/login` (OIDC) → foundation → `az acr build` → app → health
smoke test.

Set these as **repository variables** (not secrets — none of them is one):

| Variable                | Meaning                                   |
| ----------------------- | ----------------------------------------- |
| `AZURE_CLIENT_ID`       | app registration used for OIDC federation |
| `AZURE_TENANT_ID`       | your tenant                               |
| `AZURE_SUBSCRIPTION_ID` | target subscription                       |
| `AZURE_RESOURCE_GROUP`  | target resource group                     |

Federation setup, with your own values substituted:

```bash
az ad app create --display-name autocosm-ci
# note the appId, then:
az ad app federated-credential create --id <appId> --parameters '{
  "name": "autocosm-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/<repo>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
az role assignment create --assignee <appId> --role Contributor \
  --scope /subscriptions/<subId>/resourceGroups/rg-autocosm
az role assignment create --assignee <appId> --role "User Access Administrator" \
  --scope /subscriptions/<subId>/resourceGroups/rg-autocosm
```

The second role assignment is needed because the foundation creates data-plane role assignments.
There is no publish profile, no service principal password and no long-lived credential.

---

## 2. Cold starts

`world-web` has `minReplicas: 0`. The first request after an idle period pays:

| Stage                       | Typical | Notes                                                      |
| --------------------------- | ------- | ---------------------------------------------------------- |
| Container Apps activation   | 2–5 s   | image pull is cached after the first cold start            |
| Node boot + config validate | ~0.3 s  | Zod validation of the environment happens once, at startup |
| First storage read          | 0.1–1 s | private endpoint DNS resolution, then the Table read       |
| Browser bundle              | <1 s    | no binary assets; everything is procedural                 |

The client shows an explicit cold-start state rather than an empty scene or a spinner that lies.

To trade money for latency, set `webMinReplicas` to 1. The template defaults to 0 because idling at
zero is the entire point of the Consumption profile.

Jobs have no cold-start concern: they are expected to start, work and exit.

---

## 3. Catch-up

The tick job is scheduled every minute but nothing guarantees it runs every minute. Container Apps
Jobs can be delayed, an execution can fail, and a deployment can pause the schedule.

On start the job:

1. reads `lastProcessedTick` from the `control` table;
2. computes how many logical ticks _should_ have elapsed —
   `elapsedMinutes × AUTOCOSM_TICKS_PER_MINUTE`;
3. caps that at `AUTOCOSM_MAX_TICKS_PER_RUN` (60);
4. advances ticks one at a time while `AUTOCOSM_TICK_BUDGET_MS` (45 s) remains;
5. persists, then advances the watermark;
6. exits 0, leaving any remainder for the next run.

So a 30-minute outage at 4 ticks/minute leaves 120 ticks owed. The next run does 60, the one after
does the rest, and the world is current again within three minutes. It never times out mid-tick and
never produces an unbounded run.

**Tuning.** If `tick lag` grows steadily, raise `maxTicksPerRun` _and_ `AUTOCOSM_TICK_BUDGET_MS`
together — and remember `AUTOCOSM_TICK_LEASE_MS` must stay larger than the budget or the lease could
expire mid-run. Startup refuses a configuration where it does not, so a mistake is a crash rather
than silent double-application.

---

## 4. Idempotency and concurrency

Assume every job can run twice concurrently and can die at any instruction. Five mechanisms:

**Lease.** Both jobs take an ETag compare-and-swap lease on a `control` row before doing anything. A
second execution finds it held and exits 0 quietly. Leases carry an expiry so a crashed holder does
not block forever.

**Deterministic event IDs.** `eventIdFor(worldId, tick, ordinal)` is pure. Replaying tick _N_
rewrites the same rows. There is no append-with-new-guid path anywhere.

**Watermark last.** State and events are durable before `lastProcessedTick` advances. A crash in
between means the tick is redone — which is a no-op.

**Claim expiry.** A think execution claims a decision with an ETag CAS plus `claimExpiresAt`. If it
dies holding claims, they expire and a later run picks the work up. `storage-contract.test.ts`
covers exactly this.

**Pure advance.** `advance(state, actions, seed, tick)` has no I/O and no `Math.random()`. Same
inputs, byte-identical output. `simulation.test.ts` asserts identical state _and_ identical event
IDs over 40 ticks, and `persistence.test.ts` round-trips through storage between every single tick
and asserts the replay still matches — which is what makes a job restart invisible.

`replicaRetryLimit: 0` in Bicep is deliberate. A failed execution is not retried; the next scheduled
run does the catch-up, and it does so with fresh leases and a fresh budget.

---

## 5. Model degradation

If `AUTOCOSM_DECISION_PROVIDER=azure-openai` and calls fail, the thinker does **not** quietly fall
back to the heuristic. Silent fallback would hide a broken production dependency behind plausible
behaviour.

Instead it:

- releases its claims so the decisions are retried on a later schedule;
- records the failure count in the run result;
- sets a degraded flag surfaced as `aiDegraded: true` on `GET /api/v1/world`;
- exits 0, because a failed model is not a failed job.

The browser status bar shows a degraded badge. The world keeps running — deterministic survival
behaviour is unaffected, since AI is only consulted at meaningful choice points.

**Triage:**

| Symptom                                   | Cause                                          | Fix                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `aiDegraded: true`, 401/403 in think logs | role assignment missing or not propagated      | confirm the think identity has Cognitive Services OpenAI User on the account; wait up to 10 minutes for propagation |
| 404 on the deployment                     | wrong `azureOpenAiDeployment`                  | it is the _deployment_ name, not the model name                                                                     |
| 429                                       | at the account's TPM quota                     | lower `maxDecisionsPerRun` or raise the quota                                                                       |
| Proposals rejected as malformed           | model not returning the expected JSON envelope | check `agent-runtime` logs for the rejection reason; consider a more capable deployment                             |

To ride it out, redeploy with `decisionProvider=heuristic`. The world continues, permanently and for
free.

---

## 6. Troubleshooting

### Private DNS

**Symptom:** `getaddrinfo ENOTFOUND` or a connection timeout to `*.table.core.windows.net` from a
job or the web app.

The name must resolve to a **private** address inside the VNet. Check, in order:

```bash
# 1. The private DNS zone exists and is linked to the VNet.
az network private-dns zone list -g rg-autocosm -o table
az network private-dns link vnet list -g rg-autocosm -z privatelink.table.core.windows.net -o table

# 2. The zone has an A record pointing at the private endpoint NIC.
az network private-dns record-set a list -g rg-autocosm -z privatelink.table.core.windows.net -o table

# 3. The private endpoint has a private IP and its DNS zone group is wired.
az network private-endpoint list -g rg-autocosm -o table
az network private-endpoint dns-zone-group list -g rg-autocosm --endpoint-name <peName> -o table

# 4. The Container Apps environment really is in the VNet.
az containerapp env show -g rg-autocosm -n <envName> --query properties.vnetConfiguration
```

Most common causes: the DNS zone group was not created, so the zone has no A record; or the
environment was created without `vnetConfiguration` and is running on a platform-managed network
with no line of sight to the private endpoint.

**Do not "fix" this by enabling public network access on the storage account.** That would break the
central security invariant and fail `npm run infra:build`. If you genuinely cannot get private DNS
working, the correct move is to fix the DNS wiring, not to open the account.

### RBAC

**Symptom:** 403 `AuthorizationPermissionMismatch` on a Table operation.

```bash
# What does this identity actually have?
az role assignment list --assignee <clientId> --all -o table

# Is AZURE_CLIENT_ID set to the right identity on the workload?
az containerapp show -g rg-autocosm -n ca-autocosm-web \
  --query "properties.template.containers[0].env[?name=='AZURE_CLIENT_ID']"
```

Three usual causes:

1. **Propagation.** Data-plane role assignments can take up to 10 minutes. Wait before debugging.
2. **Wrong identity chosen.** If `AZURE_CLIENT_ID` is unset and several identities are assigned,
   `DefaultAzureCredential` may pick a different one. Bicep sets it explicitly; verify it survived.
3. **The operation genuinely is not granted.** This is usually correct behaviour. If `world-web`
   gets a 403 writing an organism, the boundary is working — find the code that tried.

**Symptom:** 403 on `createTable` at startup.

Expected, and already handled. Table creation is a control-plane right the data-plane roles do not
include. Tables are declared in Bicep and `initialise()` skips creation in production. If you see
this, `NODE_ENV` is probably not `production`.

### Storage conflicts

A rising `storage.conflicts` counter means ETag CAS failures. A few are normal — that is optimistic
concurrency working. A flood means two tick executions are racing, which should be impossible with a
healthy lease. Check that `parallelism: 1` and `replicaCompletionCount: 1` survived any manual edit.

### The world stopped moving

```bash
az containerapp job execution list -g rg-autocosm -n cj-autocosm-tick -o table
az containerapp job logs show -g rg-autocosm -n cj-autocosm-tick --container tick
```

Ordered checks: is the job schedule enabled; are executions succeeding; is `tick lag` growing (raise
the budget); is a stale lease held (it should self-expire — if not, the lease TTL is misconfigured).

---

## 7. Observability

Structured JSON logs to Log Analytics, capped at 1 GB/day with 30-day retention.

Every log line carries: `correlationId`, `worldId`, `tick`, `jobExecutionId`, `decisionId` where
applicable, `durationMs` and `outcome`.

Never logged: full model prompts, hidden reasoning, credentials, creator tokens, cookie values,
storage endpoints, unbounded memory contents. `observability.test.ts` asserts the redaction.

Counters worth alerting on:

| Counter                             | Watch for                                                         |
| ----------------------------------- | ----------------------------------------------------------------- |
| `tick.lag`                          | steady growth — the job cannot keep up                            |
| `tick.durationMs`                   | approaching `AUTOCOSM_TICK_BUDGET_MS`                             |
| `agents.active`                     | sudden drop — a mass-extinction event, which may be legitimate    |
| `decisions.pending`                 | growth without `decisions.claimed` — the think job is not running |
| `decisions.claimed` / `model.calls` | cost                                                              |
| `proposals.rejected`                | a spike suggests model drift or a bad deployment                  |
| `storage.conflicts`                 | a flood suggests concurrent tick executions                       |
| `api.latencyMs`                     | user-visible slowness                                             |
| `api.snapshotBytes`                 | growth means the snapshot is drifting past its bounds             |

Useful KQL:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "cj-autocosm-tick"
| extend p = parse_json(Log_s)
| where isnotnull(p.tick)
| summarize maxTick = max(toint(p.tick)), runs = count() by bin(TimeGenerated, 5m)
| order by TimeGenerated desc
```

---

## 8. Backups

There are none. This is a deliberate MVP decision and it should be stated plainly rather than
implied.

Azure Storage gives LRS durability — three copies within a datacentre — which protects against
hardware failure but not against a bad deployment, a bad migration or an accidental delete.

What exists instead:

- **Reproducibility.** The world is a pure function of `(seed, accepted actions, ticks)`. A world
  regenerated from the same seed is identical up to the first accepted AI proposal.
- **Append-only history.** Events are never mutated, so history is auditable even after a bad state
  write.
- **Versioned records.** Every stored record carries a version and is Zod-validated on read, so a
  schema mismatch is a loud failure rather than silent corruption.

If a world becomes precious, the honest options are: enable point-in-time restore on the tables,
export periodically with `az storage entity query` from a _separate_ identity with read rights, or
move to a store with real backup. All three are roadmap items, none is implemented.

---

## 9. Configuration reference

Every variable is validated once at startup by a Zod schema per app. A malformed value fails the
process immediately rather than at the first request. Full annotated list in `.env.example`.

The cost-sensitive knobs:

| Variable                          | Default | Effect                                    |
| --------------------------------- | ------- | ----------------------------------------- |
| `AUTOCOSM_TICKS_PER_MINUTE`       | 4       | how fast the world lives                  |
| `AUTOCOSM_MAX_TICKS_PER_RUN`      | 60      | catch-up ceiling per execution            |
| `AUTOCOSM_TICK_BUDGET_MS`         | 45000   | wall-clock budget per execution           |
| `AUTOCOSM_TICK_LEASE_MS`          | 90000   | must exceed the budget                    |
| `AUTOCOSM_MAX_DECISIONS_PER_RUN`  | 12      | model calls per think execution           |
| `AUTOCOSM_MAX_DECISIONS_PER_DAY`  | 400     | the daily AI ceiling                      |
| `AUTOCOSM_MIN_TICKS_BETWEEN`      | 30      | per-lineage cooldown between AI decisions |
| `AUTOCOSM_MAX_COMPLETION_TOKENS`  | 320     | tokens per decision                       |
| `AUTOCOSM_EVENT_RETENTION_TICKS`  | 20000   | 0 disables compaction                     |
| `AUTOCOSM_SNAPSHOT_CACHE_SECONDS` | 2       | snapshot cache lifetime                   |
| `AUTOCOSM_RATE_LIMIT_PER_MINUTE`  | 240     | per-IP request limit                      |

---

## 10. Running the container locally

```bash
npm run docker:build

npm run docker:run:web     # serves on http://localhost:8080
npm run docker:run:tick    # advances once, exits 0
npm run docker:run:think   # claims a batch, exits 0
```

The mode is the container argument — `docker run autocosm:local tick` — resolved by
`docker-entrypoint.sh`, which refuses an unknown mode rather than defaulting to `web`.

With `AUTOCOSM_STORAGE_DRIVER=memory` each container has its own world, so the one-shot modes will
each seed a fresh one. To share state across containers, point them all at Azurite:

```bash
docker run -d -p 10002:10002 mcr.microsoft.com/azure-storage/azurite \
  azurite-table --tableHost 0.0.0.0

# then, in .env:
AUTOCOSM_STORAGE_DRIVER=azureTables
AZURE_TABLE_ENDPOINT=http://host.docker.internal:10002/devstoreaccount1
NODE_ENV=development
```

`NODE_ENV=development` is required: the guardrail refuses the emulator in production, and it refuses
it by crashing.
