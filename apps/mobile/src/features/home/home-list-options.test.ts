import { describe, expect, it } from "vite-plus/test";

import { resolveProjectGroupingMode } from "./home-list-options";

describe("home list options", () => {
  it("groups repository copies across machines by default", () => {
    expect(resolveProjectGroupingMode(undefined)).toBe("repository");
    expect(resolveProjectGroupingMode(true)).toBe("repository");
  });

  it("can show physical projects separately without filtering machines", () => {
    expect(resolveProjectGroupingMode(false)).toBe("separate");
  });
});
