/**
 * The uploaded project icon, alone in a leaf module.
 *
 * Same structural reason `projectCategorySlug.ts` sits apart, plus one of its
 * own: the *encoder* lives in the web app and the *validator* has to run on the
 * server, and both need the budget constants without either dragging in
 * `settings.ts` → `featureFlow.ts` → `peers.ts`. This file depends on nothing
 * but `effect/Schema`, so it can be imported from anywhere in the graph.
 * `projectCatalog.ts` re-exports it, so no call site needs to know it exists.
 *
 * **Why the icon is a string and not a file.** An icon is display — it is what
 * the project *is*, and display replicates to every machine. There is no blob
 * store in this fork and inventing one would mean inventing a transfer path
 * between connections, which doctrine refuses outright (invariant 8). So the
 * icon travels the way every other display field does: inline, in the record,
 * through the same fan-out. That makes its size a fleet-wide cost rather than
 * one machine's, which is why the budget below is small and enforced on the
 * write rather than trusted from the client.
 *
 * @module ProjectIcon
 */
import * as Schema from "effect/Schema";

/**
 * The hard cap on the stored string, in characters of the whole data URI.
 *
 * Every registry JSON on every machine carries this, and every fan-out write
 * sends it to all of them, so the number is chosen against the *fleet* rather
 * than against one file: forty projects at the cap is 1.3 MB per machine, which
 * is the largest a catalog anyone would hand-edit should ever get. A 96px webp
 * lands around 3–6 KB, so the cap is roughly six times what a well-encoded icon
 * needs — headroom for a photograph somebody insists on, not a licence for one.
 */
export const PROJECT_CATEGORY_ICON_MAX_LENGTH = 32_768;

/**
 * What an icon may be.
 *
 * Raster only, and `image/svg+xml` is absent deliberately rather than by
 * oversight: an SVG is a document that can carry script and external
 * references, and this string is rendered by every client on every machine that
 * folds the catalog. A vector icon would be nicer at 7px and is not worth
 * handing four machines an executable.
 */
export const PROJECT_CATEGORY_ICON_MIME_TYPES = [
  "image/png",
  "image/webp",
  "image/jpeg",
  "image/gif",
] as const;
export type ProjectCategoryIconMimeType = (typeof PROJECT_CATEGORY_ICON_MIME_TYPES)[number];

/** The format the client should aim for, and the box it should fit in. */
export const PROJECT_CATEGORY_ICON_TARGET_SIZE = 96;

export type ProjectCategoryIconRejection =
  | "too_large"
  | "not_a_data_uri"
  | "unsupported_type"
  | "malformed_base64"
  | "content_mismatch";

const DATA_URI_PATTERN = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Magic bytes per declared type.
 *
 * The declared MIME is the caller's claim; these are the file's own answer, and
 * a write is only accepted when the two agree. Without this the type is a label
 * anybody can write, and "it says png" becomes the only thing standing between
 * the catalog and arbitrary bytes rendered by `<img>` on four machines.
 */
const MAGIC: Record<ProjectCategoryIconMimeType, (bytes: Uint8Array) => boolean> = {
  "image/png": (bytes) =>
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a,
  // RIFF container with a WEBP fourcc at offset 8. The four bytes between are
  // the chunk length, which says nothing about the format.
  "image/webp": (bytes) =>
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50,
  "image/jpeg": (bytes) =>
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/gif": (bytes) =>
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61,
};

/** Just enough of the payload to sniff. Decoding 32 KB to read 12 bytes is waste. */
function decodePrefix(base64: string): Uint8Array | null {
  // Base64 decodes in 4-character groups; 16 characters is 12 bytes, which is
  // the longest signature above.
  const head = base64.slice(0, 16);
  try {
    const binary = atob(head);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Validates a stored icon value. `null` means "acceptable".
 *
 * Empty is acceptable and means *no icon* — the same "" idiom `accent` and
 * `glyph` already use for "derive it", so clearing an icon is a write of the
 * empty string rather than a second verb.
 *
 * Lives in contracts because three callers need the same answer: the HTTP
 * upsert, the MCP tool, and the browser encoder that must refuse before it
 * sends. A second implementation would eventually accept something one of the
 * others rejects, and the operator would learn about it from a 400.
 */
export function validateProjectCategoryIcon(value: string): ProjectCategoryIconRejection | null {
  if (value.length === 0) return null;
  // Length first: a 4 MB string should be refused without running a regex over
  // it, and every other check below is cheap only because this one ran.
  if (value.length > PROJECT_CATEGORY_ICON_MAX_LENGTH) return "too_large";

  const match = DATA_URI_PATTERN.exec(value);
  if (match === null) return "not_a_data_uri";

  const declared = match[1] as ProjectCategoryIconMimeType;
  const payload = match[2] ?? "";
  if (!PROJECT_CATEGORY_ICON_MIME_TYPES.includes(declared)) return "unsupported_type";
  // A base64 body is a whole number of 4-character groups, and a truncated one
  // decodes to garbage rather than failing, so the length check is the only
  // thing that catches a payload that was cut in transit.
  if (payload.length === 0 || payload.length % 4 !== 0) return "malformed_base64";

  const prefix = decodePrefix(payload);
  if (prefix === null) return "malformed_base64";
  return MAGIC[declared](prefix) ? null : "content_mismatch";
}

/** What to tell the operator, or the agent, about a refused icon. */
export function describeProjectCategoryIconRejection(
  rejection: ProjectCategoryIconRejection,
): string {
  switch (rejection) {
    case "too_large":
      return `The icon must be at most ${PROJECT_CATEGORY_ICON_MAX_LENGTH} characters encoded (roughly 24 KB of image). Downscale it to ${PROJECT_CATEGORY_ICON_TARGET_SIZE}px square and re-encode it as webp or png.`;
    case "not_a_data_uri":
      return "The icon must be a base64 data URI, like data:image/webp;base64,UklGR…";
    case "unsupported_type":
      return `The icon must be one of ${PROJECT_CATEGORY_ICON_MIME_TYPES.join(", ")}. SVG is not accepted.`;
    case "malformed_base64":
      return "The icon's base64 payload is truncated or contains characters base64 does not use.";
    case "content_mismatch":
      return "The icon's bytes are not the image type its data URI declares.";
  }
}

/**
 * The write-path schema: strict, because this is where bytes enter the fleet.
 *
 * Deliberately *not* used on the stored record. A catalog that somehow holds a
 * malformed icon — hand-edited, or written by a build that allowed something
 * this one does not — must still decode, or one bad string would take a
 * machine's entire projects view out (invariant 11). Reads stay tolerant and
 * the renderer falls back to the constellation when the image will not load;
 * writes are where the rule is enforced.
 */
export const ProjectCategoryIconDataUri = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const rejection = validateProjectCategoryIcon(value);
    return rejection === null ? true : describeProjectCategoryIconRejection(rejection);
  }),
);
