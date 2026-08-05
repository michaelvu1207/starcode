/**
 * Fork-owned: which pane a component belongs to, and whether that pane owns
 * the keyboard right now.
 *
 * Two mounted `ChatView`s each register their own window and document key
 * handlers — there is no keybinding registry to gate centrally, only call
 * sites — so ownership is asked for at each one. The hooks here are the only
 * way to ask.
 *
 * Outside a split pane there is no provider, `usePaneId()` is `null`, and
 * every gate answers `true`. That is the property that keeps the single-pane
 * app byte-identical.
 *
 * @module SplitPaneContext
 */
import { createContext, use, useCallback, useEffect, useRef, type ReactNode } from "react";

import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { paneOwnsKeyboard, resolveKeyboardOwner, type SplitPaneId } from "./Split.logic";
import { useSplitStore } from "./splitStore";

const SplitPaneIdContext = createContext<SplitPaneId | null>(null);

/** `null` when the component is not inside a split pane. */
export function usePaneId(): SplitPaneId | null {
  return use(SplitPaneIdContext);
}

/**
 * Composer handles by pane, so the command palette can insert into the pane
 * the user is actually looking at. Panes register on mount; the app-wide ref
 * provided by `CommandPalette` remains the fallback for the single-pane case,
 * where nothing registers here at all.
 */
const composerHandleByPane = new Map<SplitPaneId, ComposerHandleRef>();

export function resolveFocusedComposerHandle(
  fallback: ComposerHandleRef | null,
): ChatComposerHandle | null {
  const owner = resolveCurrentKeyboardOwner();
  const registered = composerHandleByPane.get(owner);
  return registered?.current ?? fallback?.current ?? null;
}

/** The owning pane right now, read without subscribing. */
export function resolveCurrentKeyboardOwner(): SplitPaneId {
  const { renderState, focusedPane } = useSplitStore.getState();
  return resolveKeyboardOwner({ renderState, focusedPane });
}

/**
 * Reactive ownership, for render-time decisions (disabled affordances, focus
 * rings). Event handlers should use `usePaneKeyboardGate` instead: it is
 * stable, so it does not churn the dependency arrays of the very large
 * effects it guards.
 */
export function usePaneOwnsKeyboard(): boolean {
  const paneId = usePaneId();
  const renderState = useSplitStore((state) => state.renderState);
  const focusedPane = useSplitStore((state) => state.focusedPane);
  return paneOwnsKeyboard({
    paneId,
    keyboardOwner: resolveKeyboardOwner({ renderState, focusedPane }),
  });
}

/**
 * The gate, as a stable predicate. Call it inside the handler, not outside:
 * ownership is a property of the moment the key was pressed.
 */
export function usePaneKeyboardGate(): () => boolean {
  const paneId = usePaneId();
  return useCallback(
    () => paneOwnsKeyboard({ paneId, keyboardOwner: resolveCurrentKeyboardOwner() }),
    [paneId],
  );
}

/**
 * Marks its subtree as one pane.
 *
 * Two things happen here that nothing else does:
 *
 * 1. **A per-pane composer handle.** `ChatView` reads
 *    `useComposerHandleContext() ?? localComposerRef`, and the app-wide
 *    provider means the last composer to mount wins the ref — so
 *    `insertTextAtEnd`, `focusAtEnd` and `getSendContext` in one pane would
 *    drive the other pane's composer. Providing a fresh ref per pane fixes it
 *    with no `ChatView` edit at all.
 * 2. **Focus follows the pointer *and* programmatic focus.** `focusin` is
 *    listened for as well as `pointerdown`, so a pane that grabs focus in code
 *    also takes ownership — which is what keeps `document.activeElement`-based
 *    helpers like `getTerminalFocusOwner` agreeing with the owner.
 *
 * `closing` is the mid-drag warning: this is the pane that release would
 * dismiss. It scrims rather than resizes, because the panes hold two live
 * transcripts and reflowing one to nothing on every armed frame — and back
 * again on every cancel — is a lot of layout to spend on a preview. The rule
 * down the scrim's outer edge is where the divider would have ended up.
 */
export function SplitPaneProvider({
  paneId,
  className,
  closing = false,
  children,
}: {
  readonly paneId: SplitPaneId;
  readonly className?: string;
  readonly closing?: boolean;
  readonly children: ReactNode;
}) {
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const focusPane = useSplitStore((state) => state.focusPane);
  const focusedPane = useSplitStore((state) => state.focusedPane);

  useEffect(() => {
    composerHandleByPane.set(paneId, composerRef);
    return () => {
      if (composerHandleByPane.get(paneId) === composerRef) {
        composerHandleByPane.delete(paneId);
      }
    };
  }, [paneId]);

  const takeFocus = useCallback(() => {
    if (useSplitStore.getState().focusedPane === paneId) return;
    focusPane(paneId);
  }, [focusPane, paneId]);

  return (
    <SplitPaneIdContext value={paneId}>
      <ComposerHandleContext value={composerRef}>
        <div
          data-split-pane={paneId}
          data-split-pane-focused={focusedPane === paneId ? "true" : "false"}
          data-split-pane-closing={closing ? "true" : "false"}
          className={className}
          onPointerDownCapture={takeFocus}
          onFocusCapture={takeFocus}
        >
          {children}
          {closing ? (
            <div className="sc-split-pane-scrim" data-testid={`split-scrim-${paneId}`}>
              <span className="sc-split-pane-scrim-label">Release to close this pane</span>
            </div>
          ) : null}
        </div>
      </ComposerHandleContext>
    </SplitPaneIdContext>
  );
}
