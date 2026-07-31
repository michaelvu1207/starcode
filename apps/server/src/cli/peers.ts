/**
 * `starcode peers` - pairing this environment with the other machines in the fleet.
 *
 * This exists because the registry had no operator surface at all. The routes
 * were there and nothing called them: no button in the web app, no command
 * here, so the only way to add a peer was to hand-write a `curl` against
 * `/api/peers/register` with a token pasted out of another terminal. Every
 * federation feature in the fork sits behind that step, and re-registering was
 * the documented remedy for an expired credential — which made "the fix is a
 * curl you have to remember" the load-bearing part of the design.
 *
 * Deliberately a CLI rather than a settings pane. Pairing is a two-machine
 * operation: you are already on the peer's shell to mint its token, and the
 * shape of the work is "run this there, run that here". A UI would have to
 * explain that; a command can just be the second half of it.
 *
 * @module PeersCli
 */
import { PeerEnvironment, PeerName, type PeerRegisterInput } from "@starcode/contracts";
import { fromJsonStringPretty } from "@starcode/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PeerRegistry from "../peers/PeerRegistry.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const encodePeerJson = Schema.encodeUnknownEffect(fromJsonStringPretty(PeerEnvironment));
const encodePeersJson = Schema.encodeUnknownEffect(
  fromJsonStringPretty(Schema.Array(PeerEnvironment)),
);

/**
 * Runs against the registry file directly rather than over HTTP.
 *
 * The registry is a local file plus a secret in the local secret store, and
 * this command runs on the machine that owns both. Going through the server's
 * own HTTP API would mean the operator needed a credential for their own
 * machine before they could add a credential for someone else's — a bootstrap
 * problem with no answer on a fresh install.
 */
const runWithPeerRegistry = <A, E>(
  flags: CliAuthLocationFlags,
  run: (registry: PeerRegistry.PeerRegistry["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const registry = yield* PeerRegistry.PeerRegistry;
      return yield* run(registry);
    }).pipe(
      Effect.provide(
        PeerRegistry.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const nameArgument = Argument.string("name").pipe(
  Argument.withDescription("Local name for the peer. This is the name the peer_* tools take."),
  Argument.withSchema(PeerName),
);

const describePeer = (peer: PeerEnvironment): string => {
  const ssh = peer.sshUser === null ? "" : `\n    ssh:        ${peer.sshUser}@${hostOf(peer)}`;
  return [
    `  ${peer.name}`,
    `    url:        ${peer.baseUrl}`,
    `    label:      ${peer.label ?? "(unknown)"}`,
    ssh,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

const hostOf = (peer: PeerEnvironment): string => {
  try {
    return new URL(peer.baseUrl).hostname;
  } catch {
    return "?";
  }
};

const addCommand = Command.make("add", {
  ...authLocationFlags,
  name: nameArgument,
  url: Argument.string("url").pipe(
    Argument.withDescription(
      "Base URL of the peer, for example https://laptop.tailnet.ts.net:3773",
    ),
  ),
  token: Flag.string("token").pipe(
    Flag.withDescription(
      "Bearer token minted on the peer with `starcode auth session issue --token-only`. Use --pairing-token instead for a one-time pairing credential.",
    ),
    Flag.optional,
  ),
  pairingToken: Flag.string("pairing-token").pipe(
    Flag.withDescription("One-time pairing credential from the peer, redeemed on registration."),
    Flag.optional,
  ),
  sshUser: Flag.string("ssh-user").pipe(
    Flag.withDescription(
      "Login name for reaching this machine over SSH, reported by peers_list so an agent can run `ssh user@host`.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Register another starcode environment as a peer of this one."),
  Command.withHandler((flags) =>
    runWithPeerRegistry(
      flags,
      (registry) =>
        Effect.gen(function* () {
          // Refused rather than resolved by precedence: the two credentials come
          // from different commands on the peer and mean different things, and a
          // caller who passed both believes something about this call that
          // silently honouring one of them would leave wrong.
          if (Option.isSome(flags.token) === Option.isSome(flags.pairingToken)) {
            return yield* Console.error(
              Option.isSome(flags.token)
                ? "Pass --token or --pairing-token, not both."
                : "Pass --token (from `starcode auth session issue --token-only` on the peer) or --pairing-token.",
            );
          }

          const input = {
            name: flags.name,
            baseUrl: flags.url,
            credential: Option.isSome(flags.token)
              ? { token: flags.token.value }
              : { pairingToken: Option.getOrThrow(flags.pairingToken) },
            ...(Option.isSome(flags.sshUser) ? { sshUser: flags.sshUser.value } : {}),
          } as PeerRegisterInput;

          const peer = yield* registry.register(input);
          yield* Console.log(
            flags.json
              ? yield* encodePeerJson(peer)
              : `Registered peer ${peer.name}.\n${describePeer(peer)}\n`,
          );
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const listCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List the machines this environment is paired with."),
  Command.withHandler((flags) =>
    runWithPeerRegistry(
      flags,
      (registry) =>
        Effect.gen(function* () {
          const peers = yield* registry.list;
          if (flags.json) {
            return yield* Console.log(yield* encodePeersJson(peers));
          }
          yield* Console.log(
            peers.length === 0
              ? "No peers registered. Add one with `starcode peers add <name> <url> --token ...`.\n"
              : `${peers.map(describePeer).join("\n\n")}\n`,
          );
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const removeCommand = Command.make("remove", { ...authLocationFlags, name: nameArgument }).pipe(
  Command.withDescription("Forget a peer and drop its stored credential."),
  Command.withHandler((flags) =>
    runWithPeerRegistry(flags, (registry) =>
      Effect.gen(function* () {
        const removed = yield* registry.remove(flags.name);
        yield* Console.log(
          removed ? `Removed peer ${flags.name}.\n` : `No peer named ${flags.name}.\n`,
        );
      }),
    ),
  ),
);

/**
 * Exists because `setSshUser` was written, tested, and then reachable from
 * nowhere — no route, no command. The login could only be set while registering,
 * so recording one you had forgotten meant re-pairing the machine.
 */
const sshUserCommand = Command.make("ssh-user", {
  ...authLocationFlags,
  name: nameArgument,
  user: Argument.string("user").pipe(
    Argument.withDescription("Login name, or `-` to clear the one on record."),
  ),
}).pipe(
  Command.withDescription("Record how to reach a peer over SSH."),
  Command.withHandler((flags) =>
    runWithPeerRegistry(flags, (registry) =>
      Effect.gen(function* () {
        const sshUser = flags.user === "-" ? null : flags.user;
        const updated = yield* registry.setSshUser(flags.name, sshUser);
        yield* Console.log(
          !updated
            ? `No peer named ${flags.name}.\n`
            : sshUser === null
              ? `Cleared the SSH login for ${flags.name}.\n`
              : `${flags.name} is now reachable as ${sshUser}.\n`,
        );
      }),
    ),
  ),
);

export const peersCommand = Command.make("peers").pipe(
  Command.withDescription("Pair this environment with the other machines in the fleet."),
  Command.withSubcommands([addCommand, listCommand, removeCommand, sshUserCommand]),
);
