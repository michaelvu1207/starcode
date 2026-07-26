/**
 * A project's mark: an uploaded icon when it has one, its constellation when it
 * does not.
 *
 * Every project gets a shape nobody drew — a handful of stars joined by a
 * hairline, deterministic from the slug, so the same project is the same figure
 * on every machine and stays that figure forever. It is what makes a grid of
 * cards scannable without anyone naming an icon.
 *
 * Drawn in the engraving vocabulary rather than in colour: `currentColor` at
 * the caller's opacity, hairline strokes, no fills beyond the stars themselves.
 * The accent hue is applied by the card, not here, so a glyph inherits whatever
 * the theme decides ink is.
 *
 * **Why the icon lives in this component rather than beside it.** Six surfaces
 * render this mark, every one of them wrapped in the same `.sc-project-mark`
 * span at the size that surface uses. Choosing icon-versus-constellation here
 * makes that one decision in one place; a sibling component would make it six,
 * and the seventh surface somebody adds would forget. It also puts the fallback
 * where the failure is: an icon whose bytes will not decode falls back to the
 * constellation without the caller knowing there was ever a choice.
 */
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

import { projectGlyph, projectGlyphSeed } from "./ProjectsIndex.model";

export function ProjectGlyph({
  slug,
  variant = "",
  icon = "",
  className,
}: {
  readonly slug: string;
  /** Chosen figure. Empty — the default — is the one the slug gives. */
  readonly variant?: string;
  /** Uploaded mark as a data URI. Empty — the default — draws the figure. */
  readonly icon?: string;
  readonly className?: string;
}) {
  const glyph = useMemo(() => projectGlyph(projectGlyphSeed(slug, variant)), [slug, variant]);
  const [broken, setBroken] = useState(false);

  // A new icon deserves a fresh attempt: without this, one failed decode would
  // keep a project on its constellation for the rest of the session even after
  // the operator uploaded something that works.
  useEffect(() => setBroken(false), [icon]);

  if (icon.length > 0 && !broken) {
    return (
      <img
        src={icon}
        alt=""
        aria-hidden
        onError={() => setBroken(true)}
        // The accent's hue rotation is undone by `.sc-project-mark:has(img)` in
        // `Projects.css` — on the wrapper, because an ancestor's filter applies
        // to its whole subtree and cannot be cancelled from inside it. Rounded
        // and cropped square here so an icon reads as a mark, not an avatar.
        className={cn("size-full rounded-[3px] object-cover", className)}
      />
    );
  }

  return (
    <svg
      viewBox="0 0 1 1"
      className={cn("size-full", className)}
      aria-hidden
      // Strokes are specified in user units against a 1×1 box, so they scale
      // with the glyph rather than pinning to device pixels — a 20px card
      // marker and a 56px header mark are the same drawing, not two.
      vectorEffect="non-scaling-stroke"
    >
      <g stroke="currentColor" strokeWidth={0.012} strokeLinecap="round" opacity={0.55}>
        {glyph.edges.map((edge) => (
          // Keyed on geometry rather than position: the whole figure is
          // regenerated from the slug, so an edge's coordinates *are* its
          // identity and no two in one glyph share them.
          <line
            key={`${edge.x1}-${edge.y1}-${edge.x2}-${edge.y2}`}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
          />
        ))}
      </g>
      {glyph.points.map((point) => (
        // The four-point star of the wordmark, at the scale each point asks
        // for. A circle would read as a bullet; this reads as a star.
        <path
          key={`${point.x}-${point.y}`}
          fill="currentColor"
          d={[
            `M${point.x} ${point.y - point.r}`,
            `Q${point.x} ${point.y} ${point.x + point.r} ${point.y}`,
            `Q${point.x} ${point.y} ${point.x} ${point.y + point.r}`,
            `Q${point.x} ${point.y} ${point.x - point.r} ${point.y}`,
            `Q${point.x} ${point.y} ${point.x} ${point.y - point.r}`,
            "Z",
          ].join(" ")}
        />
      ))}
    </svg>
  );
}
