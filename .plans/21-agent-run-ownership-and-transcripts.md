# Agent-run ownership and transcript reconstruction

## Decision

Do not rebuild the current historical-subagent UI yet. The current implementation
mixes three different entities:

1. a background shell job or workflow step;
2. one logical provider agent run;
3. the messages and tool calls inside that agent run.

The sidebar must show one row per logical agent run owned by the selected parent
thread. Opening that row must render the native run history. A tool-launch
lifecycle is useful diagnostic metadata, but it is not an agent transcript.

## Evidence from the real task

The selected task is
`46b7f5da-e9fb-4658-91b9-83f446dd25fc` on `simforgelaptop`.

- It has 367 `task.started` activities.
- 363 are explicitly `taskType=local_bash`. They are background commands and
  workflow steps, not agents.
- Two are `taskType=local_agent`.
- Two are `taskType=codex_cli`.
- The current UI expands all 367 as “finished subagents.”
- Opening the sampled Claude and Codex rows shows four repeated lifecycle
  records for the launch tool. These are not the agents' internal transcripts.

The missing ownership is recoverable without guessing:

- Claude has exact files under the parent session:
  `.../<parent-session>/subagents/agent-<taskId>.jsonl`.
- Each adjacent Claude `.meta.json` names `agentType`, `description`,
  `toolUseId`, `spawnDepth`, and `model`.
- Both observed Codex CLI launches have exact rollout JSONL files whose
  session metadata matches the parent working directory and launch time, and
  whose opening prompt matches the launch command.
- Starcode currently fails to attach those native histories, leaving
  `historySessionId` null and falling back to the four launch-wrapper records.

## Model

Introduce a provider-neutral `AgentRun` read model:

```text
AgentRun
  environmentId
  parentThreadId
  provider
  agentRunId
  launchToolUseId
  taskType
  agentType
  model
  description
  status
  startedAt
  updatedAt
  historySessionId | null
  transcriptState: linked | pending | unavailable
```

The stable identity is
`(environmentId, parentThreadId, provider, agentRunId)`. The parent thread is
mandatory. `launchToolUseId` is a correlation key, not the run identity.
`historySessionId` points to an exact native history file after proof.

`agentRunId` is the provider lifecycle `taskId`. For Claude it is also the id
in `agent-<taskId>.jsonl`. For Codex CLI it is the synthetic
`codex-cli:<launchToolUseId>` task id established at launch; discovering the
native rollout UUID enriches that run and never changes its identity. Repeated
lifecycle events therefore upsert the same run, while a retry with a new launch
tool id is a new run.

Background jobs remain ordinary thread activities. They never become
`AgentRun` rows.

## Implementation phases

### 1. Stop misclassification

- Preserve provider `taskType` through ingestion and projection.
- Exclude `local_bash` and other non-agent task types from finished-agent
  history.
- Accept a row only with explicit agent evidence: an agent task type, a named
  subagent type, or an exact native-history link.
- Remove the current fallback that renders the launch tool's own lifecycle as
  an agent transcript.
- When a proven agent has no recoverable native history, show a small
  “Transcript unavailable” state and optionally a separate “Launch details”
  disclosure. Do not present wrapper events as the conversation.

### 2. Project one logical run

- Add a schema-only `AgentRun` contract and a server projection/query for agent
  runs owned by a thread.
- Upsert lifecycle changes into one row keyed by the stable identity.
- Keep status reconciliation provider-specific, but expose the same terminal
  states to clients.
- Prevent out-of-order lifecycle events from regressing a terminal status or
  moving `updatedAt` backwards.
- Return agent runs with the full selected-thread snapshot; do not derive them
  by folding arbitrary `task.*` activities in React.
- Add a migration/backfill that is deterministic and idempotent. It must never
  assign an agent to a thread unless both ownership proofs hold:
  - the native parent session is mapped to that Starcode thread; and
  - the launch `toolUseId` occurs in that thread's own activities.
  A parent-session match by itself is insufficient because imported or forked
  threads may share native session ancestry.
- Cascade/delete agent projections with their parent thread. A projection
  rebuild re-derives links from native evidence and produces the same ids.

### 3. Link Claude histories

- Extend the history index to recognize Claude's
  `<parent-session>/subagents/agent-<taskId>.jsonl` files and their meta files.
- Preserve the existing rule that subagent files do not appear as top-level
  history sessions. Add an indexed kind (`session | subagent`) so a subagent
  history can resolve by id without polluting ordinary history listings.
- Join with:
  - every native Claude session ever mapped to the parent thread, including
    resumes;
  - `taskId` from the file name;
  - `toolUseId` from the meta file and task lifecycle.
- Require the launch `toolUseId` in the selected thread even when the native
  session directory matches. Meta fields other than the filename `taskId` are
  nullable for older Claude versions; missing meta may make a run unavailable
  but must never cause a guessed cross-thread link.
