import type { DiscoveredLocalServer, ThreadId } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectThreadDiscoveredPorts } from "./portDiscoveryState";

const threadId = "thread-1" as ThreadId;
const server = (
  port: number,
  terminal: DiscoveredLocalServer["terminal"] = null,
): DiscoveredLocalServer => ({
  host: "127.0.0.1",
  port,
  url: `http://localhost:${port}`,
  processName: "vite",
  pid: 123,
  terminal,
});

describe("selectThreadDiscoveredPorts", () => {
  it("selects servers owned by the thread terminal", () => {
    const owned = server(5173, { threadId, terminalId: "terminal-1" });
    expect(
      selectThreadDiscoveredPorts({
        ports: [owned, server(3000)],
        threadId,
      }),
    ).toEqual([owned]);
  });

  it("attributes an otherwise unowned port from task output", () => {
    const mentioned = server(4173);
    expect(
      selectThreadDiscoveredPorts({
        ports: [mentioned, server(8080)],
        threadId,
        evidence: { output: "ready at http://localhost:4173/dashboard" },
      }),
    ).toEqual([mentioned]);
  });

  it("does not steal a port owned by another task", () => {
    const other = server(5173, {
      threadId: "thread-2" as ThreadId,
      terminalId: "terminal-2",
    });
    expect(
      selectThreadDiscoveredPorts({
        ports: [other],
        threadId,
        evidence: "http://localhost:5173",
      }),
    ).toEqual([]);
  });
});
