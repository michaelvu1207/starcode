/**
 * Turning a file the operator picked into something the fleet can carry.
 *
 * The icon is a display field, which means the string produced here is written
 * into a registry JSON on every connected machine and re-sent on every
 * subsequent display write. That is the whole reason this module exists rather
 * than a `FileReader.readAsDataURL` call at the call site: the file a person
 * drags in is a 2 MB screenshot, and 2 MB is not a thing to replicate four ways
 * to draw a 16px mark.
 *
 * So the browser does the work: decode, fit into a small square, re-encode, and
 * step the quality down until the encoded string is inside the budget. What
 * leaves here is a few kilobytes regardless of what came in — and the server
 * still validates it, because a client that decided its own budget is a client
 * anyone can replace with `curl`.
 */
import {
  describeProjectCategoryIconRejection,
  PROJECT_CATEGORY_ICON_MAX_LENGTH,
  PROJECT_CATEGORY_ICON_TARGET_SIZE,
  validateProjectCategoryIcon,
} from "@t3tools/contracts";

/**
 * The largest file worth decoding.
 *
 * Not a size limit on the icon — that is the encoded budget below — but a limit
 * on what this will hand to the decoder. A 200 MB image expands to its pixel
 * count in memory before any of the shrinking happens, and the operator who
 * picked it by accident should get a sentence rather than a stalled tab.
 */
export const PROJECT_ICON_MAX_SOURCE_BYTES = 12 * 1024 * 1024;

/**
 * What the browser is asked to produce, in order.
 *
 * webp first because it carries alpha at roughly half of png's size for the
 * flat-colour logos this is mostly used for. A browser that cannot encode webp
 * silently hands back png from `toDataURL`, which is why the result is measured
 * rather than assumed — the ladder responds to the string it actually got.
 */
const ATTEMPTS: ReadonlyArray<{ readonly size: number; readonly type: string; readonly quality: number }> = [
  { size: PROJECT_CATEGORY_ICON_TARGET_SIZE, type: "image/webp", quality: 0.9 },
  { size: PROJECT_CATEGORY_ICON_TARGET_SIZE, type: "image/webp", quality: 0.75 },
  { size: PROJECT_CATEGORY_ICON_TARGET_SIZE, type: "image/webp", quality: 0.6 },
  { size: 64, type: "image/webp", quality: 0.7 },
  { size: 64, type: "image/webp", quality: 0.5 },
];

export type ProjectIconEncodeResult =
  | { readonly ok: true; readonly icon: string; readonly bytes: number }
  | { readonly ok: false; readonly message: string };

/**
 * Decodes through an `<img>` rather than `createImageBitmap`.
 *
 * `createImageBitmap` is the better API for raster input and refuses SVG in
 * every engine this runs on. An `<img>` takes both, and an SVG rasterised here
 * is the *safe* way to accept one: what gets stored is the webp this produced,
 * so the vector's script and external references never reach the catalog, let
 * alone another machine's renderer.
 */
function decode(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.addEventListener(
      "load",
      () => {
        URL.revokeObjectURL(url);
        resolve(image);
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode failed"));
      },
      { once: true },
    );
    image.src = url;
  });
}

/**
 * Contain, not cover.
 *
 * A logo is the common case and cropping one to a square cuts its wordmark in
 * half. Fitting it inside a transparent square costs a photograph some empty
 * corners, which is the cheaper mistake — and because what is stored is already
 * square, the `object-cover` the renderer applies never crops anything back.
 */
function draw(image: HTMLImageElement, size: number): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  const source = Math.max(image.naturalWidth, image.naturalHeight);
  if (source === 0) return null;
  const scale = size / source;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
  return canvas;
}

/**
 * Encodes a picked file into a stored icon, or explains why it will not.
 *
 * Every rejection message is the one the server would give for the same value,
 * because both sides call `validateProjectCategoryIcon`. An operator should
 * never see this succeed and then watch the save fail.
 */
export async function encodeProjectIcon(file: File): Promise<ProjectIconEncodeResult> {
  if (file.size > PROJECT_ICON_MAX_SOURCE_BYTES) {
    return {
      ok: false,
      message: `That file is ${Math.round(file.size / (1024 * 1024))} MB. Pick something under ${
        PROJECT_ICON_MAX_SOURCE_BYTES / (1024 * 1024)
      } MB — it is being shrunk to ${PROJECT_CATEGORY_ICON_TARGET_SIZE}px either way.`,
    };
  }

  let image: HTMLImageElement;
  try {
    image = await decode(file);
  } catch {
    return { ok: false, message: "That file could not be read as an image." };
  }

  let last = "";
  for (const attempt of ATTEMPTS) {
    const canvas = draw(image, attempt.size);
    if (canvas === null) return { ok: false, message: "This browser could not draw the image." };
    last = canvas.toDataURL(attempt.type, attempt.quality);
    if (last.length > PROJECT_CATEGORY_ICON_MAX_LENGTH) continue;
    // The same check the server runs, on the same string, before it is sent —
    // so a browser that produced something unexpected is caught here rather
    // than as a 400 after the operator hit Save.
    const rejection = validateProjectCategoryIcon(last);
    if (rejection !== null) {
      return { ok: false, message: describeProjectCategoryIconRejection(rejection) };
    }
    return { ok: true, icon: last, bytes: Math.round((last.length * 3) / 4) };
  }

  return {
    ok: false,
    message: `That image would not fit the icon budget even at 64px (${last.length} characters). Try a flatter image — a logo or a solid-background mark rather than a photograph.`,
  };
}
