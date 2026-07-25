/**
 * The seam between "somewhere that offers to import" and the import picker.
 *
 * Two surfaces already ask for the picker — the connections dropdown's footer
 * and the per-connection row in the connections view — and F12 phase 4 adds a
 * third from the command palette. All three call `openImportPicker` and none of
 * them knows what the picker is, so phase 4 can build a dialog, a route, or a
 * panel without touching a single call site.
 *
 * A window-event bus, the same shape as `commandPaletteBus` and
 * `previewActionBus`: the callers live in the sidebar tree and the picker will
 * not, and an event needs no provider wrapped around either of them.
 *
 * Nothing subscribes yet. Dispatching before phase 4 lands is a no-op, which is
 * the intended state — the seam is real and typed, the destination is not built.
 */
import type { EnvironmentId } from "@t3tools/contracts";

const EVENT_NAME = "t3code:open-import-picker";

export interface ImportPickerOpenDetail {
  /**
   * Which machine's terminal history to show first. `null` opens the picker
   * across every connection — what the dropdown's footer wants, where no single
   * machine is in context.
   */
  readonly environmentId: EnvironmentId | null;
}

/** Asks for the import picker, optionally pre-scoped to one machine. */
export function openImportPicker(environmentId: EnvironmentId | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ImportPickerOpenDetail>(EVENT_NAME, { detail: { environmentId } }),
  );
}

/**
 * Subscribes to import requests, returning the unsubscribe function. Phase 4's
 * picker calls this; nothing does yet.
 */
export function subscribeImportPicker(
  listener: (detail: ImportPickerOpenDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ImportPickerOpenDetail>).detail;
    if (detail !== undefined && detail !== null) listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
