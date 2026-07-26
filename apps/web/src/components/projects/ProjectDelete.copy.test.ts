import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_DELETE_GUARANTEES,
  projectDeleteConsequence,
  projectDeleteRefusalHeadline,
} from "./ProjectDelete.copy";

describe("projectDeleteConsequence", () => {
  it("promises the threads survive, whenever there are threads to promise about", () => {
    // The load-bearing sentence. If it ever stops saying both halves — that
    // they are not deleted, and where they go — the dialog has stopped doing
    // the one job it exists for.
    for (const count of [1, 2, 7, 400]) {
      const sentence = projectDeleteConsequence(count);
      expect(sentence).toContain("not deleted");
      expect(sentence).toContain("Chats");
    }
  });

  it("counts in the right grammar, because a wrong count reads as a bug", () => {
    expect(projectDeleteConsequence(1)).toContain("The 1 thread filed under it is not deleted");
    expect(projectDeleteConsequence(2)).toContain("The 2 threads filed under it are not deleted");
  });

  it("does not promise a move when there is nothing to move", () => {
    const sentence = projectDeleteConsequence(0);
    expect(sentence).toContain("no threads");
    expect(sentence).not.toContain("Chats");
  });

  it("says a folder is never touched, which is the other half of the fear", () => {
    expect(PROJECT_DELETE_GUARANTEES[0]).toContain("folder is touched");
  });
});

describe("projectDeleteRefusalHeadline", () => {
  it("warns that a machine which refused will hand the project back", () => {
    // Without this the delete looks like it silently undid itself on the next
    // poll, which is the worst way to learn a fan-out was partial.
    expect(projectDeleteRefusalHeadline(1)).toContain("come back");
    expect(projectDeleteRefusalHeadline(3)).toContain("come back");
  });

  it("counts machines in the right grammar", () => {
    expect(projectDeleteRefusalHeadline(1)).toContain("One machine still has it");
    expect(projectDeleteRefusalHeadline(3)).toContain("3 machines still have it");
  });
});
