# Security

Autocosm's security posture rests on one idea: **there is no credential to steal, because there is
no credential.** Storage is unreachable from the internet, Shared Key authorisation is switched off
at the account, and the only way in is a workload managed identity with table-scoped data-plane
RBAC.

This document explains how that is enforced, where it is verified, and what is deliberately weak.

---

## 1. The observer boundary

The product boundary is a security boundary. It is enforced in four independent layers, so removing
any single one still fails a test.

### Layer 1 — the route table

```ts
// apps/world-web/src/server.ts
export const MUTATION_ROUTES: readonly string[] = [
  'POST /api/v1/agents',
  'POST /api/v1/agents/:agentId/goals',
];
```

`apps/world-web/src/api.test.ts` walks Fastify's _actual_ route table after boot and asserts that
the set of non-GET routes equals exactly that list. Adding a third mutation route — a reset, a seed,
a teleport, a resource grant, a trait edit — fails the build. There is nothing to remember and
nothing to review; it simply cannot merge.

### Layer 2 — the service surface

`apps/world-web/src/world-service.ts` exposes `createAgent` and `submitGoal`. There is no method
that writes an organism, a structure, a resource, a region or a world event. The API layer could not
mutate world state even if a route existed to ask it to.

### Layer 3 — Azure RBAC

The web workload's managed identity has, at the Table data plane:

- **Storage Table Data Contributor** on exactly four tables: `agents`, `lineages`, `goals`,
  `control`.
- **Storage Table Data Reader** on ten: `worlds`, `regions`, `lineagenodes`, `organisms`,
  `structures`, `materials`, `resources`, `memories`, `signals`, `events`.
- **No role at all** on `decisions`.

A remote code execution in the public web container yields an attacker who can create agents and
submit goals — which any visitor can already do — and read public world data, which is already
public. They cannot write an organism, fabricate an event, or forge an AI proposal. The privilege
boundary is enforced by Azure, not by our code.

### Layer 4 — the renderer

The spectator is a Babylon.js `FreeCamera` with collisions disabled. It has no organism record, no
position in the simulation, and no representation in any snapshot. There is nothing client-side to
manipulate, because the observer does not exist in the world model at all.

---

## 2. Storage: private by construction

Seven properties on the storage account, all asserted against the compiled ARM JSON in
`tests/infra/policy.test.ts`:

| Property                    | Value      | Why                                     |
| --------------------------- | ---------- | --------------------------------------- |
| `publicNetworkAccess`       | `Disabled` | no internet path to the account, at all |
| `networkAcls.defaultAction` | `Deny`     | default-deny even for the private path  |
| `networkAcls.bypass`        | `None`     | no "trusted Azure services" hole        |
| `allowSharedKeyAccess`      | `false`    | account keys cannot authorise anything  |
| `allowBlobPublicAccess`     | `false`    | no anonymous blob surface               |
| `supportsHttpsTrafficOnly`  | `true`     | no plaintext                            |
| `minimumTlsVersion`         | `TLS1_2`   | no downgrade                            |

`allowSharedKeyAccess: false` is the load-bearing one. With it set, an account key is not merely
secret — it is **inert**. Even a leaked key authorises nothing. That is why the repository can
honestly promise that no key exists anywhere: possessing one would not help.

### Network path

```text
Container Apps infra subnet          Private endpoint subnet
10.20.0.0/23                         10.20.2.0/24
delegated: Microsoft.App/environments   NSG attached
                                        privateEndpointNetworkPolicies: Disabled
        │                                        │
        │                                        ├── Table private endpoint
        │                                        │       │
        └────────── VNet 10.20.0.0/22 ───────────┘       │
                            │                            │
                            └── privatelink.table.core.windows.net
                                (private DNS zone, linked to the VNet)
                                        │
                                        └── A record → private endpoint NIC
```

Inside the VNet, `st<name>.table.core.windows.net` resolves through the private DNS zone to a
private IP. There is no public IP to resolve to, because public network access is disabled.

