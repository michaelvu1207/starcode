import type { DiscoveredLocalServer, EnvironmentId, ThreadId } from "@starcode/contracts";
import { useMemo } from "react";

import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);
const LOCAL_SERVER_REFERENCE =
  /(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?):(\d{1,5})/giu;

const collectReferencedPorts = (value: unknown, ports: Set<number>, seen: Set<object>): void => {
  if (typeof value === "string") {
    for (const match of value.matchAll(LOCAL_SERVER_REFERENCE)) {
      const port = Number(match[1]);
      if (port > 0 && port < 65_536) ports.add(port);
    }
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectReferencedPorts(entry, ports, seen);
    return;
  }
  for (const entry of Object.values(value)) collectReferencedPorts(entry, ports, seen);
};

export function selectThreadDiscoveredPorts(input: {
  readonly ports: ReadonlyArray<DiscoveredLocalServer>;
  readonly threadId: ThreadId | null;
  readonly evidence?: unknown;
}): ReadonlyArray<DiscoveredLocalServer> {
  if (!input.threadId) return EMPTY_PORTS;
  const referencedPorts = new Set<number>();
  collectReferencedPorts(input.evidence, referencedPorts, new Set());
  return input.ports.filter(
    (port) =>
      port.terminal?.threadId === input.threadId ||
      (port.terminal === null && referencedPorts.has(port.port)),
  );
}

export function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DiscoveredLocalServer> {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewEnvironment.discoveredServers({ environmentId, input: {} }),
  );
  return query.data?.servers ?? EMPTY_PORTS;
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly evidence?: unknown;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      selectThreadDiscoveredPorts({ ports, threadId: input.threadId, evidence: input.evidence }),
    [input.evidence, input.threadId, ports],
  );
}

export function useTerminalDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly terminalId: string | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId && input.terminalId
        ? ports.filter(
            (port) =>
              port.terminal?.threadId === input.threadId &&
              port.terminal.terminalId === input.terminalId,
          )
        : EMPTY_PORTS,
    [input.terminalId, input.threadId, ports],
  );
}
