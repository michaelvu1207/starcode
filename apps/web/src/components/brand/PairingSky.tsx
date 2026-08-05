/**
 * Fork-owned shell for the pairing screens.
 *
 * Upstream frames these three states (pending, token entry, hosted result)
 * with an emerald-and-sky radial wash repeated inline at each call site. Those
 * are literal `--color-emerald-500` / `--color-sky-500` references rather than
 * theme tokens, so they survive a token override and land as a green-and-blue
 * glow in the middle of an ink-navy app. This replaces the wash rather than
 * retinting it, and collapses three copies of the markup into one component.
 *
 * Pairing is the app's only genuinely idle screen — you open it, then wait —
 * so it is where the motif budget is spent: the night sky, and the helmet.
 *
 * It used to paint its own sky: an opaque `bg-background` plus two hand-rolled
 * gradients pinned to `--sc-ink-950` and butter, which is to say a seventh copy
 * of the backdrop that did not track the hour and drifted from the six inside
 * the app shell. `StarcodeSky` now paints the window on this route too, so this
 * component is transparent and keeps only what is genuinely its own — the
 * helmet, the wordmark, and the bright speck field an idle screen has earned.
 */
import type { ReactNode } from "react";

import { AstronautHelmet, SkySpecks } from "./CelestialArt";
import { StarcodeWordmark } from "./StarcodeWordmark";

export function PairingSky({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10 text-foreground sm:px-6">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <SkySpecks />
      </div>

      <div className="relative flex w-full max-w-xl flex-col items-center">
        <AstronautHelmet className="size-28 text-foreground/80" />
        <StarcodeWordmark className="mt-4 mb-7" size="hero" />
        {children}
      </div>
    </div>
  );
}
