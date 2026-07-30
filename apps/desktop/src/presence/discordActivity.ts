import type { DiscordPresenceSummary } from "@starcode/contracts";

/**
 * The presence payload Discord renders under your name.
 *
 * Snake-cased because these keys go over the RPC socket verbatim; Discord
 * rejects the camelCase forms. `details` is the bold first line, `state` the
 * grey second one, and `timestamps.start` becomes a counting-up timer.
 */
export interface DiscordActivity {
  readonly details: string;
  readonly state: string;
  readonly timestamps?: { readonly start: number };
  readonly assets?: {
    readonly large_image?: string;
    readonly large_text?: string;
  };
}

/**
 * Asset keys as uploaded under the Discord application's Rich Presence art.
 * A key Discord doesn't know is not an error — the artwork is simply omitted —
 * so a fork that skips the upload step still gets working text presence.
 */
export const DISCORD_LARGE_IMAGE_KEY = "starcode";

const pluralize = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`;

/**
 * The second line: how many connections the counts are drawn from. Written so
 * it reads as a continuation of `details` when work is in flight ("3 agents
 * running" / "across 4 connections") and stands alone when idle.
 */
function connectionLine(connectedEnvironmentCount: number, joined: boolean): string {
  if (connectedEnvironmentCount === 0) {
    return "No connections";
  }
  const counted = pluralize(connectedEnvironmentCount, "connection", "connections");
  if (!joined) {
    return counted;
  }
  return connectedEnvironmentCount === 1 ? "on 1 connection" : `across ${counted}`;
}

/**
 * Render a summary as Discord presence.
 *
 * Counts only, by design — see the schema's note. Running work outranks work
 * that needs attention because the timer is the interesting part of the former,
 * and a thread waiting on you is usually one you already know about.
 */
export function renderDiscordActivity(summary: DiscordPresenceSummary): DiscordActivity {
  const assets = {
    large_image: DISCORD_LARGE_IMAGE_KEY,
    large_text: "starcode",
  } as const;

  if (summary.runningThreadCount > 0) {
    const startedAt = summary.runningSince === null ? Number.NaN : Date.parse(summary.runningSince);
    return {
      details: `${pluralize(summary.runningThreadCount, "agent", "agents")} running`,
      state: connectionLine(summary.connectedEnvironmentCount, true),
      // A start in the future (clock skew across a tailnet is real) would render
      // as a timer counting down from nonsense, so an unparseable or absent
      // instant just drops the timer.
      ...(Number.isFinite(startedAt) ? { timestamps: { start: startedAt } } : {}),
      assets,
    };
  }

  if (summary.attentionThreadCount > 0) {
    return {
      details:
        summary.attentionThreadCount === 1
          ? "1 thread needs attention"
          : `${summary.attentionThreadCount} threads need attention`,
      state: connectionLine(summary.connectedEnvironmentCount, true),
      assets,
    };
  }

  return {
    details: "Idle",
    state: connectionLine(summary.connectedEnvironmentCount, false),
    assets,
  };
}

/**
 * Whether two summaries would produce the same presence.
 *
 * Compared on the rendered activity rather than the summary because the summary
 * carries more precision than the presence shows — a `runningSince` that moves
 * while the count stays at zero changes nothing a viewer can see, and Discord
 * rate-limits SET_ACTIVITY hard enough that spending an update on it matters.
 */
export function discordActivityEquals(left: DiscordActivity, right: DiscordActivity): boolean {
  return (
    left.details === right.details &&
    left.state === right.state &&
    left.timestamps?.start === right.timestamps?.start
  );
}
