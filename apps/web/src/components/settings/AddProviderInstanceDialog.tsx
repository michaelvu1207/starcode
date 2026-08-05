"use client";

import { useEffect, useState } from "react";

import type { PiAccountAuthProvider } from "@starcode/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@starcode/client-runtime/state/runtime";

import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialProvider?: PiAccountAuthProvider | undefined;
  readonly onAccountCaptured?: (() => Promise<void> | void) | undefined;
}

export const ACCOUNT_SIGN_IN_PROVIDERS = ["anthropic", "openai"] as const;

export function AddProviderInstanceDialog({
  open,
  onOpenChange,
  initialProvider,
  onAccountCaptured,
}: AddProviderInstanceDialogProps) {
  const primaryEnvironment = usePrimaryEnvironment();
  const startAuth = useAtomCommand(serverEnvironment.startPiAccountAuth, { reportFailure: false });
  const captureAuth = useAtomCommand(serverEnvironment.capturePiAccountAuth, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [attempt, setAttempt] = useState<{
    attemptId: string;
    provider: PiAccountAuthProvider;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setAttempt(null);
  }, [open]);

  const beginSignIn = async (provider: PiAccountAuthProvider) => {
    if (!primaryEnvironment) return;
    setBusy(true);
    try {
      const result = await startAuth({
        environmentId: primaryEnvironment.environmentId,
        input: { provider },
      });
      if (result._tag !== "Success") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      setAttempt({ attemptId: result.value.attemptId, provider });
      await ensureLocalApi().shell.openExternal(result.value.authorizationUrl);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start sign-in",
        description: error instanceof Error ? error.message : "Sign-in failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const saveAccount = async () => {
    if (!primaryEnvironment || !attempt) return;
    setBusy(true);
    try {
      const result = await captureAuth({
        environmentId: primaryEnvironment.environmentId,
        input: { attemptId: attempt.attemptId },
      });
      if (result._tag !== "Success") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      if (result.value.status === "pending") {
        toastManager.add({
          type: "info",
          title: "Sign-in is not finished",
          description: "Finish signing in in the browser, then choose Save account again.",
        });
        return;
      }
      await refreshProviders({
        environmentId: primaryEnvironment.environmentId,
        input: {},
      });
      await onAccountCaptured?.();
      toastManager.add({
        type: "success",
        title: "Account saved",
        description: `${result.value.label ?? "Account"} is ready to use.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save account",
        description: error instanceof Error ? error.message : "Credential capture failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const provider = attempt?.provider ?? initialProvider;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{initialProvider ? "Sign in again" : "Add account"}</DialogTitle>
          <DialogDescription>
            Choose the subscription account you want Starcode to use.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-5">
          {provider === undefined || provider === "anthropic" ? (
            <Button
              className="w-full"
              variant="outline"
              disabled={busy}
              onClick={() => void beginSignIn("anthropic")}
            >
              Sign in with Claude
            </Button>
          ) : null}
          {provider === undefined || provider === "openai" ? (
            <Button
              className="w-full"
              variant="outline"
              disabled={busy}
              onClick={() => void beginSignIn("openai")}
            >
              Sign in with OpenAI
            </Button>
          ) : null}
          {attempt ? (
            <p className="text-xs text-muted-foreground">
              Finish the official sign-in in your browser, then return here and save the account.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {attempt ? (
            <Button disabled={busy} onClick={() => void saveAccount()}>
              Save account
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
