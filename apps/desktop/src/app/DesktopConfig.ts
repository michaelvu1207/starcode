import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  starcodeHome: trimmedString("STARCODE_HOME"),
  devServerUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("STARCODE_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteStarcodeServerEntryPath: trimmedString("STARCODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.port("STARCODE_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("STARCODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("STARCODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("STARCODE_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("STARCODE_OTLP_TRACES_URL"),
  otlpExportIntervalMs: Config.int("STARCODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  // Discord application id for rich presence. Registered per-fork in the
  // Discord developer portal rather than shipped as a constant: the id is what
  // names and illustrates the presence, and a fork inheriting upstream's would
  // publish under upstream's branding. See docs/fork/DISCORD-PRESENCE.md.
  discordApplicationId: trimmedString("STARCODE_DISCORD_APP_ID"),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("STARCODE_DISABLE_AUTO_UPDATE"),
  mockUpdates: optionalBoolean("STARCODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.port("STARCODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
