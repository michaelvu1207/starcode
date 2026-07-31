# REWORK — one thread model, one roster, one auth

Status: IMPLEMENTED AND ROLLED OUT (2026-07-31)

This plan reworked the fork's architecture so the features it already claimed
actually work, without changing how the app feels. It was a refactor with a
spine, not a rewrite: ~417k lines of hand-written source (470k including
generated schemas) was far past the size where a clean-sheet rebuild was honest.

The implementation completed Phases 0–5. The rollout passed G0–G6 on 2026-07-31:
the three-node disposable rig, integrated web and iOS clients, a fresh Ubuntu
ARM64 onboarding target, the four-node tailnet fleet, and the packaged macOS
desktop app all exercised the same architecture. The live G0 provider session
surfaced 27 StarCode tools with no fetch error, discovered all four nodes with
zero failures, and received an exact simforge1 reply through `thread_send` in
approximately 28 seconds.

---

## 1. The methodology, stated as invariants

These are the rules the architecture must be derivable from. Everything below is
downstream of them.

1. **One person, many clients.** A client (phone, laptop, web) is a _viewer_. It
   owns no state that matters. Losing it loses nothing.
2. **Many machines, one fleet.** A machine is an address for an execution
   environment. "Which machine" is a routing detail, never a concept the user or
   an agent has to hold.
3. **The thread is the only noun.** Work is a thread. A thread lives on some node,
   in some project. Everything else — projects, connections, features, the
   workbench — is a _view over threads_.
4. **Threads are mutually reachable.** A thread can discover and message any other
   thread in the fleet without knowing where it lives.
5. **Setup is driven, not documented.** Adding a machine is an agent task, not a
   runbook.

Invariant 4 is the one the current architecture violates outright, and invariants
2 and 3 are the ones it violates structurally.

---

## 2. Diagnosis: one domain model, implemented twice

`docs/architecture/remote.md` already defines a clean client-side model —
`ExecutionEnvironment`, `KnownEnvironment`, `AccessEndpoint`,
`AdvertisedEndpoint`. It is good and it should survive.

The fork then built a second copy of it on the server, and did not notice:

| Concept           | Client-side (upstream)                   | Server-side (fork)                        |
| ----------------- | ---------------------------------------- | ----------------------------------------- |
| A machine         | `KnownEnvironment` + `AccessEndpoint`    | `PeerEnvironment` (`peers.json`)          |
| Reaching it       | pairing token → session, `wsTransport`   | stored bearer, `PeerEnvironmentClient`    |
| Listing threads   | WS projections                           | HTTP `orchestration` → `PeerThreadReader` |
| Creating a thread | WS `thread.create` + `thread.turn.start` | `PeerThreadWriter.createThread`           |
| …on this machine  | —                                        | `LocalThreadWriter` (a _third_ copy)      |

**"Create a thread and start a turn" is written three times.** The only shared
part is `threadPlacement.ts`, extracted after the fact. `PeerEnvironment` is
`KnownEnvironment` with a different name and a second credential system.

It is then exposed through three protocols, each with its own authorization model:

| Binding | File                                                | Auth model                       |
| ------- | --------------------------------------------------- | -------------------------------- |
| Client  | `apps/server/src/ws.ts` (2,150 lines)               | client session                   |
| Peer    | `packages/contracts/src/environmentHttp.ts` (1,018) | peer bearer + OAuth scopes       |
| Agent   | `apps/server/src/mcp/`                              | per-thread bearer + capabilities |

Three models that must agree and have no shared definition. This is not a style
problem — it is the direct cause of the live defects:

- `credentialClass: "read"` gates the **HTTP** path; `capabilities` gates the
  **MCP** path. A session can hold `peers` capability and still be refused,
  because the _other_ model says no. Every cross-machine send on this fleet 403s
  today.
- Discovery lives only in the peer binding, so `peer_threads_list` cannot see
  local threads and no local equivalent exists. A thread cannot find its
  neighbour on its own machine.
- One malformed tool schema (`PeersListInput = Schema.Struct({})`) removes all 24
  tools from every Claude thread, because nothing validates the MCP surface the
  way the other two bindings are validated.

