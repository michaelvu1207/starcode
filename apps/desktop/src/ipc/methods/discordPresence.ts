import { DiscordPresenceStateSchema, DiscordPresenceSummarySchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDiscordPresence from "../../presence/DesktopDiscordPresence.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getDiscordPresenceState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCORD_PRESENCE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DiscordPresenceStateSchema,
  handler: Effect.fn("desktop.ipc.discordPresence.getState")(function* () {
    const presence = yield* DesktopDiscordPresence.DesktopDiscordPresence;
    return yield* presence.getState;
  }),
});

export const setDiscordPresenceEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCORD_PRESENCE_SET_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DiscordPresenceStateSchema,
  handler: Effect.fn("desktop.ipc.discordPresence.setEnabled")(function* (enabled) {
    const presence = yield* DesktopDiscordPresence.DesktopDiscordPresence;
    return yield* presence.setEnabled(enabled);
  }),
});

export const setDiscordPresenceSummary = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCORD_PRESENCE_SET_SUMMARY_CHANNEL,
  payload: DiscordPresenceSummarySchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.discordPresence.setSummary")(function* (summary) {
    const presence = yield* DesktopDiscordPresence.DesktopDiscordPresence;
    yield* presence.setSummary(summary);
  }),
});
