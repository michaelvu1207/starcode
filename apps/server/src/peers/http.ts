/**
 * Peer registry HTTP routes.
 *
 * Managing peers is an access-control operation — a peer entry grants this
 * environment a standing read of another machine — so these carry the same
 * `access:read` / `access:write` scopes as the pairing-link routes.
 *
 * @module PeersHttp
 */
import { AuthAccessReadScope, AuthAccessWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { PeerRegistry } from "./PeerRegistry.ts";

export const peersHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "peers",
  Effect.fnUntraced(function* (handlers) {
    const peerRegistry = yield* PeerRegistry;

    return handlers
      .handle(
        "list",
        Effect.fn("environment.peers.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          return yield* peerRegistry.list.pipe(
            Effect.catch((cause) => failEnvironmentInternal("peers_load_failed", cause)),
          );
        }),
      )
      .handle(
        "register",
        Effect.fn("environment.peers.register")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* peerRegistry.register(args.payload).pipe(
            // Handled in one pass: a sequential `catch` would re-catch the
            // rejection response this handler had just produced.
            Effect.catchTags({
              // A rejected pairing token, a bad base URL, or a duplicate name
              // is the caller's mistake, not a server fault. The reason is
              // logged rather than returned: it can quote the peer's own
              // response, which is not this caller's to read.
              PeerRegistrationError: (error) =>
                Effect.logWarning("peer registration rejected", {
                  peer: error.name,
                  reason: error.reason,
                  detail: error.detail,
                }).pipe(Effect.andThen(failEnvironmentInvalidRequest("invalid_peer"))),
              PeerRegistryStateError: (cause) =>
                failEnvironmentInternal("peer_registration_failed", cause),
            }),
          );
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.peers.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const removed = yield* peerRegistry
            .remove(args.payload.name)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("peer_remove_failed", cause)));
          return { removed };
        }),
      );
  }),
);
