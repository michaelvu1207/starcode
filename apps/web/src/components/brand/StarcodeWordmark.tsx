/**
 * Fork-owned starcode wordmark.
 *
 * The mark is a crescent moon and the word is set lowercase in the rounded
 * display face. They are one idea, not two: the sidebar's background is a
 * night sky (see `starcode-theme.css` §4) and this crescent is the moon in it,
 * which is why the mark sits in the sidebar header and nowhere else by
 * default.
 *
 * The crescent is drawn as two arcs rather than a masked circle so it needs no
 * generated ids and stays crisp at the 14px the sidebar header gives it — a
 * masked crescent goes muddy at that size, and thin crescents disappear
 * entirely, so this one is cut to roughly a third of the disc.
 */
import { cn } from "../../lib/utils";

/**
 * Crescent alone. Sized by the caller through `className` so it can serve the
 * 14px header and the 40px empty-state hero from one path.
 */
export function StarcodeMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0", className)}
      fill="none"
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M7.34 2.46 A8 8 0 1 0 17.54 12.66 A7.4 7.4 0 0 1 7.34 2.46 Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Mark + word.
 *
 * `size` is two real lockups rather than one lockup with overridable classes:
 * the sidebar's is squeezed to fit a header that has ~51px left over after the
 * titlebar inset and four action buttons, and passing a bigger `text-*` class
 * into that lockup fights its deliberately small default. The hero lockup gets
 * the proportions the mark actually wants.
 *
 * `tone` follows the sidebar header's own rule: the header can be drawn over
 * the dev/nightly channel backdrop, where everything must go white to stay
 * legible against the art.
 */
export function StarcodeWordmark({
  className,
  markClassName,
  wordClassName,
  size = "compact",
  tone = "default",
}: {
  className?: string;
  markClassName?: string;
  wordClassName?: string;
  size?: "compact" | "hero";
  tone?: "default" | "on-backdrop";
}) {
  const hero = size === "hero";
  return (
    <span className={cn("flex min-w-0 items-center", hero ? "gap-2" : "gap-1", className)}>
      <StarcodeMark
        className={cn(
          hero ? "size-5" : "size-3",
          tone === "on-backdrop" ? "text-white" : "text-primary",
          markClassName,
        )}
      />
      <span
        className={cn(
          // Compact is 13px, not the 15px a wordmark would normally take, for
          // the header-space reason above. Baloo 2's tall x-height keeps it
          // legible there.
          "starcode-wordmark-text truncate",
          hero ? "text-xl" : "text-[0.8125rem]",
          tone === "on-backdrop" ? "text-white" : "text-foreground",
          wordClassName,
        )}
      >
        starcode
      </span>
    </span>
  );
}
