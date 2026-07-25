import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  openImportPicker,
  subscribeImportPicker,
  type ImportPickerOpenDetail,
} from "./importPicker";

/**
 * The seam F12 phase 4 builds against. These tests are the contract: a caller
 * dispatches, the picker subscribes, and the scope travels between them. Phase
 * 4 replaces the no-op destination, not this shape.
 */
describe("importPicker", () => {
  const globals = globalThis as { window?: unknown };
  let previousWindow: unknown;

  beforeEach(() => {
    previousWindow = globals.window;
    globals.window = new EventTarget();
  });

  afterEach(() => {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  });

  it("delivers the requested scope to a subscriber", () => {
    const received: ImportPickerOpenDetail[] = [];
    const unsubscribe = subscribeImportPicker((detail) => received.push(detail));

    openImportPicker("env-mac" as EnvironmentId);

    expect(received).toEqual([{ environmentId: "env-mac" }]);
    unsubscribe();
  });

  it("carries a null scope for the fleet-wide entry point", () => {
    // The dropdown footer has no machine in context; the per-connection row
    // does. Both reach the same picker, which is the point of the seam.
    const received: ImportPickerOpenDetail[] = [];
    const unsubscribe = subscribeImportPicker((detail) => received.push(detail));

    openImportPicker(null);

    expect(received).toEqual([{ environmentId: null }]);
    unsubscribe();
  });

  it("stops delivering once unsubscribed", () => {
    let count = 0;
    const unsubscribe = subscribeImportPicker(() => {
      count += 1;
    });
    openImportPicker(null);
    unsubscribe();
    openImportPicker(null);

    expect(count).toBe(1);
  });

  it("is a no-op while nothing is listening", () => {
    // The state F12 ships in: the row is live, the picker is not built yet.
    // Dispatching must not throw, or every Import row would be a crash.
    expect(() => openImportPicker(null)).not.toThrow();
  });

  it("does nothing outside a browser", () => {
    delete globals.window;
    expect(() => openImportPicker(null)).not.toThrow();
    expect(subscribeImportPicker(() => {})).toBeTypeOf("function");
  });
});
