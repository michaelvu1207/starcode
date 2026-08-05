/**
 * What the delete dialog promises, as text you can test.
 *
 * The copy is the contract here, not decoration. "Delete project" is a phrase
 * that in most software means the contents go too, and in this one it does not:
 * a category is a label held over threads that live in folders on machines, so
 * removing it removes the label. An operator who believes the other thing will
 * either never press the button or will press it once and stop trusting the
 * app. That makes the sentence a behaviour, and behaviour belongs somewhere a
 * test can reach — the dialog itself renders into a portal that no static
 * render can see.
 */

/**
 * The sentence under the title: what pressing this actually does.
 *
 * `unreachableCount` is the number of machines the fold could not read — asleep,
 * mid-rollout, or simply not answering. It changes two claims this used to make
 * unconditionally, and both were capable of being false:
 *
 * - **"every machine"**, when the delete is only sent to the machines that are
 *   connected. A machine that was never asked keeps the category and hands it
 *   back on its next poll.
 * - **"no threads"**, when the count is folded membership. If the machine
 *   holding the work is the quiet one, zero is what unavailable looks like, and
 *   saying it out loud turns "we don't know" into "there is nothing there".
 *
 * Unavailable is not empty (invariant 12), and the copy is where an operator
 * finds that out.
 */
export function projectDeleteConsequence(threadCount: number, unreachableCount = 0): string {
  const scope = unreachableCount === 0 ? "every machine" : "every machine that is answering";
  if (threadCount === 0) {
    const nothing =
      unreachableCount === 0
        ? "This project has no threads."
        : "No machine that is answering has threads filed here.";
    return `${nothing} Deleting it removes the category from ${scope}.`;
  }
  const threads = threadCount === 1 ? "1 thread" : `${threadCount} threads`;
  const verb = threadCount === 1 ? "is" : "are";
  return `This removes the category from ${scope}. The ${threads} filed under it ${verb} not deleted — they go back to Chats.`;
}

/**
 * What the machines nobody could ask mean for this delete.
 *
 * The same outcome as a refusal, reached a different way: the category survives
 * there and comes back to the fold on reconnect. Said *before* the button
 * rather than after, because unlike a refusal this one is knowable in advance —
 * and a delete that appears to succeed and then undoes itself a minute later is
 * the worst way to learn a fan-out was partial.
 */
export function projectDeleteUnreachableNote(labels: ReadonlyArray<string>): string | null {
  if (labels.length === 0) return null;
  const named = [...labels].toSorted((left, right) => left.localeCompare(right)).join(", ");
  const subject = labels.length === 1 ? "is not answering" : "are not answering";
  return `${named} ${subject}, so this cannot reach ${labels.length === 1 ? "it" : "them"}. If ${labels.length === 1 ? "it holds" : "any of them holds"} this project, it comes back on the next poll.`;
}

/** The invariants worth restating as a list, in the order they reassure. */
export const PROJECT_DELETE_GUARANTEES: ReadonlyArray<string> = [
  "No thread, worktree, branch or folder is touched.",
  "The name and its slug become available again.",
];

/**
 * What a partial fan-out means, said plainly.
 *
 * The important half is the second sentence. A machine that was asleep still
 * holds the category and hands it back to the fold on its next poll, so
 * without this the delete looks like it silently undid itself a minute later.
 */
export function projectDeleteRefusalHeadline(refusalCount: number): string {
  const subject = refusalCount === 1 ? "One machine" : `${refusalCount} machines`;
  const verb = refusalCount === 1 ? "has" : "have";
  return `${subject} still ${verb} it. It will come back on their next poll until they take the delete.`;
}
