# Architecture

## 1. Components

```text
┌──────────────────────────────────────────── browser ────────────────────────────────────────────┐
│  apps/web-client — React 19 + Vite + Babylon.js                                                 │
│    render/     engine (WebGPU → WebGL2 fallback), terrain, environment, organisms, props        │
│    components/ Viewport, InspectorPanel, LineageTree, EventTimeline, WorldNavigator, StatusBar  │
│    state/      use-world-feed (ETag polling + backoff), use-reduced-motion                      │
└────────────────────────────────────┬────────────────────────────────────────────────────────────┘
                                     │ same-origin HTTPS, JSON, ETag conditional GET
┌────────────────────────────────────▼────────────────────────────────────────────────────────────┐
│  apps/world-web — Fastify 5                                                                     │
│    server.ts        routes, secure headers, rate limit, body cap, structured errors             │
│    identity.ts      CreatorIdentity — HMAC-signed anonymous cookie                              │
│    world-service.ts authoring writes: createAgent, submitGoal (quota + idempotency)             │
│    read-model.ts    composeSnapshot / composeAgentDetail / composeLineageDetail / …             │
└────────────────────────────────────┬────────────────────────────────────────────────────────────┘
                                     │ StoragePort
┌────────────────────────────────────▼────────────────────────────────────────────────────────────┐
│  packages/storage — ports.ts is the only contract anything above depends on                     │
│    memory-repository.ts   deterministic, in-process, used by tests and `npm run dev`            │
│    azure-repository.ts    @azure/data-tables + DefaultAzureCredential, 15 tables                │
│    guardrails.ts          refuses connection strings / shared keys in production                │
└────────────────────────────────────▲────────────────────────────────────────────────────────────┘
                                     │
        ┌────────────────────────────┴───────────────────────────┐
        │                                                        │
┌───────▼──────────────────────────┐            ┌────────────────▼─────────────────────────────┐
│ apps/world-tick                  │            │ apps/agent-think                             │
│   run.ts   lease → catch-up →    │            │   queue.ts  claim → propose → store → release│
│            advance → persist →   │            │   main.ts   bounded batch, then exit         │
│            watermark             │            └────────────────┬─────────────────────────────┘
│   seed.ts  world generation      │                             │ DecisionProviderPort
└───────┬──────────────────────────┘            ┌────────────────▼─────────────────────────────┐
        │ SimulationPort                        │ packages/agent-runtime                       │
┌───────▼──────────────────────────────────┐    │   heuristic-provider.ts   deterministic, free│
│ packages/simulation  (no I/O whatsoever)  │    │   azure-openai-provider.ts managed identity  │
│   tick.ts        the authoritative advance│    │   prompt.ts   bounded observation → prompt   │
│   resolve.ts     action validation        │    │   budget.ts   per-run / per-day / per-lineage│
│   evolution.ts   mutation, inheritance    │    │   think-batch.ts orchestration + degradation │
│   ecology / worldgen / observe / heuristics│   └──────────────────────────────────────────────┘
│   persistence.ts state ⇄ records          │
└───────┬──────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────────────────────────────────────┐
│ packages/domain — the shared vocabulary. Zod schemas, branded IDs, seeded PRNG, units.        │
│   traits · materials · structures · actions · events · entities · observation · records · api │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

`packages/observability` (structured logger + counters) is used by the three apps and by nothing in
`domain` or `simulation`.

### Dependency rule

`domain` and `simulation` import **nothing** from React, Fastify, `@azure/*`, or any model provider.
The build enforces this by construction — those packages are not in their `package.json` — and the
architecture depends on it: it is why 48 simulation tests run in-process in four seconds with no
service, no container and no network.

---

## 2. Trust boundaries

```text
   ┌─────────────────────────────────────────────────────────────────┐
   │ TB1  Untrusted: the human observer                              │
   │      Can read anything public. Can create an agent and submit a │
   │      goal. Cannot express any other intent — there is no route. │
   └───────────────────────────┬─────────────────────────────────────┘
                               │ Zod-validated request, size-capped, rate-limited,
                               │ quota-checked, idempotency-keyed
   ┌───────────────────────────▼─────────────────────────────────────┐
   │ TB2  Semi-trusted: world-web                                    │
   │      Writes only `agents`, `lineages`, `goals`, `control`.      │
   │      Azure RBAC gives it read-only rights on the other 11       │
   │      tables and NO rights at all on `decisions`.                │
   └───────────────────────────┬─────────────────────────────────────┘
                               │
   ┌───────────────────────────▼─────────────────────────────────────┐
   │ TB3  Untrusted: model output                                    │
   │      Text from Azure OpenAI is parsed, Zod-validated, then      │
   │      re-checked by the simulation against visibility, range,    │
   │      ownership, cost, cooldown, maturity, evolved capability    │
   │      and world version. A valid-looking proposal is still just  │
   │      a proposal.                                                │
   └───────────────────────────┬─────────────────────────────────────┘
                               │ ProposedAction record
   ┌───────────────────────────▼─────────────────────────────────────┐
   │ TB4  Authoritative: the deterministic simulation (tick)         │
   │      Sole writer of world state. Sole source of truth about     │
   │      what exists, what happened, and what works.                │
   └─────────────────────────────────────────────────────────────────┘
```

The model has no database handle, no network egress of its own, no filesystem and no tool access.
It receives a rendered string and returns a string. Everything else is the runtime's job.

The observer boundary is enforced in **four independent places**, so removing any one of them still
fails a test:

1. **Route table** — only two mutation routes exist; `api.test.ts` asserts the exact set.
2. **Service layer** — `world-service.ts` exposes only `createAgent` and `submitGoal`; there is no
   method that writes an organism, structure, resource or region.
3. **Azure RBAC** — the web identity has Table Data Contributor on exactly four tables and Table
   Data Reader on ten; a compromised web container physically cannot write world state.
4. **Rendering** — the spectator camera is a Babylon.js `FreeCamera` with no collision and no
   simulation record, so there is nothing to manipulate even client-side.

---

## 3. Data flow

### Read path (the common case)

```text
browser ──GET /api/v1/snapshot?regionId=&radius=1, If-None-Match: "w-4821"──▶ world-web
                                                                                  │
                                        ┌─────────────────────────────────────────┤
                                        │ etag matches?                            │
                                        ├── yes ─▶ 304 Not Modified  (no storage read at all)
                                        └── no  ─▶ load state ─▶ composeSnapshot(regionId, radius)
                                                                       │
                                                     bounded: ≤ radius 2, capped organism and
                                                     event counts, capped response bytes
                                                                       ▼
                                                 200 + ETag + Cache-Control: public, max-age=2
```

The browser polls with `If-None-Match` and exponential backoff on failure. Between ticks a poll
costs a 304 and no storage transaction. There is no WebSocket and no SignalR — deliberately, because
an always-connected transport would defeat scale-to-zero.

### Write path (rare, and only authoring)

```text
browser ──POST /api/v1/agents  {name, visualSeed, habitat, drives, temperament, sensoryBias,
          Idempotency-Key: …    aspiration}
             │
             ▼
        CreatorIdentity.resolve(req)  ─▶ signed cookie, or mint a new one
             │
             ▼
        quota check (per creator, rolling day) ─▶ 429 if exceeded
             │
             ▼
        idempotency check ─▶ replay the prior response verbatim if the key was seen
             │
             ▼
        write AgentRecord + LineageRecord + `agentCreated` event
             │
             ▼
        201 {agentId, lineageId, organismId, status: 'pending'}
```

The agent does not exist _in the world_ until the next tick picks it up and instantiates it as a
viable basic cell in its preferred habitat. `world-web` never creates an organism.

---

## 4. Tick sequence

`world-tick` runs every minute, does bounded work, and exits. It must be safe to run twice
concurrently and safe to retry after a crash at any point.

```text
 world-tick                storage                        simulation
     │                        │                                │
     │ acquire lease ────────▶│  ETag CAS on control/tickLease │
     │◀──── denied ───────────│  (another execution holds it)  │
     │  exit 0, quietly       │                                │
     │                        │                                │
     │ read watermark ───────▶│  control/lastProcessedTick     │
     │◀───────────────────────│                                │
     │                        │                                │
     │ load world state ─────▶│  bounded record read           │
     │◀───────────────────────│                                │
     │                                                          │
     │ compute target = min(elapsed × ticksPerMinute,           │
     │                      maxTicksPerRun)                     │
     │                                                          │
     │  ┌── for each tick, while budget remains ──────────────┐ │
     │  │  advance(state, acceptedActions, seed, tick) ──────▶│ │
     │  │                                                     │ │
     │  │   1. environment: light, heat, pressure, decay      │ │
     │  │   2. metabolism + ageing + death        (heuristic) │ │
     │  │   3. resolve accepted AI proposals      (validated) │ │
     │  │   4. deterministic survival behaviour   (heuristic) │ │
     │  │   5. reproduction + mutation                        │ │
     │  │   6. emit events, ordinal-stamped                   │ │
     │  │   7. raise pending decisions at choice points only  │ │
     │  │◀──── new state + events ────────────────────────────│ │
     │  └─────────────────────────────────────────────────────┘ │
     │                        │                                  │
     │ persist state ────────▶│  idempotent upsert                │
     │ append events ────────▶│  id = f(worldId, tick, ordinal)   │
     │ write watermark ──────▶│  ONLY after the above are durable │
     │ release lease ────────▶│                                   │
     │ exit 0                 │                                   │
```

Five things make this safe:

- **Lease.** ETag compare-and-swap on a single control row. A second execution finds the lease held
  and exits 0 without touching anything. The lease TTL must exceed the execution budget, and startup
  refuses a configuration where it does not.
- **Deterministic event IDs.** `eventIdFor(worldId, tick, ordinal)` is a pure function, so replaying
  a tick rewrites the same rows rather than duplicating history.
- **Watermark last.** The processed watermark advances only after state and events are durable. A
  crash before that point means the next run redoes the tick — and redoing it is a no-op because the
  writes are idempotent.
- **Budget, not deadline.** The job advances as many ticks as fit in `AUTOCOSM_TICK_BUDGET_MS` up to
  `AUTOCOSM_MAX_TICKS_PER_RUN` and leaves the rest for the next run. It never times out mid-tick.
- **Seeded PRNG.** `advance()` is a pure function of `(state, actions, seed, tick)`. Running it twice
  gives byte-identical output, which is exactly what `simulation.test.ts` asserts over 40 ticks.

---

## 5. Think sequence

`agent-think` runs on a low-cost schedule and exits immediately when there is nothing to claim.

```text
 agent-think              storage                     agent-runtime            Azure OpenAI
     │                       │                             │                        │
     │ query pending ───────▶│ decisions, PK = world#epoch │                        │
     │◀── ≤ maxPerRun ───────│                             │                        │
     │                       │                             │                        │
     │ (nothing) exit 0      │                             │                        │
     │                       │                             │                        │
     │  ┌─ per decision ─────────────────────────────────┐ │                        │
     │  │ claim ────────────▶│ ETag CAS + claimExpiresAt │ │                        │
     │  │◀── lost race ──────│ skip, next decision       │ │                        │
     │  │                    │                            │ │                        │
     │  │ budget check ──────────────────────────────────▶│ per-run, per-day,        │
     │  │◀── denied ─────────────────────────────────────│ per-lineage cooldown     │
     │  │                                                 │                        │
     │  │ render prompt from the decision's OWN            │                        │
     │  │ embedded observation ─────────────────────────▶ │ ──── bounded tokens ───▶│
     │  │                                                 │◀─── text ───────────────│
     │  │                                                 │                        │
     │  │ parse → Zod → allow-list the action type ───────│                        │
     │  │◀── invalid: reject with reason, no retry loop ──│                        │
     │  │                    │                            │                        │
     │  │ store proposal ───▶│ status=proposed            │                        │
     │  │ release claim ────▶│                            │                        │
     │  └─────────────────────────────────────────────────┘                        │
     │ exit 0                                                                       │
```

Two design points worth calling out.

**The thinker never reads world tables.** The observation an agent is permitted to see is computed
by the simulation during the tick and embedded in the decision record itself. The thinker reads
`decisions`, writes `decisions`, and touches nothing else. That is why its Azure role assignment is
Table Data Contributor on `decisions` and `control` and _nothing else_ — a genuinely minimal
privilege set that is verified in `tests/infra/policy.test.ts`.

**AI is optional and rare.** Frequent survival behaviour — movement, metabolism, decay, ordinary
feeding — is deterministic and free. A pending decision is raised only at a meaningful choice point:
`novelDiscovery`, `newCreatorGoal`, `reproductionStrategy`, `constructionOpportunity`,
`socialConflict`, `cooperationOpportunity`, `environmentalShift`, `starvationRisk`. With
`AUTOCOSM_DECISION_PROVIDER=heuristic` the same decisions are answered by a deterministic policy and
the world stays completely alive at zero cost.

### Degradation

If a _configured_ Azure OpenAI deployment fails, the thinker does **not** silently fall back to the
heuristic. It marks the run degraded, releases its claims so the work is retried on a later
schedule, and surfaces `aiDegraded: true` on `GET /api/v1/world`, which the browser status bar
shows. Silent fallback would hide a broken production dependency behind plausible behaviour.

---

## 6. Rendering

`apps/web-client/src/render` is a plain TypeScript layer with no React inside it; React owns the DOM
overlay and hands the scene a snapshot.

- **Engine.** `WebGPUEngine` when `navigator.gpu` is available, otherwise `Engine` (WebGL2). The
  choice is made once at startup and logged.
- **Terrain.** One mesh per region built from the domain's own elevation function, so the browser
  and the simulation agree on where the shoreline is. Regions outside the snapshot radius are not
  built at all.
- **Organisms.** Procedural: a body whose scale comes from `bodySize`, colour from the visual seed
  modulated by `photosynthesis` and `camouflage`, appendages from `motility` and `manipulation`,
  spines from `armor`, and sensory nubs from `photoreception` and `chemoreception`. Inherited traits
  are literally visible, which is the point.
- **Instancing.** Organisms of the same lineage share a source mesh and draw as thin instances.
- **LOD and culling.** Frustum culling is on; distant regions drop to a simplified mesh; organisms
  beyond a distance threshold stop animating.
- **Atmosphere.** Procedural sky, animated water, fog, shadows, particles, ACES tone mapping and
  restrained bloom. A day/night cycle driven by the world's own light value, not wall-clock time.
- **Interpolation.** Between snapshots the client interpolates position only. It never invents an
  event, a birth, a death or an outcome — if the simulation did not say it happened, it did not
  happen.
- **Reduced motion.** `prefers-reduced-motion` disables camera easing, particles and bloom.

No binary assets ship. Every mesh, texture and material is generated at runtime, which keeps the
image small and the cold start short.
