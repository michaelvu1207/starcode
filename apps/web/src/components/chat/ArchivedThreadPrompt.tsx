import { ArchiveRestoreIcon, LoaderIcon } from "lucide-react";
import { useCallback, useState } from "react";

import type { ScopedThreadRef } from "@starcode/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@starcode/client-runtime/state/runtime";

import { useThreadActions } from "../../hooks/useThreadActions";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function ArchivedThreadPrompt({
  threadRef,
  title,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}) {
  const { unarchiveThread } = useThreadActions();
  const [isRestoring, setIsRestoring] = useState(false);

  const handleUnarchive = useCallback(() => {
    if (isRestoring) return;
    setIsRestoring(true);
    void (async () => {
      const result = await unarchiveThread(threadRef);
      if (result._tag === "Success") return;
      setIsRestoring(false);
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to unarchive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  }, [isRestoring, threadRef, unarchiveThread]);

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 py-16"
      data-testid="archived-thread-prompt"
    >
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ArchiveRestoreIcon className="size-5" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-balance text-lg font-medium text-foreground">{title}</h1>
          <p className="text-pretty text-sm text-muted-foreground">
            This thread is archived. Unarchive it to view the conversation and continue working.
          </p>
        </div>
        <Button type="button" onClick={handleUnarchive} disabled={isRestoring}>
          {isRestoring ? <LoaderIcon className="animate-spin" aria-hidden /> : null}
          {isRestoring ? "Unarchiving…" : "Unarchive thread"}
        </Button>
      </div>
    </div>
  );
}
