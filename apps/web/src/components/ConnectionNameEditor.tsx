/**
 * Renaming a connection, in the two places you look at connections: the
 * sidebar's machine groups and Settings → Connections.
 *
 * Fork-owned. The rename is a client-side alias (see `connection/connectionAlias`),
 * so this component writes to local storage and nothing else — there is no
 * request, no capability to check, and no reason to disable it when the machine
 * is unreachable. Renaming a connection that is down is in fact the common case:
 * you name it so you can tell which one is down.
 *
 * The two surfaces differ enough in chrome (a sidebar group header is a button,
 * so the pencil cannot live inside it) that this exports the trigger and the
 * input separately and lets each call site own its own edit state, rather than
 * forcing one layout on both.
 */
import { PencilIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { CONNECTION_ALIAS_MAX_LENGTH } from "~/connection/connectionAlias";
import { useConnectionAliasStore } from "~/connection/connectionAliasStore";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

export function ConnectionRenameTrigger({
  displayName,
  className,
  onStart,
}: {
  readonly displayName: string;
  readonly className?: string;
  readonly onStart: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid="connection-rename-trigger"
      aria-label={`Rename ${displayName}`}
      title={`Rename ${displayName}`}
      onClick={(event) => {
        event.stopPropagation();
        onStart();
      }}
      className={cn(
        "shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
        className,
      )}
    >
      <PencilIcon aria-hidden className="size-3" />
    </button>
  );
}

/**
 * The input, mounted in place of the name while editing.
 *
 * Commits on Enter and on blur — a rename is one field with an obvious value,
 * and a Save button next to it in a sidebar row would cost more than it earns.
 * Escape reverts. Submitting an empty field clears the alias, which is the only
 * way back to the server's own name and so must stay reachable by typing.
 */
export function ConnectionNameInput({
  environmentId,
  serverLabel,
  className,
  onDone,
}: {
  readonly environmentId: string;
  readonly serverLabel: string;
  readonly className?: string;
  readonly onDone: () => void;
}): ReactNode {
  const storedAlias = useConnectionAliasStore(
    (store) => store.aliasByEnvironmentId[environmentId] ?? "",
  );
  const setConnectionAlias = useConnectionAliasStore((store) => store.setConnectionAlias);
  const [value, setValue] = useState(storedAlias);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // `commit` runs from both Enter and blur, and Enter blurs the input; the guard
  // keeps the second call from writing an alias the user already escaped out of.
  const settled = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    setConnectionAlias(environmentId, value);
    onDone();
  }, [environmentId, onDone, setConnectionAlias, value]);

  const cancel = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    onDone();
  }, [onDone]);

  return (
    <Input
      ref={inputRef}
      autoFocus
      nativeInput
      size="sm"
      data-testid="connection-rename-input"
      aria-label={`Name for ${serverLabel}`}
      className={cn("min-w-0 flex-1", className)}
      maxLength={CONNECTION_ALIAS_MAX_LENGTH}
      placeholder={serverLabel}
      value={value}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
}
