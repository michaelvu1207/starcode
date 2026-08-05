import { EMPTY_DISCORD_PRESENCE_SUMMARY, type DiscordPresenceSummary } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { discordActivityEquals, renderDiscordActivity } from "./discordActivity.ts";

const summary = (overrides: Partial<DiscordPresenceSummary>): DiscordPresenceSummary => ({
  ...EMPTY_DISCORD_PRESENCE_SUMMARY,
  ...overrides,
});

describe("renderDiscordActivity", () => {
  it("counts running agents and starts the timer at the oldest running turn", () => {
    const activity = renderDiscordActivity(
      summary({
        runningThreadCount: 3,
        connectedEnvironmentCount: 4,
        runningSince: "2026-07-28T10:00:00.000Z",
      }),
    );

    expect(activity.details).toBe("3 agents running");
    expect(activity.state).toBe("across 4 connections");
    expect(activity.timestamps?.start).toBe(Date.parse("2026-07-28T10:00:00.000Z"));
  });

  it("singularizes both counts", () => {
    const activity = renderDiscordActivity(
      summary({ runningThreadCount: 1, connectedEnvironmentCount: 1 }),
    );

    expect(activity.details).toBe("1 agent running");
    expect(activity.state).toBe("on 1 connection");
  });

  it("drops the timer when no start instant is usable", () => {
    expect(
      renderDiscordActivity(summary({ runningThreadCount: 2, runningSince: null })).timestamps,
    ).toBeUndefined();
    expect(
      renderDiscordActivity(summary({ runningThreadCount: 2, runningSince: "not a date" }))
        .timestamps,
    ).toBeUndefined();
  });

  it("reports threads needing attention only when nothing is running", () => {
    expect(
      renderDiscordActivity(summary({ attentionThreadCount: 2, connectedEnvironmentCount: 2 }))
        .details,
    ).toBe("2 threads need attention");
    expect(renderDiscordActivity(summary({ attentionThreadCount: 1 })).details).toBe(
      "1 thread needs attention",
    );
    expect(
      renderDiscordActivity(summary({ runningThreadCount: 1, attentionThreadCount: 5 })).details,
    ).toBe("1 agent running");
  });

  it("falls back to idle, and says so plainly with nothing connected", () => {
    expect(renderDiscordActivity(summary({ connectedEnvironmentCount: 3 }))).toMatchObject({
      details: "Idle",
      state: "3 connections",
    });
    expect(renderDiscordActivity(EMPTY_DISCORD_PRESENCE_SUMMARY).state).toBe("No connections");
  });

  it("never names a project, thread, branch or machine", () => {
    // The guard for the privacy promise in DiscordPresenceSummarySchema: the
    // renderer cannot leak what the summary cannot carry, and this is the only
    // place the summary becomes text.
    const rendered = JSON.stringify(
      renderDiscordActivity(
        summary({ runningThreadCount: 2, attentionThreadCount: 1, connectedEnvironmentCount: 3 }),
      ),
    );

    expect(rendered).not.toMatch(/project|thread|branch|repo|machine|host/i);
  });
});

describe("discordActivityEquals", () => {
  it("treats a changed timer as a changed presence", () => {
    const base = renderDiscordActivity(
      summary({ runningThreadCount: 1, runningSince: "2026-07-28T10:00:00.000Z" }),
    );
    const later = renderDiscordActivity(
      summary({ runningThreadCount: 1, runningSince: "2026-07-28T10:05:00.000Z" }),
    );

    expect(discordActivityEquals(base, base)).toBe(true);
    expect(discordActivityEquals(base, later)).toBe(false);
  });

  it("ignores summary detail the presence does not show", () => {
    // Attention count is invisible while anything is running, so a change to it
    // must not spend one of Discord's five updates per twenty seconds.
    const withoutAttention = renderDiscordActivity(summary({ runningThreadCount: 2 }));
    const withAttention = renderDiscordActivity(
      summary({ runningThreadCount: 2, attentionThreadCount: 4 }),
    );

    expect(discordActivityEquals(withoutAttention, withAttention)).toBe(true);
  });
});
