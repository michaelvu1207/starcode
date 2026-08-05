import { describe, expect, it } from "vite-plus/test";

import {
  activityKindFromItemType,
  activityPhrase,
  formatActivityPhrase,
  formatElapsed,
  summarizeActivityGroup,
} from "./activityPhrasing.ts";

describe("activityPhrase", () => {
  it("uses the present participle while running and the past tense once settled", () => {
    expect(formatActivityPhrase(activityPhrase({ kind: "command", phase: "running" }))).toBe(
      "Running command",
    );
    expect(formatActivityPhrase(activityPhrase({ kind: "command", phase: "settled" }))).toBe(
      "Ran command",
    );
  });

  it("names the command when there is one", () => {
    expect(
      formatActivityPhrase(
        activityPhrase({ kind: "command", phase: "settled", target: "npm test" }),
      ),
    ).toBe("Ran npm test");
  });

  it("appends elapsed time to a settled command", () => {
    expect(
      formatActivityPhrase(
        activityPhrase({ kind: "command", phase: "settled", target: "npm test", elapsed: "1m 4s" }),
      ),
    ).toBe("Ran npm test in 1m 4s");
  });

  it("reports an interrupted command as stopped rather than as finished", () => {
    expect(
      formatActivityPhrase(
        activityPhrase({
          kind: "command",
          phase: "settled",
          target: "npm test",
          elapsed: "8s",
          stopped: true,
        }),
      ),
    ).toBe("Stopped npm test after 8s");
  });

  it("reads as a sentence for searches and listings without a target", () => {
    expect(formatActivityPhrase(activityPhrase({ kind: "search", phase: "settled" }))).toBe(
      "Searched files",
    );
    expect(formatActivityPhrase(activityPhrase({ kind: "listFiles", phase: "running" }))).toBe(
      "Listing files",
    );
  });

  it("has no target for reasoning", () => {
    expect(activityPhrase({ kind: "reasoning", phase: "running" })).toEqual({ verb: "Thinking" });
  });
});

describe("summarizeActivityGroup", () => {
  it("pluralizes within a bucket", () => {
    expect(
      summarizeActivityGroup({
        members: [
          { kind: "command", phase: "settled" },
          { kind: "command", phase: "settled" },
          { kind: "command", phase: "settled" },
        ],
      }),
    ).toBe("Ran 3 commands");
  });

  it("uses the singular article for a lone member", () => {
    expect(summarizeActivityGroup({ members: [{ kind: "command", phase: "settled" }] })).toBe(
      "Ran a command",
    );
  });

  it("joins buckets in the order they first appeared, lowercasing after the first", () => {
    expect(
      summarizeActivityGroup({
        members: [
          { kind: "fileRead", phase: "settled" },
          { kind: "fileRead", phase: "settled" },
          { kind: "command", phase: "settled" },
        ],
      }),
    ).toBe("Read 2 files, ran a command");
  });

  it("folds reads, listings and searches into one exploration bucket", () => {
    expect(
      summarizeActivityGroup({
        members: [
          { kind: "fileRead", phase: "settled" },
          { kind: "listFiles", phase: "settled" },
          { kind: "search", phase: "settled" },
        ],
      }),
    ).toBe("Read 3 files");
  });

  it("keeps a bucket in the present tense while any of its members is running", () => {
    expect(
      summarizeActivityGroup({
        members: [
          { kind: "command", phase: "settled" },
          { kind: "command", phase: "running" },
        ],
      }),
    ).toBe("Running 2 commands");
  });

  it("appends a line count as a stat rather than as another phrase", () => {
    expect(
      summarizeActivityGroup({
        members: [
          { kind: "fileEdit", phase: "settled" },
          { kind: "fileEdit", phase: "settled" },
        ],
        changedLines: 36,
      }),
    ).toBe("Edited 2 files • 36 lines");
  });

  it("falls back to a generic label when nothing in the run is bucketable", () => {
    expect(summarizeActivityGroup({ members: [{ kind: "approval", phase: "running" }] })).toBe(
      "Working",
    );
    expect(summarizeActivityGroup({ members: [{ kind: "approval", phase: "settled" }] })).toBe(
      "Work log",
    );
  });
});

describe("activityKindFromItemType", () => {
  it("prefers the approval request kind over the item type", () => {
    expect(activityKindFromItemType({ itemType: "file_change", requestKind: "command" })).toBe(
      "command",
    );
  });

  it("distinguishes create, edit and delete", () => {
    expect(activityKindFromItemType({ itemType: "file_change", changeKind: "create" })).toBe(
      "fileCreate",
    );
    expect(activityKindFromItemType({ itemType: "file_change", changeKind: "delete" })).toBe(
      "fileDelete",
    );
    expect(activityKindFromItemType({ itemType: "file_change" })).toBe("fileEdit");
  });

  it("renders native file reads as exploration instead of generic tool runs", () => {
    expect(activityKindFromItemType({ itemType: "file_read" })).toBe("fileRead");
  });

  it("falls back to the shape of the entry when the item type says nothing", () => {
    expect(activityKindFromItemType({ hasCommand: true })).toBe("command");
    expect(activityKindFromItemType({ hasChangedFiles: true })).toBe("fileEdit");
    expect(activityKindFromItemType({})).toBe("other");
  });
});

describe("formatElapsed", () => {
  it("omits sub-second durations, which read as noise next to a verb", () => {
    expect(formatElapsed(400)).toBeUndefined();
  });

  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(8_000)).toBe("8s");
    expect(formatElapsed(64_000)).toBe("1m 4s");
    expect(formatElapsed(120_000)).toBe("2m");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
    expect(formatElapsed(3_600_000)).toBe("1h");
  });

  it("rejects nonsense rather than rendering it", () => {
    expect(formatElapsed(-1)).toBeUndefined();
    expect(formatElapsed(Number.NaN)).toBeUndefined();
  });
});
