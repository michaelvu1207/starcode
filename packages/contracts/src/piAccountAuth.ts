import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";

export const PiAccountAuthProvider = Schema.Literals(["anthropic", "openai"]);
export type PiAccountAuthProvider = typeof PiAccountAuthProvider.Type;

export const PiAccountAuthStartInput = Schema.Struct({ provider: PiAccountAuthProvider });
export const PiAccountAuthStartResult = Schema.Struct({
  attemptId: Schema.String,
  provider: PiAccountAuthProvider,
  authorizationUrl: Schema.String,
  instructions: Schema.String,
});

export const PiAccountAuthCaptureInput = Schema.Struct({ attemptId: Schema.String });
export const PiAccountAuthCaptureResult = Schema.Struct({
  status: Schema.Literals(["pending", "captured"]),
  provider: PiAccountAuthProvider,
  instanceId: Schema.NullOr(ProviderInstanceId),
  label: Schema.NullOr(Schema.String),
});

export const PiAccountTestInput = Schema.Struct({ instanceId: ProviderInstanceId });
export const PiAccountTestResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: Schema.String,
  latencyMs: Schema.Number,
});

export const PiAccountDeleteInput = Schema.Struct({ instanceId: ProviderInstanceId });
export const PiAccountDeleteResult = Schema.Struct({ instanceId: ProviderInstanceId });

export const PiAccountUsageRefreshInput = Schema.Struct({});
export const PiAccountUsageRefreshResult = Schema.Struct({
  refreshed: Schema.Number,
  unavailable: Schema.Number,
  failed: Schema.Number,
  failures: Schema.Array(Schema.Struct({ instanceId: ProviderInstanceId, message: Schema.String })),
});

export const PiAccountSyncInput = Schema.Struct({});
export const PiAccountSyncTarget = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  status: Schema.Literals(["synced", "pending"]),
  imported: NonNegativeInt,
});
export const PiAccountSyncResult = Schema.Struct({
  exported: NonNegativeInt,
  targets: Schema.Array(PiAccountSyncTarget),
});

export class PiAccountAuthError extends Schema.TaggedErrorClass<PiAccountAuthError>()(
  "PiAccountAuthError",
  {
    reason: Schema.Literals([
      "unsupported",
      "launch_failed",
      "not_found",
      "not_ready",
      "capture_failed",
      "test_failed",
      "sync_failed",
    ]),
    message: Schema.String,
  },
) {}
