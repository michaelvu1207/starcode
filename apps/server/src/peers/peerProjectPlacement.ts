/**
 * Where a delegated thread lands on a peer, and what it starts as.
 *
 * `peer_thread_create({ project })` names a project by slug and lets the peer
 * decide which of its folders that is — which is the whole point of a slug, and
 * the reason no id ever crosses the wire in a direction it would be
 * meaningless. But "which folder" and "which model" are decisions the operator
 * has already recorded on the peer, in the category's `local.defaults`, and the
 * writer used to ignore both: it took `bindings[0]` and the *location's*
 * `defaultModelSelection`.
 *
 * Both are quiet failures. `bindings[0]` is file order, so a machine that binds
 * two folders under one project gets whichever the JSON happened to list first
 * — the same class of order-dependence `resolveLocalProjectMembership` refuses
 * one file over. And a category default that is silently overridden by a
 * location default is a setting the operator can watch have no effect.
 *
 * Pure, and separate from `PeerThreadWriter`, so the rules are readable and
 * testable without standing up an HTTP client.
 *
 * @module PeerProjectPlacement
 */
import type {
  ModelSelection,
  ProjectCategoryRecord,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

/** What the caller asked for explicitly. Absent means "use the peer's answer". */
export interface PeerThreadCreateOverrides {
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}

export type PeerProjectLocationChoice =
  | { readonly kind: "bound"; readonly projectId: ProjectId }
  /** The research project with no folder of its own — legal, but not somewhere
      a thread can start. */
  | { readonly kind: "unbound" }
  /** Several folders and nothing saying which. Refused rather than guessed. */
  | { readonly kind: "ambiguous"; readonly projectIds: ReadonlyArray<ProjectId> };

/**
 * Which of a peer's folders a project's new thread goes in.
 *
 * Three rules, in order:
 *
 * 1. **The operator's stated preference wins.** `defaults.preferredProjectId`
 *    is what the project's own home starts threads in, and a thread delegated
 *    into that project should land where a thread started by hand would.
 *    Required to be *among the bindings*: a preference naming a folder the
 *    category no longer binds is stale, and honouring it would file work
 *    outside the project it was delegated to.
 * 2. **One binding is not a choice.** The overwhelmingly common case, and it
 *    needs no preference to be unambiguous.
 * 3. **Several bindings and no preference is a question, not a default.**
 *    Answering it by file order is the failure that is invisible from inside
 *    the tool call that caused it; the caller can pass `projectId`, or the
 *    operator can set a preferred location, and either is one retry away.
 */
export function choosePeerProjectLocation(
  category: ProjectCategoryRecord,
): PeerProjectLocationChoice {
  const bound = category.local.bindings.map((binding) => binding.projectId);
  if (bound.length === 0) return { kind: "unbound" };

  const preferred = category.local.defaults.preferredProjectId ?? null;
  if (preferred !== null && bound.includes(preferred)) {
    return { kind: "bound", projectId: preferred };
  }

  const only = bound[0];
  if (bound.length === 1 && only !== undefined) return { kind: "bound", projectId: only };

  return { kind: "ambiguous", projectIds: bound };
}

/**
 * The model a delegated thread starts on.
 *
 * Three layers, weakest first: the folder's own default, then the category's —
 * which is machine-local precisely because a `ProviderInstanceId` inside it is
 * that server's provider config — then whatever the caller named outright.
 *
 * Returns null when nothing at any layer supplies a complete selection, which
 * the caller reports as the configuration problem it is rather than sending a
 * half-formed command.
 */
export function resolvePeerThreadModelSelection(input: {
  /** The peer folder's default. Null on a folder nobody configured. */
  readonly locationDefault: ModelSelection | null;
  /** The peer category's default, when the thread was placed by slug. */
  readonly categoryDefault?: ModelSelection | null | undefined;
  readonly overrides: PeerThreadCreateOverrides;
}): ModelSelection | null {
  const base = input.categoryDefault ?? input.locationDefault;
  const instanceId = input.overrides.instanceId ?? base?.instanceId;
  const model = input.overrides.model ?? base?.model;
  if (instanceId === undefined || model === undefined) return null;
  return { ...base, instanceId, model } as ModelSelection;
}

/**
 * How much a delegated thread may do before asking.
 *
 * Same three layers as the model, and the hardcoded floor is the cautious pair:
 * a thread created by an agent, on a machine the operator is not looking at,
 * defaults to asking. A category that says otherwise is the operator having
 * decided otherwise for that project.
 */
export function resolvePeerThreadModes(input: {
  readonly category?: ProjectCategoryRecord | undefined;
  readonly overrides: PeerThreadCreateOverrides;
}): { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode } {
  const defaults = input.category?.local.defaults;
  return {
    runtimeMode: input.overrides.runtimeMode ?? defaults?.runtimeMode ?? "approval-required",
    interactionMode: input.overrides.interactionMode ?? defaults?.interactionMode ?? "default",
  };
}
