import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_DELETE_GUARANTEES,
  projectDeleteConsequence,
  projectDeleteRefusalHeadline,
  projectDeleteUnreachableNote,
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

describe("projectDeleteConsequence, with machines that are not answering", () => {
  it("stops promising every machine when some cannot be reached", () => {
    // The delete only goes to connected machines, so a quiet one keeps the
    // category and hands it back. Promising "every machine" made that read as
    // the delete silently undoing itself.
    expect(projectDeleteConsequence(3, 1)).toContain("every machine that is answering");
    expect(projectDeleteConsequence(3, 1)).not.toContain("from every machine.");
  });

  it("stops claiming there are no threads when it cannot know", () => {
    // The count is folded membership. If the machine holding the work is the
    // quiet one, zero is what unavailable looks like.
    expect(projectDeleteConsequence(0, 2)).toContain("No machine that is answering");
    expect(projectDeleteConsequence(0, 0)).toContain("This project has no threads.");
  });

  it("still says the threads survive, which is the sentence that matters", () => {
    expect(projectDeleteConsequence(2, 1)).toContain("not deleted");
    expect(projectDeleteConsequence(2, 1)).toContain("Chats");
  });
});

describe("projectDeleteUnreachableNote", () => {
  it("says nothing when every machine answered", () => {
    expect(projectDeleteUnreachableNote([])).toBeNull();
  });

  it("names the machines and warns the project comes back", () => {
    const note = projectDeleteUnreachableNote(["simforge1", "path-pc"]);
    expect(note).toContain("path-pc, simforge1");
    expect(note).toContain("comes back");
  });

  it("counts machines in the right grammar", () => {
    expect(projectDeleteUnreachableNote(["simforge1"])).toContain("is not answering");
    expect(projectDeleteUnreachableNote(["a", "b"])).toContain("are not answering");
  });
});
