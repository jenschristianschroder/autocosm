# Autocosm

A persistent, browser-based 3D evolutionary world inhabited and changed by autonomous AI agents.

Autocosm runs one seeded biosphere in compressed time. Agents are platform-hosted autonomous
actors with persistent identities, drives, memories, relationships and lineages. They perceive a
limited local observation, propose typed actions, and a deterministic simulation decides what
actually happens. You watch.

---

## The product boundary

This is the single most important rule in the repository, and it is enforced in code, in tests and
in Azure RBAC.

**A human observer may:**

- fly freely through the live world with a non-physical camera;
- move between a wide ecosystem view and a close organism view;
- follow, unfollow and inspect agents, organisms, lineages, structures, materials and events;
- create one new autonomous agent, which enters the world as a viable basic cell;
- occasionally send an agent they created a broad goal, such as “seek the ocean”.

**A human observer may never** move, harvest, attack, build, alter terrain, change weather, rescue,
heal, edit traits, delete, teleport, grant resources, reset, or otherwise manipulate the live world.

There are exactly two mutation routes in the public API — `POST /api/v1/agents` and
`POST /api/v1/agents/:agentId/goals` — and both express _authoring intent_, not world state.
`apps/world-web/src/api.test.ts` asserts that the route table contains those two and nothing else,
so adding a third mutation route fails the build. The observer is not a physical entity: it has no
collision, no organism record and no representation in the simulation.

A submitted goal affects **motivation only**. The agent may reinterpret it, postpone it, or reject
it. Goals are rate-limited, recorded in the event history, and immutable once submitted.

> **Governing invariant:** agents propose manipulations; the authoritative world determines what
> exists, what happens, and what works.

---

## Architecture at a glance

```text
browser ──HTTPS──▶ world-web (Container App, external ingress)
                        │
                        │ Azure Tables data plane, managed identity,
                        │ private endpoint, no keys and no SAS
                        ▼
                  Storage account  ◀── world-tick  (Container Apps Job, cron */1)
                  (public access    ◀── agent-think (Container Apps Job, cron */5)
                   disabled)                │
                                            │ managed identity
                                            ▼
                                      Azure OpenAI (optional)
```

Three runtime modes, **one** container image. Agents are persisted records processed in batches;
there is never a process or container per agent.

| Mode    | Entry point        | Responsibility                                                                   |
| ------- | ------------------ | -------------------------------------------------------------------------------- |
| `web`   | `apps/world-web`   | Serves the compiled browser and `/api/v1`. Writes only authoring requests.       |
| `tick`  | `apps/world-tick`  | One bounded, idempotent deterministic world advance, then exits.                 |
| `think` | `apps/agent-think` | Claims a bounded batch of pending decisions, gets proposals, stores them, exits. |

```text
apps/
  web-client/     React + Vite + Babylon.js observatory
  world-web/      Fastify /api/v1 + static hosting
  world-tick/     deterministic world advance job
  agent-think/    bounded AI decision job
packages/
  domain/         units, traits, materials, actions, events, Zod schemas    (no I/O)
  simulation/     seeded PRNG, tick engine, action resolution, evolution    (no I/O)
  storage/        ports + in-memory adapter + Azure Tables adapter
  agent-runtime/  decision ports, heuristic provider, Azure OpenAI provider
  observability/  structured logging + counters
infra/            Bicep foundation + app, and the modules they compose
tests/            infra policy assertions + Playwright browser tests
```

`packages/domain` and `packages/simulation` have **no** dependency on React, Fastify, the Azure SDK
or any model provider. They depend on ports for persistence, clock, identifiers and AI decisions.
That is what makes the whole simulation testable in-process with an in-memory adapter and a
deterministic clock.

Deeper treatment: [docs/architecture.md](docs/architecture.md).

---

## Prerequisites

