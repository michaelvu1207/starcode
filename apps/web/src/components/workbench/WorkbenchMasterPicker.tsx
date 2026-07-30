/**
 * Fork-owned: choosing which thread orchestrates.
 *
 * Inline rather than a modal. The surface it fills is an empty pane the size of
 * a chat window, and a dialog over an empty region is a dialog for its own
 * sake. The same component doubles as the "change master" surface, so the two
 * paths cannot drift.
 */
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@starcode/client-runtime/environment";
import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/models";
import type { EnvironmentId, ScopedProjectRef } from "@starcode/contracts";
import { ServerIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { Input } from "../ui/input";

export interface WorkbenchMasterPickerProps {
  readonly currentThreadKey: string | null;
  readonly onPick: (environmentId: EnvironmentId, threadId: string) => void;
  readonly onCreate: (projectRef: ScopedProjectRef) => void;
  /**
   * Split view reuses this picker to fill its second pane, where a brand-new
   * thread is a client-side draft rather than the server thread that pane
   * renders. An optional prop rather than a generalisation: the component
   * stays where it is and keeps its name.
   */
  readonly showCreate?: boolean;
}

interface PickerRow {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string;
  readonly projectTitle: string | null;
}

const MAX_ROWS = 40;

export function WorkbenchMasterPicker({
  currentThreadKey,
  onPick,
  onCreate,
  showCreate = true,
}: WorkbenchMasterPickerProps) {
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [query, setQuery] = useState("");

  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const projectTitleByKey = useMemo(
    () =>
      new Map(
        projects.map(
          (project) => [`${project.environmentId}:${project.id}`, project.title] as const,
        ),
      ),
    [projects],
  );

  const rows = useMemo((): ReadonlyArray<PickerRow> => {
    const needle = query.trim().toLowerCase();
    return threads
      .filter((thread) => thread.archivedAt === null)
      .map(
        (thread): PickerRow => ({
          key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread,
          environmentLabel: environmentLabelById.get(thread.environmentId) ?? thread.environmentId,
          projectTitle:
            projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
        }),
      )
      .filter(
        (row) =>
          needle.length === 0 ||
          row.thread.title.toLowerCase().includes(needle) ||
          row.environmentLabel.toLowerCase().includes(needle) ||
          (row.projectTitle?.toLowerCase().includes(needle) ?? false),
      )
      .toSorted(
        (left, right) =>
          Date.parse(right.thread.updatedAt) - Date.parse(left.thread.updatedAt) ||
          left.thread.id.localeCompare(right.thread.id),
      )
      .slice(0, MAX_ROWS);
  }, [environmentLabelById, projectTitleByKey, query, threads]);

  // Creating a master is only offered on the machine this client is served by:
  // the write tools are issued by the server hosting the thread, so an
  // orchestrator on a machine the operator is not sitting at is a decision to
  // make deliberately, by designating an existing thread there.
  const localProjects = useMemo(
    () => projects.filter((project) => project.environmentId === primaryEnvironmentId),
    [primaryEnvironmentId, projects],
  );

  return (
    <div className="flex min-h-0 w-full max-w-lg flex-col gap-3">
      <Input
        type="search"
        placeholder="Search threads on any machine"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        spellCheck={false}
        data-testid="workbench-master-search"
      />

      <ul className="min-h-0 max-h-72 overflow-y-auto rounded-lg border border-border/60 bg-card">
        {rows.length === 0 ? (
          <li className="px-3 py-4 text-xs text-muted-foreground/60">No threads match.</li>
        ) : (
          rows.map((row) => (
            <li key={row.key} className="border-b border-border/40 last:border-b-0">
              <button
                type="button"
                onClick={() => onPick(row.thread.environmentId, row.thread.id)}
                data-testid="workbench-master-option"
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/40",
                  row.key === currentThreadKey && "bg-primary/8",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {row.thread.title}
                </span>
                {row.projectTitle !== null ? (
                  <span className="max-w-28 shrink-0 truncate text-[11px] text-muted-foreground/60">
                    {row.projectTitle}
                  </span>
                ) : null}
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/70">
                  <ServerIcon aria-hidden className="size-3" />
                  <span className="max-w-24 truncate">{row.environmentLabel}</span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>

      {showCreate && localProjects.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground/60">or start a new one in</span>
          {localProjects.map((project) => (
            <button
              key={`${project.environmentId}:${project.id}`}
              type="button"
              onClick={() => onCreate(scopeProjectRef(project.environmentId, project.id))}
              data-testid="workbench-master-create"
              className="cursor-pointer rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/40"
            >
              {project.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
