/**
 * When a thread last actually did something.
 *
 * The one survivor of the settle/snooze module this file replaced: ranking a
 * sidebar by attention still needs a single "last activity" instant, and the
 * answer is the latest of the four timestamps a shell carries — the user's last
 * message and the latest turn's request, start and completion. `updatedAt` is
 * deliberately not among them: it moves for bookkeeping writes that are not the
 * thread doing anything.
 */
import type { OrchestrationThreadShell } from "@t3tools/contracts";

export function threadLastActivityAt(shell: OrchestrationThreadShell): string | null {
  const candidates = [
    shell.latestUserMessageAt,
    shell.latestTurn?.requestedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.completedAt,
  ];
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}