- Derive `historySessionId` from the exact agent JSONL path.
- For live runs, continue ingesting child items stamped with
  `parentToolUseId`, but use the native file as the reconnect and historical
  source of truth.
- Define a stable cutover: live attributed items render until the native
  history contains the same terminal task boundary; then the client switches
  atomically to native history rather than merging the two sources.
- Parse the agent JSONL through the existing history timeline pipeline so the
  normal thread renderer displays reasoning, messages, tools, and results.

### 4. Link Codex CLI histories

- Fix detection and historical discovery using real command-shape fixtures,
  including:
  - setup commands before `cd`;
  - multiline Bash;
  - `nohup`;
  - redirects and a trailing background operator;
  - relative `-C .`;
  - long multiline prompts.
- Require the existing proof set: Codex exec origin, resolved cwd, bounded
  launch time, and matching opening prompt. Ambiguity remains unlinked.
- Normalize prompt matching only after deterministic shell unquoting. Heredoc,
  command substitution, or environment expansion that cannot be reconstructed
  remains unlinked.
- Exclude rollouts whose metadata identifies a nested subagent originator from
  parent-launch discovery.
- Bound filesystem work by rollout file mtime before opening candidates; do not
  turn ordinary thread snapshots into unbounded history scans.
- Persist a successful link on the `AgentRun` projection so every snapshot does
  not rescan the filesystem.
- Revalidate persisted `historySessionId` values through the history index.
  Deleted or moved files transition the run to `unavailable`; a path hash is
  never treated as proof that the file still exists.
- Attempt linking at launch, on terminal lifecycle events, and through bounded
  background retries. `pending` must resolve to `linked` or `unavailable`
  without requiring a server restart.
- Render the exact Codex rollout with the ordinary history timeline.
- Treat nested Codex multi-agent children as content owned by that rollout.
  They may receive an in-transcript disclosure later, but they must not be
  confused with separate parent-thread Bash steps.

### 5. Rebuild the UI on `AgentRun`

- Under only the selected parent task, show `View finished subagents` when it
  owns at least one terminal `AgentRun`.
- Expanding it renders one row per run, with provider, agent type, model,
  terminal status, and useful title.
- Selecting a linked run opens the normal read-only thread surface with no
  special top bar and no composer.
- A pending live link says that transcript discovery is in progress.
- An unavailable historical link explains that the native history file is
  gone; it does not show four wrapper events as a transcript.

### 6. Backfill and validate real data

- Reindex native histories read-only on startup or through an explicit,
  idempotent maintenance command.
- Run the real-data assertions against a read-only copy of the production
  database and provider histories before any desktop build.
- On the road-network task, assert:
  - 363 `local_bash` activities produce zero agent rows;
  - exactly two Claude and two Codex CLI runs are owned by the task;
  - the two Claude agent files link through their meta `toolUseId`;
  - the two Codex rollout files link through cwd/time/prompt proof;
  - opening every linked row renders the native history, not four wrapper
    records.
- Missing files remain unavailable rather than being guessed or attributed to
  another thread.

## End-to-end test

Create one disposable parent thread and run:

1. one ordinary background Bash job;
2. one Claude subagent that uses multiple tools;
3. two concurrent Codex CLI agents with distinct prompts, one using multiline
   setup plus `cd` and one using `-C .`;
4. one Codex CLI run that itself uses multi-agent mode.

Verify before and after server restart:

- the parent owns exactly the actual agent runs;
- the Bash job never appears as an agent;
- no other thread's runs appear;
- every linked agent opens a multi-item native transcript containing its
  prompt, tool calls, intermediate messages, and final response;
- duplicate lifecycle updates do not create duplicate rows;
- two concurrent runs cannot cross-link;
- two concurrent runs with identical prompt, cwd, and launch window remain
  unlinked rather than being assigned arbitrarily;
- nested Codex rollout metadata cannot be mistaken for the parent launch;
- terminal states settle correctly;
- deleting or hiding the native file produces “Transcript unavailable,” not a
  guessed transcript.

Add focused tests at the contract, history-index, provider adapter/discovery,
projection query, client state, and UI layers. Finish with an isolated web
verification and a real-data read-only verification before the single desktop
rebuild and connection rollout.

## Success criteria

- A sidebar “subagent” always means one real agent run.
- Every row is owned by exactly one parent thread.
- Background commands and workflow steps never appear as agents.
- A linked row renders the native run history.
- Wrapper lifecycle records are never presented as the transcript.
- Historical recovery is exact or unavailable; it is never heuristic.
- Restarting Starcode preserves the same rows, links, statuses, and transcripts.

## Rollout

Implement and verify all phases together, then perform one integrated desktop
build. Preserve the existing app data, install over the current Mac bundle with
a backup, and propagate the same deployment commit to every Starcode
connection. Do not deploy the current classification-only patch by itself.
