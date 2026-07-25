/**
 * Splits the speck tile into the three star layers the sky drifts.
 *
 * WHY THIS IS A SCRIPT AND NOT THREE HAND-WRITTEN TILES
 * The layers must stay a *derivation* of `--sc-speck-tile`, not a copy of it.
 * The tile has already been rewritten once for a bolder palette, and any future
 * edit to it would silently desync three hand-maintained copies — the field
 * would gain or lose stars depending on which layer you looked at. Running this
 * re-derives all three from whatever tile is currently shipping.
 *
 *   node scripts/derive-starcode-star-layers.mjs           # print the three properties
 *   node scripts/derive-starcode-star-layers.mjs --check   # verify the CSS is in sync
 *
 * THE RULE
 * Shapes are dealt round-robin by index: shape 0 to layer 1, shape 1 to layer 2,
 * shape 2 to layer 3, shape 3 to layer 1, and so on. Circles and the butter
 * sparkles are dealt separately so each layer gets one sparkle rather than all
 * three landing together. Round-robin rather than a random partition so the
 * result is reproducible and reviewable — the same tile always yields the same
 * three layers.
 *
 * Every star in the tile appears in exactly one layer, so the three layers
 * superimposed are the original field. That is what makes the parallax honest:
 * nothing was added or duplicated to create depth.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const cssPath = NodePath.resolve(here, "..", "apps", "web", "src", "starcode-theme.css");
const css = NodeFS.readFileSync(cssPath, "utf8");

const LAYERS = 3;

function readTile() {
  const match = css.match(/--sc-speck-tile:\s*url\("data:image\/svg\+xml,(.*?)"\);/s);
  if (!match) throw new Error("could not find --sc-speck-tile in starcode-theme.css");
  return decodeURIComponent(match[1]);
}

/** Deal `items` round-robin into `LAYERS` buckets. */
function deal(items) {
  const buckets = Array.from({ length: LAYERS }, () => []);
  items.forEach((item, index) => buckets[index % LAYERS].push(item));
  return buckets;
}

function buildLayers(svg) {
  const header = svg.match(/^<svg[^>]*>/)[0];
  const circles = svg.match(/<circle[^>]*\/>/g) ?? [];
  const sparkles = svg.match(/<path[^>]*\/>/g) ?? [];
  // The tile groups circles under a cream fill and sparkles under butter; the
  // shapes carry no fill of their own, so the groups have to be reproduced.
  const circleFill = svg.match(/<g fill='([^']+)'><circle/)[1];
  const sparkleFill = svg.match(/<g fill='([^']+)'><path/)?.[1];

  const circleBuckets = deal(circles);
  const sparkleBuckets = deal(sparkles);

  return circleBuckets.map((bucket, index) => {
    const parts = [header];
    if (bucket.length > 0) parts.push(`<g fill='${circleFill}'>`, ...bucket, "</g>");
    const sparkleBucket = sparkleBuckets[index];
    if (sparkleBucket.length > 0 && sparkleFill !== undefined) {
      parts.push(`<g fill='${sparkleFill}'>`, ...sparkleBucket, "</g>");
    }
    parts.push("</svg>");
    return {
      svg: parts.join(""),
      circles: bucket.length,
      sparkles: sparkleBucket.length,
    };
  });
}

const svg = readTile();
const layers = buildLayers(svg);
const properties = layers.map(
  (layer, index) =>
    `  --sc-star-layer-${index + 1}: url("data:image/svg+xml,${encodeURIComponent(layer.svg)}");`,
);

if (process.argv.includes("--check")) {
  const missing = properties.filter((property) => !css.includes(property.trim()));
  if (missing.length > 0) {
    console.error(
      `${missing.length} of ${LAYERS} star layers are out of sync with --sc-speck-tile.\n` +
        "Re-run without --check and paste the output over the --sc-star-layer-* block.",
    );
    process.exit(1);
  }
  console.log(`all ${LAYERS} star layers match the shipped tile`);
  process.exit(0);
}

const totalCircles = layers.reduce((sum, layer) => sum + layer.circles, 0);
const totalSparkles = layers.reduce((sum, layer) => sum + layer.sparkles, 0);
console.error(
  `partitioned ${totalCircles} circles and ${totalSparkles} sparkles into ${LAYERS} layers: ` +
    layers.map((layer, index) => `L${index + 1}=${layer.circles}+${layer.sparkles}`).join(" "),
);
console.log(properties.join("\n"));