| Tool              | Version used here | Needed for                                                  |
| ----------------- | ----------------- | ----------------------------------------------------------- |
| Node.js           | 22.12+ LTS        | everything (developed on Node 26)                           |
| npm               | 10+               | workspaces                                                  |
| Docker            | any recent        | `npm run docker:*` only                                     |
| Azure CLI + Bicep | 2.60+ / 0.30+     | the `infra` test project, `npm run infra:build`, deployment |

**No Azure account, Azure OpenAI deployment, or cloud credential of any kind is needed to install,
test, run, and watch the living world.** That is a hard requirement of this repository, not a
convenience.

The Azure CLI is a _tooling_ dependency, not a credential one: `az bicep build` compiles templates
offline. `npm run test` includes the infrastructure policy project, which compiles the Bicep it
asserts on; use `npm run test:code` to run every other project without the CLI installed.

---

## Local quick start

```bash
npm ci
cp .env.example .env      # optional; the defaults already work
npm run dev
```

Open <http://localhost:5173>. You get:

- a seeded 64-region biosphere with water, shore, plain and highland biomes;
- 8 autonomous lineages already alive and competing;
- a background world loop advancing ticks continuously;
- the deterministic heuristic decision provider — free, offline, and fully alive.

`npm run dev` runs `scripts/dev.mjs`, which starts the Vite dev server, an in-process world-web,
and a repeating tick/think loop that all share **one** in-memory repository. Vite proxies `/api` to
the API so the browser is same-origin exactly as it is in production.

To drive a world by hand instead:

```bash
npm run seed        # generate a world if none exists
npm run tick:once   # advance the world once, bounded, then exit
npm run think:once  # claim a batch of decisions, propose, then exit
```

Note that `memory` storage is per-process, so those three one-shot commands each operate on a fresh
world unless you point them at Azurite. See [docs/operations.md](docs/operations.md).

### Watching for the interesting bits

The seeded world reliably produces, within the first few hundred ticks: reproduction with mutation,
predation, signalling, resource sharing, material discovery, material combination, and at least one
lineage building a persistent structure from discovered materials that another lineage later
observes or uses. `packages/simulation/src/ecology.test.ts` asserts exactly that, so it is a
property of the simulation rather than a lucky seed.

---

## Commands

| Command                    | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `npm ci`                   | reproducible install from the committed lockfile                  |
| `npm run dev`              | Vite + API + world loop, one shared in-memory world               |
| `npm run seed`             | generate a world                                                  |
| `npm run tick:once`        | one bounded deterministic world advance, then exit                |
| `npm run think:once`       | one bounded decision batch, then exit                             |
| `npm run format:check`     | Prettier check                                                    |
| `npm run lint`             | ESLint (flat config, type-aware)                                  |
| `npm run typecheck`        | strict `tsc --build`                                              |
| `npm run test`             | all Vitest projects (307 tests; needs Azure CLI for `infra`)      |
| `npm run test:code`        | every project except `infra` — no Azure CLI needed                |
| `npm run test:unit`        | domain, simulation, observability, agent-runtime                  |
| `npm run test:integration` | storage contract, API, infra policy                               |
| `npm run test:browser`     | Playwright happy path                                             |
| `npm run build`            | production build of every workspace                               |
| `npm run scan:secrets`     | fail on any credential-shaped string in tracked files             |
| `npm run verify`           | format:check → lint → typecheck → test → scan:secrets → build     |
| `npm run infra:build`      | `az bicep build` both templates, then assert on the generated ARM |
| `npm run docker:build`     | build the single multi-stage image                                |
| `npm run docker:run:web`   | run the image in `web` mode                                       |
| `npm run docker:run:tick`  | run the image in `tick` mode (exits)                              |
| `npm run docker:run:think` | run the image in `think` mode (exits)                             |
| `npm run clean`            | remove build output                                               |

---

## Testing

307 automated tests across 9 Vitest projects, plus one Playwright browser test.

