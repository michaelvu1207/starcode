/**
 * A machine, drawn as a computer in that machine's own colour.
 *
 * One component for every surface that names a connection — the sidebar's
 * connection groups, the connections dropdown, the machine badge on a remote
 * thread row, the triage list — so a machine looks the same everywhere and the
 * colour is a thing you learn once. Which colour is `ConnectionMark.model.ts`'s
 * decision, and it is keyed on the environment id so renaming a connection
 * never repaints it.
 *
 * Purely decorative: every caller already renders the machine's name in text
 * beside it, so the glyph is `aria-hidden` and adds nothing to the accessible
 * name. Colour is never the only signal here — a machine that is *down* says so
 * with the status dot, which is semantic and stays semantic.
 */
import type { ReactNode } from "react";
import { MonitorIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { connectionAccentHue } from "./ConnectionMark.model";
import "./Connections.css";

export function ConnectionMark({
  environmentId,
  className,
}: {
  readonly environmentId: string;
  /** Sizing for the glyph; callers match the type beside it. */
  readonly className?: string;
}): ReactNode {
  return (
    <span
      aria-hidden
      className="sc-machine-mark inline-flex shrink-0 items-center"
      style={{ "--sc-machine-hue": `${connectionAccentHue(environmentId)}deg` } as never}
      data-testid="connection-mark"
      data-environment-id={environmentId}
    >
      <MonitorIcon className={cn("size-3.5", className)} />
    </span>
  );
}
