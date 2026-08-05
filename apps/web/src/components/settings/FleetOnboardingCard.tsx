import type { FleetOnboardingResult } from "@starcode/client-runtime/onboarding";
import { isAtomCommandInterrupted } from "@starcode/client-runtime/state/runtime";
import { CheckIcon, NetworkIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { onboardFleetHost } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export function FleetOnboardingCard() {
  const runOnboarding = useAtomCommand(onboardFleetHost, { reportFailure: false });
  const [hostname, setHostname] = useState("");
  const [result, setResult] = useState<FleetOnboardingResult | null>(null);
  const [unexpectedError, setUnexpectedError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const trimmedHostname = hostname.trim();

  const start = async () => {
    if (trimmedHostname === "" || running) return;
    setRunning(true);
    setResult(null);
    setUnexpectedError(null);
    const commandResult = await runOnboarding({ hostname: trimmedHostname });
    setRunning(false);
    if (commandResult._tag === "Success") {
      setResult(commandResult.value);
      return;
    }
    if (!isAtomCommandInterrupted(commandResult)) {
      setUnexpectedError(
        "Fleet onboarding could not be started. Close and reopen Settings, then retry.",
      );
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-muted/15 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
          <NetworkIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Add a machine to this fleet</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            StarCode finds the machine on your tailnet, checks SSH, installs or reuses the service,
            joins it once, and verifies a test thread.
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <Input
          aria-label="Fleet machine hostname"
          placeholder="MacBook-Pro or host.example.ts.net"
          value={hostname}
          onChange={(event) => setHostname(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void start();
          }}
          disabled={running}
          spellCheck={false}
        />
        <Button onClick={() => void start()} disabled={running || trimmedHostname === ""}>
          {running ? (
            <>
              <Spinner className="size-3.5" />
              Setting up…
            </>
          ) : (
            "Set up"
          )}
        </Button>
      </div>

      {result?.status === "joined" ? (
        <div className="mt-4 rounded-md border border-success/30 bg-success/5 p-3" role="status">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CheckIcon className="size-4 text-success" aria-hidden />
            {result.node.label} joined and passed verification
          </div>
          <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
            {result.steps.map((entry) => (
              <li key={entry.stage} className="flex items-start gap-2">
                <CheckIcon className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
                <span>{entry.summary}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {result?.status === "diagnosed" ? (
        <div
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3"
          role="alert"
        >
          <div className="flex items-start gap-2">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">{result.diagnosis.summary}</p>
              <p className="mt-1 text-xs text-muted-foreground">{result.diagnosis.action}</p>
            </div>
          </div>
        </div>
      ) : null}

      {unexpectedError !== null ? (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {unexpectedError}
        </p>
      ) : null}
    </div>
  );
}
