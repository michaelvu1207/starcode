import { describe, expect, it } from "@effect/vitest";

import {
  isDefinitelyUnrenderable,
  parseRecord,
  readRecordProjectPath,
  renderRecord,
  SessionHeadFold,
  toTranscriptEntry,
} from "./records.ts";

const render = (provider: "claude" | "codex", record: unknown) => {
  const parsed = parseRecord(JSON.stringify(record));
  return parsed === null ? null : renderRecord(provider, parsed);
};

describe("parseRecord", () => {
  it("returns null instead of throwing on anything unparseable", () => {
    // A session being written to right now ends mid-record, and the tail
    // reader starts at an arbitrary byte offset. Both produce garbage lines.
    for (const line of ["", "   ", "not json", '{"unterminated": ', "[1,2,3]", '"a string"']) {
      expect(parseRecord(line)).toBeNull();
    }
  });

  it("parses a well-formed record", () => {
    expect(parseRecord('{"type":"user"}')).toEqual({ type: "user" });
  });
});

describe("renderRecord - Claude", () => {
  it("renders a plain-string user message", () => {
    const rendered = render("claude", {
      type: "user",
      timestamp: "2026-07-20T10:00:00.000Z",
      message: { role: "user", content: "build the thing" },
    });
    expect(rendered).toEqual({
      role: "user",
      text: "build the thing",
      toolCalls: [],
      timestamp: "2026-07-20T10:00:00.000Z",
      isHumanTurn: true,
    });
  });

  it("renders assistant text and keeps tool names without payloads", () => {
    const rendered = render("claude", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "reading it" },
          { type: "tool_use", name: "Read", input: { file_path: "/secret/path" } },
        ],
      },
    });
    expect(rendered?.text).toEqual("reading it");
    expect(rendered?.toolCalls).toEqual(["Read"]);
    // The payload is the thing we must never echo — it is unbounded and often
    // holds file contents.
    expect(JSON.stringify(rendered)).not.toContain("/secret/path");
  });

  it("drops thinking blocks", () => {
    const rendered = render("claude", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "long private reasoning", signature: "sig" }],
      },
    });
    expect(rendered).toBeNull();
  });

  it("does not treat a tool-result carrier as a human turn", () => {
    const rendered = render("claude", {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "1\tfile line" }],
      },
    });
    // It renders nothing at all: there is no text and no tool name, so it is
    // not a transcript entry either.
    expect(rendered).toBeNull();
  });

  it("does not offer a subagent's own prompt as the session snippet", () => {
    const rendered = render("claude", {
      type: "user",
      isSidechain: true,
      message: { role: "user", content: "subagent instructions" },
    });
    expect(rendered?.isHumanTurn).toBe(false);
  });

  it("skips the store's bookkeeping record types", () => {
    for (const type of [
      "last-prompt",
      "agent-setting",
      "mode",
      "attachment",
      "queue-operation",
      "file-history-snapshot",
      "system",
      "ai-title",
    ]) {
      expect(render("claude", { type, sessionId: "s" })).toBeNull();
    }
  });

  it("never renders image data", () => {
    const rendered = render("claude", {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", source: { type: "base64", data: "iVBORw0KGgoAAAA" } },
        ],
      },
    });
    expect(rendered?.text).toEqual("look at this");
    expect(JSON.stringify(rendered)).not.toContain("iVBORw0");
  });
});

describe("renderRecord - Codex", () => {
  it("renders user and agent messages from event_msg", () => {
    expect(
      render("codex", {
        type: "event_msg",
        timestamp: "2026-07-20T10:00:00.000Z",
        payload: { type: "user_message", message: "find me a therapist" },
      }),
    ).toEqual({
      role: "user",
      text: "find me a therapist",
      toolCalls: [],
      timestamp: "2026-07-20T10:00:00.000Z",
      isHumanTurn: true,
    });

    expect(
      render("codex", {
        type: "event_msg",
        payload: { type: "agent_message", message: "on it" },
      })?.role,
    ).toEqual("assistant");
  });

  it("ignores response_item messages so turns are not rendered twice", () => {
    // Codex logs each turn as both an event_msg and a response_item, and the
    // response_item stream additionally carries the developer preamble and the
    // injected environment context as user-role messages.
    expect(
      render("codex", {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      }),
    ).toBeNull();
    expect(
      render("codex", {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions instructions>" }],
        },
      }),
    ).toBeNull();
  });

  it("names tool calls across every spelling Codex uses", () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ type: "function_call", name: "shell", arguments: "{}" }, "shell"],
      [{ type: "custom_tool_call", name: "apply_patch", input: "..." }, "apply_patch"],
      [{ type: "local_shell_call", action: {} }, "shell"],
      [{ type: "web_search_call", action: {} }, "web_search"],
    ];
    for (const [payload, expected] of cases) {
      expect(render("codex", { type: "response_item", payload })?.toolCalls).toEqual([expected]);
    }
  });

  it("skips reasoning and token accounting", () => {
    expect(render("codex", { type: "response_item", payload: { type: "reasoning" } })).toBeNull();
    expect(
      render("codex", { type: "event_msg", payload: { type: "token_count", info: {} } }),
    ).toBeNull();
    expect(render("codex", { type: "turn_context", payload: null })).toBeNull();
  });
});

