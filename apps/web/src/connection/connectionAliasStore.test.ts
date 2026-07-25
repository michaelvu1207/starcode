import { beforeEach, describe, expect, it } from "vite-plus/test";

import { resolveConnectionDisplayName } from "./connectionAlias";
import { useConnectionAliasStore } from "./connectionAliasStore";

function reset() {
  useConnectionAliasStore.setState({ aliasByEnvironmentId: {} });
}

describe("connection alias store", () => {
  beforeEach(reset);

  it("stores a normalized alias per environment", () => {
    useConnectionAliasStore.getState().setConnectionAlias("env-1", "  Render box ");
    expect(useConnectionAliasStore.getState().aliasByEnvironmentId).toEqual({
      "env-1": "Render box",
    });
  });

  it("keeps environments independent", () => {
    useConnectionAliasStore.getState().setConnectionAlias("env-1", "main");
    useConnectionAliasStore.getState().setConnectionAlias("env-2", "nightly");
    expect(useConnectionAliasStore.getState().aliasByEnvironmentId).toEqual({
      "env-1": "main",
      "env-2": "nightly",
    });
  });

  it("clears the alias when the field is emptied, restoring the server label", () => {
    useConnectionAliasStore.getState().setConnectionAlias("env-1", "Render box");
    useConnectionAliasStore.getState().setConnectionAlias("env-1", "   ");
    expect(useConnectionAliasStore.getState().aliasByEnvironmentId).toEqual({});
    expect(
      resolveConnectionDisplayName(
        useConnectionAliasStore.getState().aliasByEnvironmentId["env-1"] ?? null,
        "seablue",
      ),
    ).toBe("seablue");
  });

  it("clears explicitly", () => {
    useConnectionAliasStore.getState().setConnectionAlias("env-1", "Render box");
    useConnectionAliasStore.getState().clearConnectionAlias("env-1");
    expect(useConnectionAliasStore.getState().aliasByEnvironmentId).toEqual({});
  });

  it("does not churn state when nothing changes", () => {
    useConnectionAliasStore.getState().setConnectionAlias("env-1", "Render box");
    const before = useConnectionAliasStore.getState().aliasByEnvironmentId;
    useConnectionAliasStore.getState().setConnectionAlias("env-1", "Render box");
    useConnectionAliasStore.getState().clearConnectionAlias("env-2");
    expect(useConnectionAliasStore.getState().aliasByEnvironmentId).toBe(before);
  });
});
