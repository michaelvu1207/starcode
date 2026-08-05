import {
  EMPTY_DISCORD_PRESENCE_SUMMARY,
  type DiscordPresenceState,
  type DiscordPresenceSummary,
} from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { discordActivityEquals, renderDiscordActivity } from "./discordActivity.ts";
import type { DiscordActivity } from "./discordActivity.ts";
import { discordIpcSocketPaths } from "./discordIpcProtocol.ts";
import { connectDiscordRpc, type DiscordRpcConnection } from "./discordRpcConnection.ts";

/**
 * The fork's own Discord application id, if one has been registered and baked
 * in. Empty by default: presence publishes under whatever application the id
 * names, so an inherited id would put someone else's name and artwork on your
 * status. `STARCODE_DISCORD_APP_ID` overrides it without a rebuild.
 *
 * See docs/fork/DISCORD-PRESENCE.md for the five-minute portal setup.
 */
export const BUNDLED_DISCORD_APPLICATION_ID = "";

/**
 * How often the loop wakes.
 *
 * Discord rate-limits SET_ACTIVITY to roughly five updates per twenty seconds
 * and silently drops the excess, so the tick is the rate limiter: at most one
 * update per tick, and the renderer can push summaries as fast as it likes.
 */
const PRESENCE_TICK_INTERVAL = "4 seconds";

/**
 * Ticks to wait before retrying a failed connect. Discord not running is the
 * common case, not an error, and probing forty socket paths every four seconds
 * forever to discover that would be rude to a machine that is also running
 * agents.
 */
const RECONNECT_TICK_INTERVAL = 4;

const { logInfo, logDebug, logWarning } = DesktopObservability.makeComponentLogger(
  "desktop-discord-presence",
);

const DISABLED_STATE: DiscordPresenceState = {
  enabled: false,
  status: "disabled",
  accountName: null,
  detail: null,
};

const UNCONFIGURED_STATE: DiscordPresenceState = {
  enabled: true,
  status: "unconfigured",
  accountName: null,
  detail: "Set STARCODE_DISCORD_APP_ID to a Discord application id to publish presence.",
};

/**
 * Anything the local Discord client did that we could not complete.
 *
 * One error for connect and for writing an activity because the loop treats
 * them identically — drop the session, try again on a later tick — and a
 * finer taxonomy would only be read by the code that ignores it.
 */
