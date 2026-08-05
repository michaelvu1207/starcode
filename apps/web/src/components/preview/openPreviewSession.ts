import type {
  EnvironmentId,
  BrowserNavigationTarget,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@starcode/contracts";
import type { AtomCommandResult } from "@starcode/client-runtime/state/runtime";

import { applyPreviewServerSnapshot, rememberPreviewUrl } from "~/previewStateStore";

interface OpenPreviewSessionInput<E> {
  openPreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewOpenInput;
  }) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;
  threadRef: ScopedThreadRef;
  url?: string;
  target?: BrowserNavigationTarget;
}

export async function openPreviewSession<E>(
  input: OpenPreviewSessionInput<E>,
): Promise<AtomCommandResult<PreviewSessionSnapshot, E>> {
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.target === undefined ? {} : { target: input.target }),
    },
  });
  if (result._tag === "Failure") {
    return result;
  }
  const snapshot = result.value;
  applyPreviewServerSnapshot(input.threadRef, snapshot);
  if (input.url !== undefined || input.target !== undefined) {
    rememberPreviewUrl(
      input.threadRef,
      snapshot.navStatus._tag === "Idle" ? (input.url ?? "") : snapshot.navStatus.url,
    );
  }
  return result;
}
