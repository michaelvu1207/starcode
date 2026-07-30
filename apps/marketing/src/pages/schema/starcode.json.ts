import type { APIRoute } from "astro";

import { buildStarcodeProjectFileJsonSchema } from "@starcode/shared/starcodeProjectFile";

// Rendered at build time so checked-in starcode.json files can reference the
// canonical schema URL for editor/LSP support without a runtime dependency.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildStarcodeProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
