/**
 * The moon's actual phase, for the crescent on the idle surfaces.
 *
 * The sky already tracks the time of day; this tracks the time of month, from
 * the same clock and with the same "no network, no permissions" constraint. It
 * is a decorative detail nobody will check — which is exactly why it should be
 * right rather than a shape picked to look nice.
 *
 * Accuracy is the mean synodic month, so this drifts by a few hours against a
 * real ephemeris across a lunation. That is invisible at 16px, and the honest
 * alternative — an ephemeris table or an API — costs far more than the detail is
 * worth.
 */

/** A known new moon: 2000-01-06 18:14 UTC. */
const KNOWN_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
/** Mean synodic month, in days. */
const SYNODIC_MONTH_DAYS = 29.530588853;
const MS_PER_DAY = 86_400_000;

export type LunarPhaseName =
  | "new"
  | "waxing crescent"
  | "first quarter"
  | "waxing gibbous"
  | "full"
  | "waning gibbous"
  | "last quarter"
  | "waning crescent";

export interface LunarPhase {
  /** Position in the cycle: 0 and 1 are new, 0.5 is full. */
  readonly fraction: number;
  /** How much of the disc is lit, 0 to 1. */
  readonly illumination: number;
  /** True while the moon is filling — lit on the right in the northern sky. */
  readonly waxing: boolean;
  readonly name: LunarPhaseName;
}

function nameFor(fraction: number): LunarPhaseName {
  // Eighth-of-a-cycle buckets, with the four named instants given a narrow band
  // around them rather than a whole eighth — "full" should mean full.
  const eighth = 1 / 8;
  const near = (target: number): boolean =>
    Math.abs(fraction - target) < 0.02 || Math.abs(fraction - target - 1) < 0.02;
  if (near(0)) return "new";
  if (near(0.25)) return "first quarter";
  if (near(0.5)) return "full";
  if (near(0.75)) return "last quarter";
  if (fraction < eighth * 2) return "waxing crescent";
  if (fraction < eighth * 4) return "waxing gibbous";
  if (fraction < eighth * 6) return "waning gibbous";
  return "waning crescent";
}

export function lunarPhaseAt(date: Date): LunarPhase {
  const days = (date.getTime() - KNOWN_NEW_MOON_MS) / MS_PER_DAY;
  const fraction = (((days / SYNODIC_MONTH_DAYS) % 1) + 1) % 1;
  // The lit fraction follows the cosine of the phase angle, not the phase
  // itself: the moon spends longer looking nearly-full than a linear ramp would.
  const illumination = (1 - Math.cos(2 * Math.PI * fraction)) / 2;
  return { fraction, illumination, waxing: fraction < 0.5, name: nameFor(fraction) };
}
