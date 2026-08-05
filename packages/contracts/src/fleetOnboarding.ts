import * as Schema from "effect/Schema";

const FleetOnboardingSshTarget = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});

export const DesktopFleetOnboardingHost = Schema.Struct({
  hostname: Schema.String,
  dnsName: Schema.NullOr(Schema.String),
  addresses: Schema.Array(Schema.String),
  online: Schema.Boolean,
  sshTarget: FleetOnboardingSshTarget,
});
export type DesktopFleetOnboardingHost = typeof DesktopFleetOnboardingHost.Type;

export const DesktopFleetHostDiscovery = Schema.Struct({
  tailnetName: Schema.NullOr(Schema.String),
  backendState: Schema.NullOr(Schema.String),
  hosts: Schema.Array(DesktopFleetOnboardingHost),
});
export type DesktopFleetHostDiscovery = typeof DesktopFleetHostDiscovery.Type;

export const DesktopFleetPreflightDiagnosticCategory = Schema.Literals([
  "ssh-client-unavailable",
  "host-unreachable",
  "ssh-connection-failed",
  "host-key-rejected",
  "authentication-failed",
  "remote-shell-unsupported",
  "probe-output-invalid",
  "unsupported-os",
  "node-missing",
  "node-version-unknown",
  "node-version-unsupported",
  "package-manager-missing",
  "starcode-not-installed",
  "starcode-service-not-installed",
  "starcode-service-stopped",
  "port-occupied",
  "port-status-unknown",
  "tailscale-missing",
  "tailscale-not-running",
]);
export type DesktopFleetPreflightDiagnosticCategory =
  typeof DesktopFleetPreflightDiagnosticCategory.Type;

export const DesktopFleetPreflightDiagnostic = Schema.Struct({
  category: DesktopFleetPreflightDiagnosticCategory,
  severity: Schema.Literals(["info", "warning", "error"]),
  summary: Schema.String,
  action: Schema.String,
});
export type DesktopFleetPreflightDiagnostic = typeof DesktopFleetPreflightDiagnostic.Type;

export const DesktopFleetOnboardingPreflight = Schema.Struct({
  readyForProvisioning: Schema.Boolean,
  platform: Schema.Literals(["linux", "darwin", "windows", "unknown"]),
  starcodeInstalled: Schema.Boolean,
  starcodeServiceRunning: Schema.Boolean,
  port: Schema.Struct({
    number: Schema.Number,
    status: Schema.Literals(["available", "occupied", "unknown"]),
    owner: Schema.NullOr(Schema.String),
  }),
  diagnostics: Schema.Array(DesktopFleetPreflightDiagnostic),
});
export type DesktopFleetOnboardingPreflight = typeof DesktopFleetOnboardingPreflight.Type;
