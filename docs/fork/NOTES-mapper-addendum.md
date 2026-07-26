# NOTES.md addendum — mapper agent

Date: 2026-07-24. Source: `~/Documents/Programming/agent-hub/t3code` @ `hub` (upstream `41a430a88`).

**This file is a delta, not a map.** It contains only findings that are *not* in `NOTES.md`
(written by t3-fork-build). Read `NOTES.md` first — it is accurate and I independently verified its
load-bearing claims (multi-connection registry, MCP injection across five adapters, the
`ProviderRuntimeIngestion` drop, the `CLAUDE_CONFIG_DIR`-not-`HOME` constraint, and the §3.5
continuation-key landmine all check out against the code).

Sections here: one correction, then §7 fork hygiene (absent from NOTES.md entirely), then four
mechanical gaps.

---

## 0. One correction to NOTES.md

**NOTES.md line 75** cites `threadLastActivityAt` at `apps/web/src/components/Sidebar.snooze.ts:7`.
That file is snooze *preset* math (evening/tomorrow/next-week boundaries) and does not contain the
function. The canonical definition is:

- `threadLastActivityAt(shell)` — **`packages/client-runtime/src/state/threadSettled.ts:7`**

It computes the timestamp the schema lacks:
`max(latestUserMessageAt, latestTurn.requestedAt, latestTurn.startedAt, latestTurn.completedAt)`.

Worth stating explicitly because it constrains F1's design: **there is no `last_activity_at`
column.** Activity ordering is necessarily a client-side fold over four fields spread across
`projection_threads` and `projection_turns`, so an activity-sorted dashboard cannot be pushed down
to SQL without a new denormalized column + index.

---

## 7. Fork hygiene

NOTES.md covers what to build. This section covers what upstream will do to us while we build it.
It is the only part of the brief NOTES.md does not touch at all.

History: 2117 commits, 2026-02-07 → 2026-07-24, **~13 commits/day**. The last 500 commits span only
~37 days; the last 90 days is 747 commits. `hub`, `origin/main`, and `upstream/main` are all at
`41a430a88` — a virgin fork. `.gitattributes` is `* text=auto eol=lf` only; no merge drivers, no
`union` strategies.

### 7.1 Churn — hottest files (last 500 commits)

| count | file |
|---|---|
| 34 | `apps/web/src/components/ChatView.tsx` |
| 30 | `pnpm-lock.yaml` |
| 26 | `apps/web/src/index.css` |
| 24 | `apps/web/src/components/Sidebar.tsx` |
| 23 | `apps/server/src/server.test.ts` |
| 21 | `apps/web/src/components/SidebarV2.tsx` |
| **20** | **`apps/server/src/ws.ts`** |
| 19 | `apps/web/src/components/chat/ChatComposer.tsx` |
| 13 | `apps/web/src/components/settings/SettingsPanels.tsx` |
| 12 | `apps/web/src/components/Sidebar.logic.ts` |
| 11 | `packages/contracts/src/settings.ts` |
| **11** | **`apps/server/src/server.ts`** |
| 10 | `apps/server/src/provider/Layers/ClaudeProvider.ts` |
| 9 | `scripts/build-desktop-artifact.ts` |

90-day view (747 commits): `ChatView.tsx` 64, `server.test.ts` 53, **`ws.ts` 51**, `Sidebar.tsx` 40,
**`server.ts` 35**, **`contracts/src/ipc.ts` 32**, `SettingsPanels.tsx` 28,
`.github/workflows/release.yml` 26, `contracts/src/settings.ts` 23, **`contracts/src/rpc.ts` 22**.

Within `apps/web/src` (500-window): `components` **621** vs **`routes` 28**.

### 7.2 Verdict on the files our three features touch

| file | 500 / 90d | verdict |
|---|---|---|
| `apps/server/src/ws.ts` (2150 lines) | 20 / 51 | 🔴 hottest server file — **avoid** |
| `apps/server/src/server.ts` (503 lines) | 11 / 35 | 🔴 hot, but our diff is one `Layer.provide` line |
| `apps/server/src/http.ts` (293 lines) | 6 / ~14 | 🟡 moderate |
| `packages/contracts/src/environmentHttp.ts` | **2** | 🟢 **cold — good for F2** |
| `packages/contracts/src/settings.ts` | 11 / 23 | 🔴 hot — F3 lands here |
| `packages/client-runtime/src/**` | 318 (dir) | 🔴 hot in aggregate but **flat** — no file above 7 |
| `apps/web/src/routes/**` | **28** | 🟢 **cold — good for F1** |
| `apps/web/src/components/SidebarV2.tsx` | 21 | 🔴 hot — the NOTES.md §1 step-3 refactor lands here |
| `persistence/Migrations/` (files) | 2 | 🟢 cold at file level |
| `persistence/Migrations.ts` (registry) | 3 | 🟡 cold count, 100% append-conflict shape |