describe("isDefinitelyUnrenderable", () => {
  it("dismisses Codex image payloads from their opening bytes", () => {
    // The record this exists for: 3.5 MB of base64 that must never be
    // materialised as a string just to discover it is an image.
    const head =
      '{"timestamp":"2026-05-08T18:20:00.000Z","type":"event_msg","payload":{"type":"image_generation_end","b64":"iVBOR';
    expect(isDefinitelyUnrenderable("codex", head)).toBe(true);
  });

  it("keeps records it might be able to render", () => {
    expect(
      isDefinitelyUnrenderable(
        "codex",
        '{"timestamp":"x","type":"event_msg","payload":{"type":"agent_message","message":"hi"',
      ),
    ).toBe(false);
    expect(isDefinitelyUnrenderable("claude", '{"parentUuid":null,"type":"user","message":{')).toBe(
      false,
    );
  });

  it("dismisses Claude bookkeeping types", () => {
    expect(isDefinitelyUnrenderable("claude", '{"type":"file-history-snapshot","snapshot":{')).toBe(
      true,
    );
  });

  it("never guesses when the head is uninformative", () => {
    // Conservative by design: an unrecognised head is decoded normally rather
    // than silently dropped.
    expect(isDefinitelyUnrenderable("codex", "{ truncated")).toBe(false);
    expect(isDefinitelyUnrenderable("claude", "{}")).toBe(false);
  });
});

describe("toTranscriptEntry", () => {
  it("clips long text and says so", () => {
    const long = "x".repeat(5_000);
    const entry = toTranscriptEntry(1_234, {
      role: "user",
      text: long,
      toolCalls: [],
      timestamp: null,
      isHumanTurn: true,
    });
    expect(entry.offset).toEqual(1_234);
    expect(entry.truncated).toBe(true);
    expect(entry.text.length).toEqual(4_001); // budget plus the ellipsis
  });
});

describe("readRecordProjectPath", () => {
  it("reads Claude's per-record cwd", () => {
    expect(readRecordProjectPath("claude", { type: "user", cwd: "/Users/me/app" })).toEqual(
      "/Users/me/app",
    );
  });

  it("reads Codex's session_meta cwd and nothing else", () => {
    expect(
      readRecordProjectPath("codex", {
        type: "session_meta",
        payload: { cwd: "/Users/me/app", cli_version: "0.142.5" },
      }),
    ).toEqual("/Users/me/app");
    expect(
      readRecordProjectPath("codex", { type: "event_msg", payload: { cwd: "/spoofed" } }),
    ).toBeNull();
  });
});

describe("SessionHeadFold", () => {
  it("stops as soon as it has both fields", () => {
    const fold = new SessionHeadFold("claude");
    expect(
      fold.push(
        JSON.stringify({ type: "user", cwd: "/Users/me/app", message: { content: "do it" } }),
      ),
    ).toBe(true);
    expect(fold.result).toEqual({
      projectPath: "/Users/me/app",
      snippet: "do it",
      aiTitle: null,
    });
  });

  it("walks past the metadata records a session opens with", () => {
    const fold = new SessionHeadFold("claude");
    fold.push(JSON.stringify({ type: "last-prompt", leafUuid: "x" }));
    fold.push(JSON.stringify({ type: "agent-setting", agentSetting: "claude" }));
    fold.push("this line is not json at all");
    expect(fold.complete).toBe(false);
    fold.push(
      JSON.stringify({
        type: "user",
        cwd: "/Users/me/app",
        message: { content: "  multi\nline   prompt  " },
      }),
    );
    // Collapsed to one line, because this is a sidebar row.
    expect(fold.result.snippet).toEqual("multi line prompt");
  });

  it("takes the first human turn, not the first tool result", () => {
    const fold = new SessionHeadFold("claude");
    fold.push(
      JSON.stringify({
        type: "user",
        cwd: "/w",
        message: { content: [{ type: "tool_result", tool_use_id: "t", content: "output" }] },
      }),
    );
    expect(fold.result.snippet).toBeNull();
    fold.push(JSON.stringify({ type: "user", message: { content: "the real prompt" } }));
    expect(fold.result.snippet).toEqual("the real prompt");
  });

  it("folds a Codex head across session_meta and the first user message", () => {
    const fold = new SessionHeadFold("codex");
    fold.push(JSON.stringify({ type: "session_meta", payload: { cwd: "/Users/me/proj" } }));
    expect(fold.complete).toBe(false);
    fold.push(
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "ship it" } }),
    );
    expect(fold.result).toEqual({
      projectPath: "/Users/me/proj",
      snippet: "ship it",
      aiTitle: null,
    });
  });
});
