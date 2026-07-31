# starcode recon map — hub features

Date: 2026-07-24. Source: `~/Documents/Programming/agent-hub/starcode` @ `hub` (fork of
`pingdotgg/t3code`, upstream `41a430a88`). Companion to `PLAN.md`.

All paths below are relative to the repo root unless absolute.

---

## Headline corrections to PLAN.md

Three findings change the Phase 2 estimate materially.

1. **PLAN.md line 30 is wrong.** It says the client "connects to one environment at a
   time (no unified multi-machine pane)". It does not. The client runtime is already
   fully multi-connection: N environments connect concurrently at boot, threads from all
   of them are already merged into one flat list, the router is already
   `/$environmentId/$threadId`, and `SidebarV2` already renders a unified
   cross-environment inbox. The unified dashboard is ~80% built.

2. **Federation needs almost no new server work.** A scope-gated read-only HTTP
   thread-detail endpoint already returns full transcripts, `orchestration:read` already
   exists as an independently grantable read-only scope, restricted-scope machine-to-machine
   credentials are already mintable with an anti-escalation guard, and the t3 server already
   acts as an MCP server whose tools are injected into all five provider adapters. Net-new
   is a peer registry plus one toolkit.

3. **Usage/spend data is already produced and then thrown away.** Adapters emit
   `account.rate-limits.updated`, `thread.token-usage.updated`, and a real
   `totalCostUsd` per turn — and the ingestion switch has no case for them. We may not
   need a `ccusage` sidecar for spend at all.

There is also one semantic landmine, in §3.5, that should be settled before any code.

---

## 1. Unified multi-environment dashboard

### What already exists

The whole multi-connection spine is built and in use.

| Layer               | Path                                                        | State                                                                         |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Connection registry | `packages/client-runtime/src/connection/registry.ts`        | N supervisors, all connect at boot with `concurrency: "unbounded"` (:317-334) |
| Per-env supervisor  | `packages/client-runtime/src/connection/supervisor.ts:199`  | own state, own retry, own prepared connection                                 |
| Catalog atoms       | `packages/client-runtime/src/state/connections.ts:29`       | `Map<EnvironmentId, …>`                                                       |
| Shell projection    | `packages/client-runtime/src/state/shell.ts:366`            | `Atom.family(environmentId)`                                                  |
| Merged thread list  | `packages/client-runtime/src/state/threadShell.ts:150-173`  | iterates every catalog key                                                    |
| Router              | `apps/web/src/routes/_chat.$environmentId.$threadId.tsx:86` | env is already in the URL                                                     |
| Cache               | `apps/web/src/connection/storage.ts:36-43`                  | env-keyed IndexedDB (not localStorage)                                        |

`ScopedThreadRef = {environmentId, threadId}` (`packages/contracts/src/environment.ts:95`)
is the addressing scheme, and it is threaded through everywhere already.

`apps/server/src/ws.ts` contains **zero** references to `environmentId`. The server does
not know other environments exist — it _is_ one environment. Federation of the _view_ is
entirely client-side, so the dashboard needs no server changes at all.

The existing unified partition lives at `apps/web/src/components/SidebarV2.tsx:1362-1420`
— it takes `useThreadShells()` (every thread on every connected machine) and splits it
into active / snoozed / settled.

### What is actually missing

- **A ranked selector.** `sortThreadsForSidebarV2` (`apps/web/src/components/Sidebar.logic.ts:464`)
  sorts by static `createdAt` _on purpose_ — the comment at :460 says activity must never
  reorder rows so the screen only moves at lifecycle transitions. A dashboard sorted by
  activity is a deliberate divergence from that taste, not a bug fix. Decide explicitly.
- **A route.** There is none; the sidebar is the only surface.
- **Resolved by the fleet rework.** Sidebar V2 is now the only routed sidebar; the
  feature flag and legacy implementation were deleted. See `docs/fork/PLAN.md`.

