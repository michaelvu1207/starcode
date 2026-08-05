/**
 * The heading a plan names itself by.
 *
 * Lifted out of the web app so the server can read it too: a thread renames
 * itself to its plan the moment the plan lands, and the title it picks has to
 * be the same string the plan panel is already showing. Two implementations of
 * "the plan's title" that drifted apart would show a user one name in the
 * sidebar and another above the plan.
 *
 * @module ProposedPlanTitle
 */

/**
 * First markdown heading in the plan, at any level, or null.
 *
 * Any level rather than `#` alone because plans are written by models and by
 * hand, and one that opens `## Context` is naming itself just as much as one
 * that opens `# Context`. Leading whitespace up to three spaces is allowed for
 * the same reason CommonMark allows it.
 */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}
