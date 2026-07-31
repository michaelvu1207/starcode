import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { permitsThreadOperation } from "../threads/ThreadCapability.ts";
import { ThreadService } from "../threads/ThreadService.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const threadService = yield* ThreadService;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          if (
            !permitsThreadOperation(
              { kind: "environment", scopes: principal.scopes },
              { operation: "read" },
            )
          ) {
            return yield* failEnvironmentInternal("orchestration_thread_snapshot_failed");
          }
          const snapshot = yield* threadService
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return snapshot.value;
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          const threadOperation =
            normalizedCommand.type === "thread.create"
              ? "create"
              : normalizedCommand.type === "thread.turn.start"
                ? "turn"
                : normalizedCommand.type === "thread.archive" ||
                    normalizedCommand.type === "thread.unarchive"
                  ? "archive"
                  : null;
          if (
            threadOperation !== null &&
            !permitsThreadOperation(
              { kind: "environment", scopes: principal.scopes },
              { operation: threadOperation },
            )
          ) {
            return yield* failEnvironmentInternal("orchestration_dispatch_failed");
          }
          const dispatchEffect = Effect.gen(function* () {
            if (normalizedCommand.type === "thread.create") {
              return yield* threadService.dispatchCreate(normalizedCommand);
            }
            if (normalizedCommand.type === "thread.turn.start") {
              return yield* threadService.startTurn(normalizedCommand);
            }
            if (
              normalizedCommand.type === "thread.archive" ||
              normalizedCommand.type === "thread.unarchive"
            ) {
              return yield* threadService.setArchived(normalizedCommand);
            }
            return yield* orchestrationEngine.dispatch(normalizedCommand);
          });
          return yield* dispatchEffect.pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
        }),
      );
  }),
);
