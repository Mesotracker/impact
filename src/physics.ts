export interface Params {
  lat: number;
  lng: number;
  diameter: number;
  density: number;
  velocity: number;
  angle: number;
  shape: string;
  material: string;
}

export interface Results {
  mass: number;
  energyJ: number;
  mt: number;
  craterD: number;
  craterDepth: number;
  fireball: number;
  thermal: number;
  overpressure: number;
  lightDamage: number;
  magnitude: number;
  tsar: number;
  hiroshima: number;
  airburst: boolean;
}

export const MATERIALS: Record<string, { density: number; label: string; desc: string }> = {
  ice: { density: 1000, label: 'Porous Ice (Comet)', desc: 'Volatile nucleus, highly fragile' },
  rock: { density: 3000, label: 'Rock (Stony / Chondrite)', desc: 'Typical S-type silicate asteroid' },
  iron: { density: 8000, label: 'Iron (Metallic / M-type)', desc: 'Dense nickel-iron core fragment' },
  gold: { density: 19300, label: 'Ultra-Dense Heavy Metal', desc: 'Rare heavy-element asteroid core' },
};

export function compute(p: Params): Results {
  const r = p.diameter / 2;
  const shapeF = p.shape === 'oblate' ? 0.8 : p.shape === 'irregular' ? 0.7 : 1;
  const mass = (4 / 3) * Math.PI * Math.pow(r, 3) * p.density * shapeF;
  const v = p.velocity * 1000;
  const energyJ = 0.5 * mass * v * v;
  const mt = energyJ / 4.184e15;
  const th = (p.angle * Math.PI) / 180;
  // Collins et al. (2005) transient crater, rock target 2500 kg/m3
  const rhoT = 2500, g = 9.81;
  const Dtc =
    1.161 *
    Math.pow(p.density / rhoT, 1 / 3) *
    Math.pow(p.diameter, 0.78) *
    Math.pow(v, 0.44) *
    Math.pow(g, -0.22) *
    Math.pow(Math.sin(th), 1 / 3);
  // airburst heuristic: small weak bodies break up in dense atmosphere
  const airburst = (p.density <= 3000 && p.diameter < 60) || (p.density <= 1000 && p.diameter < 120);
  const craterD = airburst ? 0 : Dtc / 1000;
  const craterDepth = airburst ? 0 : Dtc / 2.828 / 1000;
  const fireball = (0.002 * Math.pow(energyJ, 1 / 3)) / 1000; // km
  const thermal = (1.9 * Math.pow(mt * 1000, 0.41)) / 10; // km, 3rd degree scaled
  const overpressure = 0.54 * Math.pow(mt * 1000, 1 / 3) * 0.9; // 5psi km
  const lightDamage = overpressure * 2.6; // 1psi
  const magnitude = airburst ? 0 : 0.67 * Math.log10(energyJ * 1e-4) - 5.87;
  return {
    mass,
    energyJ,
    mt,
    craterD,
    craterDepth,
    fireball,
    thermal: Math.max(thermal, fireball),
    overpressure,
    lightDamage,
    magnitude,
    tsar: mt / 50,
    hiroshima: mt / 0.015,
    airburst,
  };
}

export const fmt = (n: number, d = 2) => {
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
};

// Shock arrival (s) at distance km, Sedov-Taylor with sonic floor
export function arrival(distKm: number, mt: number) {
  const E = mt * 4.184e15, rho = 1.2, R = distKm * 1000;
  const tST = Math.sqrt((Math.pow(R, 5) * rho) / E);
  const tSonic = (R / 340) * 0.95;
  return Math.max(tST, tSonic > tST ? tSonic : tST);
}
