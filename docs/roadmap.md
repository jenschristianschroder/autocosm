# Roadmap

Two sections. The first is what actually works today, verified by tests you can run. The second is
what does not exist yet. Nothing in section 1 is a mock, a stub, or a screenshot.

---

## Implemented in the MVP

### Simulation

- [x] Deterministic tick engine. `advance(state, actions, seed, tick)` is pure — no I/O, no
      `Math.random()`. 40 ticks replay to byte-identical state and identical event IDs.
- [x] Seeded PRNG (`packages/domain/src/prng.ts`) with all authoritative arithmetic in integers.
- [x] Bounded catch-up with lease, ETag CAS, deterministic event IDs, and a watermark advanced only
      after durability. Concurrent or retried executions cannot double-apply a tick.
- [x] Round-trip through storage between _every_ tick still replays identically, so a job restart is
      invisible.
- [x] Explicit energy ledger. Inflow and outflow are modelled and asserted to balance.
- [x] 64-region seeded biosphere: water, shore, plain, highland; light, heat, mineral and biomass
      gradients; day/night; periodic environmental pressure.
- [x] 8 autonomous lineages at seed.
- [x] 24 heritable traits across 8 categories, every one with an upkeep, mass or suppression cost,
      enforced by a regression test.
- [x] Trait suppression — the mechanism that makes the trait space non-monotonic.
- [x] Intelligence as an emergent capability gated on sensing, memory, communication and energy.
      `planningDepth` alone does nothing.
- [x] Reproduction with mutation, clamped to `[0, 1000]` at any generation depth.
- [x] Lineages, `LineageNode` ancestry, agent identity surviving individual organism death,
      `lineageExtinct` only when the last organism dies.
- [x] Predation, signalling (5 channels), resource sharing, migration, death by 5 causes
      (starvation, age, predation, environment, toxicity).
- [x] 14 base materials with 8 composable properties; combination by volume-weighted property blend
      producing genuinely new material definitions.
- [x] Construction with **derived** function: 10 rules evaluated against blended properties. A model
      cannot assert that an arbitrary combination is a working tool.
- [x] Discovery, inspection, copying, damage, repair and repurposing of others' structures, gated on
      the observer's own evolved capability.
- [x] Bounded local observation. No global state ever reaches an agent.
- [x] Memory slots derived from `memoryCapacity`, deterministic salience eviction, cultural
      transmission gated on evolved communication.
- [x] 14 action types, 7 capability gates, 16 explicit rejection reasons, every rejection emitted as
      an event.
- [x] 23 event kinds, append-only, versioned, attributable, idempotent, bounded.
- [x] Event compaction with a configurable retention window.

### AI

- [x] Deterministic heuristic decision provider. Free, offline, and keeps the world fully alive.
      This is the default, so the repository builds, tests and runs with no Azure OpenAI deployment.
- [x] Azure OpenAI provider using managed identity. Endpoint and deployment name are configuration,
      never secrets.
- [x] Decisions raised only at meaningful choice points — 8 reasons, not every tick.
- [x] Prompt built from the agent's own embedded observation, drives, memories and unresolved goals.
      Bounded in every dimension.
- [x] Model output parsed, Zod-validated, allow-listed, then re-validated by the simulation against
      visibility, range, ownership, cost, cooldown, maturity, capability and world version.
- [x] Budgets: per run, per day, per lineage cooldown, completion tokens, retries, wall-clock.
- [x] ETag-based claiming with claim expiry, so a crashed thinker's work is retried, not lost.
- [x] Explicit degradation. A configured-but-failing model surfaces `aiDegraded: true` rather than
      silently falling back.

### API

- [x] `/api/v1` with health, readiness, creator, world, snapshot, agent/organism/lineage detail,
      paginated event history, and exactly two mutation routes.
- [x] The observer boundary asserted against Fastify's real route table.
- [x] Zod validation of request, response, stored record and model output.
- [x] ETag conditional GET; a poll between ticks costs a 304 and no storage transaction.
- [x] Per-creator daily quotas, per-IP rate limit, body-size cap, idempotency keys, secure headers,
      same-origin CORS, structured errors that never leak an internal cause.