Only the **Table** private endpoint exists. No Blob, no Queue, no File — the MVP does not use them,
and each unused endpoint is both a cost and an attack surface.

### Table creation is deliberately not granted

Creating a table is a _control-plane_ right
(`Microsoft.Storage/storageAccounts/tableServices/tables/write`). The data-plane roles above
deliberately do not include it. So all 15 tables are declared in `infra/modules/storage.bicep` and
`AzureTableWorldRepository.initialise()` **skips creation in production** — it only pings to verify
reachability. Locally, against Azurite, it still creates on demand.

This was a real bug caught while writing the infrastructure: the original code called `createTable`
unconditionally and would have 403'd on first production start. The lesson generalises — writing the
least-privilege policy first surfaces places where the application quietly assumed more.

---

## 3. Identity: local versus production

The same code path runs in both. The difference is entirely configuration, and the guardrail refuses
the wrong combination rather than adapting to it.

|                           | Local development                              | Production                                  |
| ------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `AUTOCOSM_STORAGE_DRIVER` | `memory` (or `azureTables` + Azurite)          | `azureTables`                               |
| Credential                | none, or the well-known Azurite dev credential | `DefaultAzureCredential`                    |
| `AZURE_CLIENT_ID`         | unset                                          | the workload's UAMI client ID, set by Bicep |
| Endpoint                  | `http://127.0.0.1:10002/devstoreaccount1`      | `https://<account>.table.core.windows.net`  |
| Network                   | localhost                                      | private endpoint inside the VNet            |

### The guardrail

`packages/storage/src/guardrails.ts` runs at startup in every workload that touches storage and
throws `InsecureStorageConfiguration` — crashing the process — on any of:

- an empty table endpoint;
- an endpoint containing `accountkey=`, `sharedaccesssignature`, `sig=`,
  `defaultendpointsprotocol=`, `?sv=` or `se=`, in _any_ environment;
- the local emulator selected while `NODE_ENV=production`;
- a connection string supplied in production;
- a production endpoint that is not HTTPS;
- a production endpoint that is not a Table service endpoint.

Crashing is the point. A process that silently authenticated with a shared key and kept serving
would be far worse than a visible crash loop.

### Why `AZURE_CLIENT_ID` is set explicitly

A Container App can have several identities assigned. `DefaultAzureCredential` with no client ID
picks one by an order that is not obvious from the app's own configuration. Bicep sets
`AZURE_CLIENT_ID` per workload to that workload's own UAMI, so credential selection is unambiguous
and a misconfiguration is a startup failure rather than a silent privilege escalation.

---

## 4. Least privilege, table by table

Three separate user-assigned managed identities. No workload can do another's job.

| Table          | web         | tick        | think       |
| -------------- | ----------- | ----------- | ----------- |
| `worlds`       | read        | contributor | —           |
| `regions`      | read        | contributor | —           |
| `agents`       | contributor | contributor | —           |
| `lineages`     | contributor | contributor | —           |
| `lineagenodes` | read        | contributor | —           |
| `organisms`    | read        | contributor | —           |
| `structures`   | read        | contributor | —           |
| `materials`    | read        | contributor | —           |
| `resources`    | read        | contributor | —           |
| `memories`     | read        | contributor | —           |
| `signals`      | read        | contributor | —           |
| `goals`        | contributor | contributor | —           |
| `events`       | read        | contributor | —           |
| `decisions`    | **none**    | contributor | contributor |
| `control`      | contributor | contributor | contributor |

Role definition IDs used, all built-in:

| Role                           | GUID                                   | Assigned to     |
| ------------------------------ | -------------------------------------- | --------------- |
| Storage Table Data Reader      | `76199698-9eea-4c19-bc75-cec21354c6b6` | web (10 tables) |
| Storage Table Data Contributor | `0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3` | per table above |
| AcrPull                        | `7f951dda-4ed3-4680-a7ca-43fe172d538d` | all three       |
| Cognitive Services OpenAI User | `5e0bd9bd-7b93-4f28-af87-19fc36ad61bd` | **think only**  |

Every assignment is scoped to a single table:

