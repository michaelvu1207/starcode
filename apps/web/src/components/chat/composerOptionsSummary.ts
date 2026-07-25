/**
 * Fork-owned: the glanceable summary for the composer options chevron.
 *
 * Model / effort / access moved off the composer bar into a popover, so the
 * trigger has to keep the hidden state readable at a glance — hidden must not
 * mean invisible. This builds the short "Fable 5 · High · Full" label shown
 * beside the chevron and the longer sentence used as its tooltip.
 *
 * @module composerOptionsSummary
 */

export interface ComposerOptionsSummaryInput {
  /** Display name of the selected model, e.g. "Claude Fable 5". */
  readonly modelName: string | null | undefined;
  /** Current value of the provider's primary select option, e.g. "high". */
  readonly effort: string | null | undefined;
  /** Runtime-mode label, e.g. "Full access". */
  readonly accessLabel: string;
}

export interface ComposerOptionsSummary {
  /** Compact label rendered next to the chevron on wide bars. */
  readonly short: string;
  /** Full sentence used for the tooltip and the accessible name. */
  readonly detail: string;
  /** Ordered parts, for callers that want their own separators. */
  readonly parts: ReadonlyArray<string>;
}

/**
 * Providers prefix their model names with the vendor, which is redundant next
 * to a provider icon and too long for the bar. "Claude Fable 5" reads as
 * "Fable 5"; anything without a known prefix is left alone.
 */
const MODEL_NAME_PREFIXES = ["Claude ", "OpenAI ", "Cursor ", "Grok ", "GPT-"] as const;

export function shortenComposerModelName(modelName: string): string {
  const trimmed = modelName.trim();
  for (const prefix of MODEL_NAME_PREFIXES) {
    if (trimmed.length > prefix.length && trimmed.startsWith(prefix)) {
      // "GPT-5.5" keeps its prefix — it is the name, not a vendor tag.
      if (prefix === "GPT-") return trimmed;
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

/** Title-case a raw option value ("xhigh" stays "Xhigh"-free via the map). */
const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
  minimal: "Minimal",
  none: "None",
};

export function formatComposerEffortLabel(effort: string): string {
  const normalized = effort.trim();
  if (normalized.length === 0) return "";
  return EFFORT_LABELS[normalized.toLowerCase()] ?? normalized;
}

/**
 * Access labels are sentences ("Full access", "Auto-accept edits"). On the bar
 * only the distinguishing first word fits.
 */
export function shortenComposerAccessLabel(accessLabel: string): string {
  const trimmed = accessLabel.trim();
  if (trimmed.length === 0) return "";
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function buildComposerOptionsSummary(
  input: ComposerOptionsSummaryInput,
): ComposerOptionsSummary {
  const shortParts: Array<string> = [];
  const detailParts: Array<string> = [];

  const modelName = input.modelName?.trim();
  if (modelName) {
    shortParts.push(shortenComposerModelName(modelName));
    detailParts.push(modelName);
  }

  const effort = input.effort?.trim();
  if (effort) {
    const label = formatComposerEffortLabel(effort);
    shortParts.push(label);
    detailParts.push(`${label} reasoning`);
  }

  const access = input.accessLabel.trim();
  if (access) {
    shortParts.push(shortenComposerAccessLabel(access));
    detailParts.push(access);
  }

  return {
    short: shortParts.join(" · "),
    detail: detailParts.length > 0 ? detailParts.join(" · ") : "Model and session options",
    parts: shortParts,
  };
}
