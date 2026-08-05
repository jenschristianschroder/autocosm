# Repository instructions for GitHub Copilot

## Mission and product boundary

This repository builds **Autocosm**, a persistent browser-based 3D evolutionary world whose autonomous AI agents perceive, evolve, construct, and change the environment.

Humans are non-physical observers. They may explore, inspect history and lineages, create a new basic-cell agent, and occasionally submit a broad motivational goal. They may never directly move organisms, collect resources, construct objects, alter terrain or weather, rescue an agent, edit live traits, or otherwise mutate authoritative world state. Do not add public UI or API controls that cross this boundary.

Agents propose typed, grounded actions. The deterministic simulation alone validates prerequisites and costs, resolves outcomes, and persists world changes. Model output is untrusted input, never authority. Agents may not directly access persistence, tools, the network, or side effects.

## Architecture invariants

- Use strict TypeScript in an npm-workspaces monorepo on the current Node.js LTS release.
- Keep domain and simulation packages deterministic and independent of React, Fastify, Azure SDKs, rendering, and model providers.
- Use ports/adapters for storage, clocks, IDs, and decision providers. Tests use deterministic clocks, seeded IDs/randomness, and an in-memory storage adapter.
- Use React + Vite for UI, Babylon.js for WebGPU with WebGL2 fallback, Fastify for the same-origin API/static host, Zod at every external or persisted boundary, Vitest for tests, and Playwright for browser smoke tests unless an existing equivalent is already established.
- Produce one container image with explicit `web`, `tick`, and `think` modes. Never create one process or container per agent.
- The web process serves bounded snapshots and accepts only agent-creation and broad-goal mutations. The tick job owns deterministic world advancement. The think job owns bounded batches of structured action proposals.
- Frequent survival behavior is deterministic and inexpensive. Invoke AI only for meaningful decisions such as discovery, a new broad goal, reproduction strategy, construction, or social conflict.
- Use polling with ETags and backoff. Do not introduce WebSockets, SignalR, Dapr, Redis, Cosmos DB, Service Bus, Queue Storage, or Blob Storage without a documented architectural decision and explicit approval.

## Simulation and domain rules

- Never call `Math.random()` in simulation code. Use an injected seeded PRNG and stable ordering.
- A tick must be replayable from prior state, accepted actions, logical time, and seed. Retries or concurrent executions must not double-apply it.
- Distinguish inherited genotype, per-organism lifetime state/learning, and culturally transmitted knowledge.
- Traits always impose tradeoffs. Intelligence is emergent from supporting sensing, memory, communication, and energy—not a direct upgrade.
- Agent identity belongs to a lineage and persists through descendants. Individual organism death remains consequential.
- Observations are local and incomplete. Do not leak global state into an agent’s prompt or heuristic policy.
- Persist creations with material composition, geometry/structure, derived functions, creator/lineage, location, condition, and usage history. Derive function from material properties and construction; never accept a model-declared capability at face value.
- Validate every proposed action after parsing. Check visibility, range, ownership, energy/material cost, cooldown, evolved capability, target existence, and current world version.
- Bound coordinates, quantities, memories, payloads, loops, catch-up work, model tokens, and retries. Document units.
- Events are append-only, compact, versioned, attributable, and idempotent. Do not store hidden model reasoning.

## Azure security requirements

These are non-negotiable production constraints:

- Azure Storage public network access is disabled.
- Storage network ACL default action is deny with no bypass.
- Shared Key authorization and Blob public access are disabled; HTTPS and TLS 1.2+ are required.
- The MVP uses Azure Table Storage through a Table private endpoint and linked `privatelink.table.core.windows.net` private DNS zone.
- Browser code never calls Azure Storage and never receives a Storage URL, key, connection string, or SAS.
- Azure workloads use separate managed identities, `DefaultAzureCredential`, an explicit `AZURE_CLIENT_ID`, the normal Table endpoint, and narrowly scoped data-plane RBAC.
- Never add a production connection-string or shared-key fallback. Azurite credentials are allowed only in explicit local/test mode, and production startup must reject them.
- Only `world-web` has external ingress. Container Apps Jobs have no ingress.
- Use a Consumption workload profile and scale-to-zero settings. Avoid fixed-cost networking and compute.
- The thinker alone receives the Azure OpenAI inference role. Azure OpenAI authentication uses managed identity; endpoint and deployment name are configuration, not secrets.
- Runtime identities receive image pull only, never image push.
- CI/CD uses GitHub OIDC federation. Never add publish profiles, client secrets, or long-lived Azure credentials.