```text
/subscriptions/…/storageAccounts/{acct}/tableServices/default/tables/{table}
```

not to the account. The policy test asserts that no data-plane role assignment has an
account-level scope.

**The thinker's privilege set is the interesting one.** It holds Table Data Contributor on
`decisions` and `control` and _nothing else_ — it cannot read a single world table. It does not need
to: the agent's permitted observation is computed by the simulation during the tick and embedded in
the decision record. The component that talks to a language model is the component with the least
access to the world. That is not a coincidence; it is the design.

### Roles the policy test asserts are _absent_

- AcrPush `8311e382-0749-4cb8-b61a-304f252e45ec` — runtime identities pull, never push.
- Storage Account Contributor `17d1049b-9a84-46fb-8f53-869881c3d3ab` — no control-plane rights.
- Storage Blob Data Contributor `ba92f5b4-2d11-453d-a403-e96b0029c9fe` — blob is not used.
- Any `Owner` or `Contributor` at resource-group scope.

---

## 5. No secrets, anywhere

| Claim                                                              | How it is verified                                                                                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No storage key, connection string, SAS token or SAS URL is created | `app.json` contains **no** `listKeys` call at all; `foundation.json` contains no `listKeys` against a storage account                                            |
| No secret is emitted as a deployment output                        | every output name is checked against `/key\|secret\|password\|connectionstring\|sas/i` and every output value against `listKeys\|listAccountSas\|listServiceSas` |
| No secure parameter other than the prototype cookie key            | `foundation.bicep` has zero `@secure()` parameters; `app.bicep` has exactly one, `creatorSigningKey`                                                             |
| The browser never receives a storage URL                           | the client's only origin is the web app; `read-model.ts` composes DTOs that contain no endpoint, account name, partition key or row key                          |
| Azure OpenAI uses managed identity                                 | endpoint and deployment name are plain parameters; there is no API-key parameter and no `api-key` header in `azure-openai-provider.ts`                           |
| No long-lived Azure credential in CI                               | `.github/workflows/ci.yml` uses `azure/login` with `permissions: id-token: write` and OIDC federation; no publish profile, no client secret                      |

`platform.bicep` _does_ call `listKeys` on the Log Analytics workspace, because the Container Apps
managed environment requires the workspace shared key in `appLogsConfiguration`. That is platform
wiring, not a storage credential, and the assertion is narrowed to storage accounts specifically so
the difference is explicit rather than hand-waved.

---

## 6. Prototype identity — a deliberate, documented weakness

The MVP has no real accounts.

`apps/world-web/src/identity.ts` mints a random creator ID, signs it with HMAC-SHA-256 using
`AUTOCOSM_CREATOR_SIGNING_KEY`, and returns it in an `HttpOnly`, `SameSite=Lax`, `Secure`-in-
production cookie. `CreatorIdentity` is an interface so Entra External ID can replace it without
touching the API surface.

**What this gives you:** per-creator quotas that are meaningfully hard to bypass casually, and a
stable identity across a browser session.

**What it does not give you:** ownership. Clearing cookies loses your lineages permanently. Anyone
who copies the cookie value can act as you. There is no password, no email, no recovery, no
revocation. The agent-creation dialog says so in the UI.

Do not build anything on top of it that assumes it is an authentication system. It is a quota key
with a signature.

### The signing key

`app.bicep` derives it deterministically when not supplied:

```bicep
uniqueString(resourceGroup().id, 'autocosm-creator-1') +
uniqueString(subscription().subscriptionId, namePrefix, 'autocosm-creator-2')
```

Stable across redeployments — unlike `newGuid()`, which would invalidate every creator cookie on
every deploy — and absent from source control, unlike a literal. It is _not_ strong: anyone with ARM
read access on the resource group can recompute it. Given that the thing it protects is a prototype
quota key, that is an acceptable and consciously chosen tradeoff, and supplying a real
`creatorSigningKey` parameter from a key vault reference is a one-line change when identity becomes
real.

---

## 7. Model output is untrusted input

