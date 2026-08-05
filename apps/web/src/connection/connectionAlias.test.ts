import { describe, expect, it } from "vite-plus/test";

import {
  CONNECTION_ALIAS_MAX_LENGTH,
  normalizeConnectionAlias,
  resolveConnectionDisplayName,
  sanitizeConnectionAliases,
} from "./connectionAlias";

describe("normalizeConnectionAlias", () => {
  it("keeps a typed name as typed", () => {
    expect(normalizeConnectionAlias("Living room box")).toBe("Living room box");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeConnectionAlias("  laptop \n")).toBe("laptop");
  });

  it("treats a whitespace-only name as no name", () => {
    expect(normalizeConnectionAlias("")).toBeNull();
    expect(normalizeConnectionAlias("   ")).toBeNull();
    expect(normalizeConnectionAlias("\t\n ")).toBeNull();
  });

  it("collapses interior whitespace so a pasted name stays one line", () => {
    expect(normalizeConnectionAlias("path\nPC   ICE")).toBe("path PC ICE");
  });

  it("caps the length without leaving a trailing space", () => {
    const long = `${"a".repeat(CONNECTION_ALIAS_MAX_LENGTH)}bbb`;
    expect(normalizeConnectionAlias(long)).toBe("a".repeat(CONNECTION_ALIAS_MAX_LENGTH));
    const cutAtSpace = `${"a".repeat(CONNECTION_ALIAS_MAX_LENGTH - 1)} tail`;
    expect(normalizeConnectionAlias(cutAtSpace)).toBe("a".repeat(CONNECTION_ALIAS_MAX_LENGTH - 1));
  });
});

describe("resolveConnectionDisplayName", () => {
  it("prefers the alias", () => {
    expect(resolveConnectionDisplayName("Render box", "seablue")).toBe("Render box");
  });

  it("falls back to the server label when there is no alias", () => {
    expect(resolveConnectionDisplayName(null, "seablue")).toBe("seablue");
    expect(resolveConnectionDisplayName(undefined, "seablue")).toBe("seablue");
  });

  it("falls back when the alias is cleared to whitespace", () => {
    expect(resolveConnectionDisplayName("   ", "seablue")).toBe("seablue");
  });

  it("normalizes a stored alias the same way the editor would have", () => {
    expect(resolveConnectionDisplayName("  Render  box  ", "seablue")).toBe("Render box");
  });

  it("lets distinct aliases separate machines that report the same label", () => {
    expect(resolveConnectionDisplayName("seablue · main", "seablue")).toBe("seablue · main");
    expect(resolveConnectionDisplayName("seablue · nightly", "seablue")).toBe("seablue · nightly");
  });
});

describe("sanitizeConnectionAliases", () => {
  it("keeps normalized string entries", () => {
    expect(sanitizeConnectionAliases({ "env-1": " laptop ", "env-2": "path PC" })).toEqual({
      "env-1": "laptop",
      "env-2": "path PC",
    });
  });

  it("drops entries that cannot be a name", () => {
    expect(
      sanitizeConnectionAliases({
        "env-1": "   ",
        "env-2": 7,
        "env-3": null,
        "": "no environment",
        "env-4": "kept",
      }),
    ).toEqual({ "env-4": "kept" });
  });

  it("refuses anything that is not a record", () => {
    expect(sanitizeConnectionAliases(null)).toEqual({});
    expect(sanitizeConnectionAliases(undefined)).toEqual({});
    expect(sanitizeConnectionAliases("laptop")).toEqual({});
    expect(sanitizeConnectionAliases(["laptop"])).toEqual({});
  });
});
