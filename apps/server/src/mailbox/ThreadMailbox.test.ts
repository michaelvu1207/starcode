import { assert, describe, it } from "@effect/vitest";
import { MAILBOX_PENDING_MAX, ThreadId, type ThreadMailboxOrigin } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ThreadMailbox,
  layer as threadMailboxLayer,
  type ThreadMailboxShape,
} from "./ThreadMailbox.ts";

const target = ThreadId.make("thread-target");

const originFrom = (threadId: string): ThreadMailboxOrigin =>
  ({
    environmentId: "env-sender",
    environmentLabel: "sender-machine",
    threadId,
    threadTitle: "Sender thread",
  }) as ThreadMailboxOrigin;

const withMailbox = <A, E>(use: (mailbox: ThreadMailboxShape) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const mailbox = yield* ThreadMailbox;
    return yield* use(mailbox);
  }).pipe(
    Effect.provide(
      threadMailboxLayer.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const send = (mailbox: ThreadMailboxShape, message: string) =>
  mailbox.enqueue({
    threadId: target,
    message,
    origin: originFrom("thread-sender"),
    sentAt: "2026-07-25T00:00:00.000Z",
  });

describe("ThreadMailbox", () => {
  it.effect("enqueues without delivering, and reports the growing backlog", () =>
    withMailbox((mailbox) =>
      Effect.gen(function* () {
        const first = yield* send(mailbox, "one");
        const second = yield* send(mailbox, "two");
        assert.strictEqual(first.pending, 1);
        assert.strictEqual(second.pending, 2);

        const pending = yield* mailbox.pending(target);
        assert.deepStrictEqual(
          pending.map((entry) => entry.message),
          ["one", "two"],
        );
        // Nothing is delivered until a turn claims it.
        assert.isTrue(pending.every((entry) => entry.deliveredAt === null));
      }),
    ),
  );

  it.effect("carries provenance through to the delivered entry", () =>
    withMailbox((mailbox) =>
      Effect.gen(function* () {
        yield* send(mailbox, "with provenance");
        const [entry] = yield* mailbox.claimForTurn(target);
        assert.isDefined(entry);
        assert.deepStrictEqual(entry?.origin, originFrom("thread-sender"));
        assert.strictEqual(entry?.sentAt, "2026-07-25T00:00:00.000Z");
      }),
    ),
  );

  it.effect("delivers each message exactly once across repeated turns", () =>
    withMailbox((mailbox) =>
      Effect.gen(function* () {
        yield* send(mailbox, "one");
        yield* send(mailbox, "two");

        const firstTurn = yield* mailbox.claimForTurn(target);
        assert.deepStrictEqual(
          firstTurn.map((entry) => entry.message),
          ["one", "two"],
        );

        // The second turn must find nothing: the first turn owns those rows.
        const secondTurn = yield* mailbox.claimForTurn(target);
        assert.deepStrictEqual(secondTurn, []);

        yield* send(mailbox, "three");
        const thirdTurn = yield* mailbox.claimForTurn(target);
        assert.deepStrictEqual(
          thirdTurn.map((entry) => entry.message),
          ["three"],
        );
      }),
    ),
  );

  it.effect("never hands the same message to two concurrent turns", () =>
    withMailbox((mailbox) =>
      Effect.gen(function* () {
        yield* send(mailbox, "contested");
        const claims = yield* Effect.all(
          [mailbox.claimForTurn(target), mailbox.claimForTurn(target)],
          { concurrency: 2 },
        );
        const delivered = claims.flat();
        assert.strictEqual(delivered.length, 1, "exactly one claim may win the row");
      }),
    ),
  );

  it.effect("keeps mailboxes separate per thread", () =>
    withMailbox((mailbox) =>
      Effect.gen(function* () {
        yield* send(mailbox, "for target");
        const other = yield* mailbox.claimForTurn(ThreadId.make("thread-other"));
        assert.deepStrictEqual(other, []);
        const mine = yield* mailbox.claimForTurn(target);
        assert.strictEqual(mine.length, 1);
      }),
    ),
  );

  it.effect("refuses a send once the undelivered backlog hits its ceiling", () =>
    withMailbox((mailbox) =>
      Effect.gen(function* () {
        for (let index = 0; index < MAILBOX_PENDING_MAX; index += 1) {
          yield* send(mailbox, `message ${index}`);
        }
        const error = yield* send(mailbox, "one too many").pipe(Effect.flip);
        assert.strictEqual(error.reason, "mailbox_full");

        // Draining the backlog makes room again.
        yield* mailbox.claimForTurn(target);
        const accepted = yield* send(mailbox, "after the drain");
        assert.strictEqual(accepted.pending, 1);
      }),
    ),
  );
});
