/**
 * The colour a machine is drawn in, everywhere a machine is named.
 *
 * Derived from the environment id rather than the label, and that is the whole
 * point: the id is what four machines agree on, the label is a local alias any
 * one of them can rename. A colour keyed on the label would change under you
 * the moment you renamed a connection, and would disagree between two clients
 * that had not yet synced the alias. Keyed on the id, `laptop` is the same
 * colour on the laptop, on the desktop, and after you rename it to `mbp`.
 *
 * The output is a hue *rotation*, not a colour, for the reason the project
 * accent gives (`ProjectMark.model.ts`): rotating the theme's one chromatic
 * constant keeps every machine at the palette's chroma level, so a machine can
 * be distinguishable without any of them coming out neon in light mode or
 * muddy in dark. The hash is restated here rather than imported from the
 * projects module — a sidebar surface should not depend on the projects index
 * for a string hash — and it is deliberately the same FNV-1a so the two
 * families of mark land on the same wheel.
 */

/** A stable, well-spread value in [0, 360) for any string. */
export function connectionAccentHue(environmentId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash ^= environmentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // FNV's low bits are the well-mixed ones; the extra round spreads them over
  // the whole word so ids sharing a prefix do not land on adjacent hues.
  const mixed = Math.imul(hash ^ 0x9e3779b1, 0x85ebca6b) >>> 0;
  return Math.round((mixed / 0x1_0000_0000) * 360) % 360;
}