Secondary accumulation, to be dealt with only after the spine is right:

- `Sidebar.tsx` (3,643) and `SidebarV2.tsx` (1,719) are both live, switched by the
  `sidebarV2Enabled` client setting. 5,362 lines for one navigation surface.
- `docs/fork/PLAN.md` is 1,757 lines of F1–F17 plans, several shipped into
  surfaces nothing routes to.

---

## 3. Target architecture

**One `ThreadService`. Three thin bindings. One roster. One capability model.**

```
   client (web/mobile/desktop)     agent session (MCP)       peer node
            │ WS                        │ HTTP                  │ HTTP
            └──────────────┬────────────┴──────────┬────────────┘
                           │                       │
                  ┌────────▼───────────────────────▼────────┐
                  │             ThreadService               │  the only place
                  │  list · read · send · create · archive  │  thread lifecycle
                  │             · turn                      │  is expressed
                  └────────┬───────────────────────┬────────┘
                           │                       │
                  ┌────────▼────────┐     ┌────────▼────────┐
                  │ local           │     │ remote          │
                  │ OrchestrationEng│     │ FleetClient     │
                  └─────────────────┘     └─────────────────┘
```

### 3.1 ThreadService

`ThreadService.send(threadId, message)` resolves local-vs-remote _itself_, by
looking the thread up in the fleet index. **No caller ever passes a node.**

That one property is what makes invariant 4 true. It collapses
`LocalThreadWriter` + `PeerThreadWriter` into one module and makes
`threadPlacement.ts` an internal detail rather than a shared-by-coincidence file.

### 3.2 Fleet roster — auto-synced, transitive

`peers.json` → `fleet.json`. A node record reuses `AdvertisedEndpoint` from the
client model; it does **not** invent a second endpoint type.

- Pairing A↔B is **symmetric and transitive**: on register, both sides exchange
  and merge full rosters. Pairing a new machine once makes it known to all.
  This kills the O(n²) hand-wired mesh — 4 machines went from 12 CLI invocations
  to 1.
- Reconcile on connect and on an interval. Merge by `environmentId`; newest
  `updatedAt` wins per record.
- Removal writes a **tombstone**, so a stale roster cannot resurrect a machine
  you deliberately dropped.

**`credentialClass` is deleted.** A node is in the fleet or it is not. What a
_session_ may do is decided per session — the model MCP already uses — not per
pairing. This removes the `--operate` flag, the read/operate split, and the
entire class of bug that silently made this fleet read-only.

### 3.3 Fleet thread index

Each node caches `{ threadId → node, project, title, status, lastActivityAt }`
for the whole fleet, refreshed on the reconcile tick and pushed on change.

- One tool family: `threads_list`, `thread_read`, `thread_send`, `thread_create`.
- `node` is an optional **filter**, never a routing argument.
- Local and remote threads are returned by the same call, uniformly.
- `peer_*` tools survive one release as deprecated aliases so running threads do
  not break mid-turn.

### 3.4 One capability model

A single `ThreadCapability` module defines who may do what. All three bindings
call it. Scopes, `credentialClass`, and MCP capabilities collapse into it. A
binding's job becomes: decode → authorize → call ThreadService → encode.

### 3.5 Session bootstrap — push, not pull

Today a Claude thread is told nothing: `ClaudeAdapter.ts` sets
`systemPrompt: { type: "preset", preset: "claude_code" }` with no append. The
excellent guidance already authored in project `notes` is reachable only by
calling `project_get`, which nothing tells an agent to do.

At session start, append a compact block: who you are (thread id, title), which
node, which project, the project's notes, the fleet roster, whether you are an
orchestrator, and that `threads_list` exists.

### 3.6 Explicitly out of scope

Not touched: the WebSocket transport itself, the relay (`infra/relay`), the
generated Codex/ACP schemas (53k lines, generated), the visual work from F11 /
F13 / F17, and the provider adapters beyond their MCP wiring.

---

## 4. Phases

Each phase is independently shippable, leaves the app working, and ships only
after passing its gate in §5.

### Phase 0 — Repair (2–3 days) · no architecture change