- [x] HMAC-signed anonymous creator cookie behind a `CreatorIdentity` interface.
- [x] Local seeding that production startup refuses to enable.

### Browser

- [x] Full-window Babylon.js scene: WebGPU when available, WebGL2 fallback.
- [x] Free-fly spectator camera with no collision and no simulation presence.
- [x] Smooth follow/unfollow for organisms and lineages.
- [x] Procedural environment: PBR materials, animated water, sky, fog, shadows, particles, ACES tone
      mapping, restrained bloom, day/night driven by the world's own light value.
- [x] Procedural organisms whose colour, scale, silhouette, appendages, defences and sensory
      features visibly reflect inherited traits.
- [x] Region-based rendering, frustum culling, thin-instance batching per lineage, distance LOD.
- [x] Inspector panel, lineage tree, event timeline, agent-creation flow, broad-goal flow.
- [x] Loading, empty, cold-start, stale-snapshot, offline and error states — all distinct.
- [x] Responsive layout, keyboard-accessible UI, `prefers-reduced-motion` support.
- [x] ETag polling with backoff. No WebSocket, no SignalR.
- [x] Zero binary assets. Every mesh, texture and material is generated at runtime.

### Storage

- [x] Port interface with two adapters: in-memory (tests, local dev) and Azure Tables.
- [x] 15 tables partitioned by world, region and epoch so ordinary queries are bounded.
- [x] Versioned, Zod-validated records; bounded entities with ring buffers where history accumulates.
- [x] ETag optimistic concurrency, expiring claims, idempotent event writes, cursor pagination.
- [x] Guardrails that crash the process on a connection string, shared key or SAS in production.
- [x] Production-aware `initialise()` that does not attempt control-plane table creation.

### Infrastructure

- [x] `foundation.bicep` and `app.bicep`, compiling cleanly under `az bicep build`.
- [x] VNet with a `/23` Container Apps infra subnet and a `/24` private-endpoint subnet.
- [x] Table private endpoint and linked `privatelink.table.core.windows.net` zone. No Blob or Queue
      endpoint.
- [x] Storage with public access disabled, ACL default deny, bypass none, shared key disabled, blob
      public access disabled, HTTPS required, TLS 1.2 minimum.
- [x] Three user-assigned managed identities with table-scoped data-plane RBAC encoding the observer
      boundary.
- [x] AcrPull without AcrPush. OpenAI inference role to the thinker alone.
- [x] One Container App with `minReplicas: 0` plus two Container Apps Jobs with no ingress.
- [x] Consumption workload profile only. No NAT Gateway, Firewall, VPN, App Gateway or dedicated
      compute.
- [x] 48 policy assertions against the **generated ARM JSON**, not the Bicep source.
- [x] GitHub Actions with OIDC federation. No publish profile, no client secret, no long-lived
      credential.

### Developer experience

- [x] `npm ci && npm run dev` gives a seeded, living world with no Azure account.
- [x] 307 automated tests across 9 Vitest projects, plus a Playwright happy path.
- [x] One multi-stage image, three modes, mode as the container argument.
- [x] Scripts for every gate; `npm run verify` runs the chain.
- [x] `.env.example` with safe placeholders only.

---

## Not implemented

Ordered by value, honestly labelled.

### Highest value

1. **Deploy it and prove the infrastructure.** Everything is validated against compiled ARM and unit
   tests; nothing has met a real subscription. First contact will exercise private DNS resolution,
   data-plane role propagation delay, and whether the tick job's cold start fits inside its budget.
   This is the single biggest gap between "verified" and "known to work".

2. **Exercise the Azure Tables adapter against Azurite in CI.** 36 contract tests run against the
   in-memory adapter through the port interface, so the _contract_ is proven but the _adapter_ is
   not. Azurite supports Table and would close this cheaply. Note that Azurite does not enforce
   RBAC, so the least-privilege story would still be unproven.

3. **Exercise the Azure OpenAI provider against a real deployment.** Request shaping, parsing,
   validation, retry and degradation are tested against a stub transport. Real models drift, refuse,
   and return prose where JSON was asked for.

### Substantial features

4. **Real identity.** Entra External ID behind the existing `CreatorIdentity` interface. Today's
   cookie is a signed quota key, not ownership — clearing cookies loses your lineages permanently.
