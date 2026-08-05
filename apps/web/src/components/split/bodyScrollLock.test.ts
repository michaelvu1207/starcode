import { afterEach, describe, expect, it } from "vite-plus/test";

import { acquireBodyScrollLock, bodyScrollLockHolders } from "./bodyScrollLock";

interface StyleBag {
  overscrollBehavior: string;
  overflow: string;
  paddingRight: string;
}

function installDocument(): { documentElement: StyleBag; body: StyleBag } {
  const documentElement: StyleBag = { overscrollBehavior: "", overflow: "", paddingRight: "" };
  const body: StyleBag = { overscrollBehavior: "", overflow: "auto", paddingRight: "12px" };
  Object.assign(globalThis, {
    document: {
      documentElement: { style: documentElement, clientWidth: 1000 },
      body: { style: body },
    },
    window: { innerWidth: 1015 },
  });
  return { documentElement, body };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "window");
});

describe("acquireBodyScrollLock", () => {
  it("locks and restores the values it found", () => {
    const { documentElement, body } = installDocument();
    const release = acquireBodyScrollLock();
    expect(documentElement.overscrollBehavior).toBe("contain");
    expect(body.overflow).toBe("hidden");
    expect(body.paddingRight).toBe("15px");

    release();
    expect(documentElement.overscrollBehavior).toBe("");
    expect(body.overflow).toBe("auto");
    expect(body.paddingRight).toBe("12px");
    expect(bodyScrollLockHolders()).toBe(0);
  });

  // Two pickers, one per split pane. A per-instance save/restore would have
  // the second one snapshot the already-locked values and restore those,
  // leaving the page unscrollable until reload.
  it("restores the original values after two overlapping locks", () => {
    const { body } = installDocument();
    const releaseFirst = acquireBodyScrollLock();
    const releaseSecond = acquireBodyScrollLock();
    expect(bodyScrollLockHolders()).toBe(2);

    releaseFirst();
    expect(body.overflow).toBe("hidden");

    releaseSecond();
    expect(body.overflow).toBe("auto");
    expect(body.paddingRight).toBe("12px");
  });

  it("ignores a release called twice", () => {
    installDocument();
    const release = acquireBodyScrollLock();
    release();
    release();
    expect(bodyScrollLockHolders()).toBe(0);
  });
});
