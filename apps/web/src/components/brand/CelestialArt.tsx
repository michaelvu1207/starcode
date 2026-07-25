/**
 * Fork-owned celestial motifs for empty and idle surfaces.
 *
 * The restraint rule from the F11 plan: decoration appears only where there is
 * nothing to work on. Thread rows, transcripts, and the composer inherit the
 * palette and get no ornament, because ornament in dense UI is noise you
 * cannot scroll past.
 *
 * There is deliberately one motif language rather than a bespoke illustration
 * per surface: the crescent from the wordmark, plus specks, at whatever scale
 * the surface affords. A sidebar strip gets a 20px crescent; the pairing page
 * gets the helmet. Three unrelated illustrations would read as three brands.
 */
import { cn } from "../../lib/utils";
import { type CSSProperties, useId, useMemo } from "react";

import { lunarPhaseAt, type LunarPhase } from "../../lunarPhase";

/**
 * The crescent at empty-state scale with a speck or two beside it. Sized for
 * the narrow strips inside the sidebar, where anything larger would push the
 * message out of view.
 */
export function EmptyStateSky({ className }: { className?: string }) {
  const moon = lunarPhaseAt(new Date());
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex size-6 items-center justify-center", className)}
    >
      {/* Warm rather than grey: a muted-foreground disc reads as a dot, and
          most of the month the moon is too full to be saved by its outline. */}
      <MoonPhase className="size-4 text-primary/70" phase={moon} />
      <span className="absolute -top-0.5 right-0 size-1 rounded-full bg-primary/50" />
      <span className="absolute bottom-0.5 -left-0.5 size-[3px] rounded-full bg-muted-foreground/35" />
    </span>
  );
}

/**
 * The wordmark's crescent, carved to tonight's actual moon.
 *
 * The disc is drawn once and a second disc is subtracted from it; sliding that
 * second disc across is what makes a crescent widen into a gibbous. Offsetting a
 * cutout is the whole trick, and it is why this is one path and a mask rather
 * than eight hand-drawn shapes.
 *
 * At new moon nothing would be left to see, so a hairline ring stays behind —
 * an empty sky with a hole in it reads as a missing icon, not as a new moon.
 */
export function MoonPhase({ phase, className }: { phase: LunarPhase; className?: string }) {
  const id = useId();
  // How far the cutout sits from centre: fully overlapping at new, fully clear
  // at full. 2 is one diameter, which is where the disc stops being occluded.
  const offset = 2 * Math.cos(Math.PI * phase.illumination) * (phase.waxing ? -1 : 1);
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0", className)}
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <mask id={id}>
        <circle cx="12" cy="12" fill="white" r="9" />
        <circle cx={12 + offset * 9} cy="12" fill="black" r="9" />
      </mask>
      <circle cx="12" cy="12" fill="currentColor" mask={`url(#${id})`} r="9" />
      <circle cx="12" cy="12" opacity="0.25" r="9" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/**
 * The full-page speck field, drawn behind the content of an idle surface.
 *
 * The tile and its opacity live in `starcode-theme.css` so the specks stay a
 * fixed size at any viewport — the earlier inline SVG scaled with the page and
 * turned 1.4px stars into 4px blobs on a wide screen.
 */
export function SkySpecks({ className }: { className?: string }) {
  // Drawn once per mount. CSS has no randomness, and a fixed period would put a
  // streak on the screen a second after every page load — see section 8.
  const flight = useMemo(() => {
    const periodSeconds = (22 + Math.random() * 33) * 60;
    // First flight somewhere in the back three quarters of the cycle, so opening
    // the app is never what triggers one.
    const firstFlightSeconds = periodSeconds * (0.25 + Math.random() * 0.75);
    return {
      "--sc-shoot-period": `${Math.round(periodSeconds)}s`,
      "--sc-shoot-delay": `${Math.round(firstFlightSeconds)}s`,
    } as CSSProperties;
  }, []);

  return (
    <div aria-hidden="true" className={cn("starcode-speck-field", className)}>
      {/* The drift layers are CHILDREN of the field, never a wrapper around it.
          The engraving rule matches on exact grandchild depth
          (`[data-slot="sidebar-inset"]:has(> * > .starcode-speck-field)`), so
          nesting the field one level deeper silently deletes the plate corners
          from every idle pane. Section 9 of the theme owns their motion. */}
      <div className="starcode-star-layer starcode-star-layer-1" />
      <div className="starcode-star-layer starcode-star-layer-2" />
      <div className="starcode-star-layer starcode-star-layer-3" />
      {/* About once an hour; see section 8 of the theme for why the period is
          set here rather than in CSS. */}
      <div className="starcode-shooting-star" style={flight} />
    </div>
  );
}

/**
 * The mascot, such as it is.
 *
 * A character — face, limbs, posture — is where hand-coded SVG goes uncanny,
 * so this is deliberately an object: a helmet whose visor reflects the same
 * night sky the sidebar is painted with. It stays inside the motif language
 * the rest of the brand already speaks (crescent, specks, ink, butter) instead
 * of introducing a cartoon that belongs to no other surface.
 *
 * Reserved for the pairing page, which is the one screen with room for it and
 * the one screen a person stares at while waiting.
 */
export function AstronautHelmet({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0", className)}
      fill="none"
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Helmet shell. */}
      <circle cx="64" cy="62" fill="var(--card)" r="46" />
      <circle cx="64" cy="62" r="46" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
      {/* Specular sweep along the upper-left rim — the only thing that makes
          the shell read as a sphere rather than a disc. */}
      <path
        d="M32 40 A39 39 0 0 1 60.6 23.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeOpacity="0.3"
        strokeWidth="4"
      />
      {/* Visor. */}
      <rect fill="var(--sc-ink-900, #12141f)" height="44" rx="22" width="64" x="32" y="42" />
      <rect
        height="44"
        rx="22"
        stroke="var(--sc-butter, #f0d9a0)"
        strokeOpacity="0.4"
        strokeWidth="1.25"
        width="64"
        x="32"
        y="42"
      />
      {/* The sky, reflected. Same crescent as the wordmark. */}
      <g transform="translate(70 56) scale(0.9)">
        <path
          d="M7.34 2.46 A8 8 0 1 0 17.54 12.66 A7.4 7.4 0 0 1 7.34 2.46 Z"
          fill="var(--sc-butter, #f0d9a0)"
          fillOpacity="0.9"
        />
      </g>
      <g fill="#e9e3d6">
        <circle cx="47" cy="62" opacity="0.55" r="1.6" />
        <circle cx="58" cy="76" opacity="0.35" r="1.1" />
        <circle cx="44" cy="82" opacity="0.28" r="1" />
        <circle cx="79" cy="83" opacity="0.3" r="1.2" />
      </g>
      {/* Collar. Overlaps the shell rather than floating below it, or the
          helmet reads as two unrelated shapes stacked. */}
      <path
        d="M40 103a44 44 0 0 0 48 0v5a6 6 0 0 1-6 6H46a6 6 0 0 1-6-6Z"
        fill="var(--card)"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
    </svg>
  );
}
