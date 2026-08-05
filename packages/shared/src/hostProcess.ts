import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@starcode/shared/hostProcess/HostProcessPlatform",
  {
    defaultValue: () => process.platform,
  },
);

export const HostProcessArchitecture = Context.Reference<NodeJS.Architecture>(
  "@starcode/shared/hostProcess/HostProcessArchitecture",
  {
    defaultValue: () => process.arch,
  },
);

export const HostProcessHostname = Context.Reference<string>(
  "@starcode/shared/hostProcess/HostProcessHostname",
  {
    defaultValue: () => NodeOS.hostname(),
  },
);

export const HostProcessEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "@starcode/shared/hostProcess/HostProcessEnvironment",
  {
    defaultValue: () => process.env,
  },
);

export const HostProcessWorkingDirectory = Context.Reference<string>(
  "@starcode/shared/hostProcess/HostProcessWorkingDirectory",
  {
    defaultValue: () => process.cwd(),
  },
);

export const HostProcessExecutablePath = Context.Reference<string>(
  "@starcode/shared/hostProcess/HostProcessExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const HostProcessArguments = Context.Reference<ReadonlyArray<string>>(
  "@starcode/shared/hostProcess/HostProcessArguments",
  {
    defaultValue: () => process.argv,
  },
);

export const HostProcessUserId = Context.Reference<number | null>(
  "@starcode/shared/hostProcess/HostProcessUserId",
  {
    defaultValue: () => (typeof process.getuid === "function" ? process.getuid() : null),
  },
);

export const isHostWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
