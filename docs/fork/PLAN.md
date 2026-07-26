# Agent Hub Plan — one UI for agents across all machines

Date: 2026-07-24. Status: EXECUTING — fork built (michaelvu1207/t3code, branch `hub`, clone at ~/Documents/Programming/agent-hub/t3code, `vp i` + `vp run dev` verified, ports 13773/5733). Full architecture map in NOTES.md.

> **Recon corrections (07-24, from codebase map — supersede statements below):**
> 1. The claim "client connects to one environment at a time" is WRONG. The client runtime is already multi-connection: N environments connect concurrently, threads merge into one list, routes are /$environmentId/$threadId, and SidebarV2 already renders a cross-environment inbox (gated off by default). F1 = activity/needs-attention ranking + route + un-gate. Zero core changes.
> 2. Federation is mostly wiring: GET /api/orchestration/threads/:threadId already serves transcripts behind an `orchestration:read` scope; restricted M2M tokens are already mintable; the server is already an MCP server injected into all five provider adapters. Net-new = peer registry + one MCP toolkit (~2 files + 3 one-line edits). Known gaps: archived threads 404, no transcript pagination.
> 3. Usage: Claude totalCostUsd + rate-limit events are already emitted but unconsumed (ingestion `default: break`). Spend/rate-limit panel = new projection, likely NO ccusage sidecar needed. Accounts: Claude probe already yields auth.email + plan per instance, already rendered in ProviderInstanceCard.
> **Decision resolved (open decision #2): per-thread account pinning** — map each CCC account to a distinct provider instance homePath (CLAUDE_CONFIG_DIR). Global credential-swapping under one home silently flips the account under continuation.groupKey, which t3's design explicitly prevents. CCC-style global swap is dropped for t3-managed sessions.

## Goals

1. **One hub UI** for agent threads running across all machines (mac, simforgelaptop, simforge1, path-pc).
2. **Cross-thread visibility** — any agent/thread can read the conversation history of agents on other connections.
3. **Account control + usage in one place** — what CCC does (switch Claude/Codex accounts, live rate-limit bars, spend), but across every machine, from the hub UI.
4. **Clean, codex-like look** — no tmux green bar; consistent copy/paste on every connection.

## Current state (audited 07-24)

- **cmux** (open-source, GPL-3.0, Ghostty-based macOS terminal) is the hub. `~/.config/cmux/cmux.json` defines 8 workspace actions, each launching Claude Code (`--dangerously-skip-permissions`) inside tmux:
  - **Local** (simcloud, arcspirits, rw-tools, rw-bot): default tmux socket, `cmux-claude-shell` wrapper (Ctrl+C-safe, falls back to login shell).
  - **Remote** (simcloud@laptop, simcloud@simforge1, arcspirits@laptop, v2x@path-pc): a *local* bridge tmux on socket `cmux-remote-bridges` running `cmux-ssh-tmux-reconnect` — an auto-reconnecting `ssh -tt` loop (exp backoff, only retries transport failures) that attaches a *remote* tmux session running claude.
- **Green bar** = tmux's default status line. No `~/.tmux.conf` on mac/simforge1/path-pc; laptop has a scroll-fix-only conf (mouse on + wheel bindings).
- **Copy/paste inconsistency root cause**: OSC 52 clipboard forwarding through the *nested* tmux chain (remote tmux → ssh → bridge tmux → cmux) is unconfigured. Single-layer local sessions forward fine; double-layer remote ones drop copies. Mouse-mode also differs per host (laptop: tmux-owned selection; others: native cmux selection).
- **Isolation**: every connection is an island. Transcripts live per-machine in `~/.claude/projects/*/*.jsonl` (mac 1.2G, laptop 47M, simforge1 34M, path-pc 30M). No cross-machine read path.
- **CCC / CCCSwitcher**: local-only Python TUI wrapping `claude-swap` + `codex-auth` + `ccusage`. Keypress-driven, no API surface, no remote awareness.
- All hosts share a tailnet (100.x) except simforge1 (public IP, ssh alias); tmux ≥3.4 and python3 everywhere.

## What t3code is (evaluated from repo/docs)

`pingdotgg/t3code` — MIT, TypeScript/React/Node, 14.6k stars, pushed daily.

- **Architecture**: per-machine Node WebSocket server wrapping provider CLIs (`codex app-server` JSON-RPC; Claude/Cursor/OpenCode adapters) + a React web app. Desktop app and hosted `app.t3.codes` are clients.
- **Remote access is first-class**: `t3 serve --host $(tailscale ip -4)`, pairing links/QR, Tailscale Serve HTTPS support. Saved "environments" per backend.
- **Multi-account Claude is native**: provider entries with distinct `Claude HOME path`s → per-thread account pinning (arguably better than CCC's global swap).
- **Relevant gaps**: self-described "very very early, expect bugs"; **not accepting contributions** (fork = permanent rebase burden against a fast-moving upstream); client connects to one environment at a time (no unified multi-machine pane); "GUIs do not currently support adding projects on remote environments"; custom Vite+ (`vp`) toolchain; no cross-thread transcript access; no usage/spend view.

## Options

**A. Patch the cmux setup (no new UI).** Uniform tmux config + a `claude-peers` transcript mirror/CLI + keep CCC per machine. Solves goals 2 (CLI-level) and 4 in ~half a day. Doesn't give one UI for accounts/usage (goal 3) or a thread inbox (goal 1 beyond what cmux already does).

**B. Fork t3code.** Best long-term fit for goals 1–3 (right stack, MIT, remote-first design). The fork adds: unified multi-environment dashboard, thread-federation read API + agent-facing tool, accounts/usage panel. Risk: upstream churn + closed contributions means we carry the diff forever; the project is early enough that core internals (orchestration contracts) will shift under us.

**C. Thin hub app over unforked t3 servers.** Our own small web app that speaks t3's typed WS contract (`packages/contracts`) to N backends and renders the unified view + accounts panel. No rebase burden on the UI we own; but the contract is undocumented/unstable, and we'd still need a per-machine sidecar for accounts/usage — so it converges with B's work anyway.

## Recommendation: phased hybrid — don't fork yet

### Phase 0 — Quick wins on the current setup (~half day, do regardless)
Everything here stays useful under any future UI (terminals never fully go away).
1. **Uniform tmux config on all 4 hosts** (laptop's scroll fix folded in): `status off` (kills the green bar), `set-clipboard on` + `allow-passthrough on` + `terminal-features ',*:clipboard'` (fixes OSC 52 end-to-end through nested tmux), mouse-wheel scroll + drag-copy. Live-apply to running sessions — no agent restarts.
2. **`claude-peers` v0**: mac-hub rsync mirror — pull each remote's `~/.claude/projects` into `~/.claude/peers/<host>/` and push the merged mirror back out (recent-files filter for the mac's 1.2G); launchd every ~10 min; a small `claude-peers list/read` CLI to render jsonl transcripts; a short section in each host's `~/.claude/CLAUDE.md` so agents know it exists. **This alone delivers "threads read each other's conversations"** — provider-agnostic, works for terminal sessions and any future UI.

### Phase 1 — Evaluate vanilla t3code (≈1 hour setup, live with it days)
Run `t3 serve` on all 4 machines over the tailnet, pair them in the desktop app, and dogfood. Verdict criteria: Claude provider fidelity vs raw Claude Code, remote-project limitation pain, environment-switching ergonomics, stability. Zero fork cost; if it fails, we've lost nothing and keep the improved cmux.

### Phase 2 — Build the hub layer (fork decision point)
Only if Phase 1 verdict is positive. Preferred shape: **fork, but keep the diff additive** (new packages/panels, minimal core edits; pin upstream monthly). Three features:
1. **Unified dashboard**: one pane showing all environments' threads (inbox sorted by activity/needs-attention), click-through to any thread on any machine.
2. **Thread federation**: read-only API on each t3 server exposing thread transcripts + an MCP tool (`peer-threads list/read`) injected into agent sessions, so an agent on simforge1 can read a mac thread live. `claude-peers` mirror stays as the fallback for non-t3 (terminal) sessions.
3. **Accounts + usage panel**: per-machine sidecar daemon exposing CCC's internals (`claude-swap`, `codex-auth`, `ccusage`) as a tiny tailnet-only HTTP API; hub panel shows every machine's active account, rate-limit bars, spend, with switch/re-login buttons. Consider migrating from global swap to t3's per-thread Claude-HOME account pinning (per-thread accounts > per-machine accounts; ccusage aggregates across homes).

### Phase 3 — Consolidate
Aesthetic pass (t3 UI is already codex-flavored minimal); decide cmux's role — recommend keeping it as the raw-terminal fallback (t3code is a thread GUI, not a terminal), with Phase 0's clean chrome.

## Open decisions

1. **Fork (B) vs thin hub (C)** if Phase 1 passes — default: fork with additive-diff discipline.
2. **Account model**: keep CCC's global per-machine swap vs move to per-thread Claude-HOME pinning (t3-native) — default: per-thread, with CCC-style dashboard on top.
3. **Federation transport**: filesystem mirror only vs mirror + live API — default: both (mirror first, it's Phase 0).
4. Whether Phase 0 should proceed now (it was in-flight when paused; scripts/configs specced but nothing deployed).

## Implementation log (07-24)

- **F0 hazard hardening — DONE** (`hub-f0-hygiene`, 14185259e + b477ff35f): self-update disabled at resolver + npm chokepoint (`forkSwitches.ts` FORK_DISABLE_SELF_UPDATE), migration-completeness boot assertion + tests.
- **F1 unified dashboard — DONE** (`hub-f1-dashboard`, 5aeed3b7e + 860bc17f2): SidebarV2 default-on; needs-attention banding (approval → input → failed → unread) + last-activity ranking via threadLastActivityAt; own v2 sort setting; machine badge on remote rows; partition/sort in fork-owned files (SidebarV2.tsx down to call sites); capability-skew rule now test-covered. Not visually verified: ranked ordering with live rows, machine badge (needs 2nd machine).
- **F2 thread federation — DONE** (`hub-f2-federation`, 89826c152 + b40dce718): peer registry (`<stateDir>/peers.json` + secret store, no migrations); routes GET /api/peers, POST /api/peers/register|remove (access:read/write); registration enforces least privilege (refuses credentials broader than orchestration:read, scopes read from peer's own /api/auth/session); `t3 auth session issue --scopes/--read-only`; MCP tools `peer_threads_list` + `peer_thread_read` on the injected t3-code server (bounded reads, (createdAt,threadId) cursor on order=created); ExecutionEnvironmentCapabilities.peerFederation. Verified live across two instances.
- **F2 follow-ups**: archived threads invisible to federation (fix via orchestration.getArchivedShellSnapshot seam); peer credentials are 30-day bearers with no refresh (re-register on expiry; expiry visible on list route); baseUrl is an SSRF-ish vector if peers ever become self-service; `peers` MCP capability currently issued to all sessions (gate is forward-looking).
- **F3 accounts + usage — DONE & MERGED** (`hub-f3-accounts` 6a6e7d2a3 → hub merge 8de2271c1): rate-limit/cost ingestion (fork-owned usage/ module, 9-line ingestion touch), migration 035_ForkUsage (idempotent, raw turn rows PK'd on event_id for replay dedup, latest-wins rate limits, 120-day prune), GET /api/usage/snapshot (orchestration:read, 30s client poll, no WS RPC), /settings/usage "Accounts & Usage" panel (per-machine → per-account cards, spend today/7d, role=meter rate bars, null-utilization rendered honestly, removed-instance spend badged not hidden), per-thread pinning ergonomics via settings copy + placeholder (~/.claude-homes/<account>). Verified end-to-end with 3 real Claude turns ($0.19) + headless DOM/screenshot incl. live 30s auto-refresh.
- **F3 follow-ups**: utilization units (pct vs fraction) UNCONFIRMED live — if bars read 1% when they should read 100%, that's it; Codex rate limits unit-tested only (no live Codex turn); cross-machine aggregation + mixedDays banner never rendered with real multi-machine data; peer credentials can read spend (needs distinct scope if peers go third-party); rate limits only populate after a turn (capability-probe-time pull via Codex account/rateLimits/read would fill on connect); days[] carried in contract but unrendered (future sparkline); no historical backfill.
- **Fork-wide review item (from F3)**: any client fetch reading connection state without waiting on `SubscriptionRef.changes(supervisor.prepared)` (idiom at client-runtime threads.ts:256) passes tests but silently fails in-app — audit F1/F2 client code for this pattern.
- **F1 follow-ups (post-merge decisions)**: (a) clock skew — remote timestamps used as-is, a fast clock pins its threads on top; (b) opening a thread drops it out of the unread band mid-read (freeze active-row rank if it feels bad); (c) slim rows show machine only in tooltip; (d) mobile keeps its own v2 default-off.
- **MERGED to `hub` @ 70a9b6213** (07-24): F0→F1→F2, zero conflicts, full gates green (15-pkg typecheck, lint, fmt, 201 contracts + 1625 server + 1526 web tests), combined boot verified (migration assertion passes, peerFederation:true + serverSelfUpdate absent in one descriptor, peers routes mounted with auth). hub = 9 ahead of upstream 41a430a88, unpushed.
- **Merge-flagged follow-ups**: peerFederation capability is write-only (nothing reads it; registering a non-federation upstream server succeeds silently and fails later as 404s — design question); no contracts-level decode test exists for ExecutionEnvironmentCapabilities at all (pre-existing gap); mobile keeps sidebarV2 device-local default-off (intended asymmetry, confirm); CI footgun: `vp run --filter t3-server test` silently matches nothing — the server package is named `t3`.
- **Merge note**: F0/F1/F3 all touch `packages/contracts/src/settings.ts` — merge sequentially, not three-way.
- Dev-state isolation: dev instances write `~/.t3/dev/state.sqlite`, real data in `~/.t3/userdata/state.sqlite`.

## F4 — Connections view: SHIPPED 07-25 (hub @ 64c94fd53, deployed to all 4 machines)

Implemented per the plan below (branch hub-f4-connections, c4d0c2b1f + 7f4cdfc91): `sidebarV2ViewMode` setting, SidebarV2ViewMenu (View + Sort in one control), fork-owned SidebarConnectionsView + Sidebar.connections.ts (consumes F1's partition so capability-skew rule can't drift), collapse via uiStateStore record `sidebar-connection-group:<envId>` (localStorage), shift-click range-select suppressed outside inbox mode. Verified live against the 4-machine mesh (evidence f4-*.png). Nice-to-haves skipped with rationale: per-group new-thread (needs env-scoped project pick), archived rows (need their own row variant). Follow-ups: jump-hint letters not in visual order in connections mode; redundant machine badge inside named groups; doubled empty state when all machines empty; group order static (local-first, alphabetical); 3 read-only f4-dev pairings left on live servers (removable).

### Original plan (07-25)

**Ask**: a sidebar mode listing all open connections (machines); expanding a connection shows its historical Claude Code and Codex threads; clicking a thread opens it in the right-side chat pane.

**Feasibility**: high — all load-bearing pieces exist. The client registry already connects all paired environments and exposes per-connection live status (the green dots on Settings → Connections); every thread shell carries environmentId + provider; the chat pane already opens any thread via `/$environmentId/$threadId`. This is a client-only, fork-owned presentation feature.

### Design
1. **View-mode setting**: add `sidebarV2ViewMode: "inbox" | "connections"` beside F1's `SidebarV2ThreadSortOrder` in `packages/contracts/src/settings.ts` (one key; hot file — minimal touch, decoding default `"inbox"` so upstream behavior is unchanged). Surface the toggle by extending F1's fork-owned sort-menu component into a small view menu (Inbox / Connections) — zero new touches to SidebarV2.tsx beyond the existing call sites.
2. **Fork-owned connections view** (`apps/web/src/components/sidebar/SidebarConnectionsView.tsx` + `Sidebar.connections.ts` logic file, unit-tested like Sidebar.partition): one collapsible section per environment — label, live-status dot (reuse the Connections settings indicator source), thread count, and a per-connection "new thread" affordance that prefills the composer's existing run-target selector. Threads within a group sort by F1's activity comparator (needs-attention first). Collapse state persisted client-side (localStorage or the settings patch mechanism, whichever the sidebar already uses for group collapse).
3. **Provider identity per row**: rows show the provider icon (Claude / Codex) the app already renders elsewhere; optionally a per-connection provider filter chip if cheap. Explicitly NOT sub-grouping by provider in v1 — mixed chronological list with icons reads better for scanning history.
4. **Historical depth**: v1 shows what the shell snapshot streams (active + settled — same data the current sidebar has). Archived threads are invisible to the snapshot (known F2 gap); add a lazy "Show archived (N)" row per group wired to the same per-environment archived query the Archive settings tab uses. If that query turns out to be local-only, archived-for-remote rides the existing `getArchivedShellSnapshot` follow-up — do not block v1 on it.
5. **Open on the right**: free — row click navigates to the existing thread route; the chat pane renders it regardless of which machine owns the thread (proven live during integration).
6. **SidebarV2.tsx footprint**: one conditional at the existing partition call site (`viewMode === "connections" ? <SidebarConnectionsView/> : current list`). Keeps the 21-touch/500 upstream file at call-site-only diffs per the fork discipline.

### Estimate & risks
One implementation agent session (client-only), plus the usual gates + a headless multi-machine render check against the live 4-machine mesh. Risks: low — the only genuinely new data dependency is archived-thread fetch for remotes (deferred); collapse-state persistence idiom needs a 5-minute recon of how the existing sidebar groups persist theirs.

## F5 plan — Terminal-history reader (07-25, GREENLIT: preview-only, no bulk import)

Michael's requirements: preview-only; mostly last-7-days usage, rare full-history dives; zero lag. Decision: lazy two-tier reader over the live CLI session stores — NO import into t3's DB.
- **Tier 1 — metadata index** (per server, fork-owned `apps/server/src/history/`): stat-only scan of `~/.claude/projects/*/*.jsonl` + `~/.codex/sessions/**` → in-memory index (path, project cwd, session id, mtime, size, first-message snippet from first ~KB). Incremental revalidation by mtime; NO SQLite migration. Endpoint `GET /api/history/sessions` (orchestration:read, paginated newest-first, default window 7d, cursor paging for older).
- **Tier 2 — on-demand transcript preview**: `GET /api/history/session-transcript` parses ONE jsonl tail-first (read file backwards by chunks for instant newest-page), paginated older pages. Opaque session ids resolved via the index — never client-supplied paths (traversal guard).
- **Client**: per-connection "Terminal history" strip in SidebarConnectionsView (lazy fetch on expand, direct to that environment's baseUrl, claude/codex icons + snippet + age, "Show older…"), read-only transcript viewer route on the right pane, virtualized, load-earlier-at-top.
- **Phase 2 (not in this build)**: per-session "Import & continue" converting one session into a real resumable t3 thread.

## F8 plan — Sidebar header minimalism (07-25, QUEUED behind F5 merge — same file region)

Michael: remove the sidebar's search bar row and the "All projects" folder-picker row entirely (few projects, not needed). Replace with a single header row: "T3 Code" title + three icons right-aligned — search (opens the existing ⌘K search overlay), new thread (the current compose action), new project (folder icon, current new-project action). Net: three rows → one. Keep ⌘K shortcut working; project sort control (currently beside All-projects) either moves into the View/Sort menu (F4's SidebarV2ViewMenu) or is dropped — implementer judgment, minimal wins. Same discipline: fork-owned header component, call-site diffs in SidebarV2.tsx. Note: project *filtering* still exists in the codebase — removing the picker removes the affordance, not the capability; if a filter is active when the picker disappears, force-reset to all-projects so threads can't be invisibly hidden.

## F9 plan — Thread-row simplification + animated task progress (07-25, IN FLIGHT)

Michael: (1) sidebar thread rows show ONLY project name + thread name — drop PR number and branch directory from rows (they remain in the thread view itself). (2) When a thread has an active task list (TodoWrite/update_plan → turn.plan.updated pipeline), render a slim segmented progress bar on the row: one segment per task with visible breakpoints, filled by completed count, colored/fun, animated fill transitions. Data: prefer plan state already streamed to shells; else add an additive optional planSummary {completed,total,activeStep?} to the thread-shell payload (optionalKey — version-skew safe). Same fork discipline; row-renderer region only.

## F10 plan — Accounts & Usage rework, CCC-grade (07-25, PROPOSED)

Michael: 4 Claude + 3 Codex accounts (currently managed by CCC/claude-swap/codex-auth on the Mac). Wants: all account usages visible concisely (no scrolling), CCC-style bars, unused providers (Cursor/Grok/OpenCode) hidden, and account switching/login. CCC recon: roster `~/.claude-swap-backup/sequence.json` + credential blobs; bars via the Anthropic OAuth usage API per account token (five_hour/seven_day pct; 429-prone → must cache); Codex analog via codex-auth (primary/secondary windows); CCC shells out for login rather than doing OAuth.

### A. Account import (the bridge, per machine)
Fork CLI `t3 accounts import-ccc`: read claude-swap + codex-auth stores, materialize one config dir per account (`~/.claude-homes/<slug>` seeded with the stored credential blob; `~/.codex-homes/<slug>`), register each as a t3 provider instance. Result: all 7 accounts become simultaneously-usable instances with per-thread pinning — "switching" mostly evaporates (pick the account per thread in the composer; no global swap, preserving the F3 continuation-key decision). Each home refreshes its own tokens after seeding; dead tokens (CCC's known gotcha) surface as failed probes → re-login path (D).

### B. Usage prober (bars without running turns — the CCC mechanism)
Server-side per-instance prober calling the same OAuth usage APIs CCC uses (Claude: five_hour/seven_day windows + resets; Codex: primary/secondary windows) with each instance's credential. Cached (TTL ~5-10 min, refresh on panel open; gentle — 429 risk is documented in CCC). Feeds the existing /api/usage/snapshot payload so F3's panel plumbing carries it; F3's turn-event path remains for live spend. This also fixes F3's "bars empty until a turn runs" follow-up properly.

### C. Panel rework — account-first, compact
- Invert the hierarchy: ONE ROW PER ACCOUNT (deduped by auth identity/email across machines and instances — rate-limit windows are account-scoped, so per-machine repetition is noise). 7 rows total, no scrolling.
- Row: provider icon · email · plan badge · 5h bar · weekly bar (CCC-style colored fills, warning/destructive past thresholds) · spend today/7d (summed across that account's instances fleet-wide) · machine-presence chips · default-account marker.
- Providers with no configured account (Cursor/Grok/OpenCode) hidden entirely; "Show all providers" toggle tucked in overflow.
- Row actions: "Use for new threads on <machine>" (sets default instance), "Add to machine…", "Re-login…".

### D. Switching + login — the honest best-approach answer
1. RECOMMENDED: seed-from-CCC (A) covers every currently-valid token with zero interaction. Per-thread instance pick IS the switch inside t3.
2. Re-login / new account: in-app terminal path — t3 already has terminal plumbing (terminal.open/attach over WS); "Re-login" opens a terminal on the target machine running `CLAUDE_CONFIG_DIR=<home> claude auth login` (resp. codex login); the OAuth happens in the CLI + browser exactly as designed. No OAuth reimplementation in t3 (fragile, upstream-hostile; even CCC shells out).
3. Cross-machine credential distribution: v1 keeps it operational (one-time seeding of remote config dirs over SSH during setup; UI shows presence chips). A product-grade encrypted credential-sync between servers is explicitly DEFERRED — it's a security surface that deserves its own design pass.

Effort: B+C = one agent (server prober + panel rework); A = one agent (import CLI + instance registration); D2 = rider on B/C if the terminal plumbing cooperates, else fast-follow. Sequence: after the current F5/F6/F8/F9 wave merges.

## F11 plan — starcode rebrand + full restyle (07-25, SHIPPED)

**SHIPPED 07-25**: 3 commits on hub-f11-starcode (5ae73d276 token layer + rebrand, 7323c4dfd contrast gate, 011d923c2 sidebar header split) — Michael approved from the 24-screenshot review package ("good enough for now"), merged clean (zero conflicts) into hub @ **7d3ace3d7**, pushed, deployed to all 4 machines (all serving `<title>starcode (Alpha)`, peerFederation intact). Desktop app rebuilt from the same commit. **Rollout lesson: F11 added `@fontsource-variable/baloo-2` — `vp i` after pull is now a MANDATORY rollout step** (all 4 builds failed identically without it; pipeline section updated). Deferred taste knobs (light-theme dev band, etc.) live in the F11 agent transcript for a future round.

**F11.1 iteration round SHIPPED 07-25 (overnight, wave = hub @ 366a5f65c)**, from Michael's live review of the deployed app: 922327d71 icon-strip recentred (root cause: 46px traffic-light inset carried into the icon row; centred + flex-wrap, robust to count), 4cc4e441e wordmark masthead (desktop-only vanish root-caused: `--workspace-controls-left` = 90px on macOS vs 12px browser → 0-width at 208px sidebar; brand moved to its own row, 28px weight-800, always visible), d3db2003e time-of-day sky backdrop (starcodeSky.ts JS phase → CSS custom properties, 1-min tick, `?sky=` phase forcing persisted to localStorage, per-phase light-theme washes, contrast gate extended to all 4 phases × 2 themes — caught 4 real failures, solved to ≥4.7; stars only on empty-state fields never dense routes), 41f1f8027 star-chart engravings (registration-mark corner pair on idle panes + centred rail on dialogs; dialog corners and popover ornaments deliberately CUT — rejected renders in evidence f11-eng-try-*; light-theme filter-inversion trap solved via :has()). Plus merges: bcd3ebd06 connection-rename (c84969ceb — client-side alias in localStorage `t3code:connection-aliases:v1`, single teach-once resolution point in state/environments.ts, per-client not synced; pencil affordances in Settings + sidebar), 366a5f65c sub-bar-to-header (e11e21631 — BranchToolbar relocated from below composer into ChatHeader runContext slot; all 4 controls survive functionally incl. branch combobox + PR pill; ChatView net −9 lines; upstream composer-layout branch left byte-identical). Gates: 1664 web tests, typecheck 0, lint 0, build clean.

Michael: rename "T3 Code" → **starcode** and redesign the color scheme/styling. Reference image = style inspiration ONLY (not layout): deep-ink/navy cosmos backgrounds, cream/ivory foreground, warm butter accent, soft large radii, thin warm borders, lowercase rounded wordmark, moon/stars motifs, cute-cozy mood ("built for deep focus").

### Scope decisions
- **Brand = user-visible surfaces only in v1**: wordmark (SidebarChrome brand slot — F8 kept it upstream-owned with an actions prop; brand text/logo swap is a small targeted change), browser/tab titles, app icon (the repo has a brand-icon pipeline: `scripts/export-brand-icons.ts` / `vp run icons:export` — regenerate, don't hand-draw pngs), notification strings, settings/about copy. NOT in v1: npm package name, service labels (com.simforge.t3-hub etc.), bundle ids, URL schemes — invisible identifiers whose rename churns infra for zero daily value (they're already on the release-blocker list §7.7 for if/when the fork ever publishes).
- **Theme = token override layer, not a restyle-in-place.** index.css is the repo's 2nd-hottest file (26/500) — never fork it wholesale. The app styles via CSS custom properties + Tailwind tokens: ship a fork-owned `starcode-theme.css` overriding the variable layer (backgrounds, foregrounds, accents, borders, radii, status hues), imported at one call site. Dark theme is primary (Michael's usage); light gets the palette translated but less polish. All existing components inherit automatically; F7's future views are born themed.
- **Palette direction** (to be tuned in-implementation against real screens): bg deep ink-navy (#12141f-ish family, warm cast, NOT pure black), elevated panels one step lighter with generous radius, foreground warm cream (#e9e3d6-ish), primary accent warm butter/cream (the reference's Accept button) with dark text, secondary starlight blue-grey, status colors softened to match (success sage, warning amber, destructive muted rose), focus rings cream. Contrast: keep WCAG AA on all text tokens — verify, don't eyeball.
- **Typography**: rounded/friendly display face for the wordmark + large headings ONLY (bundled font file, no CDN); body/UI/mono faces unchanged (they're load-bearing for density and diff rendering).
- **Graphics**: tasteful celestial motifs as fork-owned SVG — subtle star-speck texture in the sidebar backdrop, crescent-moon in the wordmark, themed empty states (history strip, no-threads, workbench) and the pairing page. Mascot (astronaut) is a RESERVED SLOT: attempt one SVG mascot for the pairing/empty-state; ship only if it clears the taste bar, otherwise motifs-only (a bad mascot is worse than none; Michael can supply/commission art later and it drops into the slot).
- **Restraint rule**: decoration only in empty/idle surfaces — never in dense working UI (thread rows, transcripts, composer stay clean; they just inherit the palette).

### Process
One high-taste implementation agent (frontend-design guidance loaded): tokens + wordmark + icons + motifs + screenshots of every major surface (inbox, connections view, thread, history, usage, settings, popover) in dark + light; Michael reviews screenshots and iterates ("more contrast", "warmer", etc.) before merge. Verification includes the version-skew banner + dev-stage backdrop interactions F8 documented, and an AA contrast pass over the token set.

### Sequencing
Can run parallel with F7/F10 (token layer + brand slots are disjoint from feature work), and SHOULD land before or with F7 so the Workbench ships already-themed. After the current wave (F9) merges.

## F7 plan — Workbench view + master-planner orchestration (07-25, PROPOSED)

**Ask**: a new "Workbench" view with one pinned thread at top — the master planner — whose role is orchestration, never writing code. It must be able to create threads, inspect threads, and send messages to threads across all connections, and the view should organize the resulting work (commits, PRs). Functionality only — NO prompt authoring (Michael owns the prompts).

### What already exists (reuse, don't rebuild)
- Read federation: `peer_threads_list` / `peer_thread_read` MCP tools in every session (F2), peer registry + least-privilege credential plumbing.
- An authenticated HTTP dispatch path (`POST /api/orchestration/dispatch`, orchestration:operate scope) — proven live during F3 verification.
- Thread shells already stream branch, PR number, diff/status per thread (rendered in sidebar rows today) — the raw material for the commits/PRs board.
- Per-session access modes (plan/build, access levels) — the mechanism for "never writes code" as configuration, not prompt text.
- F4 grouping logic for per-connection organization.

### Build plan
1. **Operator-grade federation (server)**: a second peer-credential class — `orchestration:operate` tokens, minted per peer with explicit opt-in (`t3 auth session issue --scopes orchestration:read,orchestration:operate`), stored in the existing registry with the scope class visible. Registration keeps refusing over-scoped tokens per class. Verify the HTTP surface covers thread-create + message-send (dispatch exists; add a typed thread-create endpoint via the §8 4-edit recipe if creation turns out to be WS-RPC-only — never a new WS RPC).
2. **MCP write toolkit**: `peer_thread_create` (peer, project/cwd, provider+model, access mode, first message) and `peer_thread_send` (peer, threadId, message), added to the existing t3-code MCP server BUT gated behind a new MCP capability (e.g. `peers-operate`) that is issued ONLY to sessions of the designated master thread — the per-session gating F2 left forward-looking becomes real here. Read tools stay universal; write tools are master-only.
3. **Master designation (server + settings)**: `workbenchMasterThreadId` setting; ProviderService issues the `peers-operate` MCP capability when starting that thread's sessions; master sessions default to the read-only/plan access mode (config-enforced "never writes code" — overridable in UI, but the default is the contract).
4. **Workbench view (client)**: new fork-owned route `/workbench` — top: the pinned master thread as a full chat pane (picker/creator for which thread is master, persisted); below: the orchestration board — child threads grouped by connection (F4 logic) with branch / PR / diff-stat / status badges from the data the shells already carry, click-through to any thread, and a "spawned by master" association where determinable (v1: threads the master created via the tools are tagged through a metadata note; heuristic fallback acceptable).
5. **No prompt content**: the master thread's behavior comes from whatever Michael writes into it; the fork ships tools + gating + view only.

### Amendment (07-25, Michael): peer-to-peer, not just master→children
Threads should know about each other's existence and be able to send messages to each other — general inter-thread communication, with the master planner as the orchestrating special case. Awareness is already universal (F2 read tools); messaging goes to every session; master keeps create + the pinned Workbench slot.

**RESOLVED (07-25, from workbench.md/prior-art research — full findings in transcript; workbench.md is a real 2-week-old product, not an established convention, but its protocol is worth copying):**
- **Messaging = mailbox-default + interrupt-reserved.** Per-thread mailbox on each server: `peer_thread_send` enqueues; delivery to the target happens when it next turns (injected as attributed context) — never mid-turn. True interrupt (t3's existing dispatch, which triggers an immediate paid turn) is a SEPARATE master-only tool (`peer_thread_dispatch`) reserved for start-work/stop-work. This mirrors the field consensus: mailbox for chatter, interrupts as a privileged narrow channel, structural loop-prevention over behavioral.
- **Loop/noise guards baked in structurally**: never deliver a thread its own messages (excludeActor); message envelopes carry provenance metadata (from-thread, from-machine, timestamp — mechanism only, no prompt content per Michael's boundary); messages are data-not-instructions by construction (delivered inside an untrusted-content envelope — the workbench.md trust rule, which matters MORE for us since our agents have Bash).
- **No new board artifact in v1** — t3 already IS the board: threads are the cards, and their status is DERIVED from live session state (the OpenClaw derived-not-self-reported pattern, natively). The Workbench view is the human-readable projection (the thing all mature systems ship alongside the machine state). A claim/ASK primitive (CAS + TTL) is deferred until multi-agent contention actually appears.
- **Registry/liveness**: environments + session status streams already give heartbeat-grade liveness; no new registry needed at 4 machines.
- **Meta-lesson relayed from every source**: 3–5 concurrent worker threads is the practical ceiling — the constraint is review bandwidth and merge absorption, not coordination tech. The Workbench should make ~5 agents legible, not promise a fleet.
- MCP capability split final: read = all sessions; send(mailbox) = all sessions; create + dispatch(interrupt) = master-only.

### Amendment (07-25, Michael, revised twice): the feature-flow panel — Workbench's right side
**FEATURE-level, not git-level.** Michael explicitly does not want branches/worktrees/commit structure in the UI — git is hidden plumbing. The panel is a per-project pipeline of FEATURES flowing toward and through dev:
- **Stages as columns/lanes**: In progress → dev → staging → production. A feature is a node; its stage is computed under the hood (thread active = in progress; work merged into dev = dev; contained in staging/production trunks = promoted) but rendered purely as the feature sitting in / flowing into a stage. Cute animated transitions when a feature merges (node glides into the dev lane).
- **Feature node** = thread name + live status color + the F9 task-progress bar (same segmented component) + machine chip. Click → opens the thread. No branch names, no ahead/behind, no PR jargon on the node (a small "ready to merge / conflicts" dot is the only mergeability surface, from the hidden git/PR signals).
- **Dependencies**: feature-to-feature links — inferred where git knows (stacked work), manual depends-on annotation otherwise; rendered as simple connecting lines so "what waits on what" is visible at a glance.
- **Data**: same per-server endpoint as before (trunks, thread-bound work state, containment/merge detection, PR state) — but it exists to COMPUTE feature stage/readiness, not to be displayed. Client composes per-project pipelines across environments.
- OUT: everything git-shaped in the UI (branch names, worktrees, commit history, ahead/behind counts), CI status, review surfaces. The panel answers exactly three questions: what's being worked on for this project, how far along is each, and what has flowed into dev/staging/production.

### Risks / decisions
- Write-capable peer tokens raise blast radius: mitigated by the separate credential class, per-peer opt-in, master-only capability gating, and the existing anti-escalation checks. Still worth stating: a compromised master session can start work on every machine — that is also its job.
- Thread-create parameters on remote machines require a valid project/cwd on the target — v1 exposes the peer's project list (already readable via shell snapshot) to pick from; free-form cwd is phase 2.
- Estimated effort: ~2 implementation agents (server federation-write + client workbench) plus merge/rollout, after F5/F6 land.

## Desktop client — SHIPPED 07-25 + follow-ups
`/Applications/T3 Code (Alpha).app` (fork v0.0.28, ad-hoc signed, update feed verified pointing at michaelvu1207/t3code + kill switch): pure-client is structurally impossible (renderer is served by the local backend), so the app runs a sacrificial embedded backend in isolated `~/.t3-desktop-client` with all 4 machines paired as remotes (encrypted connection catalog, survives restarts). Rebuild path = the kept worktree `~/Documents/Programming/agent-hub/t3code-desktop` (`build-desktop-artifact.ts --keep-stage` — no DMG mount needed; plist LSEnvironment edits BEFORE codesign).
**Rebuild 07-25 (F11 starcode):** rebuilt from hub `7d3ace3d7` (branch `desktop-build` in the desktop worktree — `hub` is checked out in the main clone, so git refuses a second checkout of it) and swapped into `/Applications` (same app name/path; the starcode rename is still a follow-up). Recipe held exactly: `vp i` → `T3CODE_DESKTOP_UPDATE_REPOSITORY=michaelvu1207/t3code T3CODE_DISABLE_AUTO_UPDATE=true node scripts/build-desktop-artifact.ts --keep-stage --verbose` (~10 min; `GITHUB_REPOSITORY` unset so the feed can't drift upstream), PlistBuddy LSEnvironment inserts → `codesign --force --deep -s -` → `rm -rf` + `ditto` into /Applications → cua-driver `launch_app` (bundle id `com.t3tools.t3code`). Verified: `app-update.yml` still owner michaelvu1207/repo t3code, asar carries commit `7d3ace3d7f29`, `icon.icns` hash changed (new brand icon), window title + served `<title>` both `starcode (Alpha)`, renderer boot traffic at launch (asset GETs + `/oauth/token` 200) so the UI painted, embedded backend on 127.0.0.1:3773 with migration `36_ThreadMailbox` applied, connection catalog preserved. App never stole focus (frontmost stayed `cmux` across a 90s poll) so no cmd+H was needed. Pre-swap backup: `~/Documents/Programming/agent-hub/backup/T3-Code-Alpha-pre-f11.zip`. Note the stage `.app` lives in `$TMPDIR/t3code-desktop-mac-stage-*/app/dist/mac-arm64/` — pick the newest (`ls -dt`), each stage dir is ~1.7G so delete the stale ones.
**Rebuild 07-25 (F7b workbench):** same recipe, rebuilt from hub `a318093af` (F7b merge `f9ec91506` + server typecheck-debt fix) and swapped in; app version still 0.0.28, so builds are only distinguishable by asar commit stamp (`a318093af218` verified in the installed bundle). No new backup — `T3-Code-Alpha-pre-f11.zip` still holds the pre-starcode state and every build after it is reproducible from its hub commit. This time the app WAS running: `osascript -e 'tell application "T3 Code (Alpha)" to quit'` exited it in ~20s without touching the foreground, then rm -rf + ditto + relaunch. **Verified with a real AX/screenshot capture** (the window happened to be on the current Space, unlike the F11 attempt): full UI paints, all 4 machines listed in the sidebar, and the workbench LayoutGrid icon is present in the sidebar icon strip; `sidebar-workbench` is in the served client bundle. Backend healthy on 127.0.0.1:3773. Frontmost stayed `cmux` across the 90s poll. Two traps worth knowing: the embedded backend took ~90s to listen this time (a curl right after launch gets connection-refused — poll `~/.t3-desktop-client/userdata/server-runtime.json` instead of assuming failure), and zsh does not word-split unquoted vars, so `for a in $LIST` needs `${(f)...}`.
**Rebuild 07-25 (F11.1 header + sky, hub `366a5f65c`):** built and installed; asar stamp `366a5f65cad4`, plist keys + adhoc signature verified, packaged client carries `starcodeSky`/`skyPhase`/`dawn`/`dusk`, `masthead`, `wordmark`, `sky-` (JS + CSS) and `sidebar-workbench`. **Blocked on a macOS keychain prompt, NOT on any code defect** — see below. Runtime verification (sky phase, recentred strip, header run-context) is therefore still OUTSTANDING.
**🔑 THE KEYCHAIN TRAP — read before blaming a build.** Every rebuild is ad-hoc signed (`codesign -s -`), which gives the bundle a NEW code identity, so the login-keychain ACL on the `t3code Safe Storage` item no longer matches and macOS puts up "T3 Code (Alpha) wants to use your confidential information stored in “t3code Safe Storage” in your keychain — enter the “login” keychain password". **The app blocks at startup until a human answers it**: no backend child, no `server-runtime.json`, `waitForHttpReady` eventually fails with `BackendTimeoutError`, and the desktop trace stops after `makeBackendInstance` with ~8 spans. It looks exactly like a broken build. Agents cannot clear it (it needs Michael's password; "Always Allow" needs the password too). Diagnose with `cua-driver list_windows` on the SecurityAgent pid — a live prompt has `element_count` > 0. This also retro-explains the "backend took ~90s to listen" note from the F7b rebuild: that was Michael answering this dialog, not slow startup. **FIXED 07-25 — signing identity is now stable.** The recipe's signing step changed from `codesign -s -` to a dedicated self-signed identity, so the code identity no longer changes per build: `security unlock-keychain -p "$(cat ~/Documents/Programming/agent-hub/backup/signing/keychain-password.txt)" ~/Library/Keychains/t3code-signing.keychain-db` then `codesign --force --deep -s "T3 Code Fork Signing" --keychain ~/Library/Keychains/t3code-signing.keychain-db "<app>"` (plist edits still BEFORE signing). Dedicated keychain, generated password, `.p12` backup and full rationale/restore steps in `~/Documents/Programming/agent-hub/backup/signing/README.md`; Michael's login keychain was NOT touched and no login password is needed. Verify with `codesign -dvvv <app> | grep Authority` → `Authority=T3 Code Fork Signing` (never `Signature=adhoc`). `security find-identity -v -p codesigning` reporting 0 valid identities is expected — self-signed means untrusted-for-Gatekeeper, which does not affect local signing or launching. ⚠️ The switch itself raises ONE last prompt (identity changed); Michael answering it with **Always Allow** binds the ACL to the certificate. That the NEXT rebuild is then prompt-free is sound in theory but UNCONFIRMED — check it on the next rebuild.
**Rebuild 07-25 (F11.2 + F12, hub `c21818e34`):** built, signed with the stable identity (`Authority=T3 Code Fork Signing`), swapped in; asar stamp `c21818e34667`, plist keys intact. **🔴 THE NO-PROMPT PREMISE FAILED.** Michael had already answered the prompt for the previous build signed with the SAME certificate, yet this new build prompted again — so the keychain ACL binds to the specific binary (cdhash), NOT to the signing certificate. A stable identity does not buy prompt-free rebuilds. One caveat before treating that as final: it assumes he clicked *Always Allow* rather than *Allow*. Cheap test to settle it — after the next Always Allow, relaunch the SAME bundle without rebuilding; silence means per-cdhash binding, a repeat prompt means Always Allow is not persisting at all. New this time: the prompt no longer blocks the whole app — the embedded backend started and serves 127.0.0.1:3773 (HTTP 200), but the Electron window stays BLANK until the dialog is answered, because the connection catalog is read through Electron safeStorage (`apps/desktop/src/app/DesktopConnectionCatalogStore.ts:382`, plus `DesktopSavedEnvironments.ts:372`). **Real fix, fork-side:** stop putting the catalog behind safeStorage — `T3CODE_HOME` is already a private per-app directory, so a key kept there (or plaintext, matching what `~/.t3` already stores) removes the keychain from the boot path entirely and makes every future rebuild silent. Until that lands, budget one password prompt + a blank window per desktop swap, and swap only when Michael is at the machine.
**✅ KEYCHAIN CLOSED OUT 07-25.** The safeStorage exit (merged as `ca7e27ee0`) is proven on metal. Michael's real profile migrated on first boot: `connection-catalog.json` went v1→v2 plaintext with all four pairings intact (4 targets / 4 profiles / 4 credentials), costing exactly ONE prompt. The next rebuild (`2076716f4`, new cdhash `41d727f6…`, same signing identity) then booted **completely silently** — zero SecurityAgent processes, backend up on 127.0.0.1:3773, HTTP 200. The prompt-per-rebuild tax is gone; the stable signing identity stays useful as a real signature but was never the fix. Pre-migration safety copy kept at `backup/connection-catalog-v1-pre-migration.json`.
**⚙️ Operational rule (07-25, learned the hard way):** never boot a second bundle with the SAME `CFBundleIdentifier` (`com.t3tools.t3code`) while Michael's installed app is running. During the safeStorage acceptance test two stage-built bundles were launched with separate `T3CODE_HOME`s — which should mean independent single-instance locks — and his instance went down inside that window with no crash report. Cause never proven, but assume it was us. Boot-parity tests happen either while his app is down, or with a test-only bundle id. Related: a keychain dialog whose requesting process has died goes STALE — the window stays on screen, answering it does nothing, and a relaunch reuses the same dead window instead of raising a new one. To hand back exactly one clean pending action: quit the app, `kill -9` the SecurityAgent process holding the orphaned dialog (check its window list first — only kill it when the only windows are ours), then relaunch. macOS spawns a fresh SecurityAgent and a live dialog.
**Rebuild 07-25 (F17 global sky, hub `b1c28ec71`):** built, signed with the stable identity, swapped in; boot **silent** — zero SecurityAgent processes, backend up on first try. That is the SECOND confirmation of the safeStorage close-out above (new cdhash, no prompt), so the prompt-per-rebuild tax can be treated as settled rather than provisional. Sky verified live: `.starcode-sky` portalled to `document.body` at `position:fixed; z-index:-1`, body's inline background empty (the stacking-context trap is genuinely fixed) while `html`'s is set, 6 gradient stops + turbulence mask, three blobs animating at 193s/271s/137s, starfield on its 900s drift. Pane pixels ramp 33,35,42 (y=20) → 20,22,26 (y=1130), i.e. NOT the flat tint the trap produces.
**Rebuild 07-25 (F17 rev-2 blurred-field sky + F16 projects, hub `ea6a2f32d`):** built, signed, swapped; **silent boot, zero focus steal** — `launch_app` returned `active:false` and frontmost stayed `Rusted Warfare` throughout, and the single-path lsregister assertion below held (the rollback lives in `backup/T3-Code-Alpha-pre-rev2.app`, so it never registered). Probe PASS with the primitive flipped `gradient+image` → `image+frame-image`: 2/2 frame layers imaged, `blur(50.4px)` (= the 3.6vw spec at a 1400px viewport), 0 mesh blobs, peak vertical spread 29.6 (rev 1 was 56.3 — the blurred field is gentler but far above the trap's 0). Crossfade verified interpolating 0.25/0.5/0.75 at off-keyframe hours. F16: `/projects` serves 200 and `SidebarProjectsMenu` is in the installed bundle. ⚠️ **The projects menu reuses `FolderPlusIcon` deliberately** (`SidebarProjectsMenu.tsx:81` — it replaces the New-project *button* with a popover, same glyph), so "new icon in the strip" is the WRONG acceptance check; rev-1 and rev-2 icon strips are pixel-identical and that is correct. Verify it by the bundle string `New folder…` or by opening the popover, never by looking for a changed glyph.
**Rebuild 07-25 (F16 projects SIDEBAR VIEW + 2 sky-test fixes, hub `2417b9a8d`):** built, signed (`Authority=T3 Code Fork Signing`), swapped; asar stamp `2417b9a8d1de`, plist LSEnvironment identical to the reference, update feed still michaelvu1207/t3code. **Silent boot — zero SecurityAgent processes** (fourth consecutive cdhash with no prompt, so the safeStorage close-out is settled), backend 200 on 127.0.0.1:3773, all 4 pairings intact in the v2 plaintext catalog. Sky probe PASS (peak vertical spread 29.6, crossfade 0.5 at both off-keyframe hours, 9/10 hours ramping) — unchanged from rev 2, as expected since the commit only touched sky *tests*. Rollback: `backup/T3-Code-Alpha-pre-projects.app`. Four traps worth carrying forward: (1) 🔴 **`launch_app` stole focus this time** — returned `active:true` and frontmost went `Rusted Warfare` → `T3 Code (Alpha)`, contradicting the rev-2 run's `active:false`. It is a report, not a guarantee; always poll frontmost after. Background-shell remediation (no pointer, no keystroke): `osascript -e 'tell application "System Events" to set visible of process "T3 Code (Alpha)" to false'` restored focus in ~2s, at the cost of leaving the app HIDDEN rather than backgrounded. (2) 🔴 **`strings app.asar` cannot verify any client-side change** — the web assets are compressed inside the asar, so `strings` reports ZERO for `starcodeSky`, `SidebarProjectsMenu`, `sidebar-workbench` and `New folder` on a bundle that demonstrably ships all of them; earlier notes calling these "bundle string checks" were really HTTP checks. Verify against the running app: `curl 127.0.0.1:3773/` → `/assets/index-*.js`, and keep the PREVIOUS build's `index-*.js` as a baseline so each acceptance string is provably absent-in-old / present-in-new. (3) That baseline is what caught a false discriminator: **`"No projects yet"` was already in the pre-F16 bundle** (from the standalone `/projects` page). The signals that actually discriminate are the testids `sidebar-v2-project-group{,-attention,-toggle}`, `sidebar-v2-project-{archived-toggle,seed,empty-link}`, `sidebar-v2-unfiled-triage{,-project,-thread}` and the tooltip `File unfiled threads into a project` — all 0 in old, 1 in new. For "Projects is in the view menu" the exact check is the minified labels object flipping from ``{inbox:`Inbox`,connections:`Connections`}`` to ``{inbox:`Inbox`,projects:`Projects`,connections:`Connections`}`` (the minifier emits BACKTICK strings, so any pattern written with `"` never matches). (4) **`pgrep -f "T3 Code (Alpha)"` silently never matches** — pgrep takes an ERE, so `(Alpha)` is a capture group matching bare `Alpha`, not the literal parens in the path; it falsely reported the app gone both 2s after quit and right after a successful launch. Use `ps ax -o pid,args | grep -F`. Also: `lsregister -u` returns `-10814` once a path is deleted (it must scan the bundle), so the stale `.prev` / stage entries are un-removable — harmless, because those leftovers are only *helper* sub-bundles with their own ids, and the passive singular-resolution gate passed with them present.
**🌤️ Finding — the sky is static across the working afternoon.** The 38 keyframes carry only 33 distinct field images, because **hours 11:00, 12:00, 13:00, 14:00 and 15:00 all share one identical 20x12 PNG** (hour 0/24 also share, correctly, as midnight wraps). Confirmed at the pixel level: 12:00, 13:30 and 15:00 all render top-luma 82.9. This is NOT a build defect and NOT the contrast clamp over-composing — `node scripts/derive-starcode-sky-timeline.mjs --check` passes clean and reports only 274/9120 cells at the contrast floor (3%, against a 35% gate), so it is a property of the derivation/source (an overcast day time-lapse that only films half the day). Worth a product call rather than a bug fix: it is the same complaint rev 1 fixed for 12:00-vs-19:00, except the collapsed span is now the middle of the working day, which is exactly when Michael has the app open. If the source genuinely has no midday variation, the honest options are to accept a static afternoon or to synthesize gentle drift the way the morning is already mirrored from the evening.
**🔭 Verifying renderer changes without driving Michael's pointer.** The packaged app serves its renderer at `http://127.0.0.1:3773`, so a headless browser can inspect the real shipped assets: `playwright-core` is a dep of `apps/desktop` (CommonJS — `import pw from ".../apps/desktop/node_modules/playwright-core/index.js"`, then `const {chromium} = pw`), and `executablePath()` resolves to an already-installed `~/Library/Caches/ms-playwright` chromium. ⚠️ **That profile is unauthenticated (lands on `/pair`) and defaults to LIGHT theme, where both ambient blobs and the entire starfield are `.dark`-only and therefore `display:none`** — which mimics the exact "flat tint, no mesh, no stars" failure you are testing for. Set `colorScheme:"dark"` AND add the `dark` class to `documentElement`, or you will report a false negative. For the app's own window use `cua-driver call screenshot '{"pid":..,"window_id":..}'` (read-only, no foregrounding) and decode the PNG in node to sample pixels. Sky-specific: `<html data-sky-phase>` reports the phase and `?sky=<hour|phase>` forces the clock — sweeping it across the day is the cheap proof the timeline is wired (distinct top stops per hour, `--sc-sky-stars` ramping 1→0→1, `--sc-sky-ember-x` sweeping east→west). **Stars are 0 from 06:30 to 19:30 by design**, so an absent starfield in the afternoon is the feature working, not a defect.
**🧪 Sky probe, proven in both directions — `~/Documents/Programming/agent-hub/scripts/probe-sky-pixels.mjs`.** Reads RENDERED PIXELS, not CSS gradient stops, so it survives the sky changing primitive (F17 = linear-gradient; rev 2 = per-keyframe data-URI images, upscaled + CSS-blurred, opacity-crossfaded). `node scripts/probe-sky-pixels.mjs http://127.0.0.1:3773` against the running desktop app; `--trap` injects the body-stacking-context failure so the probe's own teeth can be re-verified on a healthy build. Current status: PASS on `b1c28ec71` (peak vertical spread 56.3, 7/8 hours ramp, 8/8 distinct columns), FAIL with 3 assertions under `--trap` (peak spread 0.00). Three calibration findings, each of which cost a false result before it was fixed: (1) **sample columns must clear foreground UI** — a column through the centred pairing card reports ~41 luma of spread even when the sky is perfectly flat, so the trap passed undetected; columns at x=60/200/1340 read exactly 0.00 when trapped. (2) **The flat check must be GLOBAL, not per hour** — night legitimately resolves onto a near-uniform `#0e1117` (hour 3 measures ~2.6 spread on a healthy build), so a per-hour floor calls the correct night sky broken; the trap instead flattens EVERY hour at once. (3) ⚠️ **Temporal distinctness alone does NOT catch this trap** — under `--trap` the sweep still reports 7/8 distinct columns and noon≠19:00, because body is painted with the sky's own top stop, which still varies by hour. Hour-sweeping proves the timeline is wired; only the vertical assertion proves the sky is actually visible. Both are needed, for different failures.
**Rebuild 07-25 (F16.2 UI round, hub `eddd9cebb`):** built, signed, swapped; asar stamp `eddd9cebb368`, plist keys intact, fork feed intact, **silent boot** (fifth consecutive cdhash, zero SecurityAgent), backend 200, all 4 pairings intact, sky probe PASS unchanged (peak spread 29.6). All 12 handed-over discriminators PASS by absent-in-old/present-in-new against the saved `2417b9a8d` bundle — positives `sidebar-v2-row{,-status,-provider}`, `connection-mark`, `sidebar-v2-project-new-thread{,-location}`, `project-delete{,-confirm,-refusals}`; negatives `sidebar-v2-project-group-attention`, `sidebar-v2-row-card`, `sidebar-v2-row-slim` all gone. Default flip verified as `DEFAULT_SIDEBAR_V2_VIEW_MODE = "projects"`. Two method notes: match discriminators in the **backtick-delimited** form (`` `sidebar-v2-row` ``) because bare substring matching passes on prefixes — `sidebar-v2-row` "appears" in the old bundle only inside `sidebar-v2-row-card`; and the settings default is greppable only server-side, since `apps/server` ships contracts UNMINIFIED in `app.asar` while the web bundle inlines it. ⚠️ The flip is invisible to anyone with a persisted value — Michael's `client-settings.json` already read `sidebarV2ViewMode = 'projects'` before it shipped, so it changes nothing for him.
**Rebuild 07-25 (F16.2b + F15 split view, hub `afbff141c`):** built, signed, swapped; asar stamp `afbff141cfcf`, plist intact, fork feed intact, **silent boot** (sixth consecutive cdhash), backend 200 in ~3s, 4 pairings intact, sky probe PASS (29.6). Used the PASSIVE `lsregister` single-path check — exactly one top-level `/Applications/T3 Code (Alpha).app`, and 0 processes after, confirming it launches nothing. All 15 positives and all negatives PASS; split view confirmed renderer-only (0 `sc-split` across all 3 `dist-electron` files). **Third confirmation of the ~10s foreground drift**: `launch_app` returned `active:false`, frontmost stayed `ChatGPT` at t=3s/6s, then flipped to the app at t=9s and stayed — so the ~20s poll is mandatory, not belt-and-braces. Three method corrections, each of which would have produced a wrong verdict: (1) **`grep -c` counts LINES, not occurrences** — the minified client is ~586 very long lines, so a string occurring 2-3x within one line still reports `1`. Fine for present/absent, silently wrong for "expect exactly N": the handed-over check said `starcode-section-rule` should appear exactly 2x and `grep -c` said 1, while the true count (`grep -oF | wc -l`) was 2, plus 4 in the CSS bundle where the class is defined. (2) **Match by how each string is emitted.** Whole literals (testids, aria-labels, storage keys, sentences) are backtick-delimited; CSS classes live inside a longer `className` string and DOM attributes are bare, so `starcode-section-rule`, `sc-split-{divider,container}` and `data-split-pane` only match as SUBSTRINGS — demanding a closing backtick fails them wrongly. (3) For the main-process assertion, extract via `@electron/asar` resolved under `node_modules/.pnpm/@electron+asar@*/...` (a bare `require` fails — pnpm does not hoist), and print counts with `process.stdout.write(String(n))`: `console.log(n)` ANSI-colorizes numbers, which made a passing `0` fail a shell string comparison. ⚠️ Two handed-over discriminators were also wrong and were reclassified rather than failed: **`Settle thread` survives by design** (it is a label in the very ··· menu this wave adds, `SidebarV2.tsx:1510`; asserting absence = false failure), and `sidebar-v2-project-group-attention` / `sidebar-v2-row-card` / `sidebar-v2-row-slim` were **already 0 in the `eddd9cebb` baseline** — carried over stale from the previous wave, so they are regression guards that prove nothing about this build.
**Rebuild 07-25 (F16.2c split entry + docked Chats, hub `d118b4396`):** built, signed, swapped; asar stamp `d118b4396640`, plist + fork feed intact, **silent boot** (seventh consecutive cdhash), backend 200 in ~3s, 4 pairings intact, sky probe PASS (29.6). Passive `lsregister` check: exactly one top-level bundle, 0 processes after. **Fourth confirmation of the foreground drift** — `active:false`, frontmost still `cmux` at t=3s, app took over at t=6s and held to t=24s (drift onset now measured at 6-12s across four swaps). All discriminators PASS: `Open in split` 0→1, `sidebar-v2-chats-panel` 0→1, and the prefix-safe token census gives `sc-chats-dock` 0→(js 1 + css 2) with `sc-chats-dock-gap` 0→3 in CSS. **Two method notes.** (1) Baselining the **CSS** bundle as well as the JS was load-bearing this wave — `sc-chats-dock-gap` ships only in CSS, so a JS-only diff could not have proven it shipped at all. (2) For the `sc-chats-dock` / `sc-chats-dock-gap` prefix pair, do not count the short form and do not rely on match ordering: enumerate `grep -oE 'sc-chats-dock[a-z-]*'` and bucket the tokens with `grep -cx`, which separates both in one pass and cannot double-count. Confirms the standing don't-conflate warning too: `Open split view` (1) and `Close split view` (3) are pre-existing from F15 and identical old vs new, so either would have "passed" no matter what shipped.
**Rebuild 07-25 (F16.2c rev-2 split entry + portal-bubble fix, hub `41b2bf979`):** built, signed, swapped; asar stamp `41b2bf979543`, plist + fork feed intact, **silent boot** (eighth consecutive cdhash), backend 200 in ~3s, 4 pairings intact, sky probe PASS (29.6). Passive `lsregister` check clean (one top-level bundle, 0 processes after). Fifth drift confirmation (`active:false`, cmux held at t=3/6s, app took over at t=9s). All gated checks PASS: `Open in split view` 0→1, `Already open here` 0→1, `Already in split view` 0→1, bonus reason codes `already-primary`/`already-secondary` 0→2 each, bare `Open in split` 1→0 prefix-safely, `sc-chats-dock-gap` still 3 in CSS (hash `index-Bhhdlg-1.css` unchanged, as predicted).
**Rebuild 07-25/26 (F16.3 row-menu verbs, hub `dc26fdf7a`):** built, signed, swapped; asar stamp `dc26fdf7a480`, plist + fork feed intact, **silent boot** (ninth consecutive cdhash), backend 200 in ~3s, 4 pairings intact, sky probe PASS (29.6, 10/10 distinct columns). Passive `lsregister` clean. All 10 handed-over discriminators PASS 0→1 (testids `sidebar-v2-row-{rename,move-to-project,move-to-chats,move-target,fork,archive}`; labels `Fork thread`, `Move to project`, `Remove from project`; toast `Same folder, branch and model. The conversation starts fresh.`) — a genuinely clean list this time, every one confirmed 0-in-baseline beforehand and present in source. Added a **carry-forward regression spot-check** the brief did not ask for (`Open in split view`, `Already open here`, `sidebar-v2-row-menu`, `sidebar-v2-chats-dock`, `sc-chats-dock-gap`) — all survived; a purely additive wave is exactly where a silent regression in the previous wave's work would hide. Ran an explicit prefix-relationship scan over the six testids first and found none, so plain substring matching was safe here — worth doing rather than assuming, since `…move-to-project` and `…move-to-chats` share a long prefix but diverge, unlike the `sidebar-v2-row` / `-card` / `-slim` family that broke an earlier wave.
**🌤️ NO FOREGROUND DRIFT on this swap — the first one.** `launch_app` returned `active:false` and frontmost stayed `Claude` across the full 24s poll, where the previous five swaps all drifted at t=6-12s. The one variable that changed: **Michael was away** (HIDIdleTime 5075s ≈ 85 min) rather than actively at the keyboard. Not enough to call causal, but it suggests the drift may be an activation race with the user's live session rather than a pure timer. Keep the 20s poll regardless — no drift on one swap is not a guarantee.
**⚠️ PLAN.md IS NOW A TRACKED REPO FILE.** Since the docs move (`924f64df9`), `~/Documents/Programming/agent-hub/PLAN.md` is a SYMLINK to `t3code/docs/fork/PLAN.md` inside the main clone. Edits tools may refuse to write through the symlink (resolve with `readlink -f` and edit the real path), and — more importantly — **every PLAN.md edit is now an uncommitted change in the shared main clone**, where the existing "two agents sharing the main clone = footgun" and "build in main clone can capture concurrent agent WIP" hazards both apply. Whoever edits it should commit by explicit path promptly, and anyone building in that clone should `git status` first.
**🔴 IDENTIFIERS ARE NOT VALID BUNDLE DISCRIMINATORS.** The handed-over negative `resolveSplitControlPlacement` was **vacuous, not merely weak**: it reads 0 in the `d118b4396` bundle ALREADY, even though the function demonstrably existed there (exported at `openInSplit.ts:97`, 12 source hits in that commit). The production minifier mangles function and variable names, so **only string literals, testids, CSS classes and DOM attribute names survive into a bundle**. Asserting the absence of an identifier reports PASS while proving nothing — a third distinct way a negative can be empty, after "already removed last wave" and "already present for unrelated reasons". Same applies to `resolveOpenInSplitAvailability`. Both removals were verified at SOURCE level (`git show 41b2bf979`) and reported as informational rather than gated. Related: this commit's footer removal has **no clean bundle-observable signature at all** — everything it deletes is either an identifier or a generic short string (`"footer"`, `"menu"`, `"primary"`, `"secondary"`, `"split"`) that appears throughout the bundle for unrelated reasons; and `Two threads at once` appears on BOTH sides of the diff, so it survives and is not a footer signal either. The honest proof is the positive set plus the disappearance of the bare label.
**⏸️ Swapping while Michael is IN the app: wait, and close the race.** He was frontmost in the app for ~15 min reviewing the previous build. Quitting then would have yanked the window mid-look. Two things made this workable: (a) `ioreg -c IOHIDSystem | awk '/HIDIdleTime/'` gives seconds since last keyboard/mouse input, which distinguishes "actively using it" from "window merely sitting frontmost while he is away" — a passive read, no pointer involved; (b) a check-then-quit in two separate Bash calls LOSES the race (he switched back in between and the quit aborted). Do the poll and the quit in ONE script: sample frontmost twice a few seconds apart, and if both samples are clear, quit and `ditto` immediately in the same process.
**🔴 CORRECTION (07-25): the "passive" single-path assertion is what steals focus.** `osascript -e 'POSIX path of (path to application id "com.t3tools.t3code")'` — which the rule below tells everyone to run before every relaunch — **LAUNCHES the app and foregrounds it**. Proven directly: quit to 0 processes, ran only that one line, and 3s later there were 2 processes with `T3 Code (Alpha)` frontmost. This retro-explains both "launch_app stole focus" reports: the app was already up and frontmost *before* `launch_app` was called, so `active:true` was just a report on an instance the check itself had started. **Use the passive form instead** (verified to launch nothing — 0 processes after, frontmost unchanged): `lsregister -dump | grep -E '^\s*path:' | grep -F "/Applications/T3 Code"`, asserting exactly one TOP-LEVEL `/Applications/T3 Code (Alpha).app` row; `…Helper.app` and `.app.prev/Contents/Frameworks/…` rows are helper sub-bundles with their own ids and never contend. Separately, **`launch_app` is focus-safe at return but the app drifts foreground ~12s later**: a cold-start test returned `active:false` with frontmost still `Arc` at t=3/6/9s, then `T3 Code (Alpha)` at t=12s — [[cua-driver-launch-foreground-drift]] measured. So poll frontmost for ~20s after a relaunch, not once. Remediate with `osascript -e 'tell application "System Events" to set visible of process "T3 Code (Alpha)" to false'` (leaves the app HIDDEN — tell Michael), and **stop hiding if frontmost starts oscillating**: that is Michael switching apps himself, and re-hiding fights him for his own machine.
**⚙️ Operational rule (07-25): keep rollback bundles OUT of /Applications, and assert a single LaunchServices path before relaunching.** Parking the previous build beside the new one as `T3 Code (Alpha).app.prev` re-creates the very bundle-id collision that deleting the upstream Nightly was meant to end: LaunchServices registers any bundle under /Applications regardless of the `.prev` suffix, so `com.t3tools.t3code` resolves to two apps and a `launch_app` by bundle id can silently start the STALE build — indistinguishable from a swap that didn't take, and worth hours of phantom debugging. Rollbacks live in `~/Documents/Programming/agent-hub/backup/` (current: `T3-Code-Alpha-pre-f17.app`). Before any relaunch, assert resolution is singular with `osascript -e 'POSIX path of (path to application id "com.t3tools.t3code")'` — a passive query that does not launch. Dead `$TMPDIR` stage copies register too and SURVIVE their directories being deleted; clear them with `lsregister -u <path>` (binary under `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/`). Both were live on 07-25 (two stage ghosts + one `.prev`) and are now cleared.
**Follow-ups:** (1) 🔴 hide/disable the "seablue Local" environment in the fork UI — threads created against it would be invisible orphans (guidance until then: always pick a named machine in the composer); (2) 🔴 stock "T3 Code (Nightly).app" shares bundle id AND would contend on ~/.t3 with the launchd hub if launched — don't launch it; real fix = §7.7 DESKTOP_APP_ID fork-identity rename (or delete Nightly); (3) one-off client-side 500 on restart — "Reload app" fixes, watch for recurrence; (4) cua lesson memorized: slow Electron launches outlive the focus guard — verify frontmost post-launch. **Relaunch is `cua-driver call launch_app '{"bundle_id":"com.t3tools.t3code"}'`, never `open -a` — every form of `open` routes through LaunchServices and foregrounds the target, stealing focus from whatever Michael is in.** This was violated on the F17 swap by an instance working from the memory file alone, which carried the `launch_app` path for pairing but not the prohibition; both the rule and the passive frontmost check (`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`) are now in that memory file too, so a fresh instance cannot miss it.

## Standing rollout pipeline (updated 07-25)
⚠️ **Run `vp i` after every pull, before every build** — merges that add dependencies (F11's @fontsource-variable/baloo-2) break the build identically on every machine otherwise. Also: path-pc SSH = alias `path-pc` (user `path`), not a guessed user@ip. Every merged wave ships to: (1) Mac launchd hub server (vp i + vp run build + kickstart — serves web UI + all API surfaces), (2) the three remote servers (pull/build/restart), and — per Michael 07-25 — (3) **the installed desktop app**: rebuild the desktop artifact from hub and swap it into /Applications, then relaunch (mechanics per t3-desktop's report — asar/contents swap if viable, else full electron-builder rebuild; auto-update feed points at the fork so a future GitHub-releases path can replace manual swaps if we ever clear the release-pipeline blockers). Desktop is a pure client — server-side changes reach it via the hub; client-side changes require the desktop rebuild step.

## Effort

| Phase | Effort |
|---|---|
| 0 — tmux + claude-peers | ~half day |
| 1 — vanilla t3 eval | ~1h setup + passive days |
| 2 — fork: dashboard + federation + accounts | ~1–2 weeks part-time (sidecar ~1–2 days, MCP tool ~1 day) |
| 3 — consolidate | small |

## F12 plan — Connections dropdown + view rework + import-only history (07-25, PROPOSED, rev 2)

**Ask (Michael)**: (1) a connections icon in the sidebar icon strip with a small dropdown showing per-connection subscription usage, health, and ping; (2) rework the connections view; (3) **"get rid of the whole idea of viewing historical threads — that should only be usable in the import. All I care about is knowing which conversation I'm looking at, because sometimes the title doesn't represent the conversation. We don't need to see the whole conversation. The import view should just show the title, a small preview, and allow me to resume and start code from there."**

Rev 2 folds in the scope cut: **F5's history-*viewing* surface is deleted; F5's history *reader* survives as the import picker's data source.** History is now import-only.

**Headline verdict: real resume works.** A new starcode thread can genuinely CONTINUE a historical CLI session — the model keeps its own context — for **both** Claude and Codex, with **zero adapter changes, no new WS RPC, and no migration**. Evidence in §A. Michael wants to resume and start coding, not read old history, so resume is the whole feature and the transcript-graft fallbacks are dead.

---

### A. Import mechanism — the load-bearing recon

**Claude.** `ClaudeAdapter.startSession` reads a resume cursor and passes it straight to the Agent SDK:
- `apps/server/src/provider/Layers/ClaudeAdapter.ts:3170-3174` — `existingResumeSessionId = readClaudeResumeState(input.resumeCursor)?.resume`
- `ClaudeAdapter.ts:3547-3548` — `...(existingResumeSessionId ? { resume: existingResumeSessionId } : {})`
- SDK typing `@anthropic-ai/claude-agent-sdk@0.3.170` `sdk.d.ts:1764-1767` — *"Session ID to resume. Loads the conversation history from the specified session."*
- The cursor parser `ClaudeAdapter.ts:559-596` validates only UUID shape (`:582`). **It never checks that t3 created the session.** That single fact is why import is possible.

**Codex.** Same story, cleaner:
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts:457-494` — `thread/resume { threadId, ...startParams }` when a cursor exists, else `thread/start`
- cursor schema is one field: `CodexSessionRuntime.ts:67-69` — `{ threadId: Schema.String }`
- `packages/effect-codex-app-server/src/_generated/schema.gen.ts:40503` documents resume-by-thread-id as *"load the thread from disk by thread_id"*

**The seam that makes import a server-side one-liner** — `apps/server/src/provider/Layers/ProviderService.ts:562-567`:
```ts
const effectiveResumeCursor =
  input.resumeCursor ??
  (persistedBinding?.providerInstanceId === resolvedInstanceId
    ? persistedBinding.resumeCursor : undefined);
```
Write one `provider_session_runtime` row at import time (`ProviderSessionDirectory.upsert`, `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:98-146`) and the thread's first turn resumes the foreign session. The persisted row is required, not optional: `ProviderCommandReactor.startProviderSession` only forwards a cursor on *restart* (`ProviderCommandReactor.ts:573-596`), never on first start.

**Thread creation needs no new surface.** `POST /api/orchestration/dispatch` already accepts the whole `ClientOrchestrationCommand` union (`packages/contracts/src/environmentHttp.ts:513-519`), incl. `project.create` and `thread.create`. F7's `apps/server/src/peers/PeerThreadWriter.ts:261-356` is a working fork-authored reference. ⚠️ `bootstrap.createThread` is silently ignored over HTTP (only `ws.ts:840` unpacks it) — fine, since import wants a thread that sits idle until Michael types, not one that fires a paid turn.

**Two traps that must be designed against, not discovered:**
1. **cwd/project.** `ProviderCommandReactor.ts:495` resolves the session cwd via `resolveThreadWorkspaceCwd` (`apps/server/src/checkpointing/Utils.ts:12-28`) = `thread.worktreePath ?? project.workspaceRoot`, which **wins over** the persisted cwd. Claude resolves `--resume` relative to the cwd's project dir. Import must file the thread under a project rooted at the session's exact cwd — creating it via `ProjectCreateCommand` (`packages/contracts/src/orchestration.ts:532-541`) if absent — or refuse.
2. **Instance/home ownership.** `CLAUDE_CONFIG_DIR` (`apps/server/src/provider/Drivers/ClaudeHome.ts:33`) and `CODEX_HOME` (`CodexSessionRuntime.ts:731-735`) are per *provider instance*. Wrong instance = resume fails, and for Codex it fails **silently**: `CodexSessionRuntime.ts:436-443, 484-491` degrades a not-found thread into a brand-new empty one — an import that looks successful and has amnesia. Pre-flight existence + home-ownership checks are mandatory.

**Recommendation: mechanism (1) — real resume via the seeded binding row.** Not transcript-graft, not read-only view. It is the only option that gives the model its history, it needs no decider/projector/contract changes, and it is symmetric across both providers.

**Do NOT defer Codex.** The brief anticipated Codex might be much harder — the opposite is true. Its cursor is one field and its id is a straight copy from the rollout filename. Claude is the messier one (4-field cursor). The only Codex-specific work is the pre-flight check above.

**What the imported thread shows** (now that viewing is gone): an empty transcript that the model nonetheless remembers. That is a genuine UX hazard — a thread that looks brand new but carries hundreds of messages of hidden context. §E keeps one non-interactive provenance line to defuse it.

---

### B. Removal inventory — history viewing dies, the reader lives

The F5 components form a **closed reference cluster** (verified by grep across `apps` + `packages`): nothing outside the set below imports any of them, so deletion is clean and shrinks the fork diff rather than growing it.

**DELETE (client, all fork-owned, ~1,150 lines):**

| File | Why |
|---|---|
| `apps/web/src/components/history/HistoryTranscriptView.tsx` (290) | full-conversation reader |
| `apps/web/src/components/history/HistoryTranscript.logic.ts` (105) + `.test.ts` (132) | its pagination fold / auto-continue |
| `apps/web/src/routes/_chat.$environmentId.history.$sessionId.tsx` (36) | the viewer route |
| `apps/web/src/components/sidebar/SidebarTerminalHistoryStrip.tsx` (239) | the passive sidebar strip |
| `apps/web/src/components/Sidebar.history.ts` (195) + `.test.ts` (175) | strip paging/expansion logic |
| `useHistoryTranscriptPage` in `apps/web/src/state/terminalHistory.ts:57-63` | paginated transcript hook |

**Call-site edits caused by the deletions** (all shrink): `SidebarConnectionsView.tsx` (drop the import at `:35` and the render block at `:176-183`), `apps/web/src/connection/runtime.ts` (repoint the loader layer), `apps/web/src/routeTree.gen.ts` (**regenerate, never hand-edit** — header at `:7-8`), `packages/client-runtime/package.json` (`exports` subpath).

**KEEP but reshape** — `apps/web/src/components/sidebar/HistoryProviderIcon.tsx` (24 lines) moves into the picker; `packages/client-runtime/src/state/terminalHistory.ts` keeps its sessions loader and swaps the transcript loader for the bounded preview loader.

**KEEP wholesale (server, `apps/server/src/history/`)** — this is the picker's data source and none of it is viewing-specific:

| File | Fate |
|---|---|
| `HistoryIndex.ts` (348) | keep — stat-index + lazy per-page hydration; **extend** with title (§C) |
| `paths.ts` (117) | keep — id minting, traversal guard, Claude dir decoding; **extend** with native-id extraction |
| `records.ts` (321) | keep — jsonl record parser; **extend** with title/preview folds |
| `tailReader.ts` (286) | keep — `readSessionHead` + backwards chunked reads; still needed for preview and title |
| `query.ts` (156) | keep the sessions cursor/window math; **drop** the transcript-cursor half |
| `http.ts` (142), `layer.ts` (11) | keep, reshaped endpoints |

**Endpoint reshape.** `GET /api/history/sessions/:sessionId/transcript` (paginated, `before`/`nextBefore` byte-offset cursor) is replaced by `GET /api/history/sessions/:sessionId/preview` — **bounded, no cursor, no load-more**. The whole `history` group was added by F5 and is ours to reshape (`packages/contracts/src/environmentHttp.ts:636-665`); dropping the cursor deletes the transcript half of `query.ts`, the `HistoryTranscriptPage`/`nextBefore` contract shapes, and the client pagination loop. Constraining rather than reshaping would leave dead pagination machinery behind — reshape is the smaller permanent diff.

⚠️ Rollout skew: during the fleet update a new client hitting an old server gets **200 + SPA HTML**, not 404 (`packages/client-runtime/src/state/terminalHistory.ts:16-21`). The preview fetch must catch broadly and degrade to "no preview", exactly as F5's loaders do.

---

### C. The picker's disambiguation payload — title + small preview

Michael's requirement is narrow and specific: *know which conversation this is, because the title sometimes lies.* Two recon findings shape this, and neither was obvious:

**1. Claude sessions carry a real title — but only sometimes.** Records of the form `{"type":"ai-title","aiTitle":"check cmux licensing","sessionId":"…"}` appear in **16 of the 40 most recent sessions on this Mac**; the other 24 have none (older sessions predate the field). Titles are appended as they are revised, so **the last one wins** and it can sit anywhere in the file — finding it needs a tail read as well as the head read F5 already does. `tailReader.ts` has both primitives (`readSessionHead`, `readTranscriptTail`), so this is a fold, not new I/O machinery — but it must stay lazy and per-page like F5's snippet hydration (`HistoryIndex.ts:303-327`), never a full scan.

**2. Codex rollouts have no title at all.** Confirmed against a live rollout: record types are `session_meta`, `event_msg`, `response_item`, `world_state`, `turn_context`, `inter_agent_communication_metadata`, `compacted` — nothing title-shaped.

So the picker's title is a **fallback chain**: `ai-title` (Claude, when present) → first user message clipped → project label. Add `title: Schema.NullOr(TrimmedNonEmptyString)` to `HistorySessionSummary` (`packages/contracts/src/history.ts:88-108`) and let the client render the fallback honestly — a derived title should look derived, not authoritative.

**Preview = bounded, ~6–10 entries**: the opening user message plus the last few exchanges. That is what actually disambiguates — a mistitled conversation is identified by how it *started* and where it *ended up*, and the existing 240-char snippet (first human turn only) cannot separate two sessions in the same repo. Reuse `records.ts`'s renderer (role, clipped text, tool-call names, timestamp — `records.ts:55-66`); it is lossy by design (no tool arguments, no results, no thinking blocks) and that is now exactly right.

⚠️ **Codex `compacted` records**: a compacted rollout replaces early history with a summary (`compacted.payload.replacement_history`), so "the first user message" may live inside one. Fold it in, or the preview of a long Codex session starts mid-conversation. ⚠️ Also, `session_meta` appeared **96 times** in one live rollout (resumes append), so the authoritative resume id is the **filename**, not "the last `session_meta`".

**Picker row**: provider icon · title · one-line snippet · project label · machine · age · **Resume in starcode**. Selecting a row expands the bounded preview inline (side pane when wide, expanded row when narrow). Already-imported rows badge as **Imported** and offer **Open** instead.

---

### D. Phase 1 — Connections icon + status dropdown (client only)

A 7th button in the icon strip. Today there are **six** (the brief said five): sidebar trigger, search, new thread, workbench, new project, view menu — `apps/web/src/components/sidebar/SidebarHeaderCompact.tsx:108-205`, all inline JSX in the flex container at `:107`. The header comment at `:91-106` already budgets for it (six 28px buttons = 188px of the 208px minimum width; `flex-wrap` is the declared overflow strategy — *"A seventh icon… wraps to a second centred line"*), but that wrap has never actually been seen. Verify at minimum width; if it reads as broken, fold the view menu into the new dropdown.

A self-contained trigger needs **zero prop threading and zero `SidebarV2.tsx` edits** (the call site at `SidebarV2.tsx:2158-2163` is untouched).

**Primitive**: `apps/web/src/components/ui/popover.tsx`, not the `Menu` used by `SidebarV2ViewMenu.tsx` — rich rows, not menu items. Copy the tooltip-wrapped trigger sandwich from `SidebarV2ViewMenu.tsx:44-65` verbatim. Base UI (`@base-ui/react`), not Radix.

**One row per connection** (~320px, no scrolling at 4 machines):

| Element | Source | Evidence |
|---|---|---|
| status dot + phase + retry countdown | `environmentCatalog.stateAtom(envId)` via `useEnvironmentConnectionState` | `apps/web/src/state/environments.ts:87-89`; enum `packages/client-runtime/src/connection/model.ts:118-137` |
| label, Local badge, URL | `useEnvironments()` | `apps/web/src/state/environments.ts:36-56` |
| ping (RTT ms) | **new** fork-owned atom, §D.1 | — |
| spend today + peak rate-limit % | `environmentUsage.snapshotValueAtom(envId)` + `peakUsedPercent` | `apps/web/src/state/usage.ts:17`; `packages/client-runtime/src/state/usage.ts:140-148` |
| retry action | `environmentCatalog.retryNow` | `packages/client-runtime/src/state/connections.ts:106-115` |
| error + trace id | `connection.error` / `.traceId` | `packages/client-runtime/src/connection/presentation.ts:15-19` |

Read `stateAtom`, **not** `EnvironmentConnectionPresentation` — the presentation layer discards `attempt`, `retryAt`, and `stage` (`presentation.ts:26-55`), and "reconnecting, retry in 8s" is exactly what this dropdown exists to say.

Usage reuse is free: `usage.ts:140-148` is an `Atom.family` with 5-min idle TTL + 30s refresh, so the dropdown shares the settings panel's cache and thrashes nothing. Per-connection is the right cut (the endpoint is per-machine; `instances[]` inside it is per-account — `packages/contracts/src/usage.ts:104-124`). Keep it to spend-today + peak-%; per-account bars stay in `/settings/usage`. **Null is not zero** (`packages/contracts/src/usage.ts:43-47`) — render unknown utilization as the striped track from `AccountsUsagePanel.tsx:82-86`, never an empty bar.

Badge the trigger icon when any connection is unhealthy or any account crosses its warning threshold — that is the point of putting it in the strip. Footer: **"Import a conversation…"**, plus links to `/settings/connections` and `/settings/usage`, and optionally a fleet-total spend line.

#### D.1 Ping — the one genuinely new measurement

**There is no latency measurement anywhere.** `apps/web/src/rpc/requestLatencyState.ts` is a slow-request watchdog that records `startedAtMs` and never subtracts it (`:47-82`). No WS heartbeat exists.

`connectionProbe` is real and universally advertised — contract `packages/contracts/src/environment.ts:42`, server advertises at `apps/server/src/environment/ServerEnvironment.ts:142`, RPC `server.probe` (`packages/contracts/src/rpc.ts:207`), handler returns `{}` immediately at `apps/server/src/ws.ts:1457-1458` under `orchestration:read` — but it fires **only** on app-foreground wake (`packages/client-runtime/src/connection/supervisor.ts:404-448`) and is never timed.

**Recommendation**: a fork-owned client atom that times the existing `RpcSession.probe` (`packages/client-runtime/src/rpc/session.ts:128-146`, an `Effect<void>`), reached via `runInEnvironment(envId, …)` → `EnvironmentSupervisor.session`. Measure on popover open plus a slow interval while open. It measures the real WS path, adds no RPC method, and does not touch the supervisor service shape at `supervisor.ts:196-207`. The probe closes over a cached `initialConfig` (`session.ts:117-131`), so discard or label the first sample on a fresh session. A `backoff` connection has no session to probe — show "—", visually distinct from "slow".

Rejected: extending the supervisor to time its own probe (changes a shared service interface for a cosmetic number); timing `.well-known/t3/environment` (`packages/client-runtime/src/environment/descriptor.ts:8-17` — measures HTTP, would read healthy while the WS is down).

**Size**: ~1 agent session, client only.

---

### E. Phase 2 — Connections view rework + viewing removal (client only)

`SidebarConnectionsView.tsx` is 189 lines. The rework is mostly subtraction:

1. **Status detail moves to the dropdown.** Health today is exactly `:124-137` — a `ConnectionStatusDot` whose tooltip is `connectionStatusText(group.connection)`. Keep the dot (it is the collapsed-state signal and costs nothing); drop the prose tooltip. The header becomes label · Local badge · count · chevron.
2. **The terminal-history strip is deleted** (§B), not restyled. In its place, one dashed **"Import conversation…"** row per group, opening the picker pre-scoped to that connection.
3. **Unchanged**: the thread list (`:163`), "Show N more" paging (`:164-175`, logic in `Sidebar.connections.ts:128-146`), the empty state, and group ordering (local-first then by label, `Sidebar.connections.ts:110-120`).
4. Close two F4 follow-ups while in the file: the redundant machine badge inside named groups, and the doubled empty state when every machine is empty.

**Provenance in the imported thread**: one non-interactive line — *"Resumed from a Claude terminal session · 483 messages · Jul 12"* — as a fork-owned `ImportedThreadPrelude` behind a single conditional in `ChatView.tsx` (~`:5675`). No link (the viewer is gone). Recommend keeping it despite `ChatView.tsx` being the repo's hottest file (34/500): without it, an imported thread looks brand new while the model silently remembers everything, which is the kind of surprise that erodes trust in the whole feature. It is one conditional plus one import, with all logic in the fork-owned component — the discipline F4 used in `SidebarV2.tsx`. If Michael prefers zero hot-file diff, dropping it is a clean one-line decision (§J q2).

**Size**: small — a rider on Phase 1, mostly deletions.

---

### F. Phase 3 — Import + reader reshape, server side

**Endpoints land on the existing F5 history group** — no new contract group and **no `server.ts` edit**, because `historyHttpApiLayer` is already provided there. Cheaper than the §8 4-edit recipe: 2 edits (endpoints on `EnvironmentHistoryHttpApi` at `packages/contracts/src/environmentHttp.ts:636-665`, handlers in `apps/server/src/history/http.ts`).

```
GET  /api/history/sessions              → orchestration:read     (kept; + title in the summary)
GET  /api/history/sessions/:id/preview  → orchestration:read     (REPLACES …/transcript)
POST /api/history/sessions/:id/import   → orchestration:operate  (new)
GET  /api/history/imports               → orchestration:read     (new)
```

`POST …/import` body `{ projectId?, providerInstanceId?, model?, title?, createProjectAtCwd?: boolean }`. Handler:

1. `HistoryIndex.resolve(sessionId)` (`HistoryIndex.ts:331-338`) — the traversal guard is already correct: paths only ever come from `Map.get` on the server's own index.
2. Extract the **native** session id + cwd. Claude = filename minus `.jsonl` + `record.cwd`; Codex = the **filename** uuid (not "the last `session_meta`" — a live rollout had 96 of them) + `payload.cwd`. `readRecordProjectPath` (`records.ts:266-274`) already reads cwd for both.
3. **Idempotency**: consult the registry; if the mapped thread still exists, return `{threadId, alreadyImported: true}` and stop.
4. **Validate**: Claude id passes the adapter's UUID check (`ClaudeAdapter.ts:582`); the file lives under the chosen instance's home (`makeClaudeContinuationGroupKey`, `ClaudeHome.ts:37`; `codexConfig.homePath`, `CodexAdapter.ts:1404`); the file still exists. Fail loudly — this is the only thing standing between a typo and a silently amnesiac Codex thread.
5. **Resolve the project**: prefer one whose `workspaceRoot` equals the session cwd; else `project.create` at that cwd when `createProjectAtCwd`; else 409 carrying the cwd.
6. `thread.create` through the orchestration engine (the same call `apps/server/src/orchestration/http.ts:84` makes), `title` set explicitly and **no `titleSeed`** — that is what suppresses the LLM auto-rename (`ProviderCommandReactor.ts:109-119`).
7. Seed the binding row (§A).
8. Record provenance; return `{threadId, projectId, alreadyImported: false}`.

**Registry — a JSON file, not a migration.** `<stateDir>/history-imports.json`, mirroring F2's `peersPath` (`apps/server/src/config.ts:116`) — one added line in `config.ts`. Entries `{historySessionId, nativeSessionId, provider, threadId, projectId, importedAt}`. Rationale: threads have **no free-form metadata field** (`packages/contracts/src/orchestration.ts:345-378`; `projection_threads` in `005_Projections.ts:21-33` plus later ALTERs — nothing free-form), and adding one is a ~6-file contracts/decider/projector change plus a `037_` migration. Migrations are the fork's #1 documented risk (NOTES-addendum §7.4) and this feature does not need one. Stale entries are caught by a projection lookup before claiming "already imported".

**Cross-machine is free**: the client calls the endpoint on the *owning* environment's `httpBaseUrl`, so import and resume both happen on the machine that owns the session and its cwd. No peer credential, no federation hop.

**Size**: ~1 agent session, server only (import + preview reshape + title extraction).

---

### G. Phase 4 — The import picker (client)

The picker is now the **only** history UI in starcode. Reachable from the Phase 1 dropdown footer, the Phase 2 per-group row, and ⌘K.

- **List**: `GET /api/history/sessions`, reusing F5's fetch layer (`packages/client-runtime/src/state/terminalHistory.ts:75-99`), with a connection selector, provider filter, and text search over title/snippet/project. Rows per §C.
- **Preview**: bounded fetch on selection; ~6–10 entries, no load-more, no virtualization (that machinery is what we just deleted).
- **Target**: resolved project (or "will create project at `<cwd>`"), provider instance, model.
- **Action**: **Resume in starcode** → navigate to `/$environmentId/$threadId` with the composer focused, because the point is to start coding.

**Fetch idiom (mandatory)** — `environmentEndpointUrl` → `makeEnvironmentHttpApiClient` → `buildEnvironmentAuthHeaders` → `withEnvironmentCredentials` → `executeEnvironmentHttpRequest`, per `terminalHistory.ts:83-98`. Build the URL fully interpolated (the relay DPoP proof binds to it). And the fork-wide review item applies: **wait on `SubscriptionRef.changes(supervisor.prepared)`** (idiom at `packages/client-runtime/src/state/threads.ts:255-269`, repeated at `usage.ts:116-129`) — a fetch that reads the connection once passes tests and silently fails in-app.

**Size**: ~1 agent session.

---

### H. File-level touch list

**Fork-owned, new**: `sidebar/SidebarConnectionsMenu.tsx` + `.logic.ts` + test; `state/connectionPing.ts` (web + client-runtime); `history/ImportConversationPicker.tsx` + `.logic.ts` + test; `chat/ImportedThreadPrelude.tsx`; `state/historyImports.ts` (web + client-runtime); `apps/server/src/history/import.ts` + test; `apps/server/src/history/importRegistry.ts` + test.

**Fork-owned, deleted**: the seven files in §B (~1,150 lines).

**Fork-owned, modified**: `SidebarHeaderCompact.tsx` (one JSX block at `:107`); `SidebarConnectionsView.tsx` (status trim, strip removal, import row); `Sidebar.connections.ts`; `apps/server/src/history/{http,paths,records,query,tailReader,HistoryIndex,layer}.ts`; `packages/client-runtime/src/state/terminalHistory.ts`.

**Upstream files, call-site diffs only** — the entire non-fork-owned footprint:
- `packages/contracts/src/environmentHttp.ts` — reshape the F5 `history` group (`:636-665`). Cold file (2/500).
- `packages/contracts/src/history.ts` — F5-authored; add `title`, swap transcript page for preview page.
- `apps/server/src/config.ts` — one line, `historyImportsPath`
- `apps/web/src/components/ChatView.tsx` — **one conditional** (the prelude). 🔴 hottest file, 34/500 — one line plus one import, nothing more.
- `apps/web/src/routeTree.gen.ts` — **regenerate** after the route deletion
- `apps/web/src/connection/runtime.ts`, `packages/client-runtime/package.json` — loader/exports adjustments

**Not touched**: `apps/server/src/ws.ts`, `packages/contracts/src/rpc.ts`, `apps/server/src/server.ts`, `packages/contracts/src/settings.ts`, `SidebarV2.tsx`, any adapter, any migration. **Net line count is likely negative** — the deletions outweigh the additions.

**Migrations: none.**

---

### I. Test plan

- **Pure logic (unit)**: dropdown row model (health precedence, unknown-vs-zero utilization, ping formatting, `—` for backoff); title fallback chain (ai-title present / absent / Codex); preview fold incl. Codex `compacted` replacement history; import-target resolution (project match by normalized cwd, create-project decision, instance/home ownership); registry read/write/dedup with stale-thread entries.
- **Server integration**: import against temp `~/.claude/projects` and `~/.codex/sessions` fixtures — asserts the thread row, the `provider_session_runtime` contents (instance id match, cursor shape, cwd payload), idempotent re-import, 409 on missing project, rejection when the session sits outside the instance's home, rejection when the file is gone. F5's `records.test.ts` / `paths.test.ts` are the fixture pattern.
- **Deletion hygiene**: typecheck plus a grep gate proving no dangling references to the removed components; regenerated `routeTree.gen.ts` committed; the old `/history/:sessionId` URL 404s cleanly rather than white-screening.
- **Live end-to-end — the gate that actually matters**: on the 4-machine mesh, import one real Claude and one real Codex session **on a remote machine**, then send a follow-up whose answer exists only in the old transcript. Anything less proves a thread was created, not that resume works. Do it for a Claude session **with** an `ai-title` and one **without**.
- **Version skew**: point the client at a pre-F12 server and confirm the picker degrades (no preview, no import) rather than erroring — old servers answer unknown routes with 200 + SPA HTML (`terminalHistory.ts:16-21`).
- **Visual**: headless screenshots of the icon strip at minimum sidebar width (the 7-icon wrap), the popover with a healthy and an unreachable connection, the reworked connections view, the picker with a preview expanded, and an imported thread's provenance line — dark and light.
- Full gates: 15-package typecheck, lint, fmt, contracts + server + web suites. Reminder: `vp run --filter t3-server test` matches nothing — the package is named `t3`.

---

### J. Risks and open questions

**Risks**
1. 🔴 **Silent Codex fallback.** A wrong or missing rollout id makes `thread/resume` degrade to a fresh empty thread (`CodexSessionRuntime.ts:436-443, 484-491`). Pre-flight checks are mandatory, not best-effort.
2. 🔴 **cwd/project mismatch** breaks Claude resume confusingly. Mitigated by resolving/creating the project at the exact cwd and refusing otherwise.
3. 🟡 **Titles are missing more often than not** — 24 of 40 recent Claude sessions have no `ai-title`, and Codex has none ever. The fallback chain must look derived, or the picker will feel broken precisely when Michael needs it most.
4. 🟡 **Preview depth is a taste call.** Too shallow and it fails the disambiguation job Michael described; too deep and we have rebuilt the viewer we just deleted. Start at ~6–10 entries (opening + tail) and tune once he uses it.
5. 🟡 **`ChatView.tsx` touch** — one conditional in a 34/500 file, the round's only hot-file diff. Droppable (§J q2).
6. 🟡 **The imported thread's first turn is a real paid turn** on the full resumed context. Surface session size (already in `HistorySessionSummary.sizeBytes`).
7. 🟢 **Icon strip wrap at 7** — anticipated in the design (`SidebarHeaderCompact.tsx:91-106`) but never observed; verify at 208px.
8. 🟢 **Registry drift** if a thread is deleted outside t3 — handled by the projection lookup.

**Open questions for Michael**
1. **Preview shape** — opening message plus the last few exchanges (recommended), or just the opening? A mistitled conversation is usually identified by where it *ended up*.
2. **Keep the one-line "Resumed from…" marker in the thread?** Recommended yes — otherwise an imported thread looks empty while the model remembers everything. Saying no removes the only hot-file diff in the round.
3. **When no project matches the session's cwd** — auto-create silently, or ask? (Recommend ask once, showing the cwd; silent project creation across four machines gets messy.)
4. **Sessions on machines that aren't paired are invisible** (the reader is per-server). Fine, or should the picker say so?
5. **Dropdown scope** — per-connection usage only, or also a fleet-total spend line? (Recommend adding it; one row, answers "what have I spent today" without leaving the sidebar.)

---

### K. Sequencing and size

| Phase | Side | Size |
|---|---|---|
| 1 — connections icon + status/usage/ping dropdown | client | 1 agent session |
| 2 — connections view rework + viewing-surface removal | client | rider on Phase 1 |
| 3 — import endpoint + preview reshape + title extraction + registry | server | 1 agent session |
| 4 — import picker | client | 1 agent session |
| Deferred | — | bulk/auto import; sessions on unpaired machines; archived-thread federation |

Phases 1+2 and Phase 3 are disjoint and parallelizable; Phase 4 depends on both. ≈3 agent sessions plus merge, gates, and the standing rollout (⚠️ `vp i` after every pull; all 4 servers **plus the desktop rebuild** — Phases 1, 2 and 4 are client-side, so without the rebuild Michael sees none of it).

---

## F13 plan — Living sky: motion & particles (07-25, PROPOSED)

**Ask (Michael, verbatim)**: "incorporate more animations, stuff like particles and stuff that would make the sky look animated and lively but not cheesy."

**Base**: builds on **F11.2's final state**, not today's hub. F11.2 (bolder styling) is actively rewriting `starcode-theme.css` and may rewrite `--sc-speck-tile` and push the starfield into sidebar chrome. Nothing in F13 may be authored against the current tile bytes — see §F.6 for the mitigation (partition *rule*, not partition output). F13 starts after F11.2 merges into `hub`.

**What exists today** (audited at hub `f526c56a6`): `starcodeSky.ts` resolves the local clock to `--sc-sky-top/glow/wash/stars` + `<html data-sky-phase>` on a 60s `setInterval`, with `?sky=night|dawn|day|dusk|<hour>|auto` persisted to `localStorage["starcode:sky"]`. All painting is CSS. There is exactly **one** animation in the fork: `.dark .starcode-speck-field::after` — a second copy of the 660×540 speck tile offset by `180px 90px`, pulsing opacity `0.16 → 0.5` on a 9s ease-in-out loop, with a reduced-motion static fallback at 0.32. The field itself (`SkySpecks` in `components/brand/CelestialArt.tsx`) is mounted in exactly **two** files: `PairingSky.tsx` and `routes/_chat.index.tsx` (`NoProjectsHero` + `HostedStaticOnboardingState`).

---

### A. The not-cheesy doctrine (encode this in the CSS header comment)

Five rules. Any effect that breaks one is cut, not tuned.

1. **Slow.** Nothing cycles under ~20s except the shooting star, which is an *event*, not a cycle. Ambient periods live in the 3-10 minute range for drift and 11-25s for twinkle.
2. **Sparse.** Rarity is the whole product. A shooting star every 20 minutes is magic; one every 20 seconds is a screensaver. The rarity budget is a shipped constant with a name, not a vibe.
3. **Physically plausible.** Things drift and fall. Nothing bounces, pulses on a beat, spins, scales, or reacts to the pointer. The celestial sphere rotates east-to-west; that is the only justification a drifting starfield needs, and it is why the drift is near-horizontal rather than random float.
4. **Low contrast.** Motion must be perceptible in peripheral vision and invisible to direct attention. If you can watch it move, it is too fast or too bright. Test: look directly at the field for 5 seconds — if you can track a single star's motion, halve the speed.
5. **Never under body text, never in dense working surfaces.** The F11 restraint rule survives bold mode intact. Motion is allowed only where the speck field is already allowed: idle and empty surfaces. A moving background under a transcript, a settings list, or a thread row is disqualifying regardless of how faint it is.

---

### B. Candidate effects, each with a verdict

| # | Effect | Verdict | Phase |
|---|---|---|---|
| 1 | Multi-layer parallax star drift | **IN** | A |
| 2 | Per-star twinkle variation | **IN** | A |
| 3 | Occasional shooting star | **IN** | B |
| 4 | Dawn/dusk shimmer band | **IN, conditional** | B |
| 5 | Drifting particle dust | **OUT** | — |
| 6 | Cloud wisps for day | **OUT** | — |
| 7 | Moon with real lunar phase | **IN** | C |
| 8 | Meteor shower | **IN as a dev flag only** | B |
| 9 | Satellite pass (proposed, not in brief) | **OUT** | — |
| 10 | Pointer/scroll parallax (proposed, not in brief) | **OUT** | — |

**1. Multi-layer parallax drift — IN.** Two or three star layers translating horizontally at differential speeds (far layer slowest). One tile width (660px) traversed over 4-10 minutes puts every layer well under a pixel per frame: you cannot see it move, but the sky is demonstrably different when you look up again. This is the single highest ratio of "alive" to risk in the whole round, and it needs zero JS. Direction: near-horizontal with a shallow 4-8° downward cant on the far layer, never vertical — stars sliding straight down read as falling snow.

**2. Per-star twinkle variation — IN.** Today one tile copy blinks *every star in unison* at 9s, which the existing CSS comment already identifies as the failure mode it was trying to avoid (it avoided blinking the base field, not the copy). Fix: partition the tile's 32 specks into 3 subsets, give each subset its own layer, its own period (11s / 17s / 23s — no common multiple inside a working session), and a negative `animation-delay`. Apparent per-star phase offset, zero JS, 3 composited layers. Amplitude drops from today's 3× swing (0.16→0.5) to roughly ±20% around the layer's phase opacity — the current swing is visible as a *pulse* when you catch it.

**Fold 1 and 2 into the same three elements.** Each layer carries one star subset, one drift speed, one twinkle period. `transform` and `opacity` on the same element are independent animations and both stay on the compositor. Three elements do both jobs.

**3. Occasional shooting star — IN, and it is the round's delight.** Michael's budget (1-3/hour) is right; recommend defaulting to the *low* end — a randomized interval in [22, 55] minutes — because a person who sees one on their third session tells someone about it. Rules: never in the first 30s after load (his rule, and it also prevents the shooting star from becoming a page-load animation); never when `document.hidden`, with the timer **cancelled** on hide and **rescheduled fresh** on show (no backlog burst on return); never when the phase has no stars (`--sc-sky-stars < 0.25`, i.e. never at midday); dark theme only; only where the field is mounted. Motion: enters the upper third, travels 900-1400ms on a shallow down-and-across path, thin tapered tail 60-120px, fades in over the first ~15% and out over the last ~40%, so it is never at full brightness at either end. Start x, angle, length, and duration randomize per flight.

**4. Dawn/dusk shimmer — IN, conditionally, as the first thing to cut.** Explicitly **not aurora ribbons** — green curtains are the cheesiest thing in this entire candidate list. What ships instead: one very large, very soft warm gradient blob tinted from `--sc-sky-glow`, opacity ceiling ~0.06, translating and scaling over 120-180s, gated to `html[data-sky-phase="dawn"], html[data-sky-phase="dusk"]`. It reads as high cloud catching light before sunrise. It lives behind its own token so removing it is one line, and if Michael's read is "atmospheric fog" it goes without argument. **Never animate the gradient stops** — that is a full repaint per frame; only the pre-painted layer's `transform`/`opacity` move.

**5. Drifting particle dust — OUT.** This is the particles.js tell. At the sizes involved, dust motes and stars are the same 1-2px dot, so "dust" just makes the starfield look like it is crawling with insects, and dust that floats *upward* (as every implementation does) has no physical story in a sky. The parallax drift already delivers "the field is alive" with a real justification. Cutting this is what buys the shooting star its budget.

**6. Cloud wisps for the day phase — OUT.** The day phase is deliberately still dark (`#1e2739`) with stars at 0; wisps on dark navy read as smoke, not weather. Day is also when the app is used hardest, which is when rule 4 matters most. If day feels dead, the answer is the shimmer band (#4) extended to day at half amplitude — one selector — not clouds.

**7. Moon with real phase — IN, phase C.** The crescent is already the brand's vocabulary (wordmark, helmet visor), so a moon in the sky is a restatement, not a new idea — which is exactly why it can carry weight the other effects can't. Static art, positioned by the *same* clock: altitude/azimuth derived from the sky hour, opacity tracking `--sc-sky-stars` so it sets with the starfield, and illumination computed from the date against a known new moon (~10 lines of synodic arithmetic). It moves about a pixel a minute on the existing 60s tick — imperceptible, and correct. **Constraint**: the moon appears on the full-page field only, never in the sidebar chrome, where the wordmark crescent already sits 200px away; two crescents on one screen is a duplication, not a motif.

**8. Meteor shower — IN as `?sky=…,meteors`, a dev/screenshot flag, never user-facing.** Once the shooting star exists this is the same primitive with the interval set to ~2s, and it makes the effect reviewable and screenshot-able instead of a 1-in-30-minute lottery. Never reachable without the query param, never persisted, never advertised. (If Michael later wants it as a real easter egg, a date check against the Perseids peak — Aug 12 — is one line. Not shipping it now.)

**9. Satellite pass — OUT** (proposed for completeness): a steady dim dot with no tail crossing over 30s is indistinguishable from a stuck pixel or a rendering bug. The cost of "is something broken?" massively exceeds the delight.

**10. Pointer/scroll-reactive parallax — OUT** (proposed for completeness): the signature move of a template landing page, and it violates rule 4 by construction — motion tied to input *is* motion demanding attention. It also drags rAF and scroll listeners into a design that otherwise needs neither.

---

### C. Architecture — CSS-first, JS schedules but never animates

**Recommendation: pure CSS keyframes for all ambient motion; one tiny scheduler module for the shooting star.** Not canvas, not WAAPI-driven.

| Option | Verdict |
|---|---|
| **Pure CSS on layered elements** | ✅ **Chosen for ambient motion.** `transform`/`opacity` keyframes on pre-rasterized layers are handled entirely by the compositor: zero main-thread work per frame, automatically throttled/suspended by the browser when the document is hidden, and authored in the same file and voice as everything else in the theme. |
| **Single canvas + rAF** | ❌ Rejected. A 60fps rAF loop is precisely the battery cost we are avoiding, and canvas re-rasterizes its whole layer every frame — it *forfeits* the compositor shortcut rather than exploiting it. It also brings DPR handling, resize observers, and manual pause logic, and replaces a working declarative field with imperative code in a fork we have to keep rebasing. Canvas earns its keep at hundreds of independently-simulated particles; we are shipping three layers and a rare streak. |
| **CSS + WAAPI hybrid** | ⚠️ Partially. WAAPI's `finished` promise is genuinely nicer for one-shot cleanup than an `animationend` listener, but adopting it introduces a second animation-authoring style so half the sky's motion is no longer greppable in `starcode-theme.css`. Use custom properties + a CSS keyframe + `animationend`; keep WAAPI in reserve if per-flight randomization gets awkward. |

**The rule that makes the budget hold**: `transform` and `opacity` are the *only* properties any keyframe touches. Nothing animates `background-position` (a repaint every frame — this is the trap, because it is the obvious way to drift a repeating tile), gradient stops, `filter`, `width/height`, or `box-shadow`.

**Seamless drift without repainting**: each layer is an absolutely positioned box extended one tile beyond the viewport (`right: -660px`), painted with `background-repeat: repeat`, and translated by *exactly* one tile width per cycle. The wrap is invisible because the tile is periodic; the paint happens once.

**Hard performance budget**:
- ≤ 5 additional composited layers, and only on idle surfaces.
- **0** rAF loops. **0** new intervals. **1** `setTimeout` chain, live only while a starry phase is visible.
- Main-thread work attributable to the sky while idle-visible: < 1ms/minute.
- Zero work when `document.hidden`: CSS animations are suspended by the browser; the scheduler cancels its timer explicitly on `visibilitychange`.
- No new dependency. (Fork hygiene: F11's `@fontsource-variable/baloo-2` is why `vp i` is now a mandatory rollout step on all four machines — F13 must not add a second such trap.) No WebGL.
- Bundle: < 4KB gzipped. Splitting the existing ~3.5KB tile into three subsets is roughly the same total bytes, not 3×.
- Verification: a 30s Chrome performance trace on the idle route showing no long tasks and a flat main thread, plus DevTools' Animations panel confirming every animation is composited (it flags non-composited ones explicitly).

**Where the layer mounts — three structural traps, all discovered in the audit:**

1. **Depth is load-bearing.** The engraving rule is `[data-slot="sidebar-inset"]:has(> * > .starcode-speck-field)::after` — it matches on *exact grandchild depth*. Wrapping the field in a new motion container silently deletes the plate-corner engravings from every idle pane. **The motion layers must be children of `.starcode-speck-field`, never a wrapper around it.** The field element becomes the motion host.
2. **The light-theme filter trap** (already paid for once during F11.1's engraving work): `:root:not(.dark) .starcode-speck-field { filter: invert(1) saturate(0.4) }` applies to every descendant and establishes a containing block. Any child layer inherits the inversion. Motion is dark-only anyway — light theme has no stars — so **every motion rule is gated on `.dark`**, exactly like today's twinkle rule. This is a rule, not a preference.
3. **The uncover rule is direct-child scoped**: `[data-slot="sidebar-inset"] > .bg-background { background-color: transparent }`. Any new surface that mounts the field must keep that structure or the sky gradient goes back under an opaque fill.

**Phase lockstep, at zero plumbing cost**: layers read `--sc-sky-stars` inside their `opacity: calc(...)` exactly as `.starcode-speck-field` does today, so they track dawn/dusk/day automatically and go to zero at noon with no JS involvement. Phase-gated effects key off the existing `html[data-sky-phase]` attribute. The one thing the scheduler needs from JS is the current star level — add a `currentSky()` accessor to `starcodeSky.ts` (it already computes `ResolvedSky` every tick; stash it in a module-level variable) rather than doing a `getComputedStyle` read on a timer. One source of truth, no DOM reads in the effects module.

**Files touched** — all fork-owned, so rebase risk against upstream's ~13 commits/day is ≈ 0:
- `apps/web/src/starcode-theme.css` — new §4d "Motion", plus edits to the §4b/4c tail. (Fork-owned file, but *the* F11.2 conflict surface — see §F.6.)
- `apps/web/src/starcodeSky.ts` — `?sky=` grammar, `currentSky()` accessor, moon math in phase C.
- `apps/web/src/starcodeSkyEffects.ts` — **new**, ~110 lines: the shooting-star scheduler and nothing else. Started from `startStarcodeSky()`, so `main.tsx` (upstream-adjacent) keeps its existing 2-line diff.
- `apps/web/src/components/brand/CelestialArt.tsx` — `SkySpecks` renders the three layer divs.

**`?sky=` extension for evidence.** Grammar becomes `phase[,effect[,effect…]]`:

| Token | Effect |
|---|---|
| `?sky=night,shoot` | fire one shooting star ~1s after mount |
| `?sky=night,shoot-hold` | **freeze a shooting star mid-flight** (`animation-play-state: paused` at ~45%) — the only way to screenshot a 1.1s event deterministically |
| `?sky=dusk,meteors` | dev shower, ~2s interval |
| `?sky=auto,still` | all motion off — for diffing screenshots against the pre-F13 baseline |
| `?sky=night,moon=0.5` | force lunar illumination (phase C) |

Only the **phase** token persists to `localStorage`; effect tokens are stripped before the write, or a pinned `meteors` follows Michael around forever. `<html>` gains `data-sky-effects` listing what is active, so a screenshot's DOM proves what rendered — the same doctrine that made `data-sky-phase` worth having.

---

### D. prefers-reduced-motion — full matrix

| Effect | Under reduced motion |
|---|---|
| Parallax drift | `animation: none`. Layers hold their offsets → a static field indistinguishable from today's. **Nothing is lost.** |
| Twinkle groups | `animation: none`, each group pinned at its **mid** opacity so composite brightness matches the animated average (today's fallback does exactly this at 0.32). |
| Shooting star | **Disappears entirely.** The scheduler never starts. Checked at start *and* on the media query's `change` event, so toggling the OS setting takes effect without a reload. |
| Dawn/dusk shimmer | `animation: none`, layer parked at its median position/opacity → a static soft glow. Colour survives, drift does not. |
| Moon | **Unaffected** — static art. Its position updates on the 60s tick, which is not animation; but the CSS transition that smooths that update must be disabled, so it jumps rather than glides. |
| Meteors dev flag | Never fires (it is the shooting star multiplied). |
| Base speck field | Unchanged — it is static today and stays static. |

JS must honour the preference too, not just CSS: `matchMedia("(prefers-reduced-motion: reduce)")` plus a `change` listener, following the conventions already in `components/sidebar/ThreadTaskProgress.tsx` and `chat/draftHeroTransition.ts`.

---

### E. Phasing — three independently shippable commits

**Phase A — the field breathes.** (~150-180 lines CSS, ~15 lines markup, **no new TS module**.) Partition the speck tile into three subsets; three layers, each with a drift speed and a twinkle period; reduced-motion statics; retire or rebase the current `::after` twinkle. Evidence: a still frame cannot prove drift — capture the same viewport at t=0 / t=60s / t=180s under `?sky=night`, plus a reduced-motion still. Size: 1 commit, medium. **This is the phase that delivers "lively" and it carries no JS and no new risk.**

**Phase B — rare events and dawn light.** (~80 lines CSS, ~110-line `starcodeSkyEffects.ts`, `?sky=` grammar + tests.) Shooting star + scheduler + effect-token plumbing + `data-sky-effects`; then the shimmer band as its own commit so it can be reverted alone. Evidence: `?sky=night,shoot-hold` still; `?sky=dawn` at two timestamps. Size: 2 commits.

**Phase C — the moon.** (~60 lines CSS, ~40 lines of altitude/illumination math in `starcodeSky.ts` + unit tests in the existing `starcodeSky.test.ts` style.) Crescent art reusing `StarcodeMark`'s path. Evidence: `?sky=night,moon=0.5` and `moon=0.95`. Size: 1 commit.

Order rationale: A is the best risk-adjusted value and ships without JS; B is where the delight *and* the taste risk both live; C is a discrete object Michael can veto without disturbing A or B. Each phase reverts as one CSS section plus (for B) one module.

---

### F. Risks and open questions for Michael

1. **⚠️ Where does this actually get seen? — the load-bearing question.** `routes/_chat.index.tsx` auto-redirects into a draft thread whenever any project exists, so the full-page speck field is reachable today only by a user with **no projects** and on the **pairing screen**. Michael's daily surfaces — the draft hero, thread views, Workbench — have no field at all. As mounted, F13's ambient motion would be nearly invisible to him. Options: (a) mount the field behind the **draft hero** (the CSS already calls it "the first thing on the screen you open most often"), (b) the Workbench idle pane, (c) leave it and accept that the sky is a first-run and pairing experience. **Recommendation: (a)**, via the cold `routes/_chat.draft.$draftId.tsx` route file rather than `ChatView.tsx` (34 touches / 500 commits — the repo's hottest file, do not put a fork diff there). **Side effect to decide with it**: mounting the field on the draft route also fires the `:has()` engraving rule there, so the draft pane gains plate corners — accept, or narrow the selector?
2. **Sidebar chrome vs idle fields — needs coordination with F11.2, which is pushing the starfield into chrome right now.** Motion in permanently-visible chrome, inches from the thread list you scan all day, is a materially higher bar than motion on a hero you see for three seconds. **Recommendation: the chrome band stays static in F13** (drift and twinkle on idle fields only); revisit after living with F11.2's bolder chrome for a few days.
3. **Pick between shimmer and moon?** Both are "a light/object in the sky", and shipping both risks a busy sky. **Recommendation: ship the shimmer in B, live with it, then decide on C.** Michael should not feel obliged to take all of §B.
4. **Rarity, confirm the number.** Brief says 1-3/hour; the plan defaults to the low end (~1 per 22-55 min randomized). Rarer is more precious, and the knob is named and one line.
5. **Battery line — visible-but-unfocused.** Page Visibility cannot see focus, so a window on a second monitor counts as visible and its shooting stars will fire. **Recommendation: accept** — the ambient cost there is compositor-only and a second-monitor sighting is a good sighting. Motion stops entirely when the window is genuinely hidden.
6. **F11.2 rebase discipline.** F11.2 owns `starcode-theme.css` and may change `--sc-speck-tile` (bolder likely means brighter or denser stars). Phase A must therefore ship a **derivation rule, not literal output**: "partition the shipped tile's circles by index mod 3", documented in the CSS header, so it can be re-derived against whatever tile F11.2 lands. F13 does not start until F11.2 is merged into `hub`.
7. **Does "not cheesy" survive bold mode?** F11.2 is deliberately raising contrast and presence. The doctrine in §A assumes restraint. If bold mode wants brighter stars, motion amplitude must come *down* to compensate, not up — brighter plus faster is exactly where this turns into a screensaver. Worth an explicit ruling from Michael before Phase A tunes its numbers.

## F15 plan — Split view: two threads at once (07-25, PROPOSED)

**Michael's ask (verbatim)**: *"incorporate a sort of split view? This is so I can see multiple threads open at one time. There should be a button where I can open split view and I should be able to enlarge one thread vs another thread using a bar in the middle."*

**Why this is a real gap, not a nicety**: a thread's transcript stream is subscribed per-mount with a 5-minute idle TTL (`packages/client-runtime/src/state/threads.ts:329-339`, `THREAD_STATE_IDLE_TTL_MS` at `packages/client-runtime/src/state/threadRetention.ts:3`). Only the *shell* (title/branch/latestTurn metadata) streams for unrendered threads (`state/shell.ts:180-181`). So today you cannot watch two agents work — you can only watch one and see the other's badge change. Split view is the feature that makes the 4-machine mesh legible in real time.

**Verdict: feasible, medium cost.** The embedding is proven; the cost is concentrated in one thing — *pane keyboard/focus ownership* — and it is the whole reason this is two phases rather than one.

### A. Dual-ChatView feasibility — the recon

**The embedding recipe already exists and is proven in production.** `WorkbenchMasterPane` renders a full `ChatView` outside the thread route, for a thread on *any* machine. Its header comment states the finding directly (`apps/web/src/components/workbench/WorkbenchMasterPane.tsx:1-9`): *"`ChatView` takes its identity entirely from props, so embedding it here costs one readiness gate, copied from the thread route."* The gate is `resolveThreadRouteRenderState({...})` at `WorkbenchMasterPane.tsx:95-116`, copied from `apps/web/src/routes/_chat.$environmentId.$threadId.tsx:44-50`; the mount itself is `WorkbenchMasterPane.tsx:118-126`. `ChatViewProps` (`apps/web/src/components/ChatView.tsx:455-474`) carries `environmentId`, `threadId`, `routeKind` and nothing route-derived; `ChatViewContent` destructures exactly those (`ChatView.tsx:1119-1133`). **F15 copies this recipe per pane.**

What actually breaks with two mounted `ChatView`s, in severity order:

| # | Blocker | Evidence | Why it breaks |
|---|---|---|---|
| 1 | **Shared composer handle — one app-wide ref** | `apps/web/src/composerHandleContext.ts:6`; provided ONCE at `apps/web/src/components/CommandPalette.tsx:437`, which wraps the whole `<Outlet/>` at `apps/web/src/routes/__root.tsx:120-130`; read at `ChatView.tsx:1242` (`useComposerHandleContext() ?? localComposerRef`); written by every composer via `useImperativeHandle` at `chat/ChatComposer.tsx:1919-1920` | Last-mounted composer wins the ref. `insertTextAtEnd` (`ChatView.tsx:4254`), `focusAtEnd` (`:2493`), `getSendContext` (`:4452,:5031,:5194`) in pane A all operate on pane B's composer. **Fix is free**: `ChatView.tsx:1242` already falls back to a local ref, so wrapping each pane in its own `<ComposerHandleContext value={paneRef}>` fixes this with *zero* ChatView edits. |
| 2 | **ChatView's window keydown listener is per-instance with no ownership check** | `ChatView.tsx:4234-4374`, registered `window.addEventListener("keydown", handler, true)` at `:4356`; the only guard is `if (!activeThreadId \|\| isCommandPaletteOpen()) return;` at `:4236` | Every command fires in BOTH panes: `terminal.toggle` opens two terminals, `terminal.close` kills a session you can't see, `terminal.new`/`split` spawn PTYs in both, and `projectScript.*` (`:4343-4349`) runs `pnpm dev` **twice, on two different projects, from one keypress**. |
| 3 | **Type-to-focus steals keystrokes into the wrong pane** | `ChatView.tsx:4248-4258`, predicate at `:429-439` | A printable key gets `insertTextAtEnd` + `preventDefault`; the first-registered instance wins and the second bails on `defaultPrevented` (`:4240`). You click pane B, type, and it lands in pane A. |
| 4 | **Digit shortcuts answer BOTH agents' pending questions** | `chat/ComposerPendingUserInputPanel.tsx:124-147` (`document.addEventListener` at `:145`), rendered from `ChatComposer.tsx:2105,:2145`. No `defaultPrevented` guard, no ownership check | Press `2` while both threads await input → both agents receive answer 2. **Irreversible, and the single most dangerous item on this list.** |
| 5 | **`DiffPanel` takes identity from route params, not props** | `apps/web/src/components/DiffPanel.tsx:204-210` (`useParams` → `routeThreadRef`), but rendered *inside* ChatView at `ChatView.tsx:381,:5565` | The secondary pane's diff panel renders the *primary* pane's diff. |
| 6 | **`previewActionBus` is an untargeted window CustomEvent** | `components/preview/previewActionBus.ts:16-31`; dispatched from `routes/_chat.tsx:125,:151`; subscribed at `ChatView.tsx:3301` and `preview/PreviewView.tsx:551-570` | One `preview.toggle` toggles both panes; `refresh`/`zoom` hit every visible preview; two URL bars race for `.focus()` (`preview/PreviewChromeRow.tsx:90-95`). |
| 7 | **Focus-detection helpers read `document.activeElement` globally** | `lib/terminalFocus.ts:3-13`, `lib/previewFocus.ts:9-15`; consumed as `when`-clause context at `ChatView.tsx:4239` and `routes/_chat.tsx:63-65` | Pane A evaluates `when: terminalFocus` as true because pane *B's* terminal has focus. Every terminal-context binding misfires in the background pane. |
| 8 | **Composer autofocus fights across panes** | `ChatView.tsx:3739-3751` (rAF `focusComposer()`, deps `[activeThread?.id, focusComposer, terminalUiState.terminalOpen]`) and `:4212-4232` (refocus on terminal close) | Both fire on split-open in the same rAF batch; the winner is whichever mounted second. Any re-render that changes pane A's `activeThread?.id` yanks the cursor out of pane B mid-typing. |
| 9 | Other global handlers with no ownership gate | `chat/OpenInPicker.tsx:234-248` (two editor windows from one keypress), `chat/ModelPickerContent.tsx:480-504`, `chat/ExpandedImageDialog.tsx:22-44` | Same class, lower stakes. |
| 10 | Body scroll-lock save/restore is not ref-counted | `chat/ProviderModelPicker.tsx:81-128` — snapshots `document.body.style.overflow`/`paddingRight` per picker | Two pickers open → the second restores already-mutated values; body scroll stays broken until reload. |
| 11 | Per-instance web-worker pool | `ChatView.tsx:6043-6049` wraps content in `DiffWorkerPoolProvider`, which spawns `max(2, min(6, cores/2))` workers + a 240-entry AST LRU (`DiffWorkerPoolProvider.tsx:51-55,:71`) | Two ChatViews = up to **12 workers** and 2× the highlight cache. Perf, not correctness. |

**Confirmed safe — no work needed.** Every persisted per-thread store is already `byThreadKey`: `uiStateStore.ts:37-40,225-294` (unread/last-visited), `composerDraftStore.ts:327-330` (draft text/images/model), `rightPanelStore.ts:52` (with `ScopedThreadRef` on every action, `:53-76`), `terminalUiStateStore.ts:564-566`, `diffPanelStore.ts:17-18`, `previewStateStore.ts:55-60` (`Atom.family` per threadKey, doc comment at `:1-7` says "each thread owns an independent atom"). Scroll position is per-instance refs only (`ChatView.tsx:3386-3401,:1467-1471`). Desktop preview tab leases are already ref-counted (`browser/desktopTabLifetime.ts:9-43`). Transcript virtualization is `@legendapp/list` per instance with no shared measurement cache (`chat/MessagesTimeline.tsx:25,:487-509`; `ChatView.tsx:5712`). Module-scope `beforeunload` flushes (`uiStateStore.ts:417-419`, `composerDraftStore.ts:75-78`) register once regardless of mount count.

**There is no keybinding registry to fix centrally.** `apps/web/src/keybindings.ts` is a pure matcher (`resolveShortcutCommand`) fed by `primaryServerKeybindingsAtom` (`state/server.ts:83`); every consumer adds its own window/document listener. So ownership must be gated at each call site — there is no single chokepoint. This is the shape of the work.

### B. State & routing — recommendation

**Today**: the open thread lives entirely in the URL. Route `apps/web/src/routes/_chat.$environmentId.$threadId.tsx:20-22` resolves params via `resolveThreadRouteRef` and passes them to `ChatView` as **props** (`:77-81`). There is no `activeThreadId` store, context, or `SubscriptionRef` anywhere — everything derives from route params through `apps/web/src/threadRoutes.ts`. (`activeEnvironmentIdAtom`, `state/entities.ts:66-81`, is a true singleton but is only connection-bootstrap state, read at `routes/__root.tsx:181-202,307,409` — not a rendering identity. Safe.)

**Recommendation: (a) primary thread in the URL, secondary in fork-owned client state, persisted to localStorage.**

- **Primary pane = the route.** `/$environmentId/$threadId` is untouched. Every existing navigation, deep link, back button and `router.navigate` call site keeps working with zero edits.
- **Secondary pane = `splitStore`** (fork-owned zustand, modeled on `rightPanelStore.ts`): `{ enabled, secondary: ScopedThreadRef | null, ratio: number, focusedPane: "primary" | "secondary" }`, persisted under `t3code:split-view:v1`. Survives reload, which is what actually matters day to day.

**Why not (b) both in URL.** A second route segment means route-tree surgery, and `routeTree.gen.ts` is generated with a "should NOT make any changes" header at `:7-8` (regenerate on conflict, never hand-merge — NOTES-mapper-addendum §7.3). The lighter both-in-URL variant is a **search param** (`?split=envB:threadB` + `validateSearch` on the one route file), which avoids route surgery — but TanStack drops search params on `navigate` unless every call site preserves them, and the sidebar's `navigateToThread` (`SidebarV2.tsx:1526-1540`, in a 21/500 hot file) plus `CommandPalette` and `useThreadActions.ts:153-156` would all need editing. **That is a real audit for a benefit — "send me a link to my split" — nobody has asked for.** Deep-linking stays a clean, additive phase-3 upgrade: the store already holds a full `ScopedThreadRef`, so `?split=` becomes a hydration source layered on top, not a rewrite.

**Sidebar click while split: the focused pane fills.** One fork-owned chokepoint, `openThreadInFocusedPane(threadRef)`, called from `SidebarV2.tsx`'s existing `navigateToThread` callback (`:1526-1540`) — one import plus one line in the hot file, the same call-site discipline F1 and F4 used. If split is off, or the primary pane is focused → `router.navigate` exactly as today. If the secondary pane is focused → `splitStore.setSecondary(threadRef)`, no navigation at all. Focus is set by `pointerdown` on the pane wrapper, and the focused pane carries a visible (restrained) border treatment so "where will this land" is never a guess. **No pane-lock pin in v1** — a lock is a second concept to learn, and "the pane I last clicked" is the same mental model as every editor split. Revisit if it misfires in practice.

**Cross-machine works natively.** The secondary is a full `ScopedThreadRef` (environmentId + threadId), `ChatView` takes `environmentId` from props, and `WorkbenchMasterPane` already proves a cross-environment embed in production. Two panes on two different machines is the *default* case, not an edge case — it is the point of the feature.

### C. The divider

**No `react-resizable-panels` dependency exists** (checked root, `apps/web`, and all `packages/*` package.json — zero hits). But there *is* a fork-adjacent primitive to model on:

- `apps/web/src/hooks/useResizableWidth.ts` — pointer-capture drag (`:99-113`), rAF-throttled updates (`:126-131`), min/max clamp (`:44-50`), **persist once at drag-end, not per frame** (`:142-148`, comment: "avoid 60Hz localStorage writes"), cancel reverts to start width (`:153-162`), `document.body` cursor + user-select lock (`:104-105`, released at `:88-89`).
- `apps/web/src/components/preview/RightPanelResizeHandle.tsx` — the visual shell: `role="separator" aria-orientation="vertical"`, 8px hit target overlapping the border, 1px indicator that lights on hover/active.
- Call site precedent: `preview/PreviewPanelShell.tsx:34-40,:56`, with a viewport-derived max width (`getPreviewPanelMaxWidth`, `:17-19`, and the resize-aware `useViewportClampedMaxWidth` at `:65+`).

**Recommendation: a fork-owned `useResizableRatio` + `SplitDivider`, modeled line-for-line on those two, not a reuse.** Reasons: `useResizableWidth` stores a **pixel width for a side-anchored panel**, so resizing the OS window would keep the left pane fixed and let the right absorb everything — wrong for a 50/50 split. And `RightPanelResizeHandle` is `absolute inset-y-0 -left-1` (right-anchored positioning), so it cannot sit between two flex children. The new hook stores a **0..1 ratio**, converts pointer delta against the container's measured width via a ref, and drives a CSS grid template (`grid-template-columns: {r}fr 6px {1-r}fr`) rather than a fixed width.

Everything else copies the proven idiom: pointer capture, rAF throttle, drag-end-only persistence (`t3code:split-view:v1`), body cursor lock, cancel-reverts.

Three things the existing primitive lacks that F15 must add:
1. **Double-click resets to 50/50.** Standard, and the only fast way back from a lopsided drag.
2. **Keyboard resizable (a11y).** The existing handle has `role="separator"` but no `tabIndex`, no `aria-valuenow`, and no key handling — it is a mouse-only separator wearing a separator's ARIA role. The fork-owned one adds `tabIndex={0}`, `aria-valuenow={Math.round(ratio*100)}` + `aria-valuemin/max`, arrow keys ±2%, shift+arrow ±10%, `Home`/`End` to the min/max, `Enter` to reset. (Note: these are element-scoped handlers, so they are immune to the §A ownership problem.)
3. **Min pane width of 420px**, converted to a ratio against the live container width, so the clamp tightens automatically as the window narrows (`PreviewPanelShell` uses 360px for a preview; a transcript *plus* composer needs more).

### D. The button, and how the second thread gets chosen

**Where it lives**: `apps/web/src/components/chat/ChatHeaderActions.tsx` — fork-owned since F6, whose header comment (`:1-12`) exists precisely so header changes stay out of `ChatHeader.tsx`/`ChatView.tsx`. It already renders the action cluster next to the panel toggles. Because it is fork-owned it can read the split-pane context directly, so **no prop drilling through `ChatHeader` is needed**.

- **Primary pane header**: a `Columns2` toggle — "Open split view" / "Close split view".
- **Secondary pane header**: a small `X` — "Close this pane". (Same component, different branch on pane id. Two "close split" buttons would be ambiguous about *which* thread survives.)
- **Density note**: the sub-bar move (merged, `e11e21631`) put the whole run-context cluster into `ChatHeader`'s `runContext` slot (`ChatHeader.tsx:37-40,:107`), so the header is materially fuller than it was. The header already uses container queries (`@container/header-actions`, `ChatHeader.tsx:88`) — hide the split button below the same breakpoint that hides the other optional actions.

**Recommended minimal v1 fill flow** (exactly as the brief proposes):
1. Click the button → the pane splits 50/50 with an **empty right pane showing a thread picker**.
2. The picker is **`WorkbenchMasterPicker`, reused as-is** (`apps/web/src/components/workbench/WorkbenchMasterPicker.tsx`). It is already fork-owned, already lists threads **across every machine** with environment label + project title, already has search and a create affordance, and its props are generic — `{ currentThreadKey, onPick(environmentId, threadId), onCreate(projectRef) }` (`:25-29`). Only the `data-testid`s and one comment say "master". **Do not move or rename it in v1** (see collisions, §G). Wrap it, pass different copy.
3. Once filled, a sidebar click fills whichever pane is focused (§B) — the empty pane is focused by definition the moment it opens, so the very first sidebar click after splitting lands in it with no extra affordance.

**Deferred, deliberately**: dragging a sidebar row into a pane (needs DnD plumbing for a flow the picker already covers), "Open in split" on the sidebar row context menu (cheap and genuinely nice — first fast-follow), and a `⌘\` keybinding (adding a command touches the keybindings contract; needs its own recon before it is promised).

### E. Scope guards — what stays single-pane in v1

- **Mobile: no split.** `useIsMobile()` is `max-md` (`apps/web/src/hooks/useMediaQuery.ts:85-87`). Below that the primary renders alone; the store keeps its value so the split returns on a wide window. Mirrors the F1 precedent of mobile keeping its own defaults.
- **Narrow desktop: auto-collapse, and say so.** With a 420px min pane, split needs roughly ≥900px of container. Below that, render the primary alone and disable the button with a tooltip explaining why — a silently-vanishing pane reads as a bug.
- **The Workbench route is untouched.** It owns its own layout (`workbench/WorkbenchView.tsx:160-171`) and F14 is actively rewriting it into the star map. Split view applies to `_chat.$environmentId.$threadId` only.
- **The draft route stays single-pane** (`_chat.draft.$draftId.tsx`) — a second route file for a case nobody asked for. A draft can still be *promoted* into a split pane once it becomes a server thread.
- **Max 2 panes.** N panes is a store-shape question (array vs pair) more than a layout one; the ratio hook generalizes, but three half-width transcripts on a laptop is not a product. Noted as future, not built.
- **Preview stays effectively single-tenant** — not by a special rule, but because the §A#6 ownership gate means `preview.toggle` only ever hits the focused pane. Two simultaneous webviews are possible but not encouraged; watch it in the perf pass.

### F. Perf

- **Virtualization is already per-ChatView and safe**: `@legendapp/list` at `chat/MessagesTimeline.tsx:25`, rendered `:487-509` with `keyExtractor` (`:490`) and `estimatedItemSize={90}` (`:493`); the list ref is per-instance (`ChatView.tsx:3481-3596`). `TimelineRowCtx` is module-scope but *provided* inside the render tree (`MessagesTimeline.tsx:147-148`), so each pane gets its own value. No shared measurement cache to corrupt.
- **The inactive pane keeps streaming — by construction, and that is the entire point.** Subscription lifetime follows *mounting*, not focus: `subscribeThread` is forked per thread key in `makeEnvironmentThreadState` (`packages/client-runtime/src/state/threads.ts:243-299`) and wrapped as `Atom.family` per threadKey (`:329-339`). Two panes on two threads = two independent live subscriptions; two panes on the *same* thread share one entry (`Atom.family` dedupes by key). Nothing in that path is pane-aware, so no work is required to keep the background pane live.
- **Idle-pane cost** ≈ one extra `subscribeThread` subscription + one `OrchestrationThread` body in memory and IndexedDB. Cheap.
- **The one real cost is the worker pool** (§A#11): hoist `DiffWorkerPoolProvider` out of `ChatView`'s default export (`ChatView.tsx:6043-6049`) up to `AppRoot`/`__root` so both panes share one pool. ~5 lines, and it improves the single-pane case too.
- Minor: two capture-phase window `scroll` listeners from the composer popover anchor (`chat/ChatComposer.tsx:126-128`).

### G. Phases, estimates, collisions, tests, styling

**Phase 0 — Pane ownership groundwork (no visible split).** Fork-owned `SplitPaneContext` (pane id + `isFocused`) + `splitStore` + a pure `Split.logic.ts`; per-pane `ComposerHandleContext` provider (fixes §A#1 with zero ChatView edits); the ownership gates for §A#2, #3, #4, #6, #7, #9; `DiffPanel` gains an optional `threadRefOverride` prop (§A#5); `DiffWorkerPoolProvider` hoisted (§A#11); ref-count the body scroll lock (§A#10). **The gate predicate must return `true` whenever split is disabled**, so single-pane behavior is provably byte-identical — that is the phase's acceptance test. Ships invisible. ~1 agent session.

**Phase 1 — The split itself.** `SplitContainer` (CSS grid) mounted in the route component at `_chat.$environmentId.$threadId.tsx:75-83` — a **cold file** (`routes/` is 28 touches per 500 commits vs 621 for `components/`, NOTES-mapper-addendum §7.1-7.2, the same reasoning F1 used); `useResizableRatio` + `SplitDivider`; the header button in `ChatHeaderActions`; the picker wrapper; `openThreadInFocusedPane` + the one-line `SidebarV2.tsx` call site; focus ring; mobile/narrow guards. ~1 agent session.

**Phase 2 — Polish** (fold into phase 1 if it fits): starcode divider styling, keyboard resize, double-click reset, screenshot review in dark + light at 50/50 and 30/70.

**Phase 3 — Deferred**: `?split=` deep links, "Open in split" context menu, `⌘\`, N panes.

**Total: ~2 implementation agent sessions**, plus gates and a live two-machine check. Phase 0 is the larger and riskier half despite shipping nothing visible — budget accordingly and do not let it be skipped into phase 1.

**Fork-hygiene footprint.** `ChatView.tsx` (🔴 34/500, the repo's hottest file) takes exactly **one line plus one import** — the ownership gate folded into the existing early return at `:4236`. Everything else lands in fork-owned files or cold ones. `SidebarV2.tsx` (🔴 21/500) takes one line. This is the F4/F12 discipline, unchanged.

**Collisions**
- **F11.2 (bolder styling), uncommitted in the main clone** — modifies `apps/web/src/starcode-theme.css`, `routes/__root.tsx`, `components/brand/CelestialArt.tsx`, `components/settings/settingsLayout.tsx`, `components/history/ImportConversationDialog.tsx`, adds `lunarPhase.ts`. **F15 must not write into `starcode-theme.css`** — put divider styling in a fork-owned `SplitPane.css` imported at the split container, and reference the theme *variables* (`--sc-glyph-ink`, `--sc-butter`, `--sc-star-chrome-max`) rather than any literal values. This is F13's lesson (PLAN.md:646) applied one round early: author against the rule, not the bytes.
- **F14 (star map), worktree `t3code-f14` @ `f526c56a6`** — deletes `workbench/WorkbenchBoard.tsx` and `workbench/FeatureFlowPanel.tsx`, modifies `workbench/WorkbenchView.tsx`, `workbench/Workbench.tone.ts`, `state/featureFlow.ts`. **F15 touches none of those.** It *does* import `workbench/WorkbenchMasterPicker.tsx`, which F14 leaves alone — so import it in place and do **not** move, rename, or generalize it during F15. Generalizing the picker into a shared `ThreadPicker` is a fine follow-up *after* both land.
- **F12 (connections + import), worktrees `t3code-f12cli`/`t3code-f12srv`** — plans a one-conditional `ImportedThreadPrelude` touch at `ChatView.tsx:~5675` (PLAN.md:379). F15's ChatView touch is at `:4236`. Different regions, so a textual conflict is unlikely, but both land in the 34/500 file: **merge sequentially, F12 first** (it is further along), then rebase F15.
- **Sub-bar move (merged, `e11e21631`)** — already relocated `BranchToolbar` into `ChatHeader`'s `runContext` slot. No file conflict with F15's `ChatHeaderActions` change, but it is why the header-density note in §D exists.
- **Upstream churn**: `ChatView.tsx` runs 64 touches per 90 days. Every rebase must re-verify that the `:4236` guard still sits in the right early return.

**Test plan**
- *Unit (pure, in the `Sidebar.partition` / `Workbench.board` idiom)*: `Split.logic.ts` — ratio clamp against min pane width, reset, narrow-width collapse threshold, focused-pane resolution, and the navigate-vs-fill decision.
- *Unit, load-bearing*: the ownership predicate returns `true` for every input when split is disabled. This is the regression gate for all 1664 existing web tests.
- *Component*: two `ChatView`s mounted — (1) typed characters reach only the focused pane's composer; (2) **a digit key answers only the focused pane's pending question** (`ComposerPendingUserInputPanel.tsx:145`, the irreversible one); (3) `terminal.toggle` toggles one terminal, not two.
- *Regression*: anything asserting `ComposerHandleContext` at `CommandPalette.tsx:437` — the command palette's "insert into the composer" must now target the focused pane.
- *Live, two machines*: two panes on two different environments, both agents mid-turn, both transcripts streaming simultaneously; drag the divider; reload and confirm restore; narrow the window past the threshold and back.
- *Headless screenshots*: dark + light, 50/50 and 30/70, plus the empty-right-pane picker state.

**Starcode styling — the divider**
The divider sits between two dense working surfaces, which is exactly where F11's restraint rule (PLAN.md:161) and F13's motion doctrine (PLAN.md:517) say decoration does **not** belong. So:
- **At rest**: a plain hairline, indistinguishable from the existing panel borders (`border-border/60`, as used at `WorkbenchMasterPane.tsx:45` and `WorkbenchView.tsx:167`). Nothing celestial. It should read as structure, not ornament.
- **On hover/focus**: the grip appears — the four-point star node from the engraving vocabulary (the `Q`-curve star used in `--sc-glyph-constellation`, `starcode-theme.css:763`), ~10px, centred, drawn as a mask over `background-color: var(--sc-glyph-ink)` — the same mask-not-fill technique the plate corners use (`starcode-theme.css:776-793`), which is what keeps it correct in light theme where the speck field is inverted.
- **While dragging**: the hairline warms toward `--sc-butter` at low alpha. No glow, no motion, no trail.
- Ceiling is `--sc-star-chrome-max` (0.13, `starcode-theme.css:115`) — chrome-level restraint, not empty-state-level. Found rather than noticed, per the engraving comment at `starcode-theme.css:761`.

### H. Open questions for Michael

1. **Deep links** — is reload-persistence enough (recommended), or do you want `?split=` shareable-link support, at the cost of auditing every `navigate` call site for search-param preservation?
2. **Fill target** — focused-pane-fills (recommended, no new concept), or an explicit pane-lock pin on each pane?
3. **Half-width surfaces** — should the secondary pane be allowed to open terminal / diff / preview at half width, or stay transcript-plus-composer only in v1? (Symmetric is only ~15 lines more work; the question is whether it is *usable* at that width.)
4. **`⌘\`** — worth a keybindings-contract recon now, or button-only until the split proves itself?
5. **N panes** — is 2 the product, or should the store be an array from day one? (Cheap now, annoying later.)

## F16 plan — Projects as cross-machine categories + per-project workbench (07-25, PROPOSED)

**Ask (Michael)**: *"Make a new projects view. A project should not really be folder-related. They're mostly to categorize threads and for threads to be organized through the tool calls. Projects can house threads of that project, multiple connections, and even different features, and under each project should be a workbench thread. The workbench should be specific to each project, not a global one. Also consider other things that I'm not thinking of."*

**Headline verdict: the folder does not disappear — it stops being the identity.** Today's `project` is a load-bearing infrastructure record (it is the *only* source of a thread's cwd) and it cannot be weakened without breaking git, diffs, worktrees, terminals and file browsing. So F16 does not touch it. It adds a **fork-owned category layer on top**, keyed by slug rather than path, that groups today's server-projects (now read as *locations*) across machines, owns the per-project master thread, and is reachable by MCP tools. **No migration, no new WS RPC, no edit to `ws.ts`, `ChatView.tsx` or `SidebarV2.tsx`.**

---

### A. What a "project" is today — the recon that constrains the design

**It is an event-sourced aggregate, not a row you can casually redefine.** `project` is one of two aggregate kinds (`packages/contracts/src/orchestration.ts:926`); commands → `orchestration_events` → projector → `projection_projects` (`apps/server/src/persistence/Migrations/005_Projections.ts:8-18`: `project_id, title, workspace_root NOT NULL, default_model, scripts_json, …`). There is **no project CRUD RPC and no `/api/projects`** — the three constants at `packages/contracts/src/rpc.ts:152-154` are dead (no `Rpc.make`, absent from the group at `:721-724`). Every mutation goes through `orchestration.dispatchCommand`, decided at `apps/server/src/orchestration/decider.ts:227-344`. Projects reach the client only inside the shell snapshot (`orchestration.ts:448`, deltas `:456-463`), folded into atoms at `packages/client-runtime/src/state/projectEntities.ts:18-105`.

**`workspaceRoot` is the identity, and it is per-machine.** Uniqueness is an application invariant, not a DB constraint — `apps/server/src/orchestration/commandInvariants.ts:75-97` refuses a second *active* project on the same normalized path (enforced at `decider.ts:233-238` and, on path change, `:264-271`). The lookup used by auto-bootstrap does raw string equality (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:720-740`) and its index is non-unique (`Migrations/019_ProjectionSnapshotLookupIndexes.ts:8-9`). So the same repo on four machines is four unrelated projects with four ids.

**What genuinely depends on folder-ness (all of this must keep working, untouched):**

| Dependency | Evidence |
|---|---|
| **Thread cwd — the single choke point** | `apps/server/src/checkpointing/Utils.ts:12-28` `resolveThreadWorkspaceCwd` = `thread.worktreePath ?? project.workspaceRoot` |
| Provider session cwd (and restart-on-change) | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:494-508`, `:547` |
| Worktree creation | `apps/server/src/ws.ts:998-1024` → `GitWorkflowService.ts:298-301`; writes `worktreePath` back via `thread.meta.update` |
| Checkpoints / diffs | `CheckpointReactor.ts:186-192`, `CheckpointDiffQuery.ts:132,240`, and two `INNER JOIN projection_projects` (`ProjectionSnapshotQuery.ts:787`, `:996`) — a project-less thread returns **zero rows** |
| File browser | `apps/server/src/workspace/WorkspaceEntries.ts:40` (`current_project_required`) |
| Asset scoping, `t3.json`, favicon, setup scripts | `ws.ts:1723-1742`, `T3ProjectFileLoader.ts:67-68`, `ProjectFaviconResolver.ts:22-30`, `ProjectSetupScriptRunner.ts:135-139` |
| Branch toolbar + thread git cwd (client) | `BranchToolbar.tsx:253`, `Sidebar.tsx:408-409,2114`, `DiffPanel.tsx:219` |
| F12 import's cwd→project equality resolve | plan §A trap 1; server-side twin at `serverRuntimeStartup.ts:191-243` |

`ThreadCreateCommand.projectId` is **required** and the decider hard-requires the project to exist (`decider.ts:345-350`). Threads without a project are not representable. Good: it means F16 never has to invent an orphan state.

**Two cross-machine identity precedents already exist, and they disagree.**
1. **Upstream, repository-based** — `packages/client-runtime/src/state/projectGrouping.ts:118-137` `deriveLogicalProjectKey` groups by `repositoryIdentity.canonicalKey` (resolved lazily by shelling `git remote -v`, `apps/server/src/project/RepositoryIdentityResolver.ts:28`, surfaced at `ProjectionSnapshotQuery.ts:1848`), with modes `repository` / `repository_path` / `separate` and a label picker at `:164+`.
2. **Fork, basename-based** — F7b's `apps/web/src/components/workbench/FeatureFlow.layout.ts:99-104` `featureFlowProjectKey` lowercases the path basename. **F14 deletes this file and its replacement `FeatureFlow.model.ts` drops project grouping entirely** (it flattens `snapshot.projects` at `:134-145`). So after F14 there is no cross-machine project merge in the workbench at all.

F16 replaces both with one explicit, user-owned key: a slug the operator names, seeded *from* `deriveLogicalProjectKey` rather than derived forever by it. Derivation is the right default and the wrong contract — Michael's whole point is that a project is a category he decides, not a path the filesystem decides.

**The workbench master is a per-SERVER setting today** — `packages/contracts/src/settings.ts:516` `workbenchMasterThreadId`, stored in `<stateDir>/settings.json` (`apps/server/src/config.ts:117`), read by the client at `WorkbenchView.tsx:54` and written at `:96`/`:105`, and — the load-bearing consumer — read at credential-mint time by `apps/server/src/mcp/McpSessionRegistry.ts:100-111,135-140` to decide whether a session gets the `peers-operate` capability (`capabilityToolFilter.ts:41-45` gates `peer_thread_create` / `peer_thread_dispatch` on it). Any move to per-project masters **must** carry that gate with it or the master silently loses its tools.

---

### B. Where the unified project lives — decision and reasoning

**Recommendation: (c) hybrid — a fork-owned JSON registry on every server, slug-keyed, unioned client-side by slug, with client-orchestrated fan-out writes.** Not a hub server, not client-only.

The record lives at `<stateDir>/project-catalog.json` on each machine and holds *that machine's view* of every project: which local server-projects bind to it, which local threads are explicitly filed into it, and which local thread (if any) is its master. The client fetches all four and folds them into one project by slug. Writes go to one machine, except create/rename/archive which the **client** replays to every connected machine (it already fans out reads; a fan-out write is the same loop).

**Why not (a) a hub-server registry federated out.** There is no hub. Four peers, symmetric, any of which may be offline; designating one makes project creation fail when that machine sleeps and invents a server↔server write path F2 deliberately does not have (`peers.json` is read-heavy; the write tools are thread-scoped). It buys consistency we do not need at four machines and one operator.

**Why not (b) client-side grouping.** It is the cheapest build and it fails the actual requirement: *"for threads to be organized through the tool calls."* An agent calling `project_file_thread` must hit a surface the server owns. Client-only grouping is invisible to MCP, invisible to the desktop app's separate storage, and invisible to any future automation. Michael asked for the one thing (b) cannot do.

**Why (c) is cheap rather than merely correct.** Every piece already has a working exemplar in this fork:
- Registry: copy `apps/server/src/history/importRegistry.ts` wholesale — versioned file schema, `Semaphore.make(1)` write lock, `EMPTY_REGISTRY` on missing file, `writeFileStringAtomically`. Its own header comment argues the JSON-over-migration case for us.
- Transport: the typed-HttpApi 4-edit recipe (addendum §8), exactly as `apps/server/src/featureFlow/http.ts:13-31` does it.
- Client fan-out: `packages/client-runtime/src/state/featureFlow.ts:145-214` — per-env atom family plus a snapshots map, **including its 200-HTML degradation** (`:92-120`; an old server answers an unknown route with the SPA catch-all, not a 404).
- Cross-machine fold: `Workbench.master.ts:57-83` `resolveWorkbenchMaster` already takes a *candidates array* and picks local-first with alternates. Per-project masters need **no signature change** — just a different array.

**Migration-or-registry: registry, and not marginally.** Making category membership an event would mean a new aggregate or new thread meta field → contracts + decider + projector + a migration, i.e. the 6-file change `importRegistry.ts:1-19` documents, in the one area addendum §7.4 calls the fork's highest risk (two append-only conflict hunks per migration, plus the silent-skip hazard). The catalog is *metadata about a workspace*, not an aggregate needing replay, audit, or undo. **The cost we accept**: it is outside the shell snapshot, so the client polls (45s, featureFlow cadence) plus refetch-on-focus and optimistic local update on write; and there is no event history if a record is clobbered. Both are fine for an operator-owned index.

**The one real weakness — name drift.** Machine A renames "alpamayo" to "Alpamayo Pipeline"; machine B keeps the old title. Mitigations, in order: the **slug is the identity** and is immutable after creation (rename changes `title` only, never the join key); the client fan-outs create/rename/archive to every connected machine so convergence is the default path; and the fold breaks ties on `updatedAt`, so the newest title wins in the UI even when one machine missed the write. A machine that was offline during a rename shows the stale title until the next write reaches it — visible, harmless, self-healing.

---

### C. The data model

New fork-owned contract file `packages/contracts/src/projectCatalog.ts` (brand-new file, zero conflict surface):

```ts
ProjectCategoryRecord {
  slug              // identity. kebab, ≤64 chars, immutable after create
  title, summary    // display; newest updatedAt wins in the fold
  accent            // theme token name (null = derived from slug hash)
  bindings          // ReadonlyArray<{ projectId }> — LOCAL server-projects ("locations")
  threadIds         // explicit adds: local threads that belong despite their cwd
  excludedThreadIds // explicit removes: local threads that do NOT, despite their cwd
  masterThreadId    // "" = this machine designates none  (mirrors settings.ts:516 semantics)
  masterDefaults    // { runtimeMode, interactionMode } — same shape as settings.ts:494-502
  defaults          // { modelSelection?, runtimeMode?, interactionMode?, preferredProjectId? }
  links, notes      // pinned URLs + a small markdown blob (see §F item 4)
  archivedAt, createdAt, updatedAt
}
ProjectCatalogSnapshot { categories, computedAt }
```

**Membership is derived-first, override-second** — the rule that makes day one work with zero manual filing:

```
threadsOf(slug) = { t | binding(t.environmentId, t.projectId) == slug }   // derived from cwd, free
                ∪ { t | t.threadId ∈ threadIds(t.environmentId, slug) }   // explicit add
                \ { t | t.threadId ∈ excludedThreadIds(...) }             // explicit remove
```

Thread ids and project ids are machine-local, so `bindings`/`threadIds`/`excludedThreadIds`/`masterThreadId` are **never fan-out replicated** — only `title`/`summary`/`accent`/`links`/`notes`/`archivedAt` are. That split is what keeps the registry conflict-free: each machine is the sole author of its own membership.

A category with **zero bindings is legal** — that is Michael's "not folder-related" case (a research project whose threads live in scratch dirs and are filed explicitly). A thread still has a cwd, because its underlying server-project still exists; the category simply doesn't care what it is.

---

### D. Surfaces

**Server** — `apps/server/src/projectCatalog/`:
- `ProjectCatalogRegistry.ts` — `importRegistry.ts` clone; path `<stateDir>/project-catalog.json` (one line at `config.ts:113-133`, beside `peersPath:118` / `historyImportsPath:119`).
- `http.ts` — typed group `projectCatalog`, four endpoints, `featureFlow/http.ts` shape verbatim:
  - `GET /api/project-catalog` → snapshot, `AuthOrchestrationReadScope`
  - `POST /api/project-catalog/upsert` → record, `AuthOrchestrationOperateScope` (`packages/contracts/src/auth.ts:77`)
  - `POST /api/project-catalog/remove` `{ slug }` → operate
  - `POST /api/project-catalog/file-thread` `{ threadId, slug|null }` → operate; `null` un-files
- `layer.ts` — one line, `featureFlow/layer.ts:12-14` shape.
- Capability `projectCatalog: Schema.optionalKey(Schema.Boolean)` in `packages/contracts/src/environment.ts` (the blessed seam, addendum §7.3), declared at `apps/server/src/environment/ServerEnvironment.ts:148` beside `featureFlow: true`.

**Client data layer** — `packages/client-runtime/src/state/projectCatalog.ts` (featureFlow.ts clone incl. the HTML-degradation guard) + `apps/web/src/state/projectCatalog.ts` instantiation.

**Pure fold** — `apps/web/src/components/projects/ProjectCatalog.model.ts` (+ `.test.ts`), in the `Workbench.board.ts` / `Sidebar.partition.ts` idiom: union by slug, membership resolution, per-project master candidates → `resolveWorkbenchMaster`, unfiled computation, binding suggestions.

**Routes** (🟢 `routes/` is 28 touches/500 vs 621 for `components/`):
- `apps/web/src/routes/_chat.projects.tsx` — the index
- `apps/web/src/routes/_chat.projects.$slug.tsx` — project home
- `routeTree.gen.ts` — **regenerate, never hand-merge** (header `:7-8`)

**Entry point — no eighth icon.** The strip is already at seven (`SidebarHeaderCompact.tsx:107-205`: sidebar trigger, search, new thread, workbench, `SidebarConnectionsMenu`, new project, view menu) and its own comment (`:104-109`) admits seven already wraps at the 208px minimum. So the **`FolderPlus` "New project" button becomes a fork-owned `SidebarProjectsMenu` popover** — modelled on `SidebarConnectionsMenu`, using `ui/popover.tsx` — listing projects (click → project home), with "New project…" and "New location…" at the foot. One import swap plus one element swap in a file F8 already rewrote. It also delivers keyboard-ish project switching for free without touching `CommandPalette.tsx`.

**`/workbench` is left exactly as F14 ships it** — the global all-machines sky. Project homes get their own filtered sky. The "constellation of constellations" (re-axing the all-sky by project instead of machine) is **deferred**: it rewrites `StarMap.layout.ts:255-321` and `StarMapRegion`, and F14 has not even landed yet.

---

### E. The view

**`/projects` — the index.** A card grid, not a sky (cards scan; the sky is for one project's work-in-flight). Each card:
- Project name + a **constellation glyph** seeded from the slug via F14's own `starSeed` FNV hash (`t3code-f14/.../StarMap.layout.ts:131-145`) — same sky, same determinism, no new art pipeline, and it makes projects visually identifiable at a glance.
- Machine chips (which connections carry work for it), active-thread count, **needs-attention badge** (§F item 2), the F9 segmented progress bar rolled up across active threads, last activity.
- A one-line feature rollup from the feature-flow snapshot (`n in dev · n in staging · n shipped`) — the existing per-server data, re-grouped by slug instead of the basename key F14 removed.
- Click → project home.
- Plus an **"Unfiled" card** (§F item 1) and archived projects behind a disclosure.

**`/projects/$slug` — the project home.** Deliberately the **F14 workbench layout with a project header**, so the delta is a filter prop rather than a new view:
- Header bar: name, glyph, machines, defaults, actions (rename, archive, bind a location, edit notes).
- Left: `WorkbenchMasterPane` bound to *this project's* master (with `WorkbenchMasterPicker` for designate/create, imported **in place** — F15 has the same standing instruction not to move or rename it).
- Right: `WorkbenchStarMap` filtered to the project's threads. Threads are already the stars; no separate thread list is needed, which is the whole reason the star map is worth reusing.
- Collapsible drawer: notes + pinned links, and the unfiled-suggestion strip when this project has a plausible unbound location.

**Filtering the map — use the seam, not the surface.** Recon's verdict: add an optional membership predicate to `Workbench.board.ts:buildWorkbenchBoard`'s input (a file F14 does **not** touch but does consume, `StarMap.model.ts:27`) and an optional filter param to F14's `FeatureFlow.model.ts:116-158` `buildFeatureFlowView`. Both are additive optional params defaulting to "everything", so `/workbench` keeps its current behaviour byte-for-byte. Note `StarMapStar.projectTitle` already exists (`StarMap.model.ts:37`) but is keyed physically (`environmentId:projectId`, `WorkbenchStarMap.tsx:537-545`) — F16 supplies the slug-merged label instead.

**Styling** — F11/F13 restraint rules apply unchanged. Cards are plates in the existing engraving vocabulary; the glyph is a mask over `--sc-glyph-ink` (the plate-corner technique, `starcode-theme.css:776-793`), not a fill, so it inverts correctly in light theme. Ceiling `--sc-star-chrome-max`. **No writes into `starcode-theme.css`** (F13's lesson, PLAN.md:646) — a fork-owned `Projects.css` referencing theme variables.

---

### F. "Things I'm not thinking of" — ranked, with an explicit cut line

**In v1 — each earns its place by making the view correct or worth opening:**

1. **Unfiled triage + auto-suggest.** Without it the view is empty on day one and wrong on day two. A first-open **auto-seed** proposes one project per distinct `deriveLogicalProjectKey` across all four machines, named by `deriveProjectGroupLabel` (`projectGrouping.ts:164+`), with checkboxes — accept and the catalog is populated with real bindings in one click. Thereafter, an unbound server-project is suggested to the project whose bound locations share its `repositoryIdentity.canonicalKey` (strong), else basename (weak, labelled as such). *Cost: small; it is a pure fold over data already on the client.*
2. **Needs-attention rollup on the card.** The reason to open the index at all: which project has an agent waiting on me. Aggregates the per-thread status the shells already carry — no new data. *Cost: small.*
3. **Per-project defaults** (model, runtime/interaction mode, preferred machine+location) applied when creating a thread from the project home. Reuses the `workbenchMasterDefaults` shape from `settings.ts:494-502`. *Cost: small, leverage high — it is how a project stops being a label and starts being a workspace.*
4. **Notes + pinned links.** A small markdown blob and a link list on the record, **readable by `project_get`**. This is the piece that makes "organized through the tool calls" real in both directions: the human writes what the project is, and every agent that asks can read it. *Cost: small. Boundary respected — it is operator-authored content the tools expose, not prompt text the fork writes.*
5. **Archive** (record field + index disclosure) and **cross-project move** (falls out of `file-thread` — it is the same write). *Cost: ~zero.*

**Deferred, explicitly:**
- **Constellation-of-constellations all-sky** — re-axing `StarMap.layout.ts` by project; revisit once F14 has been lived with.
- **Per-project spend/usage rollup** — F3's data is per account/instance; there is no per-thread attribution to roll up. Would need real work upstream of the view.
- **Command-palette project switcher (⌘P)** — the `SidebarProjectsMenu` covers switching; a palette entry lands in `CommandPalette.tsx` (9/500) for marginal gain.
- **Project templates**, **nested sub-projects** (open question 5), **drag-and-drop filing**, **per-project agent instructions auto-injection** (prompt content — Michael's F7 boundary), **server↔server catalog sync** (the client fan-out covers four machines).
- **Sidebar tree re-shaped to categories** — see open question 4; `SidebarV2.tsx` is 🔴 21/500 and v1 should not spend that budget.

---

### G. Phases

**Phase 1 — Server catalog (invisible).** Contract file, registry, HTTP group, layer wiring, capability flag. Acceptance: `curl` round-trip on a live server; missing file reads as empty; concurrent upserts serialize. ~1 agent session.

**Phase 2 — Client data layer + fold.** Per-env atoms with skew degradation, `ProjectCatalog.model.ts` + tests, optimistic write helpers, client fan-out on create/rename/archive. Ships invisible. ~0.5 session (fold into phase 3).

**Phase 3 — The view.** `/projects` index, `/projects/$slug` home, `SidebarProjectsMenu`, auto-seed flow, unfiled triage, the `Workbench.board.ts` + `FeatureFlow.model.ts` filter params, `Projects.css`. **Requires F14 merged first.** ~1.5 sessions.

**Phase 4 — Per-project workbench.** Master designation moves into the catalog record; `resolveWorkbenchMaster` fed per-project candidates; `McpSessionRegistry.resolveMasterThreadId` → `resolveMasterThreadIds()` returning `{legacy settings.workbenchMasterThreadId} ∪ {every record's masterThreadId}`, so a project master gets `peers-operate` and the existing global master keeps it. The `settings.ts:516` field is **left in place** (hot file; it remains the `/workbench` global master). ~0.5 session.

**Phase 5 — Tool-call integration.** New MCP toolkit `apps/server/src/mcp/toolkits/projects/{tools,handlers}.ts` + two registration lines in `McpHttpServer.ts:220-232`:
- `project_list` → slug, title, machines, thread counts (capability `peers`)
- `project_get` → the above plus notes, links, bound locations, threads with status (capability `peers`)
- `project_file_thread` → files/moves/un-files a thread. **Self-filing** (`threadId` == the calling session's thread) at `peers`; filing *another* thread requires `peers-operate`. Verify the invocation context carries the caller's threadId — `toolkits/peerThreads/handlers.ts:59-80` stamps provenance, so it should.
- Optional `project` (slug) param on `PeerThreadCreateInput` (`packages/contracts/src/peers.ts:340-372`, additive optional field alongside `instanceId`/`model`) — the handler resolves slug → the peer's bound `projectId`, erroring with the available list when unbound. **Membership then needs no cross-machine write**: the thread lands in a bound location, so derivation files it automatically.
~0.5 session.

**Total ~3–4 agent sessions**, sequenced after F14 merges, plus the standing rollout (4 servers + desktop rebuild).

---

### H. Fork-hygiene footprint

| File | Churn | F16 edit |
|---|---|---|
| `packages/contracts/src/projectCatalog.ts` | new | fork-owned, whole file |
| `apps/server/src/projectCatalog/**` | new | fork-owned, whole dir |
| `packages/contracts/src/environmentHttp.ts` | 🟢 2/500 | group class + one `.add` at `:790-799` |
| `apps/server/src/server.ts` | 🔴 11/500 | **one** `Layer.provide` line |
| `apps/server/src/config.ts` | 🟡 | one path line |
| `packages/contracts/src/environment.ts` | seam | one capability field |
| `apps/server/src/environment/ServerEnvironment.ts` | 🟡 | one line at `:148` |
| `apps/server/src/mcp/**` | fork-owned (F7a) | new toolkit + 2 registration lines + master-gate widening |
| `packages/contracts/src/peers.ts` | fork-owned (F7a) | one optional field |
| `apps/web/src/routes/_chat.projects*.tsx` | 🟢 28/500 | two new files |
| `apps/web/src/routeTree.gen.ts` | generated | **regenerate** |
| `apps/web/src/components/projects/**` | new | fork-owned |
| `apps/web/src/components/sidebar/SidebarHeaderCompact.tsx` | fork-rewritten (F8) | swap one button for a popover |
| `apps/web/src/components/workbench/Workbench.board.ts` | not touched by F14 | one optional param |
| `packages/client-runtime/src/state/projectCatalog.ts` | new | fork-owned |

**Not touched: `ws.ts`, `ChatView.tsx`, `SidebarV2.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`, `settings.ts`, `rpc.ts`, any migration.** No new WS RPC (addendum §7.3's worst case avoided entirely).

---

### I. Collisions

- **F14 (star map), worktree `t3code-f14`** — **must land first.** F16 phase 3 depends on `WorkbenchStarMap.tsx`, `StarMap.model.ts` and `FeatureFlow.model.ts` existing. Two notes: (1) F14 is 3 commits *behind* `hub` and its rebase will itself conflict in `CelestialArt.tsx` / theme CSS — that is F14's problem, not F16's, but it gates the start date; (2) F14 **deletes** `FeatureFlow.layout.ts` and with it `featureFlowProjectKey` — F16 is the thing that reintroduces cross-machine project grouping, by slug rather than basename, which is strictly better. Do not restore the deleted file.
- **F12 (connections + import)** — owns `SidebarConnectionsMenu` in the icon strip and the import dialog. F16's strip edit is the *New project* button, a different element in the same file: land F12 first, then rebase. F12's cwd→project equality resolve is untouched by F16 (bindings are additive metadata; `projection_projects` semantics are unchanged).
- **F15 (split view)** — imports `WorkbenchMasterPicker.tsx`; F16 needs it project-aware. Resolve by **adding an optional prop**, never by moving, renaming, or generalizing it. If both land, generalizing to a shared `ThreadPicker` is a fast-follow after.
- **F13 (living sky)** — F16 writes no motion and no theme CSS; the constellation glyph is static.
- **Upstream churn** — the only hot-file lines F16 owns are single `Layer.provide` / capability lines. Rebase cost should stay near zero.

---

### J. Test plan

- **Pure unit** (`ProjectCatalog.model.test.ts`): slug union across four machines incl. one offline; newest-`updatedAt` title tie-break; membership = derived ∪ explicit \ excluded, with a thread that is both bound and excluded; unfiled set; suggestion ranking (canonicalKey beats basename, and a basename-only match is flagged weak); per-project master resolution local-first with alternates; a category with zero bindings.
- **Server**: registry round-trip, missing-file-is-empty, concurrent-upsert serialization, slug immutability on rename. In a **fork-owned test file** — not `server.test.ts` (🔴 23/500).
- **Capability skew** (the trap that bit F5/F12): an old server answers `/api/project-catalog` with **200 + SPA HTML**, not 404. The loader must degrade to "no catalog" and the project home must render a per-machine footnote ("this machine doesn't report projects yet"), mirroring `featureFlow.ts:92-120`.
- **MCP gating**, beside `McpMasterGating.test.ts`: a project master gets `peers-operate`; the legacy global master still does; a non-master does not; self-filing works at `peers` and filing another thread does not.
- **Live 4-machine**: create a project on the Mac → verify it appears on path-pc/simforge1/laptop after fan-out; bind a location on each; designate a per-project master; have that master call `peer_thread_create` with `project: "<slug>"` and confirm the new thread appears in the project's sky on the right machine without any manual filing; rename on one machine and confirm the title converges.
- **Headless screenshots**: index (populated / empty / unfiled-heavy) and project home, dark + light.

---

### K. Open questions for Michael

1. **One project per thread, or many?** Recommend **one** (a category, not a tag) — it keeps the fold trivial, makes "which sky does this star belong to" answerable, and matches how you described it. Tags are a different feature and can be added later without breaking this.
2. **Auto-seed on first open?** Recommend **yes, with a confirm step**: propose one project per repository across all four machines, pre-bound, named from the repo — accept-all in one click. The alternative (start empty, file everything by hand) makes day one an unpaid chore.
3. **Does `/workbench` survive as the global all-machines sky?** Recommend **yes** in v1 — projects get their own filtered skies, and the global one stays as the everything view. If you would rather the workbench icon go straight to the projects index and the global sky become just another card, say so now; it is a one-line routing change *before* phase 3, and a rework after.
4. **Sidebar in v1: leave it folder-shaped?** Recommend **yes** — reach projects from the header popover and the new view, and only re-shape the sidebar tree into categories once the model has proven itself. Re-shaping now spends the `SidebarV2.tsx` hot-file budget on the least certain part of the design.
5. **Do projects nest?** (e.g. Alpamayo › eval-harness, Alpamayo › render-fleet.) Recommend **flat** for v1 — nesting doubles the fold, the view, and the tool surface. Worth knowing now if you expect to want it, because a `parentSlug` field is far cheaper to reserve than to retrofit.

## Projects & Orchestration Doctrine (07-26)

**Status: doctrine, not a plan.** F16 shipped the mechanism; this section fixes what the
mechanism *means*, so that later features extend it instead of quietly redefining it. Where a
verdict below contradicts an F16/F17 detail, this section wins.

**Michael, on what projects are for:**

> *"I want the projects to be a way for threads to know about each other. I think that's all it
> should be about."*

> *"…all the threads live on different connections and they all live in different file system
> directories. Maybe we can have it such that star code syncs up all the directories. To be honest
> I'm not really sure if that would work. Maybe we can have it such that we just don't do anything
> and we just leave it like it is. … I'm thinking that we be loose on the file system stuff but I'm
> not sure."*

> *"In the workbench area you can see all the different connections and where each of them is in
> relation to features and they deploy the feature stuff like that. If they're being planned to be
> deployed through the master planner, essentially the whole flow I want the user to have is that in
> the master planner they will create threads and features on the various different connections. It
> will orchestrate the management of those features all the way from development to deployment and
> all the way from promotion to dev to production. Its goal is that the main planner is just to
> manage all that."*

**Amendment (07-26, Michael), after reading the above — two rulings folded into §1–§4 and
invariant 13:**

> *"The master planner should also be able to SSH into the individual connections themselves and be
> able to see the status of everything. That's one of the features of the master planner so we don't
> really need a synced file system. Yeah keep in mind the workbench. Each project should have its
> own workbench with its own master planner so keep that in mind."*

---

### 1. What a project is: a mutual-awareness layer

**A project is the one name that means the same thing on every machine.** That is the entire
concept. Four servers issue their own `ProjectId`s and `ThreadId`s and none of them is meaningful
anywhere else; the slug is the only identifier that survives a peer boundary intact. Everything
projects do falls out of that single property:

- **Threads know about each other.** A thread can ask `project_get` and learn what else is running
  under the same name, on this machine, with status — and read the operator's notes about what the
  project *is*. The orchestrator can create work elsewhere with `peer_thread_create({ project })`
  and the receiving machine resolves the slug to whichever of its folders it binds, so the new
  thread arrives already filed. No id ever crosses the wire in a direction it would be meaningless.
- **A shared workbench, and this is a rule, not a mechanism.** *"Each project should have its own
  workbench with its own master planner."* One project, one workbench, one orchestrator. Each
  machine may name one thread as this project's orchestrator (`local.masterThreadId`), and the
  client resolves them local-first with alternates through the same `resolveWorkbenchMaster` the
  global workbench uses. The global `/workbench` is not a different kind of thing — it is this
  same surface with the membership filter absent (§3, invariant 13).
- **Seen together.** The project home is the fleet sky filtered to the project's membership — one
  picture of work that physically lives in four different checkouts.

**What a project is NOT, stated so nothing drifts back into it:**

| Not a… | Because |
|---|---|
| **Folder** | The folder already exists and is load-bearing. A server `project` record is a *location*: `resolveThreadWorkspaceCwd` = `thread.worktreePath ?? project.workspaceRoot`, and checkpoints, diffs, worktrees, the file browser and `t3.json` all `INNER JOIN` it. A category sits above that record and never replaces it. A category with **zero bindings is legal** — that is the research project whose threads live in scratch dirs. |
| **Filesystem thing** | See §2. A slug never resolves to a path. Nothing may derive a cwd from a project. |
| **Deployment unit** | A project does not build, deploy, or own an environment. It is the set the master planner *operates over*; the promotion machinery is a separate axis (§4) that a project scopes but does not embody. |
| **Access-control boundary** | Capabilities are minted per session against the master gate, not per project. A project is not a permission. |
| **Tag** | One project per thread. `resolveLocalProjectMembership` breaks a double claim deterministically (explicit beats derived; ties go to the lexicographically smaller slug) precisely so "which sky is this star in" always has one answer. Tags are a different feature; adding them later does not require breaking this. |

---

### 2. Filesystem stance: loose, and here is the argument

**Verdict: each connection keeps its own directories, forever. starcode never syncs directories.
The cross-machine anchor is repository identity (`repositoryIdentity.canonicalKey`), and git is the
sync layer.** Michael's instinct — *"be loose on the file system stuff"* — is right, and it is right
for reasons stronger than caution.

**Steelmanning the sync alternative first, honestly.** If starcode mirrored each connection's
project directories, you would get: an agent on the laptop could read a file another agent just
wrote on simforge1 without a push; uncommitted work would be visible fleet-wide, which is exactly
the state a supervising planner most wants to see; "same project, different machine" would need no
inference because the bytes would be identical; and a thread could migrate between machines
mid-task. That is a real list. It is not why we refuse.

**And the strongest item on that list is answered without syncing anything.** Michael: *"The master
planner should also be able to SSH into the individual connections themselves and be able to see the
status of everything. That's one of the features of the master planner so we don't really need a
synced file system."* The visibility need is real — a planner that cannot see uncommitted work on
simforge1 is flying blind — but the way to satisfy it is to **go and look**, not to make a second
copy. `git status`, `git log`, the branch a checkout sits on, whether a service is up, what a log
says: all of that is one read-only command away over a connection the operator already has. Sync
answers the question by continuously moving bytes nobody asked for; SSH answers it by asking, when
asked. The steelman's best argument turns out to be an argument for observation, not replication.

**Why it fails anyway:**

1. **Divergent checkouts are the feature, not the defect.** The Mac is on `dev`, simforge1 is on a
   worktree of `feat/x`, path-pc is pinned to a release tag. Every one of those is deliberate. A
   syncer's job is to destroy exactly that difference. The fleet is useful *because* four machines
   can be at four points in history at once; convergence would be a downgrade sold as a feature.
2. **Conflict surface with no adjudicator.** Two agents editing the same file on two machines is
   normal here. A directory syncer must then either pick a winner (silently losing an agent's work —
   the failure mode that is invisible from inside the tool call that caused it) or surface conflicts
   in a second, non-git vocabulary the operator has to learn and reconcile by hand.
3. **The payload is hostile.** These trees carry `node_modules`, `.venv`, build caches, `.git`
   itself, model checkpoints, CARLA assets, and per-machine `.env` files with machine-scoped
   credentials. Syncing `.git` across machines corrupts it; syncing dotfiles leaks secrets and
   breaks per-machine config; syncing large binaries saturates the links that already flap (see the
   simforge1 serialize-SSH note). An exclude list that gets all of this right is a product.
4. **It re-implements git and Dropbox, badly.** Content sync between machines with divergent history
   is a solved problem with two mature answers, one of which is already installed, already
   understands these trees, already has conflict semantics the operator knows, and already
   *is* the promotion mechanism (§4). A worse third one earns nothing.
5. **It contradicts the concept.** A project is mutual awareness. Sync is mutual *state*. The moment
   a project moves bytes, deleting a project can destroy work — and invariant 1 (§6) is gone.

**The middle path, which we do want and largely already have.** The valuable part of sync is
*awareness*, and awareness costs nothing. The client already knows when two folders on two machines
are the same repository: `repositoryIdentity.canonicalKey` rides in the shell snapshot,
`deriveLogicalProjectKey` groups on it, and `ProjectCatalogLocation.repositoryKey` puts it on the
wire raw — deliberately underived, so seeding does not become a second implementation of the
grouping rule. The seed dialog then draws the exact line this doctrine wants: **a shared
`canonicalKey` is a fact and is pre-checked; a shared folder basename is a guess and is listed,
marked weak, and left for the operator to opt into.**

Keep extending awareness in that direction and no other. Legitimate future work: showing that a
project's three checkouts sit on different branches, that one is behind, that a file is dirty on one
machine. All of that is *reporting* on directories. None of it moves a byte. **SSH is the second
awareness channel and the deeper one** — the catalog says where a project lives, and SSH says what
state it is actually in.

**The line SSH must not cross, stated now rather than after someone crosses it: SSH is for
observation.** The planner reads — branch, dirty state, ahead/behind, logs, service and process
status, disk, GPU. It does not edit files, apply patches, or run builds on another machine as a way
of getting work done. Work is *dispatched*, not *performed remotely*: `peer_thread_create` starts a
real thread on that connection, with its own transcript, its own checkpoints, its own approval
gates, and its own place on the sky. A planner that instead SSHes in and edits files directly
produces changes with no thread, no history, and no star — invisible to the exact surface this
doctrine exists to make trustworthy. Read remotely; write through threads.

**The practical seam, honestly.** Masters are ordinary agent sessions running on their host machine,
so they SSH with *that host's* own `~/.ssh` config and keys, under the operator's existing access.
starcode's job here is to **document reachability, not to broker credentials** — a project's notes
and links are the natural place to record which connections it spans and how they are reached, and
`project_get` already returns both to any agent that asks. There is no case for a credential store
in the catalog: the catalog replicates its display half to four machines, and secrets must never be
in anything that replicates (invariant 3).

---

### 3. The workbench: the sky, filtered by membership

**Every project has its own workbench and its own master planner. The global `/workbench` is the
unfiltered case of that same surface, not a separate thing.** Michael: *"Each project should have
its own workbench with its own master planner."* This is a rule about what must always be true, not
a description of the current build — a future surface that gives one project a bespoke workbench, or
that makes the global workbench the only real one, is out of doctrine.

The mechanism already matches the rule: `includeThreadKey` is an optional predicate on
`buildFeatureFlowView` and `buildWorkbenchBoard`, defaulting to "everything", so `/workbench`
behaves byte-for-byte as before and `/projects/$slug` passes the project's resolved thread keys.
The orchestrator resolves the same way in both places — `resolveWorkbenchMaster` over a candidates
array, local-first with alternates — and both kinds of master are granted `peers-operate` and
`features-operate` by the same union in `resolveMasterThreadIds`. **Designating a project master
never demotes the global one**; the two answer different questions and both keep their answer.

What the operator reads there is Michael's *"where each of them is in relation to features"*, and
the sky's own vocabulary already spells the flow out. Altitude is stage, lineage is what a feature
grew out of, and there is deliberately **nothing about machines in the geography** — which machine
runs a piece of work is a fact about today's fleet, not about the work, so it lives on the hover
card and nowhere else:

```
latest (the origin, on the horizon — the shared state everything branches from)
  → in flight   (in-progress: not contained in any trunk)
  → landed      (in-dev)
  → ready       (in-staging)
  → shipped     (in-production)
```

**The doctrine this fixes:** the per-project view owes the operator two things the global sky
cannot give — *which connections carry this project* (chips, not geography) and *where each is in
the flow*. Deployment state belongs on this surface when it exists (§4 gap 4), attached to the
feature, never to the machine.

---

### 4. Master planner doctrine

**Michael:** *"in the master planner they will create threads and features on the various different
connections. It will orchestrate the management of those features all the way from development to
deployment and all the way from promotion to dev to production."*

**Each project has its own master thread, and its job is that project's feature lifecycle end to
end.** Concretely, the intended loop:

1. **Plan** — lay the intended shape out as planned features on the sky (`feature_plan_set` replaces
   the whole planned overlay in one call, because a plan is a shape, not a pile of rows).
2. **Create** — start threads on the right connections with `peer_thread_create({ project })`; the
   peer resolves the slug to its own bound folder and derivation files the thread automatically, so
   membership needs no cross-machine write.
3. **Bind** — link each real thread to its feature, which is how a planned feature becomes real.
4. **Observe** — *"SSH into the individual connections themselves and be able to see the status of
   everything."* The planner's own senses, and the reason no synced filesystem is needed (§2). Where
   the catalog says a project lives on three machines, the planner goes and reads what state each
   one is actually in: branch, dirty tree, ahead/behind, running services, logs. **Read-only** —
   observation feeds the loop, it does not perform the work.
5. **Drive** — watch stages climb as work lands, and correct the account when git has not caught up
   (`feature_promote` overrides the derived stage, deliberately: promotion is an act, and an act the
   operator's agent performed should not be silently overruled by a containment check).
6. **Promote** — carry the feature dev → staging → production.

Steps 1–5 exist; step 4 exists as an agent capability rather than as anything starcode implements,
which is the right split — the master is an agent session on a host that already has SSH. Step 6 is
bookkeeping only, and that is the honest state of it.

**Two rules that must not erode.** First, **no git vocabulary crosses the feature boundary** — a
feature has a name, a stage, dependencies, and whether it is real; branches, worktrees and PRs stop
at the stage computation. Second, **the master's account and git's account stay separate sources
that reconcile by thread id**: git is accurate and mute, the master knows why. Deployment state,
when it lands, is a *third* source and must not be folded into either.

#### Roadmap: what exists, what is missing

| Piece | Today | Gap |
|---|---|---|
| Cross-machine project identity | `ProjectCategoryRecord` — slug identity, `display` replicates / `local` never does | — |
| Per-project orchestrator | `local.masterThreadId`; `resolveMasterThreadIds` unions settings + every category and grants `peers-operate` + `features-operate`; halves degrade independently | — |
| Create work on another connection | `peer_thread_create({ project })`; peer resolves the slug against **its own** catalog and errors with the available list when unbound | Picks `bindings[0]` when a machine binds several folders, and ignores the category's `local.defaults.preferredProjectId` / `modelSelection` — it uses the *location's* `defaultModelSelection`. Small, real, fixable in the writer. |
| Agent-facing project reads | `project_list`, `project_get` (notes, links, locations, threads, features, master), `project_file_thread` with self-file at `peers` and other-file at `peers-operate` | — |
| Feature authoring | `feature_map_{list,create,update,promote,link,plan_set}`, gated on `features-operate` | — |
| **Features scoped to a project** | **Missing.** `FeatureMapEntry` has id/name/description/threadId/stage/dependsOn/planned/timestamps — **no project**. A planned feature has `threadId: null`, so it cannot be reached by a membership rule that keys on threads at all. | **The load-bearing gap.** Add `slug` to `FeatureMapEntry` (nullable, additive). Everything else on this list is downstream of it. |
| **Project sky excludes other projects' features** | **Broken today.** `includeThreadKey` reaches the flow and the board, but `buildSkyModel` iterates `mapEntriesByEnvironment` with no filter — so `/projects/$slug` renders *every* machine's entire feature map. | Concrete bug, follows from the gap above. Filter map entries by `slug` once entries carry one; fall back to the bound thread's membership for entries that don't. |
| Cross-connection feature rollup | Feature *flow* folds across machines (`buildFeatureFlowView`). Feature *map* does not: one JSON per server, and `project_get` returns only the answering machine's features by design ("a tool result never claims to know what another machine holds"). | A master on the Mac cannot see a feature it created on simforge1. Fix **client-side** (fold the per-env feature maps by slug, as the flow already does) — not by teaching a server to guess. |
| Promotion / environment stages | The vocabulary exists: `FeatureFlowStage` = in-progress / in-dev / in-staging / in-production, derived from trunk containment, with `FeatureFlowTrunkConfig` letting the operator name trunks per project. | Stages are *observations*, and `feature_promote` is an *assertion*. Nothing **performs** a promotion — no tool merges dev→staging, opens a PR, or triggers a deploy. Michael's "manage all that" currently means "record all that". |
| Deployment state ingestion | **Nothing.** No deploy, CI, or check-run signal anywhere in contracts or server. | `in-production` means "contained in the production trunk", not "deployed". The sky can honestly say *shipped* when nothing has been deployed. Needs a distinct source, rendered distinctly — do not overload the stage. |
| Nested projects | `display.parentSlug` reserved, nothing reads it | Deliberate. Flat until the flat model is proven. |

**Sequencing verdict:** `FeatureMapEntry.slug` first (it unblocks the sky filter and the rollup),
then the client-side cross-machine feature fold, then deployment ingestion as its own source, and
only then any tool that *performs* a promotion. Do not build the promotion actuator against a
feature model that cannot yet say which project a feature belongs to.

#### Self-development (07-26, Michael approved)

**starcode hosts its own development as an ordinary project.** A `starcode` project, threads that
build the fork, its own workbench and master planner — the same rules as any project, no special
case. Two guardrails, because the tool being modified is the tool doing the modifying:

1. **A self-development thread never hot-restarts the server hosting its own session.** Killing the
   process mid-turn destroys the transcript of the change that caused it, and the operator is left
   with a broken server and no record of why. Rollouts go through the standing pipeline, and
   **preferably driven from a different connection than the one being rolled out** — the fleet
   makes this free, so the Mac ships to simforge1 and simforge1 ships to the Mac. F12's resume
   machinery is the accepted safety net for the one cutover moment that cannot be avoided.
2. **Development and testing run against a dev instance, never production state.**
   `T3CODE_DEV_INSTANCE` deterministically shifts every dev port together, and `T3CODE_HOME` moves
   the state directory — **both**, since the ports alone would leave two servers writing one
   `project-catalog.json`, `feature-map.json` and `peers.json`. A self-development thread that
   points at the live hub's state is not testing, it is editing production.

**Self-update stays disabled.** F0 turned it off at the resolver and the npm chokepoint
(`forkSwitches.ts`, `FORK_DISABLE_SELF_UPDATE`) and in-app development does not reintroduce an
auto-update path by the back door. The fork updates when the standing rollout says so — a machine
that can rewrite itself on its own initiative is a machine whose state nobody can reason about, and
that is a strictly worse position than the manual swap it would replace.

---

### 5. Best-practice check: the repo-anchored metadata pattern

Every adjacent system that got this right drew the same line — **a project is metadata that
references work; it never owns the bytes.**

- **VS Code multi-root workspaces** — a `.code-workspace` file is a list of *references* to folders
  that stay where they are, on whatever machine, in whatever state. It never copies or reconciles
  them. Our `bindings` array is the same object.
- **Linear / Jira projects** — pure metadata layers over work items. A project groups issues,
  carries a name and a description, and rolls up status. It owns no repository and no artifact, and
  deleting one deletes no work. This is the closest analogue to what Michael asked for, and
  `project_get` returning operator-authored notes is exactly its "project description" affordance.
- **Vercel projects** — repo-anchored deploy targets: a project is bound to a git repository, and
  *the repository* is the sync mechanism. Every environment (preview / staging / production) is a
  different point in that repo's history, deliberately divergent — the argument of §2 in production
  at scale.
- **git worktrees** — many directories, one repository, no syncing between them. The canonical proof
  that "same project" and "same directory contents" are unrelated ideas.

The counter-examples are instructive too: Dropbox-style sync of source trees is exactly what
developers turn *off* for repositories, and monorepo tooling only gets away with one tree because
there is one machine and one history. Nobody who has built this has concluded that the project layer
should move files. We are on the established path, not an improvised one.

---

### 6. Invariants

Short, testable, and binding on every future feature. Breaking one is a design change requiring an
edit to this section, not a patch.

1. **Deleting a project never touches a thread, a server-project, a worktree, or a file.** Removing
   a category removes a record. Nothing else, on any machine.
2. **A project never implies a path.** No code derives a cwd, a repo root, or a file location from a
   slug. The only cwd source stays `thread.worktreePath ?? project.workspaceRoot`.
3. **`display` replicates, `local` never does.** No fan-out write may carry a `ProjectId`, a
   `ThreadId`, or a `ProviderInstanceId`. The nesting exists to make this a type, not a comment.
4. **The slug is immutable.** Rename edits `display.title`; the join key never moves. Display
   conflicts resolve on `display.updatedAt`, `createdAt` takes the earliest.
5. **Membership is `derived ∪ explicit-adds \ excludes`, resolved in exactly one place per scope** —
   `resolveLocalProjectMembership` for a machine, `ProjectCatalog.model.ts` for the fold. A third
   implementation is a bug by construction.
6. **A thread belongs to at most one project,** and a double claim resolves deterministically
   (explicit beats derived, then smaller slug) — never by file order or fetch order.
7. **A project with zero bindings is legal** and must render, be filed into, and carry a master.
8. **starcode moves no file between machines, and the planner's SSH reach is read-only.** Any
   feature that would add a file-transfer path between connections in service of projects is out of
   scope by doctrine. SSH exists for observation in the planner loop; cross-machine file mutation is
   dispatched as a thread (`peer_thread_create`), never performed remotely by the planner itself, so
   every change has a transcript, a checkpoint trail, and a star. The catalog documents
   reachability; it never stores credentials.
9. **A server's answer describes only that server.** A tool result never claims to know what another
   machine holds; cross-machine union is the client's fold.
10. **A project view is the fleet view with a filter.** New project surfaces take a predicate on an
    existing model; they do not fork the star map, the board, or the flow.
11. **A missing or unreadable catalog degrades to "no projects", never to an error.** An old server
    answers an unknown route with 200 + SPA HTML, not 404 — every loader must survive that and name
    the machine that could not answer.
12. **A disconnected machine hides its half of a project; it never deletes the project.** Local
    membership is unavailable, not empty.
13. **Every project has its own workbench and its own master planner.** One project, one workbench,
    one orchestrator per machine (`local.masterThreadId`, resolved local-first with alternates). The
    global `/workbench` is the same surface with the membership filter absent — never a second
    implementation, never the only real one. Designating a project master must not demote the global
    master: `resolveMasterThreadIds` unions the two sources and each degrades independently.
14. **No thread restarts the server hosting its own session.** Stated generally rather than as a
    self-development special case, because it is general: any thread doing operational work on the
    machine it runs on can reach this gun. The restart kills the process mid-turn and takes the
    transcript of the change that caused it, so the operator inherits a broken server and no record
    of why — the one failure this doctrine cannot tolerate, since every other guarantee here assumes
    the record survives. Restarts are dispatched to a thread on a *different* connection; the fleet
    is what makes that free.

## F17 plan — Continuous sky, glass surfaces, shaders & transitions (07-25, PROPOSED)

**Ask (Michael, verbatim)**: *"I think we should incorporate really cool shaders for the backgrounds. For the left sidebar can you implement glassy, morphing shader effects for the background as well as the threads, like the text bar at the bottom for inputs? I think the background in general should also flow from the sidebar to the threads and globally throughout the page. When switching threads or pages a star should animate to make it feel like it's moving. And because of that I think we should incorporate some better page animations."*

**Base**: builds on **F13 phase A's merged state**, not today's `hub`. F13 is uncommitted in the main clone right now (`starcode-theme.css` +159/−39 adding §9 star layers, `CelestialArt.tsx` renders three `.starcode-star-layer` children, untracked `scripts/derive-starcode-star-layers.mjs`). F17 **relocates the surfaces F13 is animating**, so it must be authored against the rule, not the bytes — see §H.

---

### A. The central finding: blur is the wrong primitive for the big surfaces

The obvious reading of "glassy" is `backdrop-filter: blur()` on the sidebar and the thread pane. That is wrong here, on two counts, and getting this right is what makes the whole round cheap.

**Visually.** A Gaussian blur of a smooth vertical gradient is, to within a rounding error, the same gradient — you spend a full-viewport GPU pass to produce a picture nobody can distinguish from the input. The one thing behind those panels that *isn't* smooth is the starfield, and blurring it is actively destructive: 1–2px specks smear into grey haze, which is precisely the texture F11.1 and F13 spent two rounds earning. What actually reads as "glass" over a smooth backdrop is **tint + hairline + inner highlight**, none of which need a filter.

**Structurally.** `backdrop-filter` promotes the element to its own composited layer and forces the backdrop root to be rasterised separately. That is affordable when the blurred region is small and its backdrop is static (today's composer, dropdowns, dialogs — all fine, all already shipped). It becomes a real cost exactly when a large element blurs *scrolling content*, and the layer-explosion failure mode is dozens of small blurred surfaces, not one big one. So the containment strategy is not "tune the blur radius" — it is **add zero new backdrop-filter surfaces**.

The repo already agrees with this without having said it out loud: every one of the nine existing `backdrop-filter` rules in `index.css` (`.chat-composer-glass-shell::before` at `:399`, `.dialog-glass` `:579`, `.dropdown-glass` `:601`, …) sits on a **floating surface over content**. Not one is on a structural panel.

**So: the sky becomes real and continuous; the panels become tinted glass over it; blur stays exactly where it already is.**

---

### B. Scope 1 — one continuous sky

#### B.1 What exists (audited at `hub` c21818e34 + F13 working tree)

The sky is painted in **six** places, all of them per-surface:

| # | Selector | File:line |
|---|---|---|
| ① | `[data-sidebar-version=…] [data-slot="sidebar-inner"]` — light band | `starcode-theme.css:378-401` |
| ② | `.dark …[data-slot="sidebar-inner"]` — star tile + gradient + grain | `:403-434` |
| ③ | `.dark [data-slot="sidebar-inner"]::before` — chrome starfield | `:439-451` |
| ④ | `.dark [data-slot="sidebar-inset"]` — pane gradient | `:542-560` |
| ⑤ | `.dark [data-slot="sidebar-inset"]::before` — chrome starfield | `:576-587` (F13 adds 900s drift at `:1048`) |
| ⑥ | `:root:not(.dark) [data-slot="sidebar-inset"]` — light pane | `:595-609` |

Plus the **uncover rule** that exists only to work around the split (`starcode-theme.css:536-540`):

```css
/* Scoped to direct children so nothing deeper — cards, popovers, the composer,
   any surface that needs to occlude what scrolls under it — loses its fill. */
[data-slot="sidebar-inset"] > .bg-background { background-color: transparent; }
```

`c284b71e4` ("Let the sky into the working UI") already fought this seam once: it pushed the sidebar band from 88px to full height *because* "held to its 88px band while the pane filled with colour… the seam down the middle of the app was the first thing the eye found." That commit treated the symptom. Michael's ask is to remove the cause.

The theme file's own comment at `:511` says *"`body` is not an option: it sits behind the inset, which is opaque."* **F17 is the round that makes body an option**, by removing the opacity.

#### B.2 Recommendation: `<div class="starcode-sky">`, portalled to `document.body`

One fork-owned element, portalled from `__root.tsx` beside `GlassAppearanceSync` (`routes/__root.tsx:150`):

```
position: fixed; inset: 0; z-index: -1; pointer-events: none;
```

It owns the gradient, the star tile / F13 drift layers, and (phase 3) the mesh blobs. `z-index: -1` in body's stacking context paints it above body's own background and beneath every in-flow descendant — the classic and correct placement.

**Why body-level and not "first child of `sidebar-wrapper`"**: every `@base-ui` portal (`dialog.tsx:18`, `menu.tsx:13`, `tooltip.tsx:30`, `combobox.tsx:161`, … no `container=` prop anywhere) mounts to `document.body`, i.e. *outside* the sidebar wrapper. Those surfaces already use `backdrop-filter`. A sky mounted inside the wrapper is not in their backdrop chain, so `.dropdown-glass` would blur nothing and every menu would read as a flat plate floating over a sky it can't see. Body-level is the only mount that makes the existing glass vocabulary correct.

**Then delete paint sites ①–⑥ and the uncover rule.** Six rules and a workaround collapse into one. This is a net *simplification* of the theme file, which is worth saying out loud in a round whose headline is "add shaders."

#### B.3 The three-tier surface doctrine (the thing to encode in the CSS header)

| Tier | Surfaces | Treatment | Cost |
|---|---|---|---|
| **L0 — sky** | the one fixed layer | gradient + stars + (P3) mesh | 1 composited layer |
| **L1 — structural panels** | `sidebar-inner`, `sidebar-inset`, workbench/settings shells | **tint only**: `background-color: color-mix(in srgb, var(--sidebar) var(--sc-glass-panel), transparent)`, plus the existing hairline and `surface-grain`. **No filter.** | zero |
| **L2 — floating over content** | composer shell, `.dropdown-glass`, `.dialog-glass`, `.alert-glass`, toasts, sheets | **unchanged** — they already blur, and their backdrop is now the sky rather than an opaque plate, which is strictly better | unchanged |
| **L3 — opaque islands** | xterm terminal drawer (`ThreadTerminalDrawer.tsx:829,1228,1262`), diff panel (`DiffPanelShell.tsx:30`), `.surface-subheader` (`index.css:365`), all form controls (`input.tsx:61`, `select.tsx:24`, …), sticky `<thead>` in Diagnostics (`DiagnosticsSettings.tsx:455,684`), `WorkbenchMasterPicker.tsx:114` | **stay opaque, by rule.** Content must never scroll under text. | zero |

L3 is not a concession, it is the restraint rule (`starcode-theme.css:38-43`) applied to translucency: *the sky is for chrome, never under body text.*

#### B.4 What breaks — the audited list

1. **The 116 `bg-background` / 46 `bg-sidebar` / 29 `bg-card` call sites.** Almost all are form controls and cards that *should* stay opaque (L3) and need no edit. Only the two shell selectors change, both in `starcode-theme.css`. **Zero component edits.**
2. **`useTheme.ts:156`** — `document.querySelector("main[data-slot='sidebar-inset']")` samples the inset's computed background to sync browser/native chrome colour. Once the inset is translucent this samples the wrong thing. Repoint it at the sky layer (or at a resolved `--sc-sky-top`). **One line, and it will be silently wrong if missed** — the app's titlebar tint is the tell.
3. **The plate-corner engraving rule** (`starcode-theme.css:755`) matches on exact grandchild depth: `[data-slot="sidebar-inset"]:has(> * > .starcode-speck-field)`. F17 does not wrap or move `.starcode-speck-field`, so it survives — but any refactor that reparents the inset's child breaks it silently. Same trap F13 documented at `CelestialArt.tsx:84-88`.
4. **`settings.tsx:66` puts `isolate` on the inset.** Harmless at body level (it was a hazard only for a wrapper-scoped layer) — but it is exactly why the wrapper mount was rejected. Note it so nobody re-proposes it.
5. **Ancestors with an opaque background would occlude a `z-index: -1` layer.** `#root` has none; `data-slot="sidebar-wrapper"` carries `has-data-[variant=inset]:bg-sidebar` (`sidebar.tsx:160`) which is inert at the default variant. **Verify both in the browser before writing the CSS**, and add a `:has()` guard if the inset variant is ever adopted.
6. **The mask-based scroll fades already work.** `.chat-timeline-scroll-fade` / `.settings-page-scroll-fade` (`index.css:314-353`) fade the *rows* with a `mask-image` rather than painting an opaque wedge — the comment at `:314` says it was written for exactly this reason. Translucency-safe with no work. Genuinely good news; the one class of bug you'd expect from this round doesn't exist.

#### B.5 Contrast — the AA gate extended to glass (non-negotiable)

`scripts/check-starcode-contrast.mjs` today models *star over opaque panel*. Under glass, every text token sits on a composite of **star × sky-gradient-at-that-height × panel-tint**. It already has the compositor it needs (`over(fg, alpha, bg)` at `:36`), so this is an extension, not a rewrite.

Two things the extension must get right:

- **Worst case is the user's, not the default's.** `glassOpacity` is a *shipped, user-facing slider* (`packages/contracts/src/settings.ts:67-68`, `MIN_GLASS_OPACITY = 40`, `MAX = 100`; slider at `SettingsPanels.tsx:610-631`; applied to `--glass-opacity` at `__root.tsx:154`). The gate must hold at **40%**, the most transparent setting a user can pick — not at the default.
- **Worst case is per phase.** Sky colour is JS-driven (`starcodeSky.ts:191-194`) across four phases; the brightest (`dawn` top `#49182d`, `day` top `#1b304b`) reduces contrast for cream-on-dark most. Iterate phase × theme × tier as F11.1's gate already does.

Output: a per-phase ceiling for `--sc-glass-panel` in the same spirit as `--sc-star-chrome-max: 0.13` (`starcode-theme.css:114`) — *the panel transparency at which the tightest text token still clears 4.70 on every surface in every phase at glassOpacity 40*. **Run the gate before writing the visual CSS, not after.** F11.2 caught eight failures that way.

#### B.6 It serves the future two-pane layout for free

F15's split view (PLAN.md §F15) puts two `ChatView`s side by side inside one inset. With per-surface sky painting, that is a **third** seam to hand-tune, and F15's §G already carries a rule forbidding it from touching `starcode-theme.css`. With one fixed body-level layer, both panes and the divider float over the same continuous sky with **zero F15 work**. Same for F14's star map (`_chat.workbench`) — it inherits the sky by being transparent, and the map sits on a real sky instead of a painted imitation of one.

**Sequencing consequence: land F17 phase 1 before F15 phase 1.** It removes work from F15 rather than adding it.

---

### C. Scope 2 — glassy morphing effects, and the shader question answered honestly

Michael asked for shaders. F13's doctrine (PLAN.md §C) is 0 rAF, compositor-only, no WebGL, <4KB. These are in genuine tension and the resolution is a **tier setting**, but the recommendation is not a fudge — it is that the cheap tier gets most of the way there and we should look at it before paying for the rest.

#### C.1 Tier `drift` (recommended default) — CSS gradient mesh, compositor-only

Three or four very large radial-gradient blobs as children of the sky layer, each `transform: translate3d()` + slow `scale()` on a 60–180s loop with prime-ish periods so they never re-phase, tinted from `--sc-sky-glow` / `--sc-butter` at ceilings around 0.04–0.08. Only `transform` and `opacity` animate — no gradient stops, no `background-position`, no `filter` (F13's §C rule, which is the difference between a compositor animation and a full repaint every frame).

**One addition that closes most of the remaining gap: a baked turbulence mask.** CSS blobs are always smooth ellipses; what makes a shader aurora read as *organic* is filamentary fbm structure. Bake an `feTurbulence` field once into an SVG data-URI and use it as a `mask-image` over the blob group, drifting on its own slow transform. Zero runtime cost — and **the codebase already uses exactly this technique**: `--surface-grain` (`index.css:1000`) is a baked `feTurbulence fractalNoise` data URI. This is established fork vocabulary, not a new idea, and the generator script has precedent in `derive-starcode-star-layers.mjs`.

**Honest estimate of how close this gets to "shader":** ~75–80%. What you get: slow morphing colour fields with organic, non-elliptical edges, correct phase tinting, banding suppressed by the existing grain. What you *cannot* get: per-pixel refraction of the backdrop (the "liquid glass" look), chromatic dispersion at glass edges, and noise that evolves over time rather than translating. The first of those is the only one I'd expect Michael to actually miss, and it is a property of the **composer bar**, not the background.

#### C.2 Tier `shader` — one low-res WebGL canvas

If C.1 isn't enough: a single `<canvas>` inside the sky layer, ~480×270 backing store upscaled by CSS (`filter: blur()`-free; the upscale *is* the blur), `powerPreference: "low-power"`, a rAF loop that gates on `timestamp` to ~24fps, `document.hidden` → cancel (not pause) the loop, `IntersectionObserver` unnecessary since it's always on-screen. Static-frame fallback: on context-lost, on `prefers-reduced-motion`, and on tier `off`, render exactly one frame and stop. Raw WebGL, ~150 lines of GLSL + boilerplate, **no three.js** (it would ~10× the bundle for a full-screen quad).

**Battery, stated as an estimate with its method — this has not been measured.** The shader work itself is negligible: 480×270 × 24fps ≈ 3.1M fragment invocations/sec, which an M-series GPU does in the noise. The cost that matters is **keeping the render pipeline out of idle**, and the CSS tier already pays most of that — F13's star drift animates continuously today. My estimate for the *marginal* cost of the WebGL tier over the CSS tier on an M-series MacBook is **~0.3–0.8 W**, i.e. roughly 3–7% of battery life on a machine that idles near 4–6 W with a display on. That is a real cost for a background nobody looks at directly, and it is the entire argument for it being opt-in.

**Measure before believing me**: `sudo powermetrics --samplers cpu_power,gpu_power -i 1000 -n 60` on the installed desktop app, idle on a thread, tier `off` vs `drift` vs `shader`, three runs each. That is the acceptance gate for phase 5, and it is cheap to run.

#### C.3 The setting

`backgroundEffects: "off" | "drift" | "shader"`, default `"drift"`.

Recipe, all of it already proven in-repo:
- **2 additive lines** in `packages/contracts/src/settings.ts` — the literal + `Schema.withDecodingDefault` in `ClientSettingsSchema` (mirror `sidebarV2ViewMode` at `:139-141`) and one `Schema.optionalKey` in `ClientSettingsPatch` (mirror `:698`). `DEFAULT_CLIENT_SETTINGS` and `UnifiedSettings` derive automatically; **`useSettings.ts` needs no edit** — `splitPatch` (`:145-163`) routes any non-server key to localStorage by construction, and `localApi.ts:52-64` gives desktop `electron-store` persistence for free.
- **UI in `BetaSettingsPanel.tsx` (2 touches)**, not `SettingsPanels.tsx` (45 touches). Copy the "Time format" 3-way `<Select>` + `SettingResetButton` row verbatim from `SettingsPanels.tsx:673-703`. No new settings route, no `SettingsSidebarNav.tsx` edit.
- Applied as `<html data-sc-effects="drift">` from a tiny sync component beside `GlassAppearanceSync`, so CSS gates on an attribute and the WebGL module gates on `getClientSettings()` (`useSettings.ts:171`).

**Do not add a second opacity dial.** `glassOpacity` already exists, already ships a slider, and already drives `--glass-opacity`. F17's panel tint reads the same token. One dial.

#### C.4 The composer bar specifically

`chat-composer-glass-shell` already exists and is good (`index.css:380-402`): `--glass-blur` + `--glass-saturation` on a `::before`, `isolation: isolate`, a `clip-path: shape()` variant that fuses the composer to the context strip into one continuous pane (`:404-441`) with a `@supports` fallback (`:519-546`), border and shadow on the sibling `.chat-composer-glass-host` (`:444-457`). It needs **no rework** — under F17 its backdrop stops being a flat plate and becomes the actual sky, which is the upgrade Michael is describing.

Two notes: (1) `chat-composer-glass-shell-with-context` has no literal TSX call site — confirm it is composed dynamically before assuming it is live, or it is dead code. (2) `.chat-composer-glass` (`index.css:374`) has zero call sites and is kept alive only by the `@supports` block at `:751` — a candidate deletion, but `index.css` is 53 touches and fork diff there is currently **zero**; leave it.

**The one place refraction is worth wanting** is the composer's top edge, where transcript text passes beneath it. That is an SVG `feDisplacementMap` in a `filter`, which repaints per frame — **OUT** at any tier. Note it as considered and rejected.

---

### D. Scope 3 — the star flies on navigation

#### D.1 The doctrine collision, stated first

F13 ships a shooting star every ~22–55 minutes, and its §A rule 2 is that **rarity is the whole product**. A meteor on every thread click fires it ~200×/day and retires the effect permanently. So whatever navigation does, it must not look like the shooting star.

#### D.2 Options

**(a) Streak from the clicked row toward the pane.** Literally matches "a star should animate." Needs source geometry (the clicked row's rect), a body-level portalled element, WAAPI, and a cancel-on-interrupt singleton. ~120 lines. Risk: it *is* a small meteor, so it collides with D.1 unless deliberately de-tailed and dimmed — at which point it is a faint dot crossing the screen, which F13 §B.9 already rejected as "is something broken?".

**(b) Whole-sky warp (recommended).** On navigation, `<html>` gets `data-sc-warp` for ~320ms; the sky's star layers take a short `translateX` kick with a slight `scale(1.015)` and an opacity dip, easing out. Pure CSS on the layer that already exists, driven by one attribute toggle. It reads as the *world* moving past you rather than an object crossing it — which is the more literal reading of "make it feel like it's moving," is distinct from the shooting star by construction, and is the effect that **pays off the unified background**: it only works because the sky is now one continuous global layer. Interruptible for free (re-set the attribute, restart the animation); no geometry, no portal, no queue.

**(c) Let the sky ride the view transition.** Rejected — it couples the effect to route changes only, and would fight §E.3.

**Recommendation: (b), ~40 lines of CSS and ~15 of TS.** If Michael wants (a) as well, it is an additive phase on top, and the taste question is in §I.

Constraints, either way: ≤ 400ms (target 320); **interruptible with no backlog** — a module-level "current warp" token, restarted not queued, so ten rapid thread switches produce one continuous warp and not ten sequential ones; `prefers-reduced-motion` → **none at all** (not "shorter"), using the `usePrefersReducedMotion` hook currently module-private in `ThreadTaskProgress.tsx:18-42` — lift it to a shared module as part of this phase; tier `off` → none; no warp on redirect/guard navigations (§E.2 list).

---

### E. Scope 4 — page animations via View Transitions

#### E.1 The API is available and already in production here

- **Electron 41.5.0 → Chromium 146** (read off the framework binary's UA string, not a mapping table). `startViewTransition` (111+), view-transition **types** (125+), `::view-transition-*` pseudos — all supported.
- **Already used**: `components/chat/draftHeroTransition.ts` wraps `startViewTransition` for the mobile composer→draft hero, with a three-part guard at `:49-56` (viewport, reduced-motion, feature-detect), a structural `ComposerViewTransitionDocument` type at `:13-15` so no TS lib bump is needed, an idempotent update latch at `:58-63`, and full try/catch fallback. Its CSS block is `index.css:9-72`, including the root-suppression trick and the hard-won `mix-blend-mode: normal` + `isolation: isolate` at `:19-30`. **Copy this file's idioms; do not invent a second style.**
- **Non-Chromium matters**: the same `apps/web` bundle deploys to Vercel as the hosted app (`vite.config.ts:29-38`), there is no `build.target` and no browserslist. Safari 18.0+ has the API (types only from 18.2); Firefox stable does not. TanStack ignores the option when unsupported, so this degrades to plain navigation — but **all evidence screenshots must be Chromium**, and nothing may be *load-bearing* on the transition.

#### E.2 Recommendation: one router default, a `types` function, an opt-out list

`@tanstack/react-router` resolved **1.170.10** / `router-core` **1.171.8**. `NavigateOptions.viewTransition?: boolean | ViewTransitionOptions` (`router-core/dist/esm/link.d.ts:77`, default `false`); `ViewTransitionOptions` is `{ types: Array<string> | ((info) => Array<string> | false) }` (`router.d.ts:551`) — note there is **no** `update`/`name` field; returning `false` from the function form skips the transition for that navigation. `defaultViewTransition` exists on the router (`router.d.ts:154`).

The alternative is annotating **~30 `navigate` call sites across 21 files plus 9 `<Link>`s**, six of them in churn-hot files (`ChatView.tsx` 34/500, `Sidebar.tsx`, `SidebarV2.tsx` 21/500, `CommandPalette.tsx`). That is unacceptable fork hygiene for an animation.

So: **set `defaultViewTransition` once in `apps/web/src/router.ts:6` (5 touches, fork-safe, currently a 4-line options bag)**, using the *function* form of `types` to name the transition per route pair from that one place. Everything else collapses into that function.

Opt **out** (return `false`) for the corrective navigations, which are `replace: true` and must not animate: `routes/__root.tsx:331`, `routes/_chat.$environmentId.$threadId.tsx:60`, `routes/_chat.draft.$draftId.tsx:50,:66`, `hooks/useThreadActions.ts:338,:346`. These are identifiable from `locationChangeInfo` in most cases; where they aren't, a `viewTransition: false` at the call site is fine — those are cold files.

#### E.3 The trap unique to this round: the sky must not be captured by `root`

`::view-transition-old(root)` / `new(root)` snapshot the **entire viewport**, sky included. Crossfading two identical skies produces a visible double-exposure and (worse) freezes the drift for the transition's duration. Fix: give the sky layer its own `view-transition-name: sc-sky` so it forms its own group, then `::view-transition-group(sc-sky) { animation: none }`. `index.css:9-12` already does the same manoeuvre for the mobile composer transition — same trick, different name. **Verify with the Animations panel, not by eye.**

Second guard: **the transition must never wait on data.** `startViewTransition` holds the last painted frame until the update callback's DOM change lands, so a route that suspends into a pending fallback will crossfade *into a spinner*. Thread↔thread is safe (`ChatView` renders immediately from cached shell state), but `→settings` and `→workbench` need checking, and the rule is: animate `opacity`/`transform` only, never gate a loader on a transition.

#### E.4 Inventory — what each switch gets

| Switch | Treatment | Why |
|---|---|---|
| thread ↔ thread | 160–180ms crossfade of the pane only; sidebar and header held still (`view-transition-name` on the transcript region, or a type that suppresses root) | the highest-frequency navigation in the app; anything longer becomes friction, and moving the sidebar on every click is nauseating |
| draft → thread | **unchanged** — `draftHeroTransition.ts` already owns this and is tuned | don't relitigate a shipped, tested transition |
| thread → settings | 200ms crossfade + 4px upward drift on the settings pane | a modal-ish context change; deserves to feel like a different room |
| settings → back | reverse, same duration | |
| thread → workbench | 200ms crossfade | F14 is rewriting this route into the star map — coordinate, and let F14 own any bespoke map entrance |
| any `replace: true` correction | **none** (§E.2 opt-outs) | a redirect that animates reads as a bug |
| list item enter/exit | **out of scope in v1** | sidebar rows are the densest surface in the app and F9 just simplified them; per-row motion is where this turns into a toy |

Duration vocabulary: reuse `DRAFT_HERO_TRANSITION_DURATION_MS = 180` and `DRAFT_HERO_TRANSITION_EASING = cubic-bezier(0.4, 0, 0.2, 1)` (`draftHeroTransition.ts:1-5`) rather than inventing new numbers.

**All new VT CSS goes in `starcode-theme.css` (8 touches), not `index.css` (53 touches, current fork diff: zero).**

---

### F. Reduced-motion — full matrix

| Effect | Under `prefers-reduced-motion: reduce` |
|---|---|
| Continuous sky layer | **unaffected** — it is a static gradient; nothing about it moves |
| Panel tint / glass | **unaffected** — not motion |
| F13 star drift + twinkle | unchanged from F13 (`animation: none`, layers held at `--sc-twinkle-mid`) |
| Gradient-mesh blobs (`drift`) | `animation: none`, blobs parked at median position/opacity → a static soft colour field. Colour survives, motion does not |
| Turbulence mask | static already; **unaffected** |
| WebGL (`shader`) | **one frame rendered, loop never started.** Not "slower" — a still image |
| Navigation warp | **none.** Checked at start *and* on the media query's `change` event so an OS toggle takes effect without reload |
| Route view transitions | **none** — `defaultViewTransition`'s `types` function returns `false` when the query matches. Navigation still works, instantly |
| Composer/dropdown blur | **unaffected** |

Belt-and-braces, per the doctrine at `ThreadTaskProgress.tsx:30-33`: CSS `motion-reduce:` / media queries **and** a JS gate, so animated elements aren't merely frozen but unrendered where that is cheaper.

---

### G. Phasing — five commits, smallest first

| Phase | Content | Cheap? | Estimate |
|---|---|---|---|
| **1 — One sky** | Portalled `starcode-sky` layer; delete paint sites ①–⑥ and the uncover rule; L1 tint tokens; `useTheme.ts:156` repoint; **contrast-gate extension run first**; re-host F13's drift onto the new layer | ✅ cheap, high value | ~1 agent session |
| **2 — Route transitions** | `defaultViewTransition` + `types` function in `router.ts`; the sky's `view-transition-name` exclusion; opt-out list; per-pair CSS in `starcode-theme.css` | ✅ cheapest win in the round | ~half session |
| **3 — Morphing mesh** | Mesh blobs + baked turbulence mask + generator script; `backgroundEffects` setting (contracts + BetaSettingsPanel); `data-sc-effects` attribute | ✅ cheap | ~1 session |
| **4 — Navigation warp** | `data-sc-warp` + CSS; shared `usePrefersReducedMotion` lifted out of `ThreadTaskProgress` | ✅ cheap | ~half session |
| **5 — WebGL tier** | Canvas + GLSL, 24fps gate, visibility/context-loss handling, static fallback, `powermetrics` acceptance run | ❌ **the expensive tail** | ~1.5–2 sessions |

**Phases 1, 2 and 4 are each independently shippable and screenshot-reviewable.** Phase 3 introduces the setting that phase 5 needs, so phase 5 can be cut entirely without stranding anything.

**Phase 5 is gated on Michael reviewing phase 3's screenshots** (§I.1). Building it before he has seen the CSS tier is how this round becomes a two-week round.

Evidence per phase: dark + light × four `?sky=` phases; for phase 1, an explicit sidebar↔pane seam close-up (that is the whole point); for phase 2, the Animations panel confirming every transition is composited and `sc-sky` is excluded; for phase 3, the same viewport at t=0 / t=45s / t=120s; for phase 4, `data-sc-warp` held via a debug flag, since a 320ms event cannot be screenshotted otherwise — the same problem F13 solved with `?sky=night,shoot-hold`. **There is no headless screenshot harness in this repo** (the only one is `scripts/mobile-showcase.ts`, iOS/Android device automation); evidence has been agent-driven all along, and that stays true here.

---

### H. Collisions and fork hygiene

- **🔴 F13 phase A, uncommitted in the main clone right now** (`starcode-theme.css` §8/§9, `CelestialArt.tsx`, untracked `derive-starcode-star-layers.mjs`). F17 phase 1 **relocates the surfaces F13 animates** — specifically `.dark [data-slot="sidebar-inset"]::before` (F13's 900s drift at `:1048`) and the sidebar chrome starfield. F17 does not start until F13 phase A merges into `hub`, and phase 1 must **re-host F13's drift rules onto the sky layer** rather than delete or duplicate them. Author against F13's *rule* ("three layers, drift + twinkle, `--sc-twinkle-mid`"), not its selectors. This is F13's own §F.6 discipline, applied back to F13.
- **F14 (star map, worktree `t3code-f14`)** — owns `_chat.workbench` and `workbench/*`. F17 touches none of it; the workbench inherits the sky by being transparent, which is strictly better for a star map. Coordinate only on §E.4's `→workbench` transition: if F14 wants a bespoke entrance, F14 owns it.
- **F15 (split view, planned)** — F17 phase 1 **removes work from F15** (§B.6). Land phase 1 first. F15's rule "must not write into `starcode-theme.css`" stays correct and gets easier.
- **File budget**: `starcode-theme.css` (fork-owned, 8 touches) takes essentially all the CSS. `router.ts` (5 touches) takes one line. `__root.tsx` takes the portal mount + effects-sync, beside the existing `GlassAppearanceSync` — the same slot F12 used for `ImportConversationDialog`. `packages/contracts/src/settings.ts` (45 touches) takes 2 additive lines in alphabetically-sorted structs. **`index.css`: zero — the fork's diff there is currently zero and stays zero.** **`ChatView.tsx`: zero.** **`SidebarV2.tsx`: zero.**
- **No new dependency.** F11's `@fontsource-variable/baloo-2` is why `vp i` is now a mandatory rollout step on all four machines (PLAN.md, Standing rollout pipeline); F17 must not add a second such trap. Raw WebGL if phase 5 happens — no three.js, no helper over 5KB.
- **Rollout**: normal wave — Mac launchd hub, three remote servers, plus a desktop rebuild (client-side change). The signing identity is stable now, so the keychain trap should not recur; confirm on this rebuild.

---

### I. Open questions for Michael (4)

1. **Do we build the WebGL tier at all?** Recommendation: **ship phase 3 (CSS mesh + baked turbulence), look at it, then decide.** My honest estimate is that it lands ~75–80% of the "morphing shader" look for ~15% of the cost and ~0 battery risk; the missing 20% is per-pixel refraction and evolving noise. Phase 5 is ~1.5–2 sessions and an opt-in setting nobody may turn on. Cut it, or keep it queued behind a screenshot review?
2. **The star on navigation — whole-sky warp or a literal streak?** Recommendation: **warp** (§D.2b) — it reads as travel rather than as an object, costs ~55 lines, is interruptible for free, and is distinct from F13's rare shooting star. A literal streak matches your words more exactly but fires ~200×/day, which retires the shooting star's rarity — the one thing F13's doctrine says is the whole product. Your call on which reading wins.
3. **How far does the sky come into the sidebar?** Phase 1 makes the sidebar a tinted plate over the sky — the seam dies either way. The open question is *depth*: a fairly opaque plate (sky visible as a wash) versus genuinely translucent (stars visible behind the thread list you scan all day). The contrast gate will hold AA either way; this is taste, and it is the single most visible decision in the round. Recommendation: **ship phase 1 at two tint values and pick from screenshots.**
4. **Thread↔thread transition scope.** Recommendation: **crossfade the thread pane only, hold the sidebar and header still** — the sidebar moving on every click gets old within an hour. The alternative (whole-window crossfade) is more cinematic and one line simpler. Which?
