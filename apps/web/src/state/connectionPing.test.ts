import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { measureProbeRoundTrip } from "./connectionPing";

describe("measureProbeRoundTrip", () => {
  it.effect("reports the elapsed time of a probe that answers", () =>
    Effect.gen(function* () {
      const elapsed = yield* measureProbeRoundTrip(Effect.void);
      expect(elapsed).not.toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("reports the delay a slow probe actually took", () =>
    Effect.gen(function* () {
      // A real socket round trip, simulated: the measurement has to include
      // the wait, not just the call.
      const fiber = yield* Effect.forkChild(measureProbeRoundTrip(Effect.sleep("250 millis")));
      yield* TestClock.adjust("250 millis");
      expect(yield* Fiber.join(fiber)).toBe(250);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resolves a failing probe to null rather than failing", () =>
    Effect.gen(function* () {
      // The dropdown renders "no answer" for this. A failure here would take
      // out the row, and a machine that cannot be measured is still a machine
      // worth listing.
      const elapsed = yield* measureProbeRoundTrip(Effect.fail("socket closed" as const));
      expect(elapsed).toBeNull();
    }),
  );

  it.effect("gives up on a probe that never answers", () =>
    Effect.gen(function* () {
      // A hung socket must resolve to "no answer" within one refresh interval,
      // not sit pending forever — a stuck row would read as "measuring" and
      // never correct itself.
      const fiber = yield* Effect.forkChild(measureProbeRoundTrip(Effect.never));
      yield* TestClock.adjust("9 seconds");
      expect(yield* Fiber.join(fiber)).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stays pending while a slow probe is still inside its budget", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(measureProbeRoundTrip(Effect.never));
      yield* TestClock.adjust("5 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("never reports a negative latency", () =>
    Effect.gen(function* () {
      const elapsed = yield* measureProbeRoundTrip(Effect.void);
      expect(elapsed ?? 0).toBeGreaterThanOrEqual(0);
    }),
  );
});
