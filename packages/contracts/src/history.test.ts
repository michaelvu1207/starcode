import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  HistoryForkRecord,
  HistoryForkResult,
  HistoryImportsPage,
  HistoryProvider,
} from "./history.ts";

const decodeHistoryProvider = Schema.decodeUnknownSync(HistoryProvider);
const decodeHistoryImportsPage = Schema.decodeUnknownSync(HistoryImportsPage);
const decodeHistoryForkResult = Schema.decodeUnknownSync(HistoryForkResult);
const decodeHistoryForkRecord = Schema.decodeUnknownSync(HistoryForkRecord);

const forkRecord = (provider: "claude" | "codex" | "pi") => ({
  threadId: "thread-fork",
  sourceThreadId: "thread-source",
  sourceTitle: "Source thread",
  sourceSessionId: "session-source",
  provider,
  projectId: "project-source",
  forkedAt: "2026-08-04T12:00:00.000Z",
  historySessionId: null,
  startedAt: null,
});

describe("history provider vocabularies", () => {
  it("keeps terminal-history decoding limited to legacy CLI stores", () => {
    expect(decodeHistoryProvider("claude")).toBe("claude");
    expect(decodeHistoryProvider("codex")).toBe("codex");
    expect(() => decodeHistoryProvider("pi")).toThrow();
  });

  it("decodes native Pi provenance through the imports HTTP payload", () => {
    const decoded = decodeHistoryImportsPage({
      imports: [],
      forks: [forkRecord("pi")],
    });

    expect(decoded.forks?.[0]?.provider).toBe("pi");
  });

  it("decodes Pi fork results while retaining legacy fork provenance rows", () => {
    const result = decodeHistoryForkResult({
      threadId: "thread-fork",
      sourceThreadId: "thread-source",
      projectId: "project-source",
      title: "Source thread (fork)",
      provider: "pi",
      sourceSessionId: "session-source",
    });

    expect(result.provider).toBe("pi");
    expect(decodeHistoryForkRecord(forkRecord("claude")).provider).toBe("claude");
  });
});
