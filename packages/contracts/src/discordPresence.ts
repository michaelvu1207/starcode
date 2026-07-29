import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";

/**
 * Discord rich presence for the desktop app.
 *
 * The renderer is the only side that knows what every connected environment is
 * doing — the main process holds backends, not thread state — so the summary is
 * computed there and pushed down. Deliberately counts-only: a Discord presence
 * is visible to every member of every server you are in, so project names,
 * thread titles, branches and machine names never cross this boundary. Widening
 * it later means widening this schema, which is the point of it being a schema.
 */
export const DiscordPresenceSummarySchema = Schema.Struct({
  /** Threads whose latest turn is still running, across every connection. */
  runningThreadCount: NonNegativeInt,
  /** Threads blocked on a person: pending approval, input, or a proposed plan. */
  attentionThreadCount: NonNegativeInt,
  /** Connections currently reachable. */
  connectedEnvironmentCount: NonNegativeInt,
  /**
   * When the oldest still-running turn started, which Discord renders as an
   * "elapsed" timer. Null whenever nothing is running, so the timer resets on
   * the next batch of work rather than counting since the app launched.
   */
  runningSince: Schema.NullOr(IsoDateTime),
});
export type DiscordPresenceSummary = typeof DiscordPresenceSummarySchema.Type;

export const EMPTY_DISCORD_PRESENCE_SUMMARY: DiscordPresenceSummary = {
  runningThreadCount: 0,
  attentionThreadCount: 0,
  connectedEnvironmentCount: 0,
  runningSince: null,
};

/**
 * - `disabled`       the user has the setting off.
 * - `unconfigured`   no Discord application id is compiled in or configured.
 * - `waiting`        enabled, but no local Discord client answered the IPC
 *                    socket yet. This is the normal state when Discord is not
 *                    running, and it resolves on its own once it is.
 * - `connected`      handshake completed; presence is live.
 */
export const DiscordPresenceStatusSchema = Schema.Literals([
  "disabled",
  "unconfigured",
  "waiting",
  "connected",
]);
export type DiscordPresenceStatus = typeof DiscordPresenceStatusSchema.Type;

export const DiscordPresenceStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  status: DiscordPresenceStatusSchema,
  /** The Discord account presence is being published to, once known. */
  accountName: Schema.NullOr(Schema.String),
  /** Human-readable reason for the current status; surfaced in settings. */
  detail: Schema.NullOr(Schema.String),
});
export type DiscordPresenceState = typeof DiscordPresenceStateSchema.Type;
