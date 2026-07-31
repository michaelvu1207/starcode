import type { DesktopBridge, DesktopWslState } from "@starcode/contracts";

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
