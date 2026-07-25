/**
 * Per-connection display aliases.
 *
 * A connection's name comes from the machine it points at: the server puts a
 * `label` in its environment descriptor, the client copies that into the
 * catalog target at pairing time, and every surface reads it from there. That
 * name is the server's opinion, and it is often the wrong one for a hub — three
 * servers on one host all announce the same hostname, so the sidebar shows
 * "seablue" three times with no way to tell them apart.
 *
 * An alias is this client's own name for a connection. It is deliberately a
 * client concept: renaming touches nothing on the far machine, needs no new
 * capability, and therefore works against servers far older than this build.
 * The server label stays the fallback, so clearing an alias restores it.
 *
 * This module is the whole rule. It is pure so the store, the editors, and the
 * one label-resolution point in `state/environments.ts` cannot disagree about
 * what a trimmed-to-empty alias means.
 */

/** Long enough for "michael's macbook pro (work)", short enough for a sidebar row. */
export const CONNECTION_ALIAS_MAX_LENGTH = 40;

/**
 * The stored form of a typed alias, or `null` when the input carries no name.
 *
 * Whitespace-only input is not an alias — it is the user clearing the field,
 * which must fall back to the server label rather than render a blank row.
 * Interior runs of whitespace collapse so a pasted name cannot smuggle a line
 * break into a single-line row.
 */
export function normalizeConnectionAlias(input: string): string | null {
  const collapsed = input.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, CONNECTION_ALIAS_MAX_LENGTH).trimEnd();
}

/**
 * The name to render for a connection: its alias when it has one, the label
 * the server gave otherwise.
 *
 * Takes the raw stored alias rather than a pre-normalized one so a value that
 * predates a normalization change (or was hand-edited in localStorage) still
 * resolves the same way the editor would have written it.
 */
export function resolveConnectionDisplayName(
  alias: string | null | undefined,
  serverLabel: string,
): string {
  const normalized = alias === null || alias === undefined ? null : normalizeConnectionAlias(alias);
  return normalized ?? serverLabel;
}

/**
 * Rehydrate a persisted alias map, dropping anything that is not a usable
 * `environmentId -> alias` pair. Persisted UI state is untrusted input: it
 * survives version changes, other tabs, and hand edits.
 */
export function sanitizeConnectionAliases(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized: Record<string, string> = {};
  for (const [environmentId, alias] of Object.entries(value)) {
    if (environmentId.length === 0 || typeof alias !== "string") continue;
    const normalized = normalizeConnectionAlias(alias);
    if (normalized === null) continue;
    sanitized[environmentId] = normalized;
  }
  return sanitized;
}
