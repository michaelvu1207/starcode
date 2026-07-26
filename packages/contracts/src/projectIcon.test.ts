/**
 * The icon budget and the type check, which are the same rule seen twice.
 *
 * An icon is the only display field whose *cost* is interesting: it replicates
 * to every machine like the rest of display, so a value that gets past this
 * validator is a value four registry files carry forever. These tests pin the
 * two ways that goes wrong — a string too big for the budget, and bytes that
 * are not what the data URI says they are — because both are silent failures
 * everywhere else. An oversize icon just makes every catalog slower, and a
 * mistyped one just renders as a broken image on somebody else's machine.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_CATEGORY_ICON_MAX_LENGTH,
  validateProjectCategoryIcon,
  type ProjectCategoryIconMimeType,
} from "./projectIcon.ts";

/** A data URI whose payload starts with the given bytes, padded to a real length. */
const uri = (mime: string, ...bytes: ReadonlyArray<number>): string => {
  const padded = [...bytes, ...Array.from({ length: 48 - bytes.length }, () => 0)];
  const binary = String.fromCharCode(...padded);
  return `data:${mime};base64,${btoa(binary)}`;
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
// "RIFF", four length bytes that say nothing, then "WEBP".
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

const SIGNATURES: ReadonlyArray<[ProjectCategoryIconMimeType, ReadonlyArray<number>]> = [
  ["image/png", PNG],
  ["image/jpeg", JPEG],
  ["image/gif", GIF],
  ["image/webp", WEBP],
];

describe("project icon validation", () => {
  it("accepts each supported type when the bytes agree with the label", () => {
    for (const [mime, bytes] of SIGNATURES) {
      expect(validateProjectCategoryIcon(uri(mime, ...bytes)), mime).toBeNull();
    }
  });

  it("treats empty as no icon rather than as a malformed one", () => {
    // The "" idiom `accent` and `glyph` already use. Clearing an icon is a
    // write of the empty string, so rejecting it here would make clearing
    // impossible through the same door setting goes through.
    expect(validateProjectCategoryIcon("")).toBeNull();
  });

  it("refuses a string over the budget, which is the fleet-wide cost", () => {
    const oversize = `data:image/png;base64,${"A".repeat(PROJECT_CATEGORY_ICON_MAX_LENGTH)}`;
    expect(validateProjectCategoryIcon(oversize)).toBe("too_large");
  });

  it("accepts the largest icon that fits and refuses the next group up", () => {
    // The boundary belongs to the accepted side: a client that encoded right up
    // to the documented budget did what it was told. Built in whole base64
    // groups because that is what an encoder emits — the largest *legal* value
    // is a few characters under the cap rather than exactly on it.
    const head = "data:image/png;base64,";
    const groups = Math.floor((PROJECT_CATEGORY_ICON_MAX_LENGTH - head.length) / 4);
    const body = btoa(
      String.fromCharCode(
        ...PNG,
        ...Array.from({ length: groups * 3 - PNG.length }, () => 0),
      ),
    );
    const largest = `${head}${body}`;
    expect(largest.length).toBeLessThanOrEqual(PROJECT_CATEGORY_ICON_MAX_LENGTH);
    expect(largest.length).toBeGreaterThan(PROJECT_CATEGORY_ICON_MAX_LENGTH - 4);
    expect(validateProjectCategoryIcon(largest)).toBeNull();
    expect(validateProjectCategoryIcon(`${largest}AAAA`)).toBe("too_large");
  });

  it("refuses bytes that are not the type the data URI claims", () => {
    // The discriminator the whole sniff exists for: the MIME is the caller's
    // word, and without this it is the only thing standing between the catalog
    // and arbitrary bytes that four machines will hand to an <img>.
    expect(validateProjectCategoryIcon(uri("image/webp", ...PNG))).toBe("content_mismatch");
    expect(validateProjectCategoryIcon(uri("image/png", ...JPEG))).toBe("content_mismatch");
    // A GIF header truncated one byte short of its version is not a GIF.
    expect(validateProjectCategoryIcon(uri("image/gif", 0x47, 0x49, 0x46, 0x38, 0x00, 0x61))).toBe(
      "content_mismatch",
    );
    // RIFF alone is a container; without the WEBP fourcc it could be audio.
    expect(
      validateProjectCategoryIcon(
        uri("image/webp", 0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20),
      ),
    ).toBe("content_mismatch");
  });

  it("refuses svg outright, whatever it contains", () => {
    // Not a sniff failure — a type refusal. An SVG is a document that can carry
    // script and external references, and this string is rendered by every
    // client on every machine that folds the catalog.
    expect(validateProjectCategoryIcon("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(
      "unsupported_type",
    );
    expect(
      validateProjectCategoryIcon("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"),
    ).toBe("not_a_data_uri");
  });

  it("refuses anything that is not a base64 data URI at all", () => {
    expect(validateProjectCategoryIcon("https://example.invalid/logo.png")).toBe("not_a_data_uri");
    // A remote URL smuggled in as a data URI's body is still not a data URI —
    // and an icon that fetched from the network would make every catalog fold a
    // request to somebody else's server.
    expect(validateProjectCategoryIcon("data:image/png,https://example.invalid/logo.png")).toBe(
      "not_a_data_uri",
    );
    expect(validateProjectCategoryIcon("data:image/png;base64,")).toBe("not_a_data_uri");
  });

  it("refuses a payload that was cut in transit", () => {
    // Base64 decodes in four-character groups. A truncated body decodes to
    // garbage rather than throwing, so length is the only thing that catches it.
    const valid = uri("image/png", ...PNG);
    expect(validateProjectCategoryIcon(valid.slice(0, valid.length - 1))).toBe("malformed_base64");
  });
});