The ingredients for ranking are already written:

- `resolveSidebarV2Status` (`Sidebar.logic.ts:411`) → `approval | input | working | failed | ready`
- `threadLastActivityAt` (`apps/web/src/components/Sidebar.snooze.ts:7`)
- `effectiveSettled` / `effectiveSnoozed` / `threadRaisedHandWhileSnoozed`
  (`packages/client-runtime/src/state/threadSettled.ts:242, ~165, 118`)

### Smallest additive shape

1. New route `apps/web/src/routes/_chat.dashboard.tsx` — inherits the `_chat` auth gate free.
2. New pure module `apps/web/src/dashboard/rankThreads.ts` over
   `ReadonlyArray<EnvironmentThreadShell>`, matching the repo's `*.logic.ts` + `*.logic.test.ts`
   convention. Rank needs-attention first, then last-activity desc.
3. Lift the partition block at `SidebarV2.tsx:1362-1420` out of its `useMemo` into a shared
   helper so sidebar and dashboard can't drift. Highest-value refactor here.

Core (`client-runtime`, `contracts`, `server`) needs **zero** changes.

### Traps

- **Capability skew is mandatory.** `threadSettlement` / `threadSnooze` are `optionalKey`
  (`packages/contracts/src/environment.ts:44,49`). A machine on an older server reports
  neither, and `SidebarV2.tsx:1385-1389` correctly refuses to classify its threads. A
  dashboard that skips the `serverConfigs.get(environmentId)` gate silently swallows
  threads from older machines. This is the #1 bug to avoid.
- **N machines means N clocks.** Timestamps originate wherever they were produced; `now`
  is the viewer's. The codebase already guards two-sided (`threadSettled.ts:63`). Reuse
  `firstValidTimestampMs` (`Sidebar.logic.ts:437`), don't roll new comparators.
- **Re-render surface.** Activity sorting re-sorts on every shell event from any machine —
  the opposite of V2's design. The clock is quantized (`useNowMinute`) precisely to stop
  `effectiveSettled` memos thrashing. Quantize the sort key or debounce.
- **Disconnected machines still render** from IndexedDB cache with status `"cached"`
  (`shell.ts:57-72`). Per-row staleness needs wiring; `ConnectionStatusDot.tsx` exists but
  nothing connects liveness to thread rows today.
- `findThreadRef` (`apps/web/src/state/entities.ts:233`) resolves a bare `ThreadId` by
  first-match across all environments — latent collision, more exposed with many machines.

---

## 2. Thread federation

### Storage and read path

Event-sourced write model plus SQLite projections, one DB at `<baseDir>/userdata/state.sqlite`
(`apps/server/src/config.ts:104-114`). Event log `orchestration_events`
(migration `001_OrchestrationEvents.ts:7`); projections from `005_Projections.ts`.

Canonical transcript read is
`ProjectionSnapshotQuery.getThreadDetailSnapshot(threadId)`
(`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:2077`). It wraps the
detail read and the snapshot sequence in one transaction on purpose — a projector landing
between two reads would hand the client a sequence ahead of its data and drop events
(comment at :2080-2084). The transcript itself is
`listThreadMessageRowsByThread` (:786).

### Read API — already federation-shaped

Contract group `EnvironmentOrchestrationHttpApi`
(`packages/contracts/src/environmentHttp.ts:460`):

| Method | Route                                  | Scope                   |
| ------ | -------------------------------------- | ----------------------- |
| GET    | `/api/orchestration/snapshot`          | `orchestration:read`    |
| GET    | `/api/orchestration/shell`             | `orchestration:read`    |
| GET    | `/api/orchestration/threads/:threadId` | `orchestration:read`    |
| POST   | `/api/orchestration/dispatch`          | `orchestration:operate` |

Handlers in `apps/server/src/orchestration/http.ts` (thread detail at :57). Live tail
exists too via WS `subscribeThread` (`apps/server/src/ws.ts:1350`).