When editing Bicep, validate both syntax and the generated ARM properties. Infrastructure changes must preserve private DNS, private endpoint routing, managed identities, RBAC scope, disabled Storage public access, disabled Shared Key, and no job ingress.

## Persistence rules

Use Azure Table Storage for the MVP. Partition by bounded access patterns such as world/region/epoch. Respect Table entity/property limits; never place an unbounded snapshot, history, transcript, or collection in one entity. Stored records are versioned and Zod-validated. Use ETags for optimistic concurrency, expiring claims for pending decision work, deterministic tick/event IDs, and a committed watermark for catch-up. Do not hide cross-partition partial failure; design operations to be idempotent and repairable.

The public API composes bounded regional snapshots. Paginate histories and cap snapshot radius and response bytes. Keep Azure resource topology and internal partition/row keys out of public response contracts unless the value is an opaque domain identifier.

## API and UI rules

- Version public routes under `/api/v1` and validate request, response, stored data, and AI output.
- Use structured errors, request-size limits, secure headers, same-origin CORS, rate limits, and idempotency keys for writes.
- Agent creation chooses starting nature and habitat, not guaranteed survival or outcomes.
- Broad goals are immutable, rate-limited, recorded, and motivational only.
- Production has no reset, seed, arbitrary action, teleport, resource-grant, trait-edit, or direct simulation endpoint.
- The spectator has no world collision and no simulated presence.
- Render inherited traits visibly. Prefer procedural assets, instancing, culling, LOD, and restrained post-processing over large binary assets.
- Support WebGPU and WebGL2 fallback, responsive layouts, keyboard navigation, reduced motion, and explicit loading/cold-start/stale/offline/error states.
- Keep the browser render loop separate from server simulation ticks; interpolate visual state without inventing authoritative outcomes.

## Coding standards

- Prefer small cohesive modules, explicit types, pure functions, dependency injection at boundaries, and exhaustive tagged unions for actions/events.
- Avoid `any`, unchecked casts, non-null assertions, ambient mutable singletons, hidden I/O, and swallowing errors. If a cast is unavoidable, validate immediately before it and explain why.
- Use UTC ISO timestamps at I/O boundaries and logical integer ticks inside the simulation.
- Validate environment variables once at startup with a typed schema. Never read `process.env` throughout domain code.
- Use structured logging with correlation, tick, job, decision, and world IDs. Never log credentials, creator tokens, full model prompts, hidden reasoning, or unbounded memory.
- Keep public contracts versioned and backwards-compatible or provide a migration.
- Comments explain invariants and tradeoffs, not obvious syntax. Update documentation when behavior or architecture changes.
- Do not claim a feature is implemented when it is only mocked, planned, or represented by static demo data.

## Required workflow for every change

1. Inspect relevant code, tests, docs, and configuration before editing; preserve unrelated work.
2. State the smallest end-to-end change and its acceptance criteria.
3. Add or update tests with implementation. Simulation bug fixes require a deterministic regression test.
4. Run the narrowest relevant tests while iterating, then formatting check, lint, strict type-check, full tests, and production build before completion.
5. For browser changes, run the Playwright happy path and check for uncaught console errors.
6. For infrastructure changes, run `az bicep build` and security-policy assertions against generated ARM JSON.
7. For container/runtime changes, verify all three modes start correctly and jobs exit after bounded work.
8. Search tracked changes for secrets, keys, connection strings intended for Azure, and SAS tokens.
9. Report commands and results honestly. If a required tool or service is unavailable, say exactly what was not verified and leave a reproducible command for it.

Maintain a local, Azure-free seeded demo using the in-memory adapter and deterministic heuristic decision provider. No task is complete if a fresh developer cannot follow the README to install, run, test, and see the living world without cloud credentials.
