import { Results, arrival } from './physics';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const APPROACH = 2.5; // s of pre-impact atmospheric entry (yield-independent)
export const REF_ANIM = 45; // baseline tau (s) the original plume/fireball shader choreography was tuned for (~1 Mt reference)

/** Tau (animation seconds) allocated for the mushroom column to fully form & dissipate. */
export function plumeAnimDuration(mt: number): number {
  const m = clamp(mt, 0.0003, 2e6);
  const logMt = Math.log10(m);
  const lo = -3.5,
    hi = 6.3;
  const f = clamp((logMt - lo) / (hi - lo), 0, 1);
  const animMin = 7,
    animMax = 78;
  return animMin + f * (animMax - animMin);
}

/** Multiplier applied to raw elapsed tau to get "warped" column time: <1 slows big plumes, >1 speeds up small ones. */
export function plumeTimeScale(mt: number): number {
  return REF_ANIM / plumeAnimDuration(mt);
}

/** Fraction of REF_ANIM that the primary shockwave traversal occupies, scaled to this impact's total animation span. */
export function shockAnimSpan(mt: number): number {
  return plumeAnimDuration(mt) * (14 / REF_ANIM);
}

/** Real-world mushroom-cloud lifetime this animation represents: ~5-50 min (small) up to 9+ hours (gigaton+). */
export function plumeLifeSeconds(mt: number): number {
  const m = clamp(mt, 0.0003, 2e6);
  const life = 3000 * Math.pow(m, 0.34);
  return clamp(life, 300, 4 * 24 * 3600);
}

/** Extra brightness/intensity for larger detonations (bigger fireballs & longer-glowing plumes). */
export function plumeBrightnessFactor(mt: number): number {
  const m = clamp(mt, 0.0003, 2e6);
  return clamp(0.75 + 0.16 * Math.log10(m + 1), 0.75, 1.9);
}

/** Physical size multiplier for the column: small impacts get a slender plume, gigaton impacts a vast one. */
export function plumeScaleFactor(mt: number): number {
  const m = clamp(mt, 0.0003, 2e6);
  return clamp(0.5 + 0.5 * Math.log10(m + 1.2), 0.42, 3.2);
}

/** Max tau (animation seconds) the replay timeline needs to cover this impact's full life cycle. */
export function simMaxTau(mt: number): number {
  return APPROACH + plumeAnimDuration(mt) * 1.12;
}

export interface TimelinePhase {
  id: string;
  label: string;
  short: string;
  tau: number;
  desc: string;
}

const PHASE_DEFS: { id: string; label: string; short: string; twRef: number; desc: string }[] = [
  { id: 'entry', label: 'Atmospheric Entry', short: 'Entry', twRef: -2.2, desc: 'Hypersonic bolide approach & plasma trail' },
  { id: 'flash', label: 'Impact & Thermal Flash', short: 'Impact', twRef: 0.12, desc: 'Detonation flash & >5,000 K plasma ignition' },
  { id: 'fireball', label: 'Fireball & Wilson Cloud', short: 'Fireball', twRef: 1.5, desc: 'Ray-marched fireball expansion & condensation dome' },
  { id: 'shock', label: 'Blast Wave & Base Surge', short: 'Shockwave', twRef: 5.2, desc: 'Overpressure shock front & radial pyroclastic surge' },
  { id: 'column', label: 'Buoyant Plume Ascent', short: 'Ascent', twRef: 12.0, desc: 'Updraft stem suction & rolling toroidal vortex cap' },
  { id: 'billow', label: 'Stratospheric Anvil Billow', short: 'Billow', twRef: 22.0, desc: 'Neutral-buoyancy anvil spreading & cauliflower lobes' },
  { id: 'dissipate', label: 'Wind Shear & Dissipation', short: 'Dissipate', twRef: 35.0, desc: 'Stem detachment, eddy breakup & atmospheric dispersal' },
];

const PHASE_TW_BREAKS = [0.6, 3.2, 8.5, 17.5, 28.0];

/** Quick-jump timeline phase markers, with tau values rescaled to this impact's total duration. */
export function getTimelinePhases(mt: number): TimelinePhase[] {
  const spanScale = plumeAnimDuration(mt) / REF_ANIM;
  return PHASE_DEFS.map(ph => ({
    id: ph.id,
    label: ph.label,
    short: ph.short,
    desc: ph.desc,
    tau: ph.id === 'entry' ? ph.twRef : ph.twRef * spanScale,
  }));
}

export function currentPhase(tau: number, mt = 1): TimelinePhase {
  const phases = getTimelinePhases(mt);
  if (tau < 0) return phases[0];
  const spanScale = plumeAnimDuration(mt) / REF_ANIM;
  const tw = tau / spanScale;
  for (let i = 0; i < PHASE_TW_BREAKS.length; i++) {
    if (tw < PHASE_TW_BREAKS[i]) return phases[i + 1];
  }
  return phases[phases.length - 1];
}

export function physTimeAt(tau: number, r: Results) {
  if (tau <= 0) return 0;
  const span = shockAnimSpan(r.mt);
  const tEnd = arrival(r.lightDamage * 1.15, r.mt);
  if (tau <= span) {
    return (tau / span) * tEnd;
  }
  const extra = tau - span;
  return tEnd + extra * (tEnd / span) * (1 + extra * 0.08);
}

export function shockKmAt(tau: number, r: Results) {
  if (tau <= 0) return 0;
  const tp = physTimeAt(tau, r);
  let lo = 0,
    hi = r.lightDamage * 4;
  for (let i = 0; i < 32; i++) {
    const m = (lo + hi) / 2;
    if (arrival(m, r.mt) < tp) lo = m;
    else hi = m;
  }
  return lo;
}

export interface PlumeStats {
  heightKm: number;
  capRadiusKm: number;
  integrity: number;
  ageSeconds: number;
  lifeSeconds: number;
}

export function plumeStatsAt(tau: number, r: Results): PlumeStats {
  const lifeSeconds = plumeLifeSeconds(r.mt);
  if (tau <= 0) return { heightKm: 0, capRadiusKm: 0, integrity: 0, ageSeconds: 0, lifeSeconds };
  const animDur = plumeAnimDuration(r.mt);
  const tw = tau * (REF_ANIM / animDur);
  const maxAltKm = clamp(
    9 * Math.pow(Math.max(r.mt, 0.01), 0.22) * clamp(0.7 + 0.25 * Math.log10(r.mt + 1), 0.7, 1.6),
    4,
    60
  );
  const rise = 1 - Math.exp(-tw / 6.5);
  const heightKm = maxAltKm * rise;
  const spread = 1 - Math.exp(-tw / 8) + Math.max(0, (tw - 14) * 0.045);
  const capRadiusKm = maxAltKm * 0.55 * spread;
  const diss = clamp((tw - 23) / 21, 0, 1);
  const integrity = Math.round((1 - diss * diss) * 100);
  const ageSeconds = clamp(tau / (animDur * 1.0), 0, 1) * lifeSeconds;
  return { heightKm, capRadiusKm, integrity, ageSeconds, lifeSeconds };
}