A typed client for exactly this endpoint is already written:
`packages/client-runtime/src/state/threadSnapshotHttp.ts:29` — reusable almost verbatim
against a peer.

Unauthenticated `GET /.well-known/t3/environment` (`environmentHttp.ts:375`) is useful for
peer discovery.

### Machine-to-machine auth — already supported

Eight scopes at `packages/contracts/src/auth.ts:76-93`; `orchestration:read` is
independently grantable.

1. `POST /api/auth/pairing-token {label, scopes:["orchestration:read"]}` mints a
   read-only credential. Handler `apps/server/src/auth/http.ts:334` requires `access:write`
   and **enforces no privilege escalation** — every delegated scope must be held by the
   caller (:347-351).
2. `POST /oauth/token` (RFC 8693 exchange) redeems it for a bearer, and narrows further
   if asked (`apps/server/src/auth/EnvironmentAuth.ts:690-698`). Supplying a DPoP
   thumbprint upgrades to proof-of-possession with a 1h TTL (:702-708).
3. Revocation exists (`/api/auth/pairing-links/revoke`, `/api/auth/clients/revoke`).

No new auth machinery required.

### MCP — the injection point already reaches every provider

The t3 server **is** an MCP server at `POST /mcp`
(`apps/server/src/mcp/McpHttpServer.ts:211-217`), with its own per-thread ephemeral bearer
auth (`apps/server/src/mcp/McpSessionRegistry.ts:105`) that binds each tool call to
`{environmentId, threadId, providerSessionId, providerInstanceId, capabilities}`.

All five adapters already mount that single `starcode` server:

| Provider | File:line                                        |
| -------- | ------------------------------------------------ |
| Claude   | `provider/Layers/ClaudeAdapter.ts:3521,3549`     |
| Codex    | `provider/Layers/CodexAdapter.ts:1397,1414-1425` |
| Cursor   | `provider/Layers/CursorAdapter.ts:534,542-556`   |
| Grok     | `provider/Layers/GrokAdapter.ts:572,582`         |
| OpenCode | `provider/Layers/OpenCodeAdapter.ts:1217-1232`   |

**Adding a tool to that server makes it appear in every running agent session. Zero
adapter changes.**

### `peer-threads` work items

1. `apps/server/src/mcp/toolkits/peerThreads/tools.ts` + `handlers.ts`, mirroring the
   existing `toolkits/preview/` pair.
2. Register in the `Layer.mergeAll` at `McpHttpServer.ts:206-209`.
3. Extend `McpCapability` (`McpInvocationContext.ts:10`, currently the single literal
   `"preview"`) and the issued set (`McpSessionRegistry.ts:117`).
4. **Peer registry** (peer id → `{baseUrl, bearerToken, label}`) — the only genuinely
   net-new component.

### Gaps

- **Archived threads 404** on the detail endpoint — `getActiveThreadRowById`
  (`ProjectionSnapshotQuery.ts:751`) filters `deleted_at IS NULL AND archived_at IS NULL`.
- **No pagination** — a long transcript returns every message in one payload.

---

## 3. Accounts + usage panel

### 3.1 Per-instance Claude home is real — and it is `CLAUDE_CONFIG_DIR`

`apps/server/src/provider/Drivers/ClaudeHome.ts:33` sets `CLAUDE_CONFIG_DIR`, and the
comment at :27-32 says they deliberately do **not** override `HOME`, because that
relocates the macOS login keychain and breaks OAuth lookup ("Not logged in"). Directly
relevant if `claude-swap` moves `~/.claude` around.

Account pinning primitive: `makeClaudeContinuationGroupKey` (:37-42) returns
`claude:home:<resolvedPath>`.

