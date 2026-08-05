import type { ProviderOptionSelections } from "@starcode/contracts";
import type { Model } from "@earendil-works/pi-ai";

export const PI_EFFORT_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiEffort = (typeof PI_EFFORT_VALUES)[number];

export const PI_CONTEXT_VALUES = ["200k", "600k", "1m"] as const;
export type PiContext = (typeof PI_CONTEXT_VALUES)[number];

const PI_CONTEXT_TOKENS: Readonly<Record<PiContext, number>> = {
  "200k": 200_000,
  "600k": 600_000,
  "1m": 1_000_000,
};

const effortValues = new Set<string>(PI_EFFORT_VALUES);
const contextValues = new Set<string>(PI_CONTEXT_VALUES);

type PiContextModel = Pick<Model<any>, "provider" | "id" | "contextWindow">;

/**
 * Starcode's Pi context presets are an explicit runtime override. They are not
 * constrained by the registry model's recommended/native context metadata:
 * Pi uses the selected value as its compaction window, including the larger
 * 600k and 1M opt-in windows for Codex-backed models.
 */
export function piContextChoicesForModel(_model: PiContextModel): ReadonlyArray<PiContext> {
  return PI_CONTEXT_VALUES;
}

/** The context Starcode should use when the caller has not made an explicit choice. */
export function piDefaultContextForModel(model: PiContextModel): PiContext | undefined {
  void model;
  return "600k";
}

/** Validate before passing a user-selected context to Pi or an upstream provider. */
export function assertPiContextSupported(model: PiContextModel, context: PiContext): void {
  const choices = piContextChoicesForModel(model);
  if (choices.includes(context)) return;
  throw new Error(
    `Pi context '${context}' is unsupported. Supported values: ${choices.join(", ")}.`,
  );
}

/**
 * Pi's provider option id is `effort`. `reasoningEffort` is accepted only as
 * an explicit compatibility alias for callers accustomed to Codex options.
 * Context uses the same `context` id and 200k / 600k / 1m values as Claude,
 * so the composer can present one familiar control across native agents.
 * Everything else is rejected so Pi can never silently fall back.
 */
export function canonicalizePiProviderOptions(
  options: ProviderOptionSelections | undefined,
): ProviderOptionSelections | undefined {
  if (options === undefined) return undefined;
  if (options.length === 0) return [];

  let effort: PiEffort | undefined;
  let context: PiContext | undefined;
  for (const option of options) {
    const id = option.id === "reasoningEffort" ? "effort" : option.id;
    if (id !== "effort" && id !== "context") {
      throw new Error(
        `Unsupported Pi provider option '${option.id}'. Supported options: 'effort' (compatibility alias: 'reasoningEffort') and 'context'.`,
      );
    }
    if (id === "context") {
      if (typeof option.value !== "string" || !contextValues.has(option.value)) {
        throw new Error(
          `Invalid Pi context '${String(option.value)}'. Supported values: ${PI_CONTEXT_VALUES.join(", ")}.`,
        );
      }
      const candidate = option.value as PiContext;
      if (context !== undefined && context !== candidate) {
        throw new Error(
          `Conflicting Pi context values '${context}' and '${candidate}' were supplied.`,
        );
      }
      context = candidate;
      continue;
    }
    if (typeof option.value !== "string" || !effortValues.has(option.value)) {
      throw new Error(
        `Invalid Pi effort '${String(option.value)}'. Supported values: ${PI_EFFORT_VALUES.join(", ")}.`,
      );
    }
    const candidate = option.value as PiEffort;
    if (effort !== undefined) {
      if (effort === candidate) continue;
      throw new Error(
        `Conflicting Pi effort values '${effort}' and '${candidate}' were supplied, possibly through both 'effort' and 'reasoningEffort'.`,
      );
    }
    effort = candidate;
  }

  return [
    ...(effort === undefined ? [] : [{ id: "effort", value: effort }]),
    ...(context === undefined ? [] : [{ id: "context", value: context }]),
  ];
}

export function readPiEffort(options: ProviderOptionSelections | undefined): PiEffort | undefined {
  const canonical = canonicalizePiProviderOptions(options);
  const value = canonical?.find((option) => option.id === "effort")?.value;
  return typeof value === "string" ? (value as PiEffort) : undefined;
}

export function readPiContext(
  options: ProviderOptionSelections | undefined,
): PiContext | undefined {
  const canonical = canonicalizePiProviderOptions(options);
  const value = canonical?.find((option) => option.id === "context")?.value;
  return typeof value === "string" ? (value as PiContext) : undefined;
}

export function piContextTokens(context: PiContext): number {
  return PI_CONTEXT_TOKENS[context];
}