export class DiscordRpcUnavailableError extends Schema.TaggedErrorClass<DiscordRpcUnavailableError>()(
  "DiscordRpcUnavailableError",
  {
    operation: Schema.Literals(["connect", "set-activity", "clear-activity"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The Discord RPC ${this.operation} call failed.`;
  }
}

export class DesktopDiscordPresence extends Context.Service<
  DesktopDiscordPresence,
  {
    readonly getState: Effect.Effect<DiscordPresenceState>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DiscordPresenceState, DesktopAppSettings.DesktopSettingsWriteError>;
    /** Record the renderer's latest counts. Publishing happens on the next tick. */
    readonly setSummary: (summary: DiscordPresenceSummary) => Effect.Effect<void>;
    /** The publish loop. Never returns; fork it once at bootstrap. */
    readonly run: Effect.Effect<never>;
  }
>()("@starcode/desktop/presence/DesktopDiscordPresence") {}

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;

  const applicationId = Option.getOrElse(
    config.discordApplicationId,
    () => BUNDLED_DISCORD_APPLICATION_ID,
  ).trim();

  const summaryRef = yield* Ref.make<DiscordPresenceSummary>(EMPTY_DISCORD_PRESENCE_SUMMARY);
  const stateRef = yield* Ref.make<DiscordPresenceState>(DISABLED_STATE);
  // Not in a Ref: these are the loop fiber's own working state, touched from
  // nowhere else, and threading three Refs through a single-owner loop buys
  // nothing but noise.
  let connection: DiscordRpcConnection | null = null;
  let publishedActivity: DiscordActivity | null = null;
  let ticksUntilReconnect = 0;

  const setState = (next: DiscordPresenceState): Effect.Effect<void> =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((previous) =>
        previous.enabled === next.enabled &&
        previous.status === next.status &&
        previous.accountName === next.accountName &&
        previous.detail === next.detail
          ? Effect.void
          : Ref.set(stateRef, next).pipe(
              Effect.andThen(
                electronWindow.sendAll(IpcChannels.DISCORD_PRESENCE_STATE_CHANNEL, next),
              ),
            ),
      ),
    );

  const dropConnection = Effect.sync(() => {
    connection?.close();
    connection = null;
    publishedActivity = null;
  });

  /**
   * Try every candidate socket in order until one completes a handshake.
   *
   * A refused or missing socket is the expected answer for all but one of them,
   * so failures are collected rather than logged: only the case where every
   * path fails is worth telling the user about, and only as "Discord isn't
   * running", which is what it almost always means.
   */
  const connect = Effect.gen(function* () {
    const paths = discordIpcSocketPaths({ platform: environment.platform, env: process.env });
    for (const socketPath of paths) {
      const attempt = yield* Effect.tryPromise({
        try: () =>
          connectDiscordRpc({
            socketPath,
            clientId: applicationId,
            processId: process.pid,
          }),
        catch: (cause) => new DiscordRpcUnavailableError({ operation: "connect", cause }),
      }).pipe(Effect.option);

      if (Option.isSome(attempt)) {
        yield* logInfo("connected to discord", {
          socketPath,
          account: attempt.value.accountName ?? "unknown",
        });
        return attempt.value;
      }
    }
    return null;
  });

  const publish = (activity: DiscordActivity, live: DiscordRpcConnection) =>
    Effect.tryPromise({
      try: () => live.setActivity(activity),
      catch: (cause) => new DiscordRpcUnavailableError({ operation: "set-activity", cause }),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          publishedActivity = activity;
        }),
      ),
      Effect.catchCause((cause) =>
        // A write that fails means the session is gone (Discord quit mid-tick).
        // Drop it and let the next tick reconnect rather than treating it as a
        // user-visible error.
        dropConnection.pipe(
          Effect.andThen(logDebug("discord activity write failed", { cause: String(cause) })),
        ),
      ),
    );

  const tick = Effect.gen(function* () {
    const settings = yield* desktopSettings.get;

    if (!settings.discordPresenceEnabled) {
      if (connection !== null) {
        // Clear the presence on the way out so turning the setting off takes
        // effect immediately instead of leaving a stale status up until Discord
        // notices the socket closed.
        yield* Effect.tryPromise({
          try: () => connection?.setActivity(null) ?? Promise.resolve(),
          catch: (cause) => new DiscordRpcUnavailableError({ operation: "clear-activity", cause }),
        }).pipe(Effect.ignore);
        yield* dropConnection;
      }
      return yield* setState(DISABLED_STATE);
    }

    if (applicationId.length === 0) {
      return yield* setState(UNCONFIGURED_STATE);
    }

    if (connection !== null && !connection.isOpen()) {
      yield* dropConnection;
    }

    if (connection === null) {
      if (ticksUntilReconnect > 0) {
        ticksUntilReconnect -= 1;
        return;
      }
      const established = yield* connect;
      if (established === null) {
        ticksUntilReconnect = RECONNECT_TICK_INTERVAL;
        return yield* setState({
          enabled: true,
          status: "waiting",
          accountName: null,
          detail: "Waiting for Discord. Presence appears once the Discord app is running.",
        });
      }
      connection = established;
      publishedActivity = null;
      yield* setState({
        enabled: true,
        status: "connected",
        accountName: established.accountName,
        detail: null,
      });
    }

    const live = connection;
    if (live === null) return;

    const activity = renderDiscordActivity(yield* Ref.get(summaryRef));
    if (publishedActivity !== null && discordActivityEquals(publishedActivity, activity)) {
      return;
    }
    yield* publish(activity, live);
  });

  const run = Effect.gen(function* () {
    while (true) {
      yield* tick.pipe(
        Effect.catchCause((cause) =>
          // The loop outliving any single tick is the whole point: a presence
          // that stops updating because of one bad socket read is worse than no
          // presence, and there is nothing here worth failing the app over.
          logWarning("discord presence tick failed", { cause: String(cause) }),
        ),
      );
      yield* Effect.sleep(PRESENCE_TICK_INTERVAL);
    }
  }) as Effect.Effect<never>;

  return DesktopDiscordPresence.of({
    getState: Ref.get(stateRef),
    setEnabled: (enabled) =>
      desktopSettings.setDiscordPresenceEnabled(enabled).pipe(
        Effect.andThen(Ref.get(stateRef)),
        // Report the state the user is heading toward, not the stale one: the
        // loop has not ticked yet, so `stateRef` still says "disabled" the
        // instant after a toggle on.
        Effect.map((state) =>
          enabled === state.enabled
            ? state
            : enabled
              ? { ...state, enabled: true, status: "waiting" as const, detail: null }
              : DISABLED_STATE,
        ),
      ),
    setSummary: (summary) => Ref.set(summaryRef, summary),
    run,
  });
});

export const layer = Layer.effect(DesktopDiscordPresence, make);