Prove the features work _before_ restructuring. Nothing here is throwaway.

1. Normalize tool `inputSchema` in `capabilityToolFilter` — the seam already
   parses and rewrites `tools/list`. Any schema lacking `type: "object"` becomes
   `{type:"object",properties:{},additionalProperties:false}`. Also fix
   `PeersListInput`. Immunizes the whole class. The repaired legacy surface
   returned 24 tools; the completed architecture exposes 27 after adding the
   canonical thread family.
2. Re-pair the three peers with `--operate`. Config only. → cross-machine send
   works.
3. Add a local `threads_list`, shipped inside the existing toolkit. → discovery
   works.
4. Append the session bootstrap block (3.5). → agents know any of this exists.

**Exit criterion:** a thread on `mac` messages a thread on `simforge1` and gets a
reply, unattended.

### Phase 1 — ThreadService (1–1.5 weeks)

Collapse `LocalThreadWriter`, `PeerThreadWriter`, and the `ws.ts` create/turn path
into one service. Introduce the fleet thread index. Ship `thread_*`; alias
`peer_*`. Phase 0's `threads_list` becomes a ThreadService call rather than a
special case.

### Phase 2 — Fleet roster (1 week)

`peers.json` → `fleet.json`. Transitive pairing, reconcile, tombstones. Delete
`credentialClass`, `--operate`, and the read/operate scope split. Adopt
`AdvertisedEndpoint`.

### Phase 3 — Unify client connections with fleet nodes (1–1.5 weeks)

`KnownEnvironment` and the fleet roster become two views of one thing. Connecting
a client to **any** node shows the whole fleet's threads. The sidebar lists
threads across machines natively, with the node as metadata rather than as a mode
you switch into.

**This is the phase where "one client, threads on every connection" becomes
literally true**, rather than something the user assembles by switching
connections.

### Phase 4 — Onboarding agent (3–5 days)

Small, because the foundation is now right. An agent that: detects the tailnet,
SSHs to the target (reuse `packages/ssh` — auth, config, command, tunnel all
exist), installs and starts starcode, pairs it into the fleet in **one** call,
then verifies by creating a thread on it and messaging it. Ships as the first-run
flow.

Built before Phases 0–2, this agent would inherit every current bug: it would run
with no tools, pair read-only nodes, and be unable to see the threads it created.

### Phase 5 — Deletion pass (ongoing)

- Delete `Sidebar.tsx` (~3,600 lines) and the `sidebarV2Enabled` setting; keep
  V2. _(Decided 2026-07-30.)_
- Audit the F1–F17 backlog for shipped-but-unrouted surfaces.
- Fold `docs/fork/PLAN.md` down to what is still true.

---

## 5. End-to-end verification

There is currently **no E2E harness** — no Playwright, no e2e suite, nothing in
`package.json` beyond unit tests. Verification is manual, via the
`test-starcode-app` / `test-starcode-mobile` skills. For a fleet feature that is
not good enough: the defects in §2 are all _integration_ defects that every unit
test passed straight through. A Zod rejection of `tools/list` cannot be caught by
any test that does not run a real MCP client against a real server.

So each phase gets a gate, and the gates get a rig.

### 5.1 The local fleet rig

The key enabler: `vp run dev --home-dir <dir>` starts a **fully isolated
environment** — its own state directory, own port, own `environmentId`. Nothing
stops us running three of them on one machine.

```bash
# three disposable nodes on one laptop
for n in alpha beta gamma; do
  d=$(mktemp -d /tmp/starcode-fleet.$n.XXXXXX)
  vp run dev --home-dir "$d"     # record port + pairing URL per node
done
```

Each is a real `ExecutionEnvironment` with its own `fleet.json`. A three-node
fleet — enough to prove transitive pairing, cross-node discovery, and routing —
becomes a **disposable local rig**, not a four-machine coordination exercise.

This matters for a second reason. The project's own iron rule is _never
hot-restart the server hosting your own session_, and rollouts should be driven
from a different connection than the one being rolled out. With a disposable rig
that is automatic: your session lives on the hub, the rig is throwaway.

