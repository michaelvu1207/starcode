import type { ExecutionEnvironmentDescriptor, ThreadId } from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * The credential-free portion of an environment descriptor that is useful to
 * a provider session. Reachability and authentication stay server concerns;
 * agents only need stable node identity and a human-readable label.
 */
export type FleetSessionBootstrapNode = Pick<
  ExecutionEnvironmentDescriptor,
  "environmentId" | "label"
>;

export interface FleetSessionBootstrapSnapshot {
  readonly localNode: FleetSessionBootstrapNode;
  readonly reachableNodes: ReadonlyArray<FleetSessionBootstrapNode>;
  readonly thread: {
    readonly threadId: ThreadId;
    readonly title?: string;
  };
  readonly project?: {
    readonly slug?: string;
    readonly title: string;
    readonly notes?: string;
  };
  readonly orchestrator: {
    readonly role: "fleet" | "project" | "worker";
    readonly designatedThreadId?: ThreadId;
  };
}

export interface FleetSessionBootstrapSnapshotInput {
  readonly threadId: ThreadId;
}

/**
 * Captures the current fleet view for one provider session.
 *
 * The provider is deliberately injected instead of importing the fleet
 * registry here. That keeps provider adapters independent of fleet storage
 * while allowing the server composition root to bind its authoritative
 * registry snapshot.
 */
export type FleetSessionBootstrapSnapshotProvider = (
  input: FleetSessionBootstrapSnapshotInput,
) => Effect.Effect<FleetSessionBootstrapSnapshot | undefined>;

export class FleetSessionBootstrap extends Context.Service<
  FleetSessionBootstrap,
  {
    readonly snapshot: FleetSessionBootstrapSnapshotProvider;
  }
>()("starcode/provider/FleetSessionBootstrap") {}

function redactSensitiveText(value: string): string {
  return value
    .replaceAll(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
      "[REDACTED PRIVATE KEY]",
    )
    .replaceAll(/\bBearer\s+[^\s<]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(api[-_ ]?key|token|password|secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`,
    )
    .replaceAll(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/giu, "$1[REDACTED]@")
    .replaceAll(/\b(?:github_pat|ghp|sk)-[a-z0-9_-]{12,}\b/giu, "[REDACTED TOKEN]");
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function oneLine(value: string): string {
  let withoutControls = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    withoutControls += codePoint <= 31 || codePoint === 127 ? " " : character;
  }
  return withoutControls.replaceAll(/\s+/gu, " ").trim();
}

function multiline(value: string): string {
  let withoutControls = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    withoutControls +=
      (codePoint <= 31 && character !== "\n" && character !== "\t") || codePoint === 127
        ? " "
        : character;
  }
  return withoutControls.trim();
}

function renderNode(node: FleetSessionBootstrapNode): string {
  return `${escapeXmlText(oneLine(redactSensitiveText(node.label)))} (${escapeXmlText(oneLine(node.environmentId))})`;
}

function renderOrchestratorStatus(
  orchestrator: FleetSessionBootstrapSnapshot["orchestrator"],
): string {
  switch (orchestrator.role) {
    case "fleet":
      return "This thread is the fleet orchestrator.";
    case "project":
      return "This thread is its project's orchestrator.";
    case "worker":
      return orchestrator.designatedThreadId
        ? `This thread is a worker. Its designated orchestrator is ${escapeXmlText(oneLine(orchestrator.designatedThreadId))}.`
        : "This thread is a worker. No orchestrator is currently designated for its project or fleet.";
  }
}

export function buildFleetSessionBootstrapInstructions(
  snapshot: FleetSessionBootstrapSnapshot,
): string {
  const localEnvironmentId = snapshot.localNode.environmentId;
  const nodesByEnvironmentId = new Map<string, FleetSessionBootstrapNode>();
  for (const node of snapshot.reachableNodes) {
    if (
      node.environmentId !== localEnvironmentId &&
      !nodesByEnvironmentId.has(node.environmentId)
    ) {
      nodesByEnvironmentId.set(node.environmentId, node);
    }
  }
  const reachableNodes = [...nodesByEnvironmentId.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );

  const renderedReachableNodes =
    reachableNodes.length === 0
      ? "- none"
      : reachableNodes.map((node) => `- ${renderNode(node)}`).join("\n");
  const threadTitle = snapshot.thread.title
    ? escapeXmlText(oneLine(redactSensitiveText(snapshot.thread.title)))
    : "(title unavailable)";
  const project = snapshot.project;
  const renderedProject =
    project === undefined
      ? "unfiled"
      : `${escapeXmlText(oneLine(redactSensitiveText(project.title)))}${
          project.slug ? ` (${escapeXmlText(oneLine(project.slug))})` : ""
        }`;
  const projectNotes = project?.notes
    ? escapeXmlText(multiline(redactSensitiveText(project.notes)))
    : "(none)";

  return `<starcode_fleet>
StarCode presents all reachable machines as one fleet. This session started on ${renderNode(snapshot.localNode)}.

Current thread: ${threadTitle} (${escapeXmlText(oneLine(snapshot.thread.threadId))})
Current node: ${renderNode(snapshot.localNode)}
Current project: ${renderedProject}
Project notes:
<project_notes>
${projectNotes}
</project_notes>
Orchestrator status: ${renderOrchestratorStatus(snapshot.orchestrator)}

Reachable nodes at session start:
${renderedReachableNodes}

Use the unified thread tools for fleet work:
- \`threads_list\` discovers threads across every reachable node.
- \`thread_read\` reads an existing thread by thread id.
- \`thread_send\` sends a message to an existing thread by thread id.
- \`thread_create\` creates a thread; placement is only relevant for a new thread.

Existing thread ids are globally routable. Never ask the user which machine owns an existing thread, and never require a node name for \`thread_read\` or \`thread_send\`; StarCode resolves the owner.
</starcode_fleet>`;
}

/**
 * Best-effort bootstrap resolution must never make provider startup depend on
 * fleet discovery. Failures are logged without their cause because registry
 * errors can carry request details that should not enter logs.
 */
export function resolveFleetSessionBootstrapInstructions(
  provider: FleetSessionBootstrapSnapshotProvider | undefined,
  input: FleetSessionBootstrapSnapshotInput,
): Effect.Effect<string | undefined> {
  if (!provider) {
    return Effect.sync((): string | undefined => undefined);
  }

  return Effect.suspend(() => provider(input)).pipe(
    Effect.map((snapshot) =>
      snapshot === undefined ? undefined : buildFleetSessionBootstrapInstructions(snapshot),
    ),
    Effect.catchCause(() =>
      Effect.logWarning("fleet session bootstrap snapshot unavailable").pipe(Effect.as(undefined)),
    ),
  );
}