| Project         | Tests | Covers                                                                        |
| --------------- | ----: | ----------------------------------------------------------------------------- |
| `domain`        |    68 | units, seeded PRNG, toroidal geometry, logical time, materials, schemas       |
| `simulation`    |    48 | determinism, replay, energy ledger, mutation bounds, trait tradeoffs, ecology |
| `infra`         |    48 | ARM policy assertions on the compiled Bicep                                   |
| `storage`       |    36 | ETag conflicts, claim expiry, event idempotency, bounded queries, validation  |
| `agent-runtime` |    34 | proposal parsing, rejection, budgets, degradation, prompt bounds              |
| `world-web`     |    31 | observer boundary, quotas, idempotency, malformed input, static hosting       |
| `world-tick`    |    15 | catch-up, lease safety, idempotent re-execution, budget                       |
| `observability` |    15 | redaction, correlation, counters                                              |
| `agent-think`   |    12 | claiming, expiry, bounded batches, safe failure                               |

The simulation suite proves the properties that matter rather than exercising lines: 40 ticks
replay to a byte-identical state and identical event identifiers; the energy ledger balances against
explicitly modelled inflow and outflow; every organism stays inside the world and inside its stated
region; pending decisions stay under budget; and a world round-tripped through storage between every
single tick replays identically, which is what makes a job restart invisible.

---

## Deployment

Nothing in this repository has been deployed. No Azure resources were created, no money was spent,
and no cloud credentials were issued. What exists is a validated, deployable definition plus the
exact commands to run it. See [docs/operations.md](docs/operations.md) for the full flow.

```bash
# 1. Validate locally first — compiles both templates and runs 48 policy assertions.
npm run infra:build

# 2. Foundation: network, private DNS, storage, tables, ACR, Log Analytics, environment, identities.
az deployment group create \
  --resource-group rg-autocosm \
  --template-file infra/foundation.bicep \
  --parameters namePrefix=autocosm location=eastus

# 3. Build and push the single image inside Azure (no local Docker or registry password needed).
az acr build --registry <acrName> --image autocosm:<sha> .

# 4. Applications: one Container App plus two Container Apps Jobs.
az deployment group create \
  --resource-group rg-autocosm \
  --template-file infra/app.bicep \
  --parameters namePrefix=autocosm location=eastus containerImage=<acrLoginServer>/autocosm:<sha>
```

