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

/** The sentence under the title: what pressing this actually does. */
export function projectDeleteConsequence(threadCount: number): string {
  if (threadCount === 0) {
    return "This project has no threads. Deleting it removes the category from every machine.";
  }
  const threads = threadCount === 1 ? "1 thread" : `${threadCount} threads`;
  const verb = threadCount === 1 ? "is" : "are";
  return `This removes the category from every machine. The ${threads} filed under it ${verb} not deleted — they go back to Chats.`;
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
