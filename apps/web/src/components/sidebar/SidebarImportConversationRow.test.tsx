import type { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { subscribeImportPicker, type ImportPickerOpenDetail } from "./importPicker";
import { SidebarImportConversationRow } from "./SidebarImportConversationRow";

type RowElement = ReturnType<typeof SidebarImportConversationRow>;

describe("SidebarImportConversationRow", () => {
  const globals = globalThis as { window?: unknown };
  let previousWindow: unknown;

  beforeEach(() => {
    previousWindow = globals.window;
    globals.window = new EventTarget();
  });

  afterEach(() => {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  });

  it("renders the import affordance for its machine", () => {
    const markup = renderToStaticMarkup(
      (<SidebarImportConversationRow environmentId={"env-mac" as EnvironmentId} />) as RowElement,
    );

    expect(markup).toContain('data-testid="sidebar-v2-import-conversation"');
    expect(markup).toContain('data-environment-id="env-mac"');
    expect(markup).toContain("Import conversation");
  });

  it("asks the picker for its own machine when clicked", () => {
    // The seam F12 phase 4 lands against: the row does not know what the
    // picker is, only which connection it is asking about.
    const received: ImportPickerOpenDetail[] = [];
    const unsubscribe = subscribeImportPicker((detail) => received.push(detail));

    const element = SidebarImportConversationRow({
      environmentId: "env-mac" as EnvironmentId,
    }) as React.ReactElement<{ readonly children: React.ReactElement<{ onClick?: () => void }> }>;
    element.props.children.props.onClick?.();

    expect(received).toEqual([{ environmentId: "env-mac" }]);
    unsubscribe();
  });
});
