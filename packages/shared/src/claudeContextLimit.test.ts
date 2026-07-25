import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_CLAUDE_CONTEXT_LIMIT_TOKENS,
  MAX_CLAUDE_CONTEXT_LIMIT_TOKENS,
  MIN_CLAUDE_CONTEXT_LIMIT_TOKENS,
  formatClaudeContextLimitLabel,
  parseClaudeContextLimitTokens,
  resolveClaudeContextLimitTokens,
} from "./claudeContextLimit.ts";

describe("resolveClaudeContextLimitTokens", () => {
  it("defaults to 600k when unset", () => {
    expect(DEFAULT_CLAUDE_CONTEXT_LIMIT_TOKENS).toBe(600_000);
    expect(resolveClaudeContextLimitTokens(undefined)).toBe(600_000);
    expect(resolveClaudeContextLimitTokens(null)).toBe(600_000);
    expect(resolveClaudeContextLimitTokens("")).toBe(600_000);
    expect(resolveClaudeContextLimitTokens("   ")).toBe(600_000);
  });

  it("reads bare counts and k/m shorthand", () => {
    expect(resolveClaudeContextLimitTokens("400000")).toBe(400_000);
    expect(resolveClaudeContextLimitTokens("400k")).toBe(400_000);
    expect(resolveClaudeContextLimitTokens("400 K")).toBe(400_000);
    expect(resolveClaudeContextLimitTokens("1m")).toBe(1_000_000);
    expect(resolveClaudeContextLimitTokens("0.5m")).toBe(500_000);
  });

  it("clamps into the band Claude Code will honor", () => {
    expect(resolveClaudeContextLimitTokens("50k")).toBe(MIN_CLAUDE_CONTEXT_LIMIT_TOKENS);
    expect(resolveClaudeContextLimitTokens("5m")).toBe(MAX_CLAUDE_CONTEXT_LIMIT_TOKENS);
  });

  it("falls back to the default rather than uncapping on garbage", () => {
    expect(resolveClaudeContextLimitTokens("lots")).toBe(600_000);
    expect(resolveClaudeContextLimitTokens("-1")).toBe(600_000);
    expect(resolveClaudeContextLimitTokens("0")).toBe(600_000);
    expect(resolveClaudeContextLimitTokens("600k tokens")).toBe(600_000);
  });
});

describe("parseClaudeContextLimitTokens", () => {
  it("separates 'absent' from 'invalid' for the caller", () => {
    expect(parseClaudeContextLimitTokens("")).toBeNull();
    expect(parseClaudeContextLimitTokens("nope")).toBeNull();
    expect(parseClaudeContextLimitTokens("600k")).toBe(600_000);
  });
});

describe("formatClaudeContextLimitLabel", () => {
  it("renders round values compactly", () => {
    expect(formatClaudeContextLimitLabel(600_000)).toBe("600k");
    expect(formatClaudeContextLimitLabel(1_000_000)).toBe("1M");
    expect(formatClaudeContextLimitLabel(200_000)).toBe("200k");
    expect(formatClaudeContextLimitLabel(612_345)).toBe("612,345");
  });
});
