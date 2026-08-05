/**
 * The project slug, alone in a leaf module.
 *
 * It lives apart from the rest of `projectCatalog.ts` for one structural
 * reason: `peers.ts` needs it (a `peer_thread_create` can name a project by
 * slug), and `projectCatalog.ts` reaches `settings.ts` for
 * `WorkbenchMasterDefaults`, which reaches `featureFlow.ts`, which reaches
 * `peers.ts`. Importing the slug from the big module would close that ring, and
 * a cycle between schema modules does not fail at build time — it fails at
 * module-evaluation time, with one of the schemas simply being `undefined` when
 * another reads its AST. This file depends on `baseSchemas.ts` and nothing
 * else, so it can be imported from anywhere in the graph.
 *
 * `projectCatalog.ts` re-exports everything here, so no call site needs to know
 * this file exists.
 *
 * @module ProjectCategorySlug
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PROJECT_CATEGORY_SLUG_MAX_LENGTH = 64;

/**
 * The identity, and the join key across machines.
 *
 * Immutable after creation — there is no rename-slug operation anywhere in this
 * contract, and renaming a category changes `display.title` only. That is what
 * makes name drift harmless: two machines can disagree about the title of a
 * category and still agree that it is the same category.
 */
export const ProjectCategorySlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_CATEGORY_SLUG_MAX_LENGTH),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("ProjectCategorySlug"));
export type ProjectCategorySlug = typeof ProjectCategorySlug.Type;

/**
 * Turns arbitrary text into a slug, or `null` when nothing survives.
 *
 * Lives in contracts rather than in either the server or the client because
 * both seed categories — the client from repository identity, the MCP tools
 * from a name an agent supplied — and two implementations of this would file
 * the same repository under two slugs.
 */
export function toProjectCategorySlug(input: string): ProjectCategorySlug | null {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_CATEGORY_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug.length === 0 ? null : (slug as ProjectCategorySlug);
}