Text returned by Azure OpenAI is treated exactly like a request body from the internet.

1. **Parse.** JSON extraction with a bounded size limit. A non-JSON response is a rejection, not an
   exception.
2. **Validate.** A Zod schema for the versioned proposal envelope. Unknown action types, extra
   fields and out-of-range numbers all fail.
3. **Allow-list.** The action type must be one of the 14 known types.
4. **Re-check in the simulation.** Even a perfectly-shaped proposal is validated again at resolution
   time against visibility, range, ownership, energy cost, material cost, cooldown, maturity,
   evolved capability, target existence and world version — 16 distinct rejection reasons.
5. **Bound.** Request tokens, completion tokens, decisions per run, decisions per day, retries,
   per-lineage cooldown, and a wall-clock budget.

The model has no database handle, no network egress of its own, no filesystem access and no tools.
It receives a rendered string and returns a string. A fully adversarial model can, at absolute
worst, cause its own proposals to be rejected.

### What is never logged

`packages/observability/src/logger.ts` redacts, and `observability.test.ts` asserts it: full model
prompts, hidden reasoning, credentials, creator tokens, cookie values, storage endpoints and
unbounded memory contents. What _is_ logged: correlation ID, world ID, tick, job execution ID,
decision ID, action type, outcome, duration, and a summary capped at 180 characters.

---

## 8. HTTP hardening

| Control        | Implementation                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secure headers | `@fastify/helmet` with a CSP that permits the app's own scripts and WASM for the Babylon.js WebGPU path                                           |
| CORS           | same-origin only; the browser is served by the same app that serves the API                                                                       |
| Body limit     | `AUTOCOSM_MAX_BODY_BYTES`, default 16 KiB — creation and goal payloads are tiny                                                                   |
| Rate limit     | `AUTOCOSM_RATE_LIMIT_PER_MINUTE` per IP, default 240                                                                                              |
| Quotas         | `AUTOCOSM_MAX_AGENTS_PER_DAY` (3) and `AUTOCOSM_MAX_GOALS_PER_DAY` (6) per creator, rolling day, server-side                                      |
| Idempotency    | `Idempotency-Key` header, `^[A-Za-z0-9_.:-]{8,128}$`, replays the prior response verbatim                                                         |
| Error mapping  | `mapError()` collapses unknown failures to a generic 500 with no message from the cause, so a storage or Azure detail can never reach the browser |
| Seeding        | `AUTOCOSM_ALLOW_LOCAL_SEEDING` — production startup **fails** if it is enabled                                                                    |

---

## 9. Verifying it yourself

```bash
npm run infra:build     # compiles both templates and runs 48 policy assertions
npm run test:integration # storage contract + API boundary + infra policy
npm run test            # everything, 307 tests
```

The policy assertions run against the **generated ARM JSON**, not the Bicep source, so a refactor
that changes how a property is expressed still has to produce the same deployed result. They cover:
storage privacy, private endpoint and DNS, network shape, identity least privilege, the observer
boundary as RBAC, container platform configuration, application configuration, and the absence of
secrets.

To scan for credential material in tracked files:

```bash
npm run scan:secrets
```

`scripts/scan-secrets.mjs` walks everything `git ls-files --cached --others --exclude-standard`
reports and fails on a storage account key, a storage connection string, a SAS token or signature,
a PEM private key, an inline API key, a bearer literal, or `AZURE_CLIENT_SECRET`. It runs as part
of `npm run verify` and in CI.

Six files are allow-listed, each because its purpose is to detect or reject the shape, so the
shape has to appear literally:

| File                                               | Why                                         |
| -------------------------------------------------- | ------------------------------------------- |
| `packages/observability/src/logger.ts`             | defines `SECRET_PATTERNS` for log redaction |
| `packages/observability/src/observability.test.ts` | proves redaction replaces them              |
| `packages/storage/src/guardrails.ts`               | defines the startup guardrail               |
| `packages/storage/src/storage-contract.test.ts`    | proves the guardrail throws                 |
| `docs/security.md`                                 | this document                               |
| `scripts/scan-secrets.mjs`                         | the scanner's own pattern table             |

