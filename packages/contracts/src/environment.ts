import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

/** How a server can replace itself with another version when asked over RPC:
    "boot-service" rewrites the systemd user unit and restarts it; "respawn"
    installs the target version and respawns the foreground process. */
export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

/** What update path a client should offer for a server: one of the RPC
    self-update methods above, or "desktop-managed" when the backend's
    version belongs to the T3 Code desktop app supervising it — updating the
    app on that machine is the only way to update the server. */
export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.settle / thread.unsettle commands. Absent on
      pre-settlement servers, so clients treat missing as unsupported and
      never send the commands under version skew. */
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.snooze / thread.unsnooze commands. Same
      version-skew contract as threadSettlement. */
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** The update path clients should offer for this server. Absent on
      servers that must be relaunched manually (dev checkouts, Windows
      foreground runs, pre-update servers). */
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Server serves `/api/peers*` and exposes the peer_threads_* MCP tools, so
      it can be registered as a federation peer and can register others. Absent
      on upstream servers, which is exactly the version-skew contract the
      settlement/snooze capabilities use: missing means unsupported. */
  peerFederation: Schema.optionalKey(Schema.Boolean),
  /**
   * Server accepts operate-class peer registrations and serves the routes
   * behind `peer_thread_send` / `peer_thread_create` / `peer_thread_dispatch`.
   * Absent means the server can still be read as a peer but cannot be operated
   * on, so a client must not offer to register it as an operator peer.
   */
  peerOrchestration: Schema.optionalKey(Schema.Boolean),
  /**
   * Server serves `/api/threads/:threadId/mailbox` and injects undelivered
   * mailbox entries at turn start. Absent means messages sent to this server's
   * threads would be accepted nowhere, so senders must not try.
   */
  threadMailbox: Schema.optionalKey(Schema.Boolean),
  /** Server serves `/api/feature-flow`. */
  featureFlow: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const EnvironmentConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type EnvironmentConnectionState = typeof EnvironmentConnectionState.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;

export const ScopedThreadSessionRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadSessionRef = typeof ScopedThreadSessionRef.Type;
