/**
 * Mailbox HTTP routes.
 *
 * `send` carries `orchestration:operate` rather than a read scope: leaving text
 * that a thread will act on is an operation on that thread. It is deliberately
 * *not* routed through `/api/orchestration/dispatch`, because every command that
 * endpoint accepts which carries user text also starts a turn.
 *
 * That used to be the whole point, and since 07-28 it is only half of it.
 * `peer_thread_send` now delivers immediately by default and does go through the
 * dispatch route; this one is what it falls back to, and what `queue: true` asks
 * for outright. So the route is no longer "the way messages arrive" — it is the
 * way a message arrives *without* costing the recipient a turn, which is still a
 * thing the dispatch endpoint cannot express.
 *
 * @module MailboxHttp
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { checkMailboxDelivery, type MailboxIntakeError } from "./intake.ts";
import { ThreadMailbox, type ThreadMailboxError } from "./ThreadMailbox.ts";

type MailboxRouteError =
  | EnvironmentInternalError
  | EnvironmentRequestInvalidError
  | EnvironmentResourceNotFoundError;

/**
 * A thread this server does not have is reported as a 404 whether it never
 * existed or was archived — a caller holding a stale id learns the same thing
 * either way, and cannot use the route to probe for thread ids.
 */
const failIntake = (error: MailboxIntakeError): Effect.Effect<never, MailboxRouteError> => {
  switch (error.reason) {
    case "thread_not_found":
      return failEnvironmentNotFound("thread_not_found");
    case "self_delivery":
      return Effect.logWarning("mailbox message refused", {
        threadId: error.threadId,
        reason: error.reason,
        detail: error.detail,
      }).pipe(Effect.andThen(failEnvironmentInvalidRequest("invalid_mailbox_message")));
    case "lookup_failed":
      return failEnvironmentInternal("mailbox_enqueue_failed", error);
  }
};

const failStore = (error: ThreadMailboxError): Effect.Effect<never, MailboxRouteError> =>
  error.reason === "mailbox_full"
    ? Effect.logWarning("mailbox message refused", {
        threadId: error.threadId,
        reason: error.reason,
        detail: error.detail,
      }).pipe(Effect.andThen(failEnvironmentInvalidRequest("invalid_mailbox_message")))
    : failEnvironmentInternal("mailbox_enqueue_failed", error);

export const mailboxHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mailbox",
  Effect.fnUntraced(function* (handlers) {
    const mailbox = yield* ThreadMailbox;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    return handlers
      .handle(
        "send",
        Effect.fn("environment.mailbox.send")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const environmentId = yield* environment.getEnvironmentId;
          yield* checkMailboxDelivery({
            threadId: args.params.threadId,
            origin: args.payload.origin,
            environmentId,
            projectionSnapshotQuery,
          }).pipe(Effect.catch(failIntake));
          const accepted = yield* mailbox
            .enqueue({
              threadId: args.params.threadId,
              message: args.payload.message,
              origin: args.payload.origin,
              sentAt: args.payload.sentAt,
            })
            .pipe(Effect.catch(failStore));
          return {
            entryId: accepted.entry.entryId,
            threadId: args.params.threadId,
            pending: accepted.pending,
          };
        }),
      )
      .handle(
        "pending",
        Effect.fn("environment.mailbox.pending")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const entries = yield* mailbox
            .pending(args.params.threadId)
            .pipe(
              Effect.catch(
                (error): Effect.Effect<never, EnvironmentInternalError> =>
                  failEnvironmentInternal("mailbox_read_failed", error),
              ),
            );
          return { threadId: args.params.threadId, pending: entries };
        }),
      );
  }),
);
