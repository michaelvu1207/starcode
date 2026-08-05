/**
 * activityPhrasing - How a tool call is described in a transcript.
 *
 * One vocabulary, shared by web and mobile, so the two surfaces cannot drift
 * into describing the same event differently. The wording follows Codex's own
 * catalog: every activity has a present-participle form while it runs and a
 * past-tense form once it settles, and a run of them collapses into a single
 * pluralized summary.
 *
 * Nothing here touches rendering. Callers get strings and decide how to draw
 * them, which is what lets React and React Native share the module.
 *
 * @module activityPhrasing
 */

/** Whether the activity is still running or has settled. */
export type ActivityPhase = "running" | "settled";

/**
 * The kinds of work a transcript describes.
 *
 * Deliberately coarser than the provider's item types: `Read`, `Listed` and
 * `Searched` are three different tool calls but one idea to a reader, and
 * grouping them is what makes "Explored 12 files" possible.
 */
export type ActivityKind =
  | "command"
  | "fileCreate"
  | "fileEdit"
  | "fileDelete"
  | "fileRead"
  | "skillRead"
  | "listFiles"
  | "search"
  | "webSearch"
  | "mcpTool"
  | "reasoning"
  | "approval"
  | "other";

export interface ActivityPhrase {
  /** Leading word(s) — "Ran", "Reading". Rendered with emphasis. */
  readonly verb: string;
  /** What the verb acted on — a command, a path, a query. May be absent. */
  readonly target?: string;
}

export interface ActivityPhraseInput {
  readonly kind: ActivityKind;
  readonly phase: ActivityPhase;
  /** Command text, file path, query — whatever the verb acted on. */
  readonly target?: string | undefined;
  /**
   * Human-readable elapsed time ("1m 4s"). When present on a settled command
   * the phrase becomes "Ran {target} in {elapsed}", matching Codex.
   */
  readonly elapsed?: string | undefined;
  /** True when the activity was interrupted rather than completing. */
  readonly stopped?: boolean | undefined;
}

const VERBS: Record<ActivityKind, { running: string; settled: string }> = {
  command: { running: "Running", settled: "Ran" },
  fileCreate: { running: "Creating", settled: "Created" },
  fileEdit: { running: "Editing", settled: "Edited" },
  fileDelete: { running: "Deleting", settled: "Deleted" },
  fileRead: { running: "Reading", settled: "Read" },
  skillRead: { running: "Reading", settled: "Read" },
  listFiles: { running: "Listing", settled: "Listed" },
  search: { running: "Searching", settled: "Searched" },
  webSearch: { running: "Searching the web", settled: "Searched the web" },
  mcpTool: { running: "Running", settled: "Ran" },
  reasoning: { running: "Thinking", settled: "Thought" },
  approval: { running: "Waiting for approval", settled: "Approved" },
  other: { running: "Working", settled: "Done" },
};

/**
 * Describe a single activity.
 *
 * The generic verbs matter: with no target, "Running command" reads as a
 * sentence where a bare "Running" would read as a truncation bug.
 */
export function activityPhrase(input: ActivityPhraseInput): ActivityPhrase {
  const target = input.target?.trim() || undefined;
  const verbs = VERBS[input.kind];
  const base = input.phase === "running" ? verbs.running : verbs.settled;

  if (input.kind === "reasoning") {
    return { verb: verbs.running };
  }

  if (input.kind === "command") {
    if (input.stopped) {
      const subject = target ?? "command";
      return {
        verb: "Stopped",
        target: input.elapsed ? `${subject} after ${input.elapsed}` : subject,
      };
    }
    if (!target) {
      return {
        verb: base,
        target: input.elapsed ? `command for ${input.elapsed}` : "command",
      };
    }
    return {
      verb: base,
      target: input.phase === "settled" && input.elapsed ? `${target} in ${input.elapsed}` : target,
    };
  }

  if (input.kind === "webSearch") {
    return { verb: base, ...(target ? { target: `for ${target}` } : {}) };
  }

  if (input.kind === "search") {
    return { verb: base, target: target ? `for ${target}` : "files" };
  }

  if (input.kind === "listFiles") {
    return { verb: base, target: target ? `files in ${target}` : "files" };
  }

  if (input.kind === "skillRead") {
    return { verb: base, ...(target ? { target: `${target} skill` } : {}) };
  }

  return { verb: base, ...(target ? { target } : {}) };
}

/** Render a phrase as one string, for surfaces that cannot style parts. */
export function formatActivityPhrase(phrase: ActivityPhrase): string {
  return phrase.target ? `${phrase.verb} ${phrase.target}` : phrase.verb;
}

/**
 * Which activities fold together under one summary line.
 *
 * Reads, listings and searches are all "looking around" and collapse into
 * Codex's Exploring/Explored accordion; the rest stay distinct because
 * "Ran 3 commands" and "Edited 2 files" answer different questions.
 */
type SummaryBucket = "commands" | "edits" | "creates" | "deletes" | "exploration" | "web" | "tools";

