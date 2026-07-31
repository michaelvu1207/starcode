/**
 * Process-local, reconcile-fed routing index for the whole fleet.
 *
 * @module FleetThreadIndex
 */
import {
  type EnvironmentId,
  type FleetNodeName,
  type FleetThreadIndex as FleetThreadIndexSnapshot,
  type FleetThreadIndexEntry,
  type FleetThreadIndexFailure,
  type ThreadId,
} from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export interface FleetThreadLocation {
  readonly environmentId: EnvironmentId;
  readonly node: FleetNodeName;
  readonly local: boolean;
}

export interface FleetThreadIndexShape {
  readonly snapshot: Effect.Effect<FleetThreadIndexSnapshot>;
  readonly lookup: (threadId: ThreadId) => Effect.Effect<Option.Option<FleetThreadLocation>>;
  readonly refresh: (
    entries: ReadonlyArray<FleetThreadIndexEntry>,
    localEnvironmentId: EnvironmentId,
    failures?: ReadonlyArray<FleetThreadIndexFailure>,
  ) => Effect.Effect<FleetThreadIndexSnapshot>;
  readonly replaceNodeEntries: (
    entries: ReadonlyArray<FleetThreadIndexEntry>,
    node: EnvironmentId,
    localEnvironmentId: EnvironmentId,
    failure?: FleetThreadIndexFailure,
  ) => Effect.Effect<FleetThreadIndexSnapshot>;
  readonly changes: Stream.Stream<FleetThreadIndexSnapshot>;
}

export class FleetThreadIndex extends Context.Service<FleetThreadIndex, FleetThreadIndexShape>()(
  "starcode/fleet/FleetThreadIndex",
) {}

const sameEntry = (left: FleetThreadIndexEntry, right: FleetThreadIndexEntry): boolean =>
  left.threadId === right.threadId &&
  left.node === right.node &&
  left.nodeName === right.nodeName &&
  left.project === right.project &&
  left.title === right.title &&
  left.status === right.status &&
  left.lastActivityAt === right.lastActivityAt &&
  left.createdAt === right.createdAt &&
  left.provider === right.provider &&
  left.model === right.model &&
  left.branch === right.branch &&
  (left.planSummary === right.planSummary ||
    (left.planSummary !== undefined &&
      left.planSummary !== null &&
      right.planSummary !== undefined &&
      right.planSummary !== null &&
      left.planSummary.total === right.planSummary.total &&
      left.planSummary.completed === right.planSummary.completed &&
      left.planSummary.activeStep === right.planSummary.activeStep));

const sameFailures = (
  left: ReadonlyArray<FleetThreadIndexFailure>,
  right: ReadonlyArray<FleetThreadIndexFailure>,
): boolean =>
  left.length === right.length &&
  left.every((failure, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      failure.node === candidate.node &&
      failure.nodeName === candidate.nodeName &&
      failure.reason === candidate.reason
    );
  });

const normalizedEntries = (
  entries: ReadonlyArray<FleetThreadIndexEntry>,
): ReadonlyArray<FleetThreadIndexEntry> =>
  entries.toSorted((left, right) => left.threadId.localeCompare(right.threadId));

const sameEntries = (
  left: ReadonlyArray<FleetThreadIndexEntry>,
  right: ReadonlyArray<FleetThreadIndexEntry>,
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined && sameEntry(entry, candidate);
  });

export const make = Effect.gen(function* () {
  const state = yield* Ref.make<FleetThreadIndexSnapshot>({
    revision: 0,
    entries: [],
    failures: [],
  });
  const localEnvironment = yield* Ref.make<Option.Option<EnvironmentId>>(Option.none());
  const changesPubSub = yield* PubSub.sliding<FleetThreadIndexSnapshot>(1);

  const snapshot: FleetThreadIndexShape["snapshot"] = Ref.get(state);

  const lookup: FleetThreadIndexShape["lookup"] = (threadId) =>
    Effect.all({ current: Ref.get(state), local: Ref.get(localEnvironment) }).pipe(
      Effect.map(({ current, local }) => {
        const entry = current.entries.find((candidate) => candidate.threadId === threadId);
        if (entry === undefined) return Option.none<FleetThreadLocation>();
        return Option.some({
          environmentId: entry.node,
          node: entry.nodeName,
          local: Option.isSome(local) && local.value === entry.node,
        });
      }),
      Effect.withSpan("FleetThreadIndex.lookup"),
    );

  const refresh: FleetThreadIndexShape["refresh"] = Effect.fn("FleetThreadIndex.refresh")(
    function* (entries, localEnvironmentId, failures = []) {
      yield* Ref.set(localEnvironment, Option.some(localEnvironmentId));
      const normalized = normalizedEntries(entries);
      const normalizedFailures = failures.toSorted((left, right) =>
        left.node.localeCompare(right.node),
      );
      const previous = yield* Ref.get(state);
      if (
        sameEntries(previous.entries, normalized) &&
        sameFailures(previous.failures, normalizedFailures)
      ) {
        return previous;
      }
      const next: FleetThreadIndexSnapshot = {
        revision: previous.revision + 1,
        entries: normalized,
        failures: normalizedFailures,
      };
      yield* Ref.set(state, next);
      yield* PubSub.publish(changesPubSub, next);
      return next;
    },
  );

  const replaceNodeEntries: FleetThreadIndexShape["replaceNodeEntries"] = Effect.fn(
    "FleetThreadIndex.replaceNodeEntries",
  )(function* (entries, node, localEnvironmentId, failure) {
    const previous = yield* Ref.get(state);
    return yield* refresh(
      [...previous.entries.filter((entry) => entry.node !== node), ...entries],
      localEnvironmentId,
      [
        ...previous.failures.filter((entry) => entry.node !== node),
        ...(failure === undefined ? [] : [failure]),
      ],
    );
  });

  return FleetThreadIndex.of({
    snapshot,
    lookup,
    refresh,
    replaceNodeEntries,
    changes: Stream.fromPubSub(changesPubSub),
  });
});

export const layer = Layer.effect(FleetThreadIndex, make);
