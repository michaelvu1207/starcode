import type { DesktopBridge, DesktopWslState, ServerProvider } from "@starcode/contracts";
import type { UsageRateLimitWindow } from "@starcode/contracts";

export function formatUsageRemaining(window: UsageRateLimitWindow | undefined): string {
  if (window?.usedPercent === null || window?.usedPercent === undefined) return "Not reported";
  return `${Math.max(0, 100 - window.usedPercent).toFixed(0)}% remaining`;
}

export type PiAccountConnection = {
  readonly provider: ServerProvider;
  readonly family: "claude" | "gpt";
  readonly familyLabel: "Claude" | "GPT";
  readonly presentationDriver: "claudeAgent" | "codex";
};

/** Account identity belongs exclusively to Connections, never the model picker. */
export function derivePiAccountConnections(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<PiAccountConnection> {
  return providers
    .flatMap((provider): ReadonlyArray<PiAccountConnection> => {
      if (
        provider.driver !== "pi" ||
        provider.selectable === false ||
        String(provider.instanceId) === "pi"
      ) {
        return [];
      }
      const identity = `${provider.instanceId} ${provider.models
        .map((model) => `${model.subProvider ?? ""} ${model.slug}`)
        .join(" ")}`.toLowerCase();
      if (identity.includes("openrouter")) return [];
      if (identity.includes("anthropic") || identity.includes("claude")) {
        return [
          { provider, family: "claude", familyLabel: "Claude", presentationDriver: "claudeAgent" },
        ];
      }
      return [{ provider, family: "gpt", familyLabel: "GPT", presentationDriver: "codex" }];
    })
    .toSorted(
      (left, right) =>
        left.familyLabel.localeCompare(right.familyLabel) ||
        (left.provider.displayName ?? "").localeCompare(right.provider.displayName ?? "") ||
        String(left.provider.instanceId).localeCompare(String(right.provider.instanceId)),
    );
}

/** API-key-backed Pi providers are presented separately from subscriptions. */
export function derivePiApiConnections(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers
    .filter((provider) => {
      if (provider.driver !== "pi" || provider.selectable === false) return false;
      const identity = `${provider.instanceId} ${provider.displayName ?? ""} ${provider.models
        .map((model) => `${model.subProvider ?? ""} ${model.slug}`)
        .join(" ")}`.toLowerCase();
      return identity.includes("openrouter");
    })
    .toSorted((left, right) => String(left.instanceId).localeCompare(String(right.instanceId)));
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/** What ordering a connection row by: the machine's own name, never this
    client's alias for it. */
export interface SavedConnectionRowOrder {
  readonly environmentId: string;
  readonly serverLabel: string;
}

export function isFleetManagedConnectionTarget(
  environmentId: string,
  target: {
    readonly _tag: string;
    readonly connectionId?: string;
  },
): boolean {
  return (
    target._tag === "BearerConnectionTarget" && target.connectionId === `fleet:${environmentId}`
  );
}

/**
 * Row order for Settings → Connections.
 *
 * Keyed on the server label rather than the displayed one because the
 * displayed one is editable in place: sorting by the alias moves a row the
 * moment you finish renaming it, and on a hub where several machines announce
 * the same hostname the row that slides into the vacated position carries the
 * same name it did before. The rename looks like it did not take.
 *
 * The environment id breaks ties so two servers on one host hold a fixed
 * order instead of swapping between renders and reloads.
 */
export function compareSavedConnectionRows(
  left: SavedConnectionRowOrder,
  right: SavedConnectionRowOrder,
): number {
  return (
    left.serverLabel.localeCompare(right.serverLabel) ||
    left.environmentId.localeCompare(right.environmentId)
  );
}

export function formatPiUsageFailure(message: string): {
  readonly message: string;
  readonly needsSignIn: boolean;
} {
  const needsSignIn = message.includes("saved authentication expired");
  return {
    needsSignIn,
    message: needsSignIn
      ? "Sign in again — Starcode's saved authentication expired. Other apps may still be signed in."
      : message,
  };
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
