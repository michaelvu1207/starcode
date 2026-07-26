import { describe, expect, it } from "vite-plus/test";

import { resolveThreadRowStatusChip } from "./SidebarThreadRow.status";

const chip = (
  status: Parameters<typeof resolveThreadRowStatusChip>[0]["status"],
  flags?: { readonly isUnread?: boolean; readonly isWoke?: boolean },
) =>
  resolveThreadRowStatusChip({
    status,
    isUnread: flags?.isUnread ?? false,
    isWoke: flags?.isWoke ?? false,
  });

describe("resolveThreadRowStatusChip", () => {
  it("shows nothing for a quiet, read thread — most rows wear no badge", () => {
    expect(chip("ready")).toBeNull();
  });

  it("names each live state", () => {
    expect(chip("working")?.tone).toBe("working");
    expect(chip("approval")?.tone).toBe("approval");
    expect(chip("input")?.tone).toBe("input");
    expect(chip("failed")?.tone).toBe("failed");
  });

  it("lets a live state outrank both remembered ones", () => {
    // A thread can be working AND unread AND freshly woken. What it is doing
    // now is the answer; what you have not read is a note about the past.
    expect(chip("working", { isUnread: true, isWoke: true })?.tone).toBe("working");
    expect(chip("approval", { isUnread: true, isWoke: true })?.tone).toBe("approval");
    expect(chip("failed", { isUnread: true, isWoke: true })?.tone).toBe("failed");
  });

  it("lets a wake outrank an unread finish", () => {
    expect(chip("ready", { isUnread: true, isWoke: true })?.tone).toBe("woke");
    expect(chip("ready", { isUnread: true })?.tone).toBe("done");
    expect(chip("ready", { isWoke: true })?.tone).toBe("woke");
  });

  it("gives every chip an accessible name, because the row draws only colour", () => {
    for (const status of ["working", "approval", "input", "failed"] as const) {
      expect(chip(status)?.label).not.toBe("");
    }
    expect(chip("ready", { isWoke: true })?.label).not.toBe("");
    expect(chip("ready", { isUnread: true })?.label).not.toBe("");
  });
});