`.github/workflows/ci.yml` does exactly this on `main` using GitHub-to-Azure OIDC federation
(`azure/login` with `permissions: id-token: write`). There is no publish profile, no service
principal password, and no long-lived Azure secret anywhere in the repository. The workflow needs
four repository variables — `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`AZURE_RESOURCE_GROUP` — whose real values are deliberately not fabricated here.

### Security invariants

These are asserted against the _generated ARM JSON_, not just written down:

- Storage `publicNetworkAccess: Disabled`, network ACL default action `Deny`, bypass `None`.
- `allowSharedKeyAccess: false`, `allowBlobPublicAccess: false`, `supportsHttpsTrafficOnly: true`,
  `minimumTlsVersion: TLS1_2`.
- A Table **private endpoint** and a `privatelink.table.core.windows.net` private DNS zone linked to
  the VNet. No Blob or Queue private endpoint.
- Three separate user-assigned managed identities with table-scoped data-plane RBAC.
- No storage account key, connection string, SAS token or SAS URL is created, accepted, logged,
  output, or sent to a browser — `app.json` contains no `listKeys` call at all.
- Only `world-web` has ingress. Both jobs have none.
- Runtime identities get `AcrPull` and never `AcrPush`.
- Only the thinker gets the Azure OpenAI inference role.

Full reasoning and the local-versus-production authentication story:
[docs/security.md](docs/security.md).

---

## Cost drivers

Designed to idle at close to nothing.

| Resource                     | Driver                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Container Apps (Consumption) | `world-web` scales to zero; you pay per request-second                        |
| Container Apps Jobs          | `tick` every minute, `think` every 5 minutes, both exit immediately when idle |
| Azure Table Storage          | transactions and a few MB; the dominant unit is tick writes                   |
| Private endpoint             | ~$7–8/month fixed — the one unavoidable fixed cost                            |
| ACR Basic                    | ~$5/month                                                                     |
| Log Analytics                | capped at 1 GB/day ingestion, 30-day retention                                |
| Azure OpenAI                 | **zero unless you configure it**; the heuristic provider is the default       |

Deliberately absent: NAT Gateway, Azure Firewall, VPN Gateway, Application Gateway, dedicated
compute, Cosmos DB, Redis, Service Bus, Queue Storage, Blob Storage, Dapr, and any always-on worker.

The knobs that decide the AI bill are all configuration, all documented in `.env.example`:
`AUTOCOSM_MAX_DECISIONS_PER_RUN`, `AUTOCOSM_MAX_DECISIONS_PER_DAY`, `AUTOCOSM_MIN_TICKS_BETWEEN`,
`AUTOCOSM_MAX_COMPLETION_TOKENS`, `AUTOCOSM_MODEL_MAX_RETRIES`.

---

## Identity

The MVP uses an anonymous, browser-scoped creator ID: the server mints a random ID, signs it with
HMAC-SHA-256, and stores it in an `HttpOnly`, `SameSite=Lax` cookie. It sits behind a
`CreatorIdentity` interface (`apps/world-web/src/identity.ts`) so Entra External ID can replace it
without touching the rest of the API.

**This is prototype identity, not account ownership.** Clearing cookies loses your lineages.
Anyone who copies the cookie can act as you. There is no password, no recovery, no email. The UI
says so on the agent-creation dialog. Do not treat it as a security boundary — it exists to make
per-creator quotas meaningful, nothing more.

---

## Current limitations

Honest list. See [docs/roadmap.md](docs/roadmap.md) for what is implemented versus planned.

- **Nothing has been deployed to Azure.** The Bicep compiles and passes 48 policy assertions
  against the generated ARM, but no resource has ever been created from it.
- **The Azure Tables adapter has never run against real Azure Storage or Azurite.** It is covered by
  36 contract tests that run against the in-memory adapter through the same port interface, and its
  Azure-specific behaviour (production refuses connection strings; production does not attempt table
  creation because that is a control-plane right the data-plane roles deliberately withhold) is
  unit-tested. Treat first contact with a real account as unproven.
- **The Azure OpenAI provider has never called a real deployment.** Request shaping, response
  parsing, validation, retry and degradation are tested against a stub transport.
- **`npm audit` reports 16 high-severity findings that cannot be fixed yet.** They come from two
  packages (`brace-expansion`, `fast-uri`) whose advisories name fix versions that upstream has not
  published — `npm audit fix` and `overrides` both fail with `ETARGET`. Eight are dev-tooling only
  and pruned from the image; the eight that ship are not reachable from untrusted input. Full
  analysis and the re-check commands are in
  [docs/security.md § 10](docs/security.md#10-dependency-advisories).
- One world per deployment. `AUTOCOSM_WORLD_ID` exists but nothing multiplexes worlds.
- The lineage tree renders ancestry but does not lay out very wide generations gracefully.
- Event compaction is implemented and bounded but has not been exercised at multi-million-event
  scale.
- No mobile-optimised control scheme; the layout is responsive but free-fly assumes a keyboard.

---

## Documentation

| Document                                     | Contents                                                        |
| -------------------------------------------- | --------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | components, trust boundaries, data flow, tick/think sequences   |
| [docs/domain-model.md](docs/domain-model.md) | traits, materials, actions, evolution, memory, construction     |
| [docs/security.md](docs/security.md)         | private storage, managed identity, local vs production auth     |
| [docs/operations.md](docs/operations.md)     | deploy, cold starts, catch-up, idempotency, degradation, triage |
| [docs/roadmap.md](docs/roadmap.md)           | implemented MVP behaviour versus future work                    |

## Licence

MIT.
