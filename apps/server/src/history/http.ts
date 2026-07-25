/**
 * Terminal history HTTP routes.
 *
 * Three reads and one write. The reads are cheap by construction: the listing
 * serves a page of an in-memory index and opens files only for the rows it is
 * about to return, the transcript reads backwards from the end of one file,
 * and the import registry is a small JSON file. None of them touch SQLite.
 *
 * The write — import — is the exception in every sense, and it lives here
 * rather than in its own group because it is addressed by history session id
 * and reads the same index the listing does. Its handler is thin: every
 * decision is in `import.ts`, and this file only maps that module's refusals
 * onto status codes.
 *
 * @module HistoryHttp
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  HistoryImportRefusedError,
  type HistoryImportRefusalReason,
  type HistoryImportsPage,
  type HistorySessionsPage,
  type HistoryTranscriptPage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { HistoryIndex } from "./HistoryIndex.ts";
import { makeHistoryImporter } from "./import.ts";
import { HistoryImportRegistry } from "./importRegistry.ts";
import {
  clampSessionsLimit,
  clampTranscriptLimit,
  parseBefore,
  parseCursor,
  resolveWindow,
  selectPage,
} from "./query.ts";
import { readTranscriptTail } from "./tailReader.ts";

/**
 * The file went away between resolving its id and reading it. Realistic: these
 * stores are the CLIs' own, and a user can delete a project at any moment.
 */
class HistoryTranscriptReadError extends Schema.TaggedErrorClass<HistoryTranscriptReadError>()(
  "HistoryTranscriptReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read the terminal-history transcript.";
  }
}

export const historyHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "history",
  Effect.fnUntraced(function* (handlers) {
    const historyIndex = yield* HistoryIndex;
    const importRegistry = yield* HistoryImportRegistry;
    const importer = yield* makeHistoryImporter;

    /**
     * Refusals carry the precondition that failed straight through to the
     * client. That is the point of having a dedicated error: "wrong Claude
     * home" and "no project at that path" are both 409s, and a dialog that
     * cannot tell them apart cannot offer the right next step.
     */
    const failImportRefused = (reason: string, detail: string | undefined) =>
      currentEnvironmentTraceId.pipe(
        Effect.flatMap((traceId) =>
          Effect.fail(
            new HistoryImportRefusedError({
              code: "history_import_refused",
              reason: reason as HistoryImportRefusalReason,
              ...(detail === undefined ? {} : { detail }),
              traceId,
            }),
          ),
        ),
      );

    return handlers
      .handle(
        "sessions",
        Effect.fn("environment.history.sessions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);

          const nowMs = yield* Clock.currentTimeMillis;
          const index = yield* historyIndex.snapshot();
          const window = resolveWindow(args.query, nowMs);
          const selection = selectPage({
            entries: index.entries,
            window,
            cursor: parseCursor(args.query.cursor),
            limit: clampSessionsLimit(args.query.limit),
          });
          const sessions = yield* historyIndex.hydrate(selection.page);

          return {
            sessions,
            nextCursor: selection.nextCursor,
            // Index-wide, ignoring the window: this is what lets the strip
            // offer "show older (N)" without a second request.
            totalAvailable: index.entries.length,
            totalInWindow: selection.totalInWindow,
            since: window.sinceMs === null ? null : formatMillis(window.sinceMs),
            indexedAt: formatMillis(index.indexedAt),
          } satisfies HistorySessionsPage;
        }),
      )
      .handle(
        "transcript",
        Effect.fn("environment.history.transcript")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);

          // The traversal guard. `resolve` takes an opaque id and answers only
          // from the index's own map, so the path below can only ever be a file
          // this server discovered under `~/.claude/projects` or
          // `~/.codex/sessions`. A forged, stale, or path-shaped id is a 404,
          // indistinguishable from a session that has been deleted.
          const entry = yield* historyIndex.resolve(args.params.sessionId);
          if (entry === null) {
            return yield* failEnvironmentNotFound("history_session_not_found");
          }

          const [tail, summaries] = yield* Effect.all(
            [
              // Failable on purpose: the file can be deleted between resolving
              // the id and opening it, and that should surface as an error the
              // viewer can show rather than a defect that kills the fiber.
              Effect.tryPromise({
                try: () =>
                  readTranscriptTail({
                    path: entry.path,
                    provider: entry.provider,
                    before: parseBefore(args.query.before),
                    limit: clampTranscriptLimit(args.query.limit),
                  }),
                catch: (cause) => new HistoryTranscriptReadError({ cause }),
              }),
              historyIndex.hydrate([entry]),
            ],
            { concurrency: 2 },
          ).pipe(
            Effect.catch((cause) => failEnvironmentInternal("history_transcript_failed", cause)),
          );

          const session = summaries[0];
          if (session === undefined) {
            return yield* failEnvironmentNotFound("history_session_not_found");
          }
          return {
            session,
            entries: tail.entries,
            hasMore: tail.hasMore,
            nextBefore: tail.nextBefore,
          } satisfies HistoryTranscriptPage;
        }),
      )
      .handle(
        "import",
        Effect.fn("environment.history.import")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          // The two refusals are turned into ordinary values before the
          // catch-all runs, then re-raised below. A `catchTags` followed by a
          // catch-all would re-catch the environment errors the first one just
          // produced and report a 404 as a 500.
          const outcome = yield* importer
            .importSession({
              sessionId: args.params.sessionId,
              ...args.payload,
            })
            .pipe(
              Effect.catchTags({
                HistorySessionNotFound: () => Effect.succeed({ refused: "not_found" } as const),
                HistoryImportRefusal: (refusal) => Effect.succeed({ refused: refusal } as const),
              }),
              // A projection read that failed, a settings load that failed:
              // ours, not the caller's.
              Effect.catch((cause) => failEnvironmentInternal("history_import_failed", cause)),
            );

          if ("refused" in outcome) {
            return yield* outcome.refused === "not_found"
              ? failEnvironmentNotFound("history_session_not_found")
              : failImportRefused(outcome.refused.reason, outcome.refused.detail);
          }
          return outcome;
        }),
      )
      .handle(
        "imports",
        Effect.fn("environment.history.imports")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);

          const imports = yield* importRegistry.list.pipe(
            Effect.catch((cause) => failEnvironmentInternal("history_imports_failed", cause)),
          );
          return { imports } satisfies HistoryImportsPage;
        }),
      );
  }),
);

const formatMillis = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));