**Driver:** the server already exposes 14 `preview_*` browser-automation tools
(`preview_open`, `preview_click`, `preview_type`, `preview_wait_for`,
`preview_snapshot`). starcode can drive its own UI. Gates below are scripted
against that surface, with `starcode-sqlite-state.ts query` for state assertions.

**What the rig cannot prove**, and what therefore needs the real fleet: tailnet
routing, real SSH onboarding, cross-OS behaviour (macOS / Linux / Windows —
`path-pc` is the only Windows node), and real latency. Those are called out
explicitly in G4 and G6.

### 5.2 Gates

| Gate | Phase                  | Rig                         | Proves                                 |
| ---- | ---------------------- | --------------------------- | -------------------------------------- |
| G0   | 0 — Repair             | real fleet                  | the four defects are actually dead     |
| G1   | 1 — ThreadService      | 3-node local                | one thread API, local + remote uniform |
| G2   | 2 — Fleet roster       | 3-node local                | transitive pairing, tombstones         |
| G3   | 3 — Client unification | 3-node local + web + mobile | one client sees the whole fleet        |
| G4   | 4 — Onboarding agent   | real fleet, fresh box       | a machine joins unattended             |
| G5   | 5 — Deletion           | 1-node local + web + mobile | nothing regressed                      |
| G6   | all                    | real fleet                  | the rollout actually landed            |

---

**G0 — the defects are dead.** On the live fleet, because these are defects _of_
the live fleet.

1. Start a Claude thread; assert `mcp-logs-starcode` contains **no**
   `Failed to fetch tools`, and that the current session lists 27 tools.
2. From a thread on `mac`, `thread_send` to a thread on `simforge1`. Assert a
   turn starts there within 60s — not a mailbox row with a null `delivered_at`.
3. `threads_list` from a thread returns its **own machine's** threads.
4. Assert the session bootstrap block is present in the thread's system prompt.

Pass: all four, unattended, no human in the loop. The final live run passed from
thread `86e46de1-3f0e-4054-90e2-eb25b02a48df`: all four fleet nodes responded,
the session bootstrap identified the Mac thread and node, and simforge1 returned
the exact requested acknowledgment in approximately 28 seconds.

**G1 — one thread API.** 3-node rig, pairwise-paired manually (Phase 2 has not
landed yet).

- `threads_list` with no filter returns threads from all three nodes _and_ the
  caller's own, in one response, same shape.
- `thread_send(id)` with **no node argument** reaches a thread on another node.
- `thread_create` on a remote node starts a turn; the new thread appears in the
  index within one reconcile tick.
- Deprecated `peer_*` aliases still work — a thread mid-turn must not break.
- Regression: kill node `gamma` mid-call. `threads_list` degrades to the
  surviving nodes with a `failures` entry, and does not hang or error the whole
  call.

**G2 — the roster is transitive.** 3-node rig, fresh.

- Pair `alpha`↔`beta`. Pair `beta`↔`gamma`. Assert **`alpha` can now reach
  `gamma`** without an explicit third pairing. This is the milestone that retires
  the O(n²) mesh, and it is the single most important assertion in the plan.
- Remove `gamma` from `alpha`. Reconcile. Assert `gamma` does **not** reappear
  from `beta`'s roster — the tombstone holds.
- Assert no `credentialClass` remains anywhere in `fleet.json` or the codebase.
- Restart a node; assert its roster survives and reconciles rather than
  re-pairing.

**G3 — one client, every connection.** 3-node rig + the two client skills. This
is the gate for the plan's headline claim, so it is the strictest.

- _Web_ (`test-starcode-app`): pair a browser to `alpha` **only**. Assert the
  sidebar lists threads from all three nodes, with the node shown as metadata —
  not as a mode you switch into. Open a `gamma` thread from an `alpha`-paired
  client and send a message.
- _Mobile_ (`test-starcode-mobile`): same assertion on one iOS Simulator, per
  AGENTS.md. Confirms `client-runtime` unification did not diverge.
- Assert the connection switcher no longer changes _which threads exist_, only
  which node new work defaults to.
