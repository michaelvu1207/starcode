# StarCode fleet plan

Status: implemented and rolled out
Updated: 2026-07-31

This is the living plan for the StarCode fork. The former F1–F17 design diary was
useful while the fork was exploratory, but it mixed shipped behavior, abandoned
alternatives, and future ideas. `docs/fork/REWORK.md` records the architectural
decision that replaced it. This file now contains only the operating model,
current feature disposition, permanent gates, and remaining release work.

## Release evidence

The fleet rework passed its final gates on 2026-07-31.

- Focused implementation verification covered 94 test files and 1,304 tests,
  plus affected typechecks, lint, formatting, and deployable builds.
- The production three-node rig passed canonical local/remote list, read, send,
  and create; compatibility aliases; partial-node failure; transitive roster
  convergence; tombstone removal; and restart persistence.
- The integrated web client and an iOS Simulator showed fleet-wide threads and
  projects from one anchor connection, including cross-node open/send and
  new-thread placement.
- A fresh Ubuntu ARM64 target joined through the Connections onboarding flow,
  converged into the roster, ran its verification thread, and was then removed
  through the same shipped UI.
- The real four-node roster contains the Mac, simforge1, path-pc, and
  simforgelaptop with no reconciliation failures.
- Final G0 ran in packaged StarCode on the Mac. It surfaced exactly 27 StarCode
  MCP tools with no fetch error, found the current local thread across all four
  nodes with zero failures, verified the credential-free `<starcode_fleet>`
  bootstrap, and received the exact simforge1 acknowledgment through
  `thread_send` in approximately 28 seconds.
- The packaged desktop and all three remote services were rebuilt and restarted
  from the final `hub` source state.

## Product model

StarCode is one workspace for one person operating agent threads across a fleet
of machines.

The product follows five invariants:

1. A client is a viewer. Losing a phone, browser, or laptop loses no authoritative
   thread state.
2. Machines form one fleet. Machine choice is placement metadata, not a separate
   mode for finding work.
3. A thread is the unit of work. Projects, connections, workbenches, and agent
   groups are views over threads.
4. A thread can discover and message another thread by thread ID without knowing
   its machine.
5. Adding a machine is a driven onboarding flow, not a manual runbook.

## Current architecture

### Threads

`ThreadService` is the domain boundary for list, read, send, create, turn, and
archive lifecycle behavior.

- Client WebSocket, authenticated environment HTTP, and agent MCP bindings call
  the same service and `ThreadCapability` policy.
- The canonical MCP family is `threads_list`, `thread_read`, `thread_send`, and
  `thread_create`.
- Callers route reads and sends by thread ID. A node may filter a list or select
  new-thread placement, but it is not a routing argument for an existing thread.
- Deprecated `peer_*` MCP names are compatibility aliases for one release. They
  do not carry separate policy or lifecycle implementations.
- Local projection changes and fleet reconciliation refresh the fleet thread
  index. Index reads may report partial-node failures without failing the whole
  list.

### Fleet

`fleet.json` contains public node metadata, revisions, and tombstones. Credentials
remain in the server secret store.

- Registration is symmetric and exchanges the complete roster.
- Reconciliation is failure-tolerant and runs after mutations and on a bounded
  interval.
- Records merge by `updatedAt`; tombstones win timestamp ties and expire after
  30 days.
- Explicit re-registration clears an older tombstone.
- Removing a node revokes its tagged sessions and invalidates client bootstrap
  credentials.
- The old `credentialClass` and `--operate` pairing mode no longer exist.
- `peers.json` migration is one-time. Only still-valid administrative
  credentials can migrate; old peer secrets and the legacy file are removed.

### Client connections

The shared client runtime treats one persisted connection as a fleet anchor.

- An authenticated anchor polls `/api/fleet/client-bootstrap`.
- The response adds other fleet nodes as ephemeral, in-memory connections.
- Derived credentials are never persisted.
- Credential rotation replaces the affected supervisor; topology failures retain
  the last usable snapshot.
- Web and mobile consume the same fleet coordinator and entity projections.
- All-machine thread and project visibility is the default. Machine selection
  affects only where new work is placed.

### Session bootstrap

Claude and Codex sessions receive a compact, credential-free bootstrap block:

- current thread ID and title;
- current node;
- logical project title, slug, and notes;
- reachable fleet nodes;
- fleet, project, or worker role;
- canonical thread tools and thread-ID routing guidance.

Metadata is escaped and credential-shaped text is redacted before it reaches a
provider prompt.

### Machine onboarding

Settings → Connections exposes “Add a machine to this fleet.”

Given a hostname, the flow:

1. discovers the current tailnet and resolves the peer;
2. runs SSH and host preflight;
3. bootstraps pinned Node on supported clean Linux/macOS hosts when necessary;
4. installs the exact public StarCode fork commit embedded in the desktop build;
5. starts a tailnet-reachable server;
6. performs one fleet registration;
7. waits for roster/client convergence;
8. creates a verification thread and requires a completed assistant response.

Production installation uses a verified GitHub codeload archive and does not
require Git or an upstream `t3` package. Wrong hostname, unreachable SSH,
authentication failure, unsupported host, occupied port, and already-installed
reuse have structured outcomes.

## Client surfaces

### Web

Only Sidebar V2 is routed. The legacy sidebar, its feature flag, its preview
helper, and the Beta settings panel are deleted.

The retained experience includes:

