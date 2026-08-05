import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "../ui/tooltip";
import { ModelFamilySidebar } from "./ModelFamilySidebar";

describe("ModelFamilySidebar", () => {
  it("renders account-blind Claude and Codex/GPT family rails", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ModelFamilySidebar
          selected="claude"
          availableFamilies={new Set(["claude", "gpt"])}
          showFavorites={false}
          onSelect={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(markup).toContain('data-model-picker-sidebar="families"');
    expect(markup).toContain('data-model-picker-family="claude"');
    expect(markup).toContain('aria-label="Claude"');
    expect(markup).toContain('data-model-picker-family="gpt"');
    expect(markup).toContain('aria-label="Codex and GPT"');
    expect(markup).not.toContain("@");
  });

  it("does not render a family that has no available models", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ModelFamilySidebar
          selected="gpt"
          availableFamilies={new Set(["gpt"])}
          showFavorites={false}
          onSelect={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(markup).not.toContain('data-model-picker-family="claude"');
    expect(markup).toContain('data-model-picker-family="gpt"');
    expect(markup).not.toContain('data-model-picker-family="other"');
  });

  it("renders a neutral family rail for non-Claude and non-GPT models", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ModelFamilySidebar
          selected="other"
          availableFamilies={new Set(["other"])}
          showFavorites={false}
          onSelect={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(markup).toContain('data-model-picker-family="other"');
    expect(markup).toContain('aria-label="Other models"');
  });
});