5. **Multiple worlds.** `AUTOCOSM_WORLD_ID` exists and partition keys are world-scoped, but nothing
   multiplexes worlds or lets a visitor choose one.
6. **Backups.** Section 8 of `docs/operations.md` says plainly that there are none. Point-in-time
   restore or a scheduled export is the honest minimum before a world becomes precious.
7. **Richer social behaviour.** Trade and theft are representable in the action and event
   vocabularies but the heuristic policy does not pursue them, so they are rare in practice.
8. **Structure decay and succession.** Structures have integrity and can collapse, but there is no
   weathering model and no ecological succession on a collapsed site.
9. **Speciation.** Lineages diverge genetically but there is no reproductive isolation, so there is
   no moment where two populations become distinct species.

### Polish

10. **Lineage tree layout** degrades on very wide generations; it needs proper tree layout rather
    than naive stacking.
11. **Mobile controls.** The layout is responsive but free-fly assumes a keyboard.
12. **Event compaction at scale.** Implemented and bounded, never exercised at multi-million-event
    volume.
13. **Snapshot delta encoding.** The client re-parses the full regional snapshot on every change;
    deltas would cut bandwidth meaningfully in busy regions.
14. **Metrics to Azure Monitor.** Counters exist and are logged; they are not exported as custom
    metrics, so alerting means log queries.
15. **Load testing.** No idea what the real concurrent-observer ceiling is.
16. **Dependency advisories.** Sixteen high-severity `npm audit` findings have no published fix
    ([docs/security.md § 10](security.md#10-dependency-advisories)). Two follow-ups: add the
    `overrides` block as soon as `brace-expansion@5.0.9` / `fast-uri@3.1.5` / `fast-uri@4.1.2`
    ship, and keep the exposure argument true — it rests on the API declaring **no** JSON-schema
    routes and **no** static directory listing, so adding either would make `fast-uri` or
    `brace-expansion` reachable and must be reviewed on that basis.
17. **Babylon WebGPU extension registration.** `@babylonjs/core/Engines/webgpuEngine` side-effect
    imports only 8 of its 14 WebGPU extensions. The remainder are registered solely by
    `webgpuEngineRegistration.pure.js`, which the deep-import path never reaches, so a method that
    works under WebGL2 can be `undefined` under WebGPU. This is not symmetrical with the WebGL
    path: several WebGL extensions self-register lazily from a constructor onto `ThinEngine`, and
    `WebGPUEngine` descends from `ThinWebGPUEngine`, so it inherits none of that. `dynamicTexture`
    was missing and is now imported explicitly in `apps/web-client/src/render/engine.ts`, guarded
    by a GPU-free prototype assertion in `engine.test.ts`. Still unimported and believed unused:
    `multiRender`, `computeShader`, `debugging`, `texture2DArrayImageSource`, `videoTexture`.
    `multiRender` is the one to watch — `prePassRendererSceneComponent` is imported by
    `world-scene.ts`, and the current pipeline (FXAA + bloom + tone mapping) does not engage the
    prepass renderer, but enabling depth of field, SSAO, screen-space reflections or motion blur
    would. Extend `engine.test.ts` when adding any such effect. Headless Chromium falls back to
    WebGL2, so the Playwright suite does not cover this on its own.

### Deliberately excluded

Not oversights. Each was considered and rejected for the MVP.

- **Cosmos DB, Redis, Service Bus, Queue Storage, Blob Storage, Dapr.** Table Storage plus ETag
  leases covers claiming, watermarks and history at this scale. Each addition is fixed cost and
  operational surface for capability the MVP does not need.
- **WebSockets / SignalR.** An always-connected transport defeats `minReplicas: 0`. ETag polling
  with backoff costs a 304 between ticks.
- **An always-on worker.** Scheduled jobs that exit are strictly cheaper and force the idempotency
  discipline that makes restarts safe.
- **One process per agent.** Agents are records processed in batches. Per-agent processes would be
  ruinous at any interesting population.
- **Binary assets.** Procedural geometry and generated textures keep the image small and cold starts
  short.
- **Human world manipulation.** The product boundary. Not a feature gap — the point.