⚠️ Note the tension with NOTES.md §1 "Smallest additive shape" step 3 (lift the partition block out
of `SidebarV2.tsx:1362-1420`). That is the right refactor for correctness, but it lands a permanent
diff in a 21-touch/500 file. Prefer extracting to a **new** `Sidebar.partition.ts` and leaving a
one-line call site behind, rather than restructuring in place.

### 7.3 Conflict risk per operation, and the absence of any seam

- **New HTTP route** — 🟢 low. See §8 for the exact shape.
- **New web route/page** — 🟢 lowest. `apps/web/src/routeTree.gen.ts` is generated (header at `:7-8`
  says "should NOT make any changes") — **regenerate on conflict, never hand-merge.** Keep nav
  entries in a fork-owned component rather than editing `Sidebar.tsx` or `CommandPalette.tsx` (9/500).
- **New WS RPC method** — 🔴 **worst case, no seam.** Four append-only lists must all be edited:
  `packages/contracts/src/rpc.ts:150-241` (`WS_METHODS` map), `:242-695` (one `Rpc.make` export per
  method, ~65 of them), `:701-772` (`WsRpcGroup = RpcGroup.make(...)`, a **single ~71-argument
  positional call** — both sides appending here conflicts every time), and
  `apps/server/src/ws.ts:1108` (`WsRpcGroup.of({...})`, one object literal running to ~line 2080
  inside the repo's hottest file). Plus 25 files in `packages/client-runtime/src` reference
  `WS_METHODS`.
  **This is the strongest argument for keeping F2 on HTTP.** F3's account-switch *action* is the one
  place we may be forced into an RPC (NOTES.md §3.4 step 2 recommends exactly that, modelled on
  `WsServerUpdateProviderRpc`); if so, append behind a `// ---- FORK METHODS ----` sentinel and put
  the handler *body* in a fork-owned module so the in-place `ws.ts` diff is one line.
- **New SQLite migration** — 🔴 guaranteed conflict; §7.4.

**There is no plugin/extension seam anywhere.** An exhaustive grep for
`registerRoute|addRoute|registerPlugin|extensionPoint|moduleRegistry|registerHandler|registerMethod`
across `apps/server/src`, `packages/contracts/src`, and `packages/client-runtime/src` returns exactly
two files: `provider/Layers/ProviderRegistry.ts` and its test — and that registry is for AI agent
*providers*, not general extensions. The only genuine seams are:

1. **`ExecutionEnvironmentCapabilities`** (`packages/contracts/src/environment.ts:40-54`) — every
   field `optionalKey(Boolean)`, missing = unsupported. This is the same mechanism NOTES.md §1 flags
   as the capability-skew trap, and it is *also* upstream's blessed way to declare fork features so
   fork↔upstream clients and servers interoperate. **Declare our features here.**
2. Effect `Layer` composition at `apps/server/src/server.ts:352-365`.

This codebase is a single-vendor monolith. It was not designed to be forked.

### 7.4 Migrations — the single highest-risk area in the fork

`apps/server/src/persistence/Migrations/` — 34 files, `001_OrchestrationEvents.ts` …
`034_ProjectionThreadsSnoozed.ts`, named `NNN_PascalCaseName.ts`, **strictly sequential, no gaps**,
each default-exporting an `Effect`. They are **statically imported — no filesystem scanning**
(comment at `Migrations.ts:5`). Runner `apps/server/src/persistence/Migrations.ts`:
imports `:16-49`, `migrationEntries` `:61-96`, `makeMigrationLoader` `:98-105`,
`runMigrations` `:127-136`, `MigrationsLive = Layer.effectDiscard(runMigrations())` `:155`.
Tracking table is Effect's default `effect_sql_migrations`.

Adding one migration means editing **two** append-only regions of one file → two conflict hunks per
migration, every time.

**🔴 The silent-skip hazard.** Effect's Migrator
(`node_modules/.pnpm/effect@4.0.0-beta.78…/effect/dist/unstable/sql/Migrator.js:143-159`):

```js
if (new Set(current.map(([id]) => id)).size !== current.length) {
  return yield* new MigrationError({ kind: "Duplicates", ... })   // :147
}
for (const resolved of current) {
  const [currentId] = resolved;
  if (currentId <= latestMigrationId) { continue }                // :156  ← SILENTLY SKIPPED
```

Two consequences:

1. Duplicate ids **hard-fail** at `:147` — the server refuses to boot. Loud, recoverable.
2. Any id `<=` the max already applied is **silently skipped** at `:156`. If our DB has applied fork
   migration `35` and we then merge upstream's own `035_TheirThing`, upstream's migration is
   `35 <= 35` and **never runs**. Schema drift with zero error output.

⚠️ **Corollary: reserving a high id range for the fork (9000+) is catastrophic.** Once
`MAX(migration_id) = 9001`, every future upstream migration (35, 36, 37…) is `<= 9001` and is
silently skipped forever. This is the intuitive defensive move and it is the worst one available.

Rules for our fork:

1. Always append at the **true numeric tail**, above every upstream id. Renumber ours on each merge
   so upstream's new ids land below ours; accept that renumbered migrations re-run.
2. **Write every fork migration idempotently** — non-negotiable given the renumber cycle. 22 of the
   34 upstream migrations already guard with `PRAGMA table_info` / `IF NOT EXISTS`. Model on
   `034_ProjectionThreadsSnoozed.ts`.
3. Add the boot-time assertion the runner lacks, beside `Migrations.ts:130`: after `runMigrations()`,
   verify every id in `migrationEntries` appears in `effect_sql_migrations` and fail loudly
   otherwise. ~15 lines, converts the silent skip into a crash.

(`infra/relay/migrations/postgres/…` is timestamp-named — different DB, conflict-free convention.
Only the SQLite server migrations are sequential.)

### 7.5 Version handshake — there isn't one

No protocol version, no compatibility gate, nothing refuses a connection. The only mechanism is
**exact string inequality on the app version**, surfaced as a dismissible banner.

- Server stamps its `package.json` version at
  `apps/server/src/environment/ServerEnvironment.ts:132-147` into
  `ExecutionEnvironmentDescriptor.serverVersion` (`packages/contracts/src/environment.ts:57-64`),
  embedded in `ServerConfig` (`packages/contracts/src/server.ts:410-426`).
- Client reads it as ordinary stream data via `subscribeServerConfig`
  (`packages/client-runtime/src/state/server.ts:157`) — not at connect time.
- The comparison, `apps/web/src/versionSkew.ts:26-44`:

```ts
if (!normalizedClientVersion || !normalizedServerVersion ||
    normalizedClientVersion === normalizedServerVersion) {
  return null;
}
return { clientVersion, serverVersion, hint: "Version mismatch. Try syncing..." };
```

Plain trimmed string equality — not semver, not a range. Missing on either side fails open. A dev
build (`APP_VERSION` unset → `"0.0.0"`, `apps/web/src/branding.ts:27`) **always** trips it. On
mismatch nothing breaks: a dismissible warning renders at `ChatView.tsx:1812-1906` and
`ConnectionsSettings.tsx:1391,1836,2983-3001`, dismissals in localStorage key
`t3code:version-mismatch-dismissals:v1` (`versionSkew.ts:13,82-133`).

`packages/shared/src/semver.ts` is **not** used for client/server compat — `compareSemverVersions`
(`:92-136`) gates external agent CLI versions, `satisfiesSemverRange` (`:148+`) gates remote Node
engine versions over SSH.

Since our fork changes both client and server, `ExecutionEnvironmentCapabilities` is the real compat
surface, not the version string.

### 7.6 🔴 Server self-update will replace our fork with upstream's npm build

`apps/server/package.json:2` is `"name": "t3"`, and the self-updater hardcodes that name in three
places:

- `apps/server/src/cloud/pinnedRuntime.ts:107-121` — `npm install --prefix <dir> t3@${version}`
  against the **default public npm registry**
- `apps/server/src/cloud/selfUpdate.ts:77-79` — `isPublishedCliEntry` matches `/node_modules/t3/dist/`
- `apps/web/src/versionSkew.ts:61-63` — manual fallback `npx t3@${targetVersion}`

**If we keep the package name `t3`, one click on the version-skew banner's "Update server" button
pulls upstream's npm tarball over our running fork server.** There is no env var or config key to
disable it — and per §7.5 the banner fires on *any* string difference, including every dev build.

Mitigations, in preference order: (1) rename the npm package and patch all three sites plus
`apps/server/src/cli/service.ts:58-109` and `apps/server/src/bin.ts:35,43`; or (2) make
`resolveServerSelfUpdateCapability` (`selfUpdate.ts:91-143`) return `null`, after which the client
degrades cleanly to "Copy update command" (`ServerUpdateAction.tsx:182-189`) with no other loss.

There is no `t3 update` command — the CLI surface is `bin.ts:42-56`
(`start|serve|auth|project|service|connect`); `t3 service update` (`cli/service.ts:95-110`) only
installs `packageJson.version`.

Desktop auto-update is safe by construction: the feed comes from an `app-update.yml` baked in at
build time from `T3CODE_DESKTOP_UPDATE_REPOSITORY` → `GITHUB_REPOSITORY`
(`scripts/build-desktop-artifact.ts:1302-1326`), so inside our fork's Actions it auto-points at our
repo with zero code change. ⚠️ Trap: building locally with `GITHUB_REPOSITORY=pingdotgg/t3code`
exported, or reusing a prebuilt upstream `app-update.yml`. Kill switch:
`T3CODE_DISABLE_AUTO_UPDATE` (`apps/desktop/src/app/DesktopConfig.ts:51`).

### 7.7 Build / release — one hard blocker

One published package: **`t3`** (unscoped), `apps/server/package.json:2`, v`0.0.28`,
`bin: { "t3": "./dist/bin.mjs" }`. Every other workspace package is `private: true`. Toolchain is
Vite+ (`vp`), not turbo/nx. Desktop embeds the *workspace* server build, not npm, via
`scripts/build-desktop-artifact.ts` (1999 lines, which generates the entire electron-builder config
at build time — there is no `electron-builder.yml` and no `build` key in `apps/desktop/package.json`).

To ship our own build, in order of blocking severity:

1. **`relay_public_config` (`.github/workflows/release.yml:169-252`) is a hard dependency of `build`,
   `publish_cli`, and `deploy_web`, and fails on missing Clerk/relay config (`:236-249`).** A naive
   fork release **fails immediately — it does not degrade.** Stand up a relay or gut that job. This
   is the single biggest release-pipeline blocker and worth knowing before anyone tries to tag.
2. Rename the npm package (`t3` is taken) — see §7.6.
3. Register an npm Trusted Publisher for our repo (publish uses OIDC, `release.yml:614-616`; there is
   no `NPM_TOKEN` in the repo) or switch to a token.
4. Desktop identity in `scripts/build-desktop-artifact.ts`: `DESKTOP_APP_ID = "com.t3tools.t3code"`
   (`:37`), artifact name (`:1392`), mac URL schemes (`:1432`), linux `executableName` (`:1451`),
   plus `apps/desktop/src/app/DesktopEnvironment.ts:203-204`.
5. Cloud coupling to decide on: `packages/shared/src/connectAuth.ts:15` (`https://app.t3.codes`),
   `packages/contracts/src/t3ProjectFile.ts:10,86`, `apps/mobile/app.config.ts:61-87` (bundle ids,
   `appleTeamId`, `owner: "pingdotgg"`).

Suggested seam: extract the identity constants to a fork-owned `scripts/lib/fork-identity.ts` so the
permanent diff in `build-desktop-artifact.ts` (9/500, 23/90d) collapses to one import. For
`release.yml` (26 touches/90d) there is no seam — prefer a separate `release-fork.yml` and delete
upstream's, so conflicts resolve as "take theirs" on a file we don't use.

Versioning: no changesets, no release-please. The git tag is the source of truth;
`scripts/update-release-package-versions.ts:49-54` writes it into four `package.json` files and the
`finalize` job commits the bump back to `main`.

### 7.8 Generated files — never hand-edit; regenerate on conflict

| file | generator | churn |
|---|---|---|
| `apps/web/src/routeTree.gen.ts` | `tanstackRouter()` (`apps/web/vite.config.ts:4,94`) | 2/500 |
| `packages/effect-codex-app-server/src/_generated/*.gen.ts` | its `scripts/generate.ts` | **16/500 — regenerate, don't merge** |
| `packages/effect-acp/src/_generated/*.gen.ts` | `packages/effect-acp/scripts/generate.ts` | 2/500 |
| `apps/desktop/src/preview/AnnotationStyles.generated.ts` | `apps/desktop/scripts/build-preview-annotation-css.mjs` | — |
| `assets/{dev,nightly,prod}/*` | `scripts/export-brand-icons.ts` (`vp run icons:export`) | — |

Both `_generated` dirs are produced from upstream JSON Schema **fetched over HTTP** at generate time
(`packages/effect-acp/scripts/generate.ts:14,34-41`), so regeneration requires network.

**`packages/contracts` is 100% hand-written Effect Schema** — 44 files, no generator, no build
script; the RPC layer is type-derived from it. Nothing in contracts is codegen'd.

---

## 8. How to add HTTP routes (the exact shape F2 needs)

NOTES.md §2 lists the existing endpoints but not the mechanics of adding one. Two mechanisms
coexist; use the typed one.

**(a) Typed `HttpApi`.** Groups in `packages/contracts/src/environmentHttp.ts` (`metadata` `:374`,
`auth` `:380`, `orchestration` `:460`, `connect` `:492`) merged into `EnvironmentHttpApi` at
`:553-557`. Auth attaches **per endpoint** via `.middleware(EnvironmentAuthenticatedAuth)` — the
middleware service is declared at `environmentHttp.ts:318-323` and implemented by
`environmentAuthenticatedAuthLayer` (`apps/server/src/auth/http.ts:174-198`), which provides
`EnvironmentAuthenticatedPrincipal`.

Handler shape to copy, `apps/server/src/orchestration/http.ts:21-56`:

```ts
export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    return handlers.handle(
      "shellSnapshot",
      Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* projectionSnapshotQuery.getShellSnapshot().pipe(
          Effect.catch((cause) => failEnvironmentInternal("orchestration_snapshot_failed", cause)),
        );
      }),
    );
  }),
);
```

Scope check is `requireEnvironmentScope` (`apps/server/src/auth/http.ts:164-172`), reading
`EnvironmentAuthenticatedPrincipal.scopes`.

Wiring point — `apps/server/src/server.ts:352-371` (`makeRoutesLayer`):

```ts
HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(connectHttpApiLayer),
  Layer.provide(orchestrationHttpApiLayer),
  Layer.provide(serverEnvironmentHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
),
```

So a new group is 4 edits: group class in `environmentHttp.ts`, `.add(...)` at `:557`, a new handler
file, and one `Layer.provide(...)` line at `server.ts:357`. Only that last line lands in a hot file.

**(b) Raw `HttpRouter.add(verb, path, effect)`** — used only for the OTLP proxy (`http.ts:117`),
assets (`:172`), and static/SPA (`:207`). Auth is manual via `authenticateRawRouteWithScope`
(`http.ts:78-95`) and errors must be converted by hand with `Effect.catchTags`.
⚠️ `staticAndDevRouteLayer` is a `GET "*"` catch-all (`http.ts:207-209`), so a raw route can be
shadowed by it depending on merge order. The typed path avoids this entirely.

**Pagination detail** (NOTES.md notes its absence; here is what it costs us): no
`cursor`/`limit`/`offset` exists anywhere in `packages/contracts/src/orchestration.ts`, and every
list query in `Layers/ProjectionSnapshotQuery.ts` is an unbounded full-table read — the only `LIMIT`s
are `LIMIT 1` single-row lookups. The one cursor concept is the event `sequence`, used for stream
resumption (`afterSequence`), not list paging. If we paginate we invent the convention; the natural
cursor is `(created_at, thread_id)`, matching the existing index
`idx_projection_threads_shell_active` (`Migrations/030_ProjectionThreadShellArchiveIndexes.ts:8`).
**Sorting by activity has no supporting index** — see §0.

---

## 9. Mechanics of per-thread Claude HOME pinning

NOTES.md §3.5 identifies the landmine and recommends option (a) — one instance per account. If that
holds, this section is moot and F3 stays cheap. If we ever want a home pinned *per thread*, here is
the exact work, because it is more invasive than it looks.

Claude's env is frozen at **adapter construction**, not per session: `makeClaudeAdapter`
(`provider/Layers/ClaudeAdapter.ts:1334`) calls `makeClaudeEnvironment` once at `:1343`, and
`ClaudeDriver.create` builds `processEnv` once at `Drivers/ClaudeDriver.ts:127`. Every thread on that
instance shares it. The session-start contract has no room for an override either —
`ProviderSessionStartInput` (`packages/contracts/src/provider.ts:53-64`) carries
`threadId, provider, providerInstanceId, cwd, modelSelection, resumeCursor, approvalPolicy,
sandboxMode, runtimeMode` and nothing else.

Three touch points, in order:

1. Add an optional home/account override to `ProviderSessionStartInput`
   (`packages/contracts/src/provider.ts:53`) so orchestration can thread it through.
2. Move `makeClaudeEnvironment` out of construction (`ClaudeAdapter.ts:1343`) into `startSession`,
   computing per-`input` and feeding `queryOptions.env` (`:3544`) and
   `pathToClaudeCodeExecutable` (`:3525`). The Agent SDK already accepts a per-`query()` env, so this
   is the only structural change required.
3. ⚠️ **Re-key two caches that assume one home per instance**, or resume and session-adoption will
   silently cross-contaminate accounts:
   `makeClaudeContinuationGroupKey` (`Drivers/ClaudeHome.ts:37`, `claude:home:<abs>`) and
   `makeClaudeCapabilitiesCacheKey` (`:44`, `binaryPath\0home\0cwd`).

Point 3 is the trap. NOTES.md §3.1 correctly identifies the continuation key as the account-pinning
primitive; the capabilities cache key is the second one and is easy to miss — it also gates the
5-minute account probe, so a stale entry reports the wrong `auth.email` for a correctly-pinned thread.

Codex needs none of this: `CodexSessionRuntimeOptions.homePath` is already per-session
(`CodexAdapter.ts:1405` → `CodexSessionRuntime.ts:731-735`, which sets `CODEX_HOME`), so a per-thread
Codex home is a plumbed field with no restructuring.

---

## 10. The CLI already mints peer credentials

NOTES.md §2 covers the HTTP pairing-token → `/oauth/token` exchange path. There is a simpler route
for provisioning our four fixed tailnet machines that needs no browser and no UI:

`apps/server/src/cli/auth.ts`:

- **`t3 auth session issue --token-only [--ttl 30d] [--label peer-mac]`** (`:162`) — issues a
  long-lived scoped **bearer token** directly to stdout. ⚠️ It currently grants
  `AuthAdministrativeScopes` (`:177`), which is far broader than a peer needs; our fork should add a
  `--scopes` / `--read-only` flag so peer tokens carry only `orchestration:read`.
- `t3 auth pairing create [--base-url ...]` (`:84`) — pairing link with `AuthStandardClientScopes`
  (`:98`), prints a ready `/pair#token=...` URL.
- `t3 auth session list|revoke` (`:196`, `:216`); `t3 auth pairing list|revoke` (`:116`, `:138`).

So provisioning is: run `t3 auth session issue --token-only` on each of the four machines, hand the
tokens to the peers, and every peer request is an ordinary `Authorization: Bearer <token>` call
against the middleware that already guards `shellSnapshot`. **No credential UI needed for v1** — the
peer registry can be a config file of `{ label, baseUrl, token }`.

---

## 11. Risk framing for the three features

| Feature | Risk | Why |
|---|---|---|
| **F1 dashboard** | 🟢 Low | Runtime spine exists; `apps/web/src/routes/**` is the coldest dir (28/500). Watch: the `SidebarV2.tsx` refactor lands in a 21/500 file (§7.2), and activity sort has no index (§0). |
| **F2 federation** | 🟡 Medium | Cheap on HTTP + the existing `t3-code` MCP server. Becomes expensive the moment it needs a WS RPC method (§7.3). |
| **F3 accounts/usage** | 🔴 High | The §3.5 landmine must be settled first; per-thread pinning has two hidden cache keys (§9); `contracts/src/settings.ts` is hot (23/90d); and the account-*action* path likely forces an RPC. |

**Top three fork-level risks, independent of feature:**

1. Migration renumbering silently drops upstream schema changes (§7.4) — and the intuitive defence
   makes it permanent.
2. The self-updater replaces our fork server with upstream's npm build on one banner click (§7.6).
3. `relay_public_config` hard-fails any fork release out of the box (§7.7) — discovered only when
   someone tries to tag.
