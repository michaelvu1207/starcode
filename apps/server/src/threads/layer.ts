/**
 * Local thread composition root.
 *
 * Same reason `peers/layer.ts` exists: `server.ts` is one of the repo's hottest
 * files, so it carries one `Layer.provide` for this area and a later service
 * added here costs no diff there.
 *
 * @module ThreadsLayer
 */
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PeerServicesLive } from "../peers/layer.ts";
import * as ThreadService from "./ThreadService.ts";

/**
 * One composition root exposes the authoritative service alongside the fleet
 * registry and deprecated peer-registry compatibility view.
 */
const ThreadServiceLive = ThreadService.layer.pipe(Layer.provideMerge(PeerServicesLive));

/**
 * Keep this node's index entries fresh between periodic fleet reconciliations.
 * The debounce lets the projection pipeline observe the event before its
 * snapshot is read and collapses bursty transcript activity into one refresh.
 */
const LocalThreadIndexRefreshLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const threadService = yield* ThreadService.ThreadService;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const refresh = threadService.refreshLocalIndex.pipe(
      Effect.catch(() => Effect.logWarning("Local fleet thread index refresh failed")),
    );
    yield* refresh;
    yield* Effect.forkScoped(
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.filter((event) => event.type.startsWith("thread.")),
        Stream.debounce("100 millis"),
        Stream.runForEach(() => refresh),
      ),
    );
  }),
);

export const ThreadServicesLive = LocalThreadIndexRefreshLive.pipe(
  Layer.provideMerge(ThreadServiceLive),
);
