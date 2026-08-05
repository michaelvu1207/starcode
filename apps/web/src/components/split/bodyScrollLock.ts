/**
 * Fork-owned: a body scroll lock that survives two of them being open.
 *
 * The picker used to snapshot `body.style.overflow` and `paddingRight` per
 * instance and restore them on close. With one picker that is correct; with
 * two — one per split pane — the second one snapshots the *already mutated*
 * values, and closing them leaves the page unscrollable until reload. Only
 * the first acquire snapshots, only the last release restores.
 *
 * @module bodyScrollLock
 */

interface LockSnapshot {
  readonly documentOverscrollBehavior: string;
  readonly bodyOverflow: string;
  readonly bodyPaddingRight: string;
}

let holders = 0;
let snapshot: LockSnapshot | null = null;

/** Locks body scroll and returns the matching release. Safe to nest. */
export function acquireBodyScrollLock(): () => void {
  if (typeof document === "undefined") return () => {};

  const { documentElement, body } = document;

  if (holders === 0) {
    snapshot = {
      documentOverscrollBehavior: documentElement.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
    };
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
    documentElement.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }
  holders += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0 || snapshot === null) return;
    documentElement.style.overscrollBehavior = snapshot.documentOverscrollBehavior;
    body.style.overflow = snapshot.bodyOverflow;
    body.style.paddingRight = snapshot.bodyPaddingRight;
    snapshot = null;
  };
}

/** Test seam: the number of locks currently held. */
export function bodyScrollLockHolders(): number {
  return holders;
}