- Screenshot diff against pre-Phase-3 for the sidebar, chat view, and command
  palette — **"feels the same" is a testable claim and this is where it gets
  tested.**

**G4 — a machine joins unattended.** Real fleet, and it must be a genuinely fresh
box (a clean VM is fine, and cheaper than a spare laptop).

- The onboarding agent is given a hostname and nothing else.
- It detects the tailnet, SSHs in, installs, starts starcode, pairs into the
  fleet, and reports the new node.
- Assert: exactly **one** pairing act; the new node appears in all pre-existing
  nodes' rosters; a thread created on it from an existing client runs and can be
  messaged.
- Negative cases, because this is the flow a human meets first: wrong hostname,
  SSH key not installed, port already bound, starcode already present. Each must
  produce a _diagnosis_, not a stack trace.

**G5 — nothing regressed.** After the deletion pass.

- Full web suite + repo typecheck + build (the documented pre-push gates).
- `test-starcode-app` and `test-starcode-mobile` walkthroughs of the flows that
  touched `Sidebar.tsx`: thread list, project grouping, new thread, search,
  archive.
- Assert `sidebarV2Enabled` is gone from settings and no dead import remains.

**G6 — the rollout landed.** Per the standing pipeline in `PLAN.md`, run from a
**different connection than the one being rolled out**.

- Mac launchd hub: `vp i` → build → kickstart.
- The three remote servers: pull → `vp i` → build → restart.
- Desktop app: rebuild and swap into `/Applications`, then relaunch via
  `cua-driver call launch_app` — never `open -a`. Assert a single LaunchServices
  path first.
- Post-rollout smoke: G0's four assertions, on the real fleet, on the shipped
  build.

### 5.3 What becomes permanent

G0–G2 are scripted against the local rig, so they are **automatable** and should
land in CI as the fork's first real integration suite — the thing whose absence
let a one-line schema change silently disable 24 tools across the fleet for three
days. G3–G6 stay human-in-the-loop; they involve real devices, a real tailnet,
and a judgement call about whether the app still feels right.

---

## 6. What "feels the same" means

Unchanged: sidebar, chat view, projects, command palette, and all visual work
from F11 / F13 / F17.

Changed, and only in ways you asked for:

- threads from other machines appear in your list natively;
- "connections" stops being a second mental model;
- agents can find and message each other;
- adding a machine is a conversation, not a runbook.

---

## 7. Honest scale note

~417k lines of hand-written source. Realistic net deletion across Phases 1–5 is
**8–12k lines** — meaningful but not transformative, and anyone promising a
dramatic line-count drop is not looking at the code.

The win is conceptual, and it is large:

| Today                                             | After                 |
| ------------------------------------------------- | --------------------- |
| 3 implementations of "create a thread"            | 1                     |
| 2 rosters (`KnownEnvironment`, `PeerEnvironment`) | 1                     |
| 3 authorization models                            | 1                     |
| 12 CLI invocations to pair 4 machines             | 1 per new machine     |
| Agents told nothing about the fleet               | Told at session start |

---

## 8. Open questions

1. **Tombstone lifetime.** How long does a removed node stay a tombstone before
   it can be re-paired cleanly? Proposed: 30 days, matching credential lifetime.
2. **Orchestrator designation.** `workbenchMasterThreadId` is a single global
   thread, and every project currently reports `hasMaster: false`. Should
   orchestrator become a per-project role in Phase 1, or stay global until
   Phase 3?
3. **Mobile.** `apps/mobile` (56k lines) consumes `client-runtime` and should
   need no restructuring beyond Phase 3's connection unification — worth
   confirming before Phase 3 rather than during.
4. **Index staleness.** How stale may the fleet thread index be before a
   `thread_send` to a vanished thread is a hard error rather than a retry?
5. **CI cost of the rig.** G0–G2 need three dev servers plus provider sessions
   per run. Cheap locally, not free in CI. Run the full rig on merge to `hub`
   only, with a single-node smoke on every PR?
6. **G4's fresh box.** A clean VM is the cheap answer, but it will not catch the
   Windows-specific path and service issues that `path-pc` would. Accept a
   Linux VM for the gate and treat Windows onboarding as a separate follow-up?
