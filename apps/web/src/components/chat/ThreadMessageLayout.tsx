import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The visual frame for a user message in any thread reading surface.
 *
 * Live threads add their timestamp/actions through `footer`; read-only
 * histories omit it. Keeping the bubble here prevents history and nested-agent
 * readers from inventing their own message geometry.
 */
export function ThreadUserMessageLayout(props: {
  readonly children: ReactNode;
  readonly footer?: ReactNode | undefined;
  readonly muted?: boolean | undefined;
}): ReactNode {
  return (
    <div className="group flex flex-col items-end gap-1">
      <div
        className={cn(
          "relative max-w-[80%] min-w-0 rounded-2xl bg-accent p-3",
          props.muted === true && "bg-accent/50 text-muted-foreground",
        )}
      >
        {props.children}
      </div>
      {props.footer}
    </div>
  );
}

/**
 * The visual frame for an assistant message in any thread reading surface.
 */
export function ThreadAssistantMessageLayout(props: {
  readonly children: ReactNode;
  readonly muted?: boolean | undefined;
}): ReactNode {
  return (
    <div
      className={cn(
        "relative min-w-0 px-1 py-0.5",
        props.muted === true && "text-muted-foreground",
      )}
    >
      {props.children}
    </div>
  );
}
