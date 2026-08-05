import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelections,
  ThreadId,
} from "@starcode/contracts";

export type AttachedAgentStatus = "running" | "paused" | "completed" | "failed" | "stopped";

export interface AttachedAgentSnapshot {
  readonly agentRunId: string;
  readonly parentThreadId: ThreadId;
  readonly parentAgentRunId?: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model?: string;
  readonly options?: ProviderOptionSelections;
  readonly description: string;
  readonly status: AttachedAgentStatus;
  readonly result?: string;
  readonly error?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface SpawnAttachedAgentInput {
  readonly parentThreadId: ThreadId;
  readonly parentAgentRunId?: string;
  readonly cwd: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model?: string;
  readonly options?: ProviderOptionSelections;
  readonly prompt: string;
  readonly description: string;
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxChildren: number;
}

export interface AttachedAgentHostShape {
  readonly spawn: (input: SpawnAttachedAgentInput) => Promise<AttachedAgentSnapshot>;
  readonly sendMessage: (
    parentThreadId: ThreadId,
    agentRunId: string,
    message: string,
    senderAgentRunId?: string,
  ) => Promise<AttachedAgentSnapshot>;
  readonly wait: (
    parentThreadId: ThreadId,
    agentRunIds: ReadonlyArray<string> | undefined,
    timeoutMs: number | undefined,
  ) => Promise<ReadonlyArray<AttachedAgentSnapshot>>;
  readonly status: (
    parentThreadId: ThreadId,
    agentRunIds?: ReadonlyArray<string>,
  ) => ReadonlyArray<AttachedAgentSnapshot>;
  readonly cancel: (parentThreadId: ThreadId, agentRunId: string) => Promise<AttachedAgentSnapshot>;
  readonly interruptTurn: (
    parentThreadId: ThreadId,
    agentRunId: string,
  ) => Promise<AttachedAgentSnapshot>;
  readonly cancelParent: (parentThreadId: ThreadId) => Promise<void>;
}

export interface AttachedAgentRecoveryRuntime {
  readonly snapshot: AttachedAgentSnapshot;
  readonly driver: ProviderDriverKind;
  /** True only after the persisted provider session and continuation turn were restored. */
  readonly live: boolean;
}

export interface AttachedAgentStartupRecovery {
  readonly awaitCompletion: () => Promise<ReadonlyArray<AttachedAgentRecoveryRuntime>>;
}

let activeHost: AttachedAgentHostShape | undefined;
let activeStartupRecovery: AttachedAgentStartupRecovery | undefined;

export function setAttachedAgentHost(host: AttachedAgentHostShape | undefined): void {
  activeHost = host;
}

export function requireAttachedAgentHost(): AttachedAgentHostShape {
  if (!activeHost) throw new Error("Starcode attached-agent orchestration is not ready.");
  return activeHost;
}

export function setAttachedAgentStartupRecovery(
  recovery: AttachedAgentStartupRecovery | undefined,
): void {
  activeStartupRecovery = recovery;
}

export function readAttachedAgentStartupRecovery(): AttachedAgentStartupRecovery | undefined {
  return activeStartupRecovery;
}
