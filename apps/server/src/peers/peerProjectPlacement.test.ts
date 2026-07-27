/**
 * Where a delegated thread lands, and what it starts as.
 *
 * Both rules used to be quietly wrong: the folder came from `bindings[0]` —
 * file order — and the model came from the *location's* default, so a project
 * default the operator had set could be watched to have no effect. These pin
 * the corrected shape, including the case the fix deliberately turns into a
 * refusal rather than a guess.
 */
import {
  ProjectCategorySlug,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type ProjectCategoryDefaults,
  type ProjectCategoryRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  choosePeerProjectLocation,
  resolvePeerThreadModelSelection,
  resolvePeerThreadModes,
} from "./peerProjectPlacement.ts";

const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const category = (input: {
  readonly bindings?: ReadonlyArray<string>;
  readonly defaults?: ProjectCategoryDefaults;
}): ProjectCategoryRecord =>
  ({
    slug: ProjectCategorySlug.make("atlas"),
    createdAt: "2026-07-01T00:00:00.000Z",
    display: {
      title: "Atlas",
      summary: "",
      accent: "",
      glyph: "",
      icon: "",
      parentSlug: null,
      links: [],
      notes: "",
      archivedAt: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
    local: {
      bindings: (input.bindings ?? []).map((projectId) => ({
        projectId: ProjectId.make(projectId),
        boundAt: "2026-07-01T00:00:00.000Z",
      })),
      threadIds: [],
      excludedThreadIds: [],
      masterThreadId: "",
      masterDefaults: { runtimeMode: "approval-required", interactionMode: "plan" },
      defaults: input.defaults ?? {},
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  }) as ProjectCategoryRecord;

describe("choosePeerProjectLocation", () => {
  it("takes the one bound folder without needing to be told", () => {
    expect(choosePeerProjectLocation(category({ bindings: ["p-1"] }))).toEqual({
      kind: "bound",
      projectId: "p-1",
    });
  });

  it("honours the operator's preferred folder over file order", () => {
    // The bug: this used to be bindings[0], so p-1 won because the JSON listed
    // it first, and the preference the operator set did nothing.
    expect(
      choosePeerProjectLocation(
        category({
          bindings: ["p-1", "p-2"],
          defaults: { preferredProjectId: ProjectId.make("p-2") },
        }),
      ),
    ).toEqual({ kind: "bound", projectId: "p-2" });
  });

  it("refuses to guess between several folders when nothing prefers one", () => {
    expect(choosePeerProjectLocation(category({ bindings: ["p-1", "p-2"] }))).toEqual({
      kind: "ambiguous",
      projectIds: ["p-1", "p-2"],
    });
  });

  it("ignores a preference naming a folder the project no longer binds", () => {
    // A stale preference would otherwise file work outside the project it was
    // delegated to — silently, since the caller never named a folder.
    expect(
      choosePeerProjectLocation(
        category({
          bindings: ["p-1", "p-2"],
          defaults: { preferredProjectId: ProjectId.make("p-gone") },
        }),
      ),
    ).toEqual({ kind: "ambiguous", projectIds: ["p-1", "p-2"] });
  });

  it("still resolves a single binding when the preference is stale", () => {
    expect(
      choosePeerProjectLocation(
        category({
          bindings: ["p-1"],
          defaults: { preferredProjectId: ProjectId.make("p-gone") },
        }),
      ),
    ).toEqual({ kind: "bound", projectId: "p-1" });
  });

  it("reports a category with no folder as unbound rather than picking one", () => {
    // Legal — the research project that lives in scratch dirs — but not
    // somewhere a thread can start.
    expect(choosePeerProjectLocation(category({}))).toEqual({ kind: "unbound" });
  });
});

describe("resolvePeerThreadModelSelection", () => {
  it("lets the project's own default beat the folder's", () => {
    expect(
      resolvePeerThreadModelSelection({
        locationDefault: selection("claude", "sonnet"),
        categoryDefault: selection("codex", "gpt-5.5"),
        overrides: {},
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.5" });
  });

  it("falls back to the folder when the project says nothing", () => {
    expect(
      resolvePeerThreadModelSelection({
        locationDefault: selection("claude", "sonnet"),
        categoryDefault: null,
        overrides: {},
      }),
    ).toEqual({ instanceId: "claude", model: "sonnet" });
  });

  it("lets the caller override either half", () => {
    expect(
      resolvePeerThreadModelSelection({
        locationDefault: selection("claude", "sonnet"),
        categoryDefault: selection("codex", "gpt-5.5"),
        overrides: { model: "claude-fable-5" },
      }),
    ).toEqual({ instanceId: "codex", model: "claude-fable-5" });
  });

  it("says nothing rather than half a selection when no layer supplies one", () => {
    expect(
      resolvePeerThreadModelSelection({
        locationDefault: null,
        categoryDefault: null,
        overrides: { model: "claude-fable-5" },
      }),
    ).toBeNull();
  });

  it("is complete once the caller supplies both halves itself", () => {
    expect(
      resolvePeerThreadModelSelection({
        locationDefault: null,
        categoryDefault: null,
        overrides: { instanceId: "codex", model: "gpt-5.5" },
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.5" });
  });
});

describe("resolvePeerThreadModes", () => {
  // The literal, not `DEFAULT_RUNTIME_MODE`: this asserts the policy — a
  // delegated thread gets the same permissions as one the operator starts by
  // hand — and an assertion written against the constant would follow the
  // constant anywhere it moved and prove nothing.
  it("defaults a delegated thread to the app-wide new-thread mode", () => {
    expect(resolvePeerThreadModes({ overrides: {} })).toEqual({
      runtimeMode: "full-access",
      interactionMode: "default",
    });
  });

  it("takes the project's settings when it has them", () => {
    expect(
      resolvePeerThreadModes({
        category: category({ defaults: { runtimeMode: "full-access", interactionMode: "plan" } }),
        overrides: {},
      }),
    ).toEqual({ runtimeMode: "full-access", interactionMode: "plan" });
  });

  it("lets the caller override the project", () => {
    expect(
      resolvePeerThreadModes({
        category: category({ defaults: { runtimeMode: "full-access", interactionMode: "plan" } }),
        overrides: { runtimeMode: "approval-required" },
      }),
    ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  });
});
