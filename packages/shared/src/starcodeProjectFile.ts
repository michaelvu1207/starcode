import * as Schema from "effect/Schema";

import { StarcodeProjectFile, STARCODE_PROJECT_FILE_SCHEMA_URL } from "@starcode/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between raw starcode project file contents (lenient JSONC string) and
 * the decoded {@link StarcodeProjectFile}.
 */
export const StarcodeProjectFileFromJson = fromLenientJson(StarcodeProjectFile);

/**
 * Build the publishable JSON Schema document for `starcode.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link STARCODE_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildStarcodeProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(StarcodeProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: STARCODE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
