/**
 * The sky. One layer, behind the whole app.
 *
 * WHAT CHANGED, AND WHY IT IS ONE ELEMENT NOW
 * The backdrop used to be painted in six places — two on the sidebar panel, two
 * on the main pane, one starfield each — plus a rule that punched a hole through
 * every route's wrapper so the pane's gradient could be seen at all. Six
 * surfaces meant six chances to disagree, and they did: the seam down the middle
 * of the app was fought twice, once by stretching the sidebar's band to full
 * height and once by tinting it from the pane's phase. Both treated the symptom.
 *
 * This is the cause removed. One fixed element, portalled to `document.body`,
 * `z-index: -1`, painting the gradient once for the whole window. The sidebar,
 * the thread pane, the workbench and the settings shell are all tinted glass
 * over it. There is no seam because there is nothing to align.
 *
 * WHY `document.body` AND NOT THE SIDEBAR WRAPPER
 * Every `@base-ui` portal in the app — dialogs, menus, tooltips, comboboxes —
 * mounts to `document.body`, outside the sidebar wrapper, and those surfaces use
 * `backdrop-filter`. A sky mounted inside the wrapper would not be in their
 * backdrop chain, so every dropdown would blur nothing and read as a flat plate
 * floating over a sky it cannot see. Body level is the only mount that makes the
 * existing glass vocabulary correct.
 *
 * WHAT IT PAINTS, IN ORDER
 *   1. two field frames — the keyframes either side of now, each a 20x12 PNG
 *      of the real sky stretched to the viewport and blurred, with the top
 *      one's opacity carrying the crossfade between them
 *   2. the starfield — the chrome field, at the solved ceiling, drifting
 *
 * It used to paint a five-stop gradient and three mesh blobs under a turbulence
 * mask, all of it standing in for shape the measurement had thrown away. The
 * field has the shape, so the blobs are gone: fewer layers, less CSS, and a
 * backdrop that is the sky rather than an impression of one.
 *
 * All of it is `transform` and `opacity` on pre-painted layers, so it lives on
 * the compositor. The blur is a filter on a static image and rasterises once.
 * No canvas, no WebGL, no rAF, no timer beyond the one-minute tick in
 * `starcodeSky.ts` that moves the pair along.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function StarcodeSky() {
  // Portals need a target that exists. Rendering nothing on the first pass and
  // the layer on the second costs one paint of the body's own background, which
  // is the same ink the sky resolves to — so the swap is invisible.
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setTarget(document.body), []);
  if (!target) return null;

  return createPortal(
    <div aria-hidden="true" className="starcode-sky">
      {/* Two frames, always both mounted. Swapping which element holds which
          image would throw away the browser's decoded copy and its blurred
          raster every half hour; keeping the roles fixed and rewriting the two
          custom properties lets it reuse both for the twenty-nine minutes out
          of thirty when neither has changed. */}
      <div className="starcode-sky-frame starcode-sky-frame-a" />
      <div className="starcode-sky-frame starcode-sky-frame-b" />
      {/* The chrome starfield. One field for the whole window now rather than
          one per panel, which is why it can afford to drift: the old sidebar
          copy was a quarter the width, so the same speed wrapped four times as
          often and was held still for it. */}
      <div className="starcode-sky-field" />
    </div>,
    target,
  );
}
