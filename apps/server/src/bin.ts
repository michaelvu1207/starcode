import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as NetService from "@starcode/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { connectCommand } from "./cli/connect.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { peersCommand } from "./cli/peers.ts";
import { pairCommand } from "./cli/pair.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { installRecoverableTransportErrorGuard } from "./recoverableTransportErrors.ts";

installRecoverableTransportErrorGuard(process);

// The desktop parent owns these pipes. During a backend restart or renderer
// reconnect it can close one while Node still has a pending write. Broken-pipe
// and connection-reset errors are transport teardown, not server failures.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ECONNRESET") throw error;
  });
}

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const connectPublicConfigMissingMessage =
  "starcode Connect commands are unavailable: this build is missing starcode Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const connectUnavailableCommand = Command.make("connect").pipe(
  Command.withDescription(
    "starcode Connect is unavailable in builds without public configuration.",
  ),
  Command.withHidden,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["starcode", "connect"],
        errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
      }),
    ),
  ),
);

export const makeCli = ({ cloudEnabled = hasCloudPublicConfig } = {}) =>
  Command.make("starcode", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the starcode server."),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      authCommand,
      projectCommand,
      peersCommand,
      pairCommand,
      serviceCommand,
      cloudEnabled ? connectCommand : connectUnavailableCommand,
    ]),
  );

export const cli = makeCli();

if (import.meta.main) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