Schema `ClaudeSettings.homePath` at `packages/contracts/src/settings.ts:252-260`, titled
"CLAUDE_CONFIG_DIR path". `ClaudeDriver` declares `supportsMultipleInstances: true`
(`Drivers/ClaudeDriver.ts:114`).

Codex is richer: `homePath` (`CODEX_HOME`) **plus** `shadowHomePath`
(`settings.ts:208-219`) which keeps `auth.json` separate while sharing state — so two
Codex accounts sharing a home get the same continuation key and _can_ be swapped mid-thread.
Claude cannot (`docs/providers/claude.md:78-89`).

Per-thread binding is `OrchestrationSession.providerInstanceId`
(`packages/contracts/src/orchestration.ts:276`), persisted in
`provider_session_runtime.provider_instance_id` (migration 027) and
`projection_thread_sessions.provider_instance_id` (migration 028).

### 3.2 The probe already knows _which_ account

`ServerProviderAuth = {status, type?, label?, email?}` (`packages/contracts/src/server.ts:52-58`),
carried on `ServerProvider` (:157-194).

Claude's `probeClaudeCapabilities` (`provider/Layers/ClaudeProvider.ts:706-760`) is clever:
it spawns the Agent SDK with a **never-yielding prompt generator** (:719-724), reads
`initializationResult()`, then aborts — so it learns the account without ever making an API
request. It extracts `{email, subscriptionType, tokenSource, apiProvider}` (:734-747).

So per instance, live-streamed, we already get: instance id, display name, accent colour,
driver, installed, version, status, **auth.status, auth.email, auth.label (plan tier)**,
checkedAt. Codex has the full ChatGPT plan enum (`CodexProvider.ts:70-102`).

Cadence: 60s default, **Claude overrides to 5 min** (`ClaudeDriver.ts:59`). Disk-cached per
instance at `<baseDir>/caches/<instanceId>.json` (`providerStatusCache.ts:43-73`). Reaches
the client via `subscribeServerConfig`. Already rendered as "Authenticated as <blurred
email> · <plan>" at `ProviderInstanceCard.tsx:580-596`.

**This is the closest existing thing to the accounts panel and it is most of it.**

### 3.3 Usage / rate limits / spend — produced, then dropped

Contracts define it all (`packages/contracts/src/providerRuntime.ts`):

- `ThreadTokenUsageSnapshot` (:307-324) — input/cached/output/reasoning tokens, tool uses, duration
- `TurnCompletedPayload` (:361-370) — includes `usage`, `modelUsage`, and
  **`totalCostUsd`** (:367)
- `AccountRateLimitsUpdatedPayload` (:537-540) — `Schema.Unknown` passthrough

Producers emit it: Claude `rate_limit_event` → `account.rate-limits.updated`
(`ClaudeAdapter.ts:2906-2914`) and **`totalCostUsd: result.total_cost_usd`**
(`ClaudeAdapter.ts:1975, 2050`); Codex `thread/tokenUsage/updated` (:735-750) and
`account/rateLimits/updated` (:1127-1138), with typed rate-limit schemas already generated
in `packages/effect-codex-app-server/src/_generated/schema.gen.ts:20273-20280, 37819-37880`.

**Where it dies:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` has
**no case** for `account.rate-limits.updated`, `account.updated`, or `auth.status` — they
fall through `default: break` at :682-687. `thread.token-usage.updated` is projected only
as a thread-scoped context-window activity (:596-614). `totalCostUsd` has **no consumer
anywhere**. The only durable trace is the NDJSON provider log
(`EventNdjsonLogger.ts:35,248-260` → `<baseDir>/userdata/logs/provider/events.log`).

Codex even has a _pull_ RPC `account/rateLimits/read` generated but **never called** in
`apps/server`.

Existing usage UI: one thread-scoped `ContextWindowMeter.tsx`. No rate-limit UI, no spend
UI, no persisted usage, no per-account aggregation. Nothing resembling `ccusage`.

**Consequence: spend may need no sidecar at all** — projecting `totalCostUsd` per
thread/instance gives real per-turn spend from data already flowing.

### 3.4 Sidecar integration — server-side proxy, not client fetch

Client-side direct fetch is wrong here for three concrete reasons: the browser often isn't
on the sidecar's machine (relay-managed environments); CORS allows only
`authorization, b3, traceparent, content-type, dpop` with a credentialed origin allowlist
including custom scheme `starcode://app` (`apps/server/src/httpCors.ts:1-14`,
`http.ts:43-59`); and the sidecar would be unauthenticated on the LAN.