- fleet-wide active and archived thread lists;
- cross-machine logical project grouping;
- new-thread placement selection;
- thread search, archive, and project views;
- agent-run ownership and provider-neutral transcript presentation;
- connections, usage, workbench, feature-flow, history import, and right-panel
  surfaces;
- the StarCode visual system, motion, sky, and glass treatments.

### Mobile

Mobile uses the same client runtime and V2 thread model as web.

- Active and archived lists span the fleet.
- Logical projects span copies on different machines.
- Child-agent rows keep stable task identities.
- The only machine chooser is new-task placement.
- Grouped V1 list modules and stale presentation preferences are deleted.

### Desktop

Desktop owns local backend lifecycle, secure settings, SSH onboarding, packaged
fork installation, and macOS LaunchAgent control.

- The stable macOS service label is `com.starcode.server`.
- Install/status/repair/uninstall operations are atomic and rollback-aware.
- Self-update accepts stable StarCode checkouts and preserves the fork safety
  switch.
- `starcode pair` issues one administrative fleet credential and may configure
  Tailscale Serve.

## Feature disposition

The old F-number labels are historical only.

| Former area                               | Disposition                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| F1–F3 setup, pairing, and peer federation | Superseded by LaunchAgent/service lifecycle, `starcode pair`, transitive fleet roster, and `ThreadService`. |
| F4 connections                            | Retained as fleet status and onboarding; no machine-scoped thread mode.                                     |
| F5/F12 history                            | Retained as import and provider-history projection; legacy history-view switching is not a navigation mode. |
| F7 workbench and orchestration            | Retained through projects, feature flow, master/worker roles, mailbox, goals, and session bootstrap.        |
| F8/F9 sidebar and agent rows              | Retained in Sidebar V2 only.                                                                                |
| F10 accounts and usage                    | Retained, including current pricing/account work.                                                           |
| F11/F13/F17 brand, motion, sky, and glass | Retained.                                                                                                   |
| F14 awareness/relay work                  | Retained where routed through current project and agent-run surfaces.                                       |
| F15 split view                            | Deferred; it is not part of the fleet rework and has no partial hidden route.                               |
| F16 cross-machine projects                | Retained through project catalog and logical project membership.                                            |

Shipped-but-unrouted duplicate implementations should be deleted, not preserved
behind new feature flags. New visual or workflow ideas belong in a focused issue
or plan, not in this operating document.

## Permanent verification gates

The disposable rig starts three real source servers with isolated homes and
ports. Its production driver uses authenticated fleet HTTP and MCP, not an
in-memory substitute.

| Gate              | Required evidence                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 repair         | Live provider session has a valid canonical tool list, no tool-fetch failure, local discovery, cross-node delivery/reply, and the session bootstrap block.              |
| G1 thread service | Three-node canonical list/read/send/create by thread ID; deprecated aliases; partial failure when one node stops.                                                       |
| G2 roster         | Alpha↔beta plus beta↔gamma gives alpha→gamma reachability; tombstone convergence; restart persistence; no credential class.                                             |
| G3 clients        | A web client and an iOS client connected only to alpha show all nodes; gamma opens and receives a message; placement changes do not hide threads.                       |
| G4 onboarding     | A genuinely fresh tailnet host joins from hostname only, with one registration, full roster convergence, a runnable verification thread, and actionable negative cases. |
| G5 deletion       | Focused affected-package tests/typechecks/builds plus web/mobile walkthroughs for list, grouping, create, search, and archive; no legacy sidebar flag/import.           |
| G6 rollout        | Local hub, remote fleet servers, and packaged desktop all run the same committed build; post-rollout G0 passes.                                                         |

The real three-node G1/G2 rig belongs in CI for `hub`. UI/device and real-tailnet
gates remain integrated release checks.

## Focused verification policy

For normal changes:

- run the smallest affected Vitest files;
- run affected package typechecks;
- run targeted lint and formatting;
- build only affected deployable packages;
- use `test-starcode-app` after user-visible web changes;
- use `test-starcode-mobile` on a representative iOS Simulator after shared or
  mobile behavior changes.

Do not use repo-wide suites as a routine local gate. CI owns the full matrix.

## Rollout procedure

Rollouts run from a different connection than the server being restarted.

1. Verify the integrated tree and scan it for credentials.
2. Commit the exact source state and push `hub`.
3. Build server, web, mobile development client, and desktop artifact from that
   commit.
4. Local macOS hub: install dependencies, build, and kickstart the LaunchAgent.
5. Remote nodes: pull `hub`, install dependencies, build, and restart their
   service from another node.
6. Desktop: replace the app in `/Applications`, verify one LaunchServices path,
   and relaunch with Computer Use.
7. Pair/reconcile the real fleet once per node.
8. Run G0 and representative web/mobile smoke checks on the shipped build.

Secrets must never appear in logs, command output, repository files, screenshots,
or generated artifacts.

## Compatibility removal

After one release with telemetry/smoke evidence:

- remove deprecated `peer_*` MCP aliases and legacy capability issuance;
- remove any remaining peer-named transport adapters;
- remove migration-only peer contracts and tests;
- keep the `fleet.json` migration marker so stale backups cannot resurrect
  `peers.json`.

## Deferred work

The following are intentionally outside the current fleet rework:

- a two-thread split view;
- Windows automatic runtime bootstrap beyond structured diagnosis;
- relay redesign;
- generated provider schema rewrites;
- a new client transport protocol.

They require separate decisions and gates.