The two account keys that appear in tests are `Zm9vYmFy` (base64 for `foobar`) and the single
letter `b`. Neither authenticates anything.

---

## 10. Dependency advisories

`npm audit` reports **16 high-severity findings** on a clean `npm ci`. None of them are
fixable today, and saying so plainly is more useful than a green badge.

Both trace to exactly two packages, and **neither has a patched version published**. The
advisories were filed against version ranges whose fix releases do not yet exist on the
registry:

| Package           | Installed | Advisory says fixed in | Latest actually published |
| ----------------- | --------- | ---------------------- | ------------------------- |
| `brace-expansion` | 5.0.8     | 5.0.9                  | **5.0.8**                 |
| `fast-uri`        | 3.1.4     | 3.1.5                  | **3.1.4**                 |
| `fast-uri`        | 4.1.1     | 4.1.2                  | **4.1.1**                 |

`npm audit fix` cannot resolve them; an `overrides` block pinning the fixed versions fails
with `ETARGET — no matching version found`. There is nothing to upgrade to. Re-check with:

```bash
npm view brace-expansion version   # when this reads 5.0.9, add the override
npm view fast-uri@3 version        # when this reads 3.1.5
npm view fast-uri@4 version        # when this reads 4.1.2
```

### What actually ships

Eight of the sixteen are dev-tooling only (`eslint`, `@typescript-eslint/*`), pruned by
`npm ci --omit=dev` in the Dockerfile. The other eight reach the runtime image:

```text
@fastify/static → glob → minimatch → brace-expansion    (ReDoS/DoS, CWE-400/770)
fastify → @fastify/ajv-compiler → ajv → fast-uri        (host confusion, CWE-436)
fastify → fast-json-stringify → fast-uri
```

### Assessed exposure: low, and why

Neither vulnerability is reachable from untrusted input in this codebase. This is an
argument from how the code is wired, not an assumption:

- **`brace-expansion`** needs a brace pattern to expand. `@fastify/static` is registered with
  a fixed `root` and no `list` option (`apps/world-web/src/server.ts`), so directory listing
  is off and `glob` is never driven by a request path. Fastify's radix router matches URLs;
  `glob` does not see them.
- **`fast-uri`** is used by `ajv` and `fast-json-stringify` to resolve schema `$ref`/`$id`
  URIs. Autocosm validates with **Zod**, not JSON Schema: the codebase contains zero
  `schema: {}` route definitions and zero `addSchema` calls, so ajv compiles nothing at
  runtime. Host confusion also only becomes a vulnerability when a parsed URI authority
  drives a security decision such as an SSRF allow-list — the API makes no outbound request
  from a user-supplied URI.

The residual risk is that a future contributor adds a JSON-schema route or enables directory
listing and silently makes one of these reachable. That is a review concern, recorded in
`docs/roadmap.md`.

Verify the split yourself:

```bash
npm audit                       # 16 high — everything
npm audit --omit=dev            #  8 high — what ships
npm ls brace-expansion --omit=dev --all
```

---

## 11. Known gaps

Stated plainly rather than buried.

- **Prototype identity.** Section 6. Cookie theft is agent theft.
- **Sixteen unfixable npm advisories.** Section 10 — no patched versions exist upstream.
- **No WAF or DDoS Standard.** Container Apps ingress is the only protection; the rate limit is
  application-level. Acceptable for a hobby-scale world, not for a target.
- **The signing key is recomputable** by anyone with ARM read access to the resource group.
- **Never deployed.** Every claim here is verified against compiled ARM and unit tests. No Azure
  resource has been created from these templates, so first contact with a real subscription is
  unproven — particularly private DNS resolution and the exact data-plane role propagation delay.
- **The Azure Tables adapter has never run against real Azure Storage or Azurite.** Its behaviour is
  covered by 36 contract tests through the port interface plus Azure-specific unit tests.
- **No secret rotation story**, because there are no secrets to rotate. When real identity arrives,
  one will be needed.