Recommended shape:

1. **Data — extend the provider snapshot.** Add optional `usage`/`rateLimits` to
   `ServerProvider` (`packages/contracts/src/server.ts:157-194`) and populate inside the
   driver's `enrichSnapshot` hook (`makeManagedServerProvider.ts:112-126`) by calling the
   sidecar over **loopback**. Inherits for free: per-instance identity, refresh cadence,
   on-demand `serverRefreshProviders`, disk cache across restarts, streaming to all clients,
   and existing render slots. Zero new transport, zero new auth.
   Bonus: the settings form is schema-driven (`ProviderSettingsForm.tsx:35-80`) — adding a
   field to the contract renders it automatically.
2. **Actions (switch / re-login) — a new WS RPC.** Model on `WsServerUpdateProviderRpc`
   (`packages/contracts/src/rpc.ts:280-284`) + `providerMaintenanceRunner.ts:42-52`, which
   already implements instance-scoped long-running child processes with a lock key, 5-min
   timeout, truncated output capture, and a streamed
   `idle|queued|running|succeeded|failed|unchanged` state machine the card already renders
   (`ProviderInstanceCard.tsx:651-694`). Gate on `AuthOrchestrationOperateScope`.
3. **Raw HTTP route only if streaming is needed** — copy `otlpTracesProxyRouteLayer`
   (`http.ts:117-170`) and extend `browserApiCorsAllowedMethods`.

Note `apps/web/src/state/server.ts:60-100` currently exposes only `primary*` atoms; a hub
panel needs the family form. `serverEnvironment.configProjection` in client-runtime is
already a family, so this is a small lift.

Prior art for reading account files directly: `apps/server/src/telemetry/Identify.ts:244-291`
reads `~/.codex/auth.json` and `~/.claude.json` — but only to hash an identity.

### 3.5 The semantic landmine — settle this before writing code

starcode keys accounts by **provider instance** (a config entry with its own
`CLAUDE_CONFIG_DIR`). `claude-swap` keys them by **credential rotated into one home**.

If a sidecar swaps credentials underneath a home, then `ServerProvider.auth.email` for that
instance changes silently while `continuation.groupKey` (`claude:home:<path>`) does **not**.
starcode will then happily continue an existing thread on a different account — exactly what
its own design intends to prevent (the model picker filters candidates by group key,
`ModelPickerContent.tsx:169-173`).

Two ways out:

- **(a)** Map each CCC account to a distinct `homePath` instance, so t3's model stays honest.
  This is PLAN.md open decision #2 resolved in favour of per-thread pinning, and it is the
  recommended path.
- **(b)** Accept the drift and force `serverRefreshProviders({instanceId})` after every swap.

---

## Revised effort read

PLAN.md estimates Phase 2 at ~1–2 weeks part-time. Given the above:

| Feature           | Revised                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified dashboard | Much smaller — one route + one pure ranking module + one refactor. No core edits.                                                                           |
| Thread federation | Small–medium — peer registry + one MCP toolkit. No auth work, no adapter work.                                                                              |
| Accounts + usage  | Medium — the accounts half is largely done; usage/spend needs projection work (possibly no sidecar for spend), and account _actions_ are genuinely net-new. |

The fork's additive-diff discipline (PLAN.md line 51) looks very achievable: the three
features touch mostly new files plus a handful of one-line registrations.