const BUCKETS: Record<ActivityKind, SummaryBucket | undefined> = {
  command: "commands",
  fileCreate: "creates",
  fileEdit: "edits",
  fileDelete: "deletes",
  fileRead: "exploration",
  skillRead: "exploration",
  listFiles: "exploration",
  search: "exploration",
  webSearch: "web",
  mcpTool: "tools",
  reasoning: undefined,
  approval: undefined,
  other: undefined,
};

const BUCKET_NOUNS: Record<
  SummaryBucket,
  { running: string; settled: string; one: string; many: string }
> = {
  commands: { running: "Running", settled: "Ran", one: "a command", many: "commands" },
  edits: { running: "Editing", settled: "Edited", one: "a file", many: "files" },
  creates: { running: "Creating", settled: "Created", one: "a file", many: "files" },
  deletes: { running: "Deleting", settled: "Deleted", one: "a file", many: "files" },
  exploration: { running: "Reading", settled: "Read", one: "a file", many: "files" },
  web: { running: "Searching the web", settled: "Searched the web", one: "", many: "" },
  tools: { running: "Calling", settled: "Called", one: "a tool", many: "tools" },
};

export interface ActivityGroupMember {
  readonly kind: ActivityKind;
  readonly phase: ActivityPhase;
}

export interface ActivityGroupSummaryInput {
  readonly members: ReadonlyArray<ActivityGroupMember>;
  /** Total added/removed lines across the run, when the run edited files. */
  readonly changedLines?: number | undefined;
}

/** Separator between verb phrases: "Read files, ran commands". */
const PHRASE_JOINER = ", ";
/** Separator before a stat: "Edited 2 files • 36 lines". */
const STAT_JOINER = " • ";

function bucketPhrase(
  bucket: SummaryBucket,
  count: number,
  phase: ActivityPhase,
  leading: boolean,
): string {
  const noun = BUCKET_NOUNS[bucket];
  const verb = phase === "running" ? noun.running : noun.settled;
  const head = leading ? verb : verb.charAt(0).toLowerCase() + verb.slice(1);
  if (noun.many.length === 0) {
    return head;
  }
  const tail = count === 1 ? noun.one : `${count} ${noun.many}`;
  return `${head} ${tail}`;
}

/**
 * One line describing a run of consecutive activities.
 *
 * Buckets keep their first-seen order so the summary narrates the run in the
 * order it happened rather than in an arbitrary canonical order.
 */
export function summarizeActivityGroup(input: ActivityGroupSummaryInput): string {
  const counts = new Map<SummaryBucket, { count: number; running: number }>();
  for (const member of input.members) {
    const bucket = BUCKETS[member.kind];
    if (!bucket) {
      continue;
    }
    const existing = counts.get(bucket) ?? { count: 0, running: 0 };
    counts.set(bucket, {
      count: existing.count + 1,
      running: existing.running + (member.phase === "running" ? 1 : 0),
    });
  }

  if (counts.size === 0) {
    return input.members.some((member) => member.phase === "running") ? "Working" : "Work log";
  }

  const phrases: string[] = [];
  let index = 0;
  for (const [bucket, tally] of counts) {
    // A bucket reads as still running while any of its members is.
    const phase: ActivityPhase = tally.running > 0 ? "running" : "settled";
    phrases.push(bucketPhrase(bucket, tally.count, phase, index === 0));
    index += 1;
  }

  const summary = phrases.join(PHRASE_JOINER);
  if (input.changedLines !== undefined && input.changedLines > 0) {
    const lines = input.changedLines === 1 ? "1 line" : `${input.changedLines} lines`;
    return `${summary}${STAT_JOINER}${lines}`;
  }
  return summary;
}

/**
 * Map a provider item type (plus request kind) onto an {@link ActivityKind}.
 *
 * Kept here rather than in the client so web and mobile classify identically;
 * a mismatch would show up as the two surfaces bucketing the same run
 * differently, which is exactly the drift this module exists to prevent.
 */
export function activityKindFromItemType(input: {
  readonly itemType?: string | undefined;
  readonly requestKind?: string | undefined;
  readonly isApproval?: boolean | undefined;
  readonly changeKind?: "create" | "edit" | "delete" | undefined;
  readonly hasCommand?: boolean | undefined;
  readonly hasChangedFiles?: boolean | undefined;
}): ActivityKind {
  if (input.isApproval) return "approval";
  if (input.requestKind === "command") return "command";
  if (input.requestKind === "file-read") return "fileRead";
  if (input.requestKind === "file-change") return "fileEdit";

  switch (input.itemType) {
    case "command_execution":
      return "command";
    case "file_read":
      return "fileRead";
    case "file_change":
      return input.changeKind === "create"
        ? "fileCreate"
        : input.changeKind === "delete"
          ? "fileDelete"
          : "fileEdit";
    case "web_search":
      return "webSearch";
    case "image_view":
      return "fileRead";
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return "mcpTool";
    case "reasoning":
      return "reasoning";
    default:
      break;
  }

  if (input.hasCommand) return "command";
  if (input.hasChangedFiles) return "fileEdit";
  return "other";
}

/** Compact elapsed label — "8s", "1m 4s", "1h 2m". */
export function formatElapsed(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return undefined;
  }
  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds < 1) {
    return undefined;
  }
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
}
