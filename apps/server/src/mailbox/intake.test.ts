import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationThreadShell,
  ThreadId,
  type ThreadMailboxOrigin,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { checkMailboxDelivery } from "./intake.ts";

const here = EnvironmentId.make("env-here");
const target = ThreadId.make("thread-target");

/** Only `getThreadShellById` is reachable from the intake check. */
const queryWith = (exists: boolean): ProjectionSnapshotQuery["Service"] =>
  ({
    getThreadShellById: () =>
      Effect.succeed(
        exists ? Option.some({ id: target } as OrchestrationThreadShell) : Option.none(),
      ),
  }) as unknown as ProjectionSnapshotQuery["Service"];

const origin = (overrides: Partial<ThreadMailboxOrigin> = {}): ThreadMailboxOrigin =>
  ({
    environmentId: "env-elsewhere",
    environmentLabel: "other-machine",
    threadId: "thread-sender",
    threadTitle: "Sender",
    ...overrides,
  }) as ThreadMailboxOrigin;

describe("mailbox intake", () => {
  it.effect("accepts a message from another thread", () =>
    checkMailboxDelivery({
      threadId: target,
      origin: origin(),
      environmentId: here,
      projectionSnapshotQuery: queryWith(true),
    }),
  );

  it.effect("refuses a thread delivering to itself", () =>
    Effect.gen(function* () {
      const error = yield* checkMailboxDelivery({
        threadId: target,
        origin: origin({ environmentId: here, threadId: target }),
        environmentId: here,
        projectionSnapshotQuery: queryWith(true),
      }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "self_delivery");
    }),
  );

  it.effect("allows a same-id thread on a different machine", () =>
    // Thread ids are unique per machine, so matching ids across environments
    // are two different threads and must not trip the self-delivery guard.
    checkMailboxDelivery({
      threadId: target,
      origin: origin({ environmentId: EnvironmentId.make("env-elsewhere"), threadId: target }),
      environmentId: here,
      projectionSnapshotQuery: queryWith(true),
    }),
  );

  it.effect("refuses a thread this server does not have", () =>
    Effect.gen(function* () {
      const error = yield* checkMailboxDelivery({
        threadId: target,
        origin: origin(),
        environmentId: here,
        projectionSnapshotQuery: queryWith(false),
      }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "thread_not_found");
    }),
  );
});
