/**
 * The small controls a project heading carries, and which of them is always
 * there.
 *
 * Three buttons share one heading — new thread, edit, open — and until now each
 * one repeated the same class string inline. A fourth copy is how they start
 * disagreeing about padding, so the string lives here instead. A constants
 * module rather than a component: what varies between the three is the icon and
 * the handler, which is all of them, and a wrapper that took both as props would
 * be a `<button>` with extra steps.
 *
 * **Why one of them does not fade in.** Michael: *"I would make sure the map for
 * each project is visible by default. You should not have to highlight it."* The
 * map is the way into `/projects/$slug`, which is the project's own home — the
 * sky, its orchestrator, its threads. Making the only route to it something you
 * discover by hovering means an operator who does not already know it is there
 * never finds out. So `open` is permanent chrome and the other two still fade
 * in, which keeps the heading quiet while leaving its destination stated.
 *
 * Fading uses `opacity`, not `hidden`, so all three reserve their space at rest.
 * That is what stops the heading reflowing under the pointer, and it is also why
 * making one permanent moves nothing.
 */

/** Shared by all three: size, hit area, colour, and what hover does to it. */
const BASE =
  "shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none";

/**
 * A secondary action: invisible until the heading is hovered, and reachable
 * from the keyboard regardless — `focus-visible:opacity-100` is what keeps a
 * fade-in affordance from being a mouse-only one.
 */
export const SIDEBAR_PROJECT_ACTION_CLASS = `${BASE} opacity-0 focus-visible:opacity-100 group-hover/project:opacity-100`;

/** Always drawn. See the note above for why exactly one of the three is. */
export const SIDEBAR_PROJECT_ACTION_PERSISTENT_CLASS = BASE;
