import * as THREE from 'three';
import { fbm } from './noise';

const MAT_COLORS: Record<string, { color: number; metal: number; rough: number; emissive?: number }> = {
  ice: { color: 0xcfe6f5, metal: 0.05, rough: 0.35 },
  rock: { color: 0x8a7f72, metal: 0.12, rough: 0.92 },
  iron: { color: 0xa8a5a0, metal: 0.88, rough: 0.42 },
  gold: { color: 0xd4a93a, metal: 0.95, rough: 0.3 },
};

export function buildAsteroid(shape: string, material: string, seed = 1.7) {
  const geo = new THREE.IcosahedronGeometry(1, 6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(MAT_COLORS[material]?.color ?? 0x8a7f72);
  const v = new THREE.Vector3();
  // random crater centers
  const craters: { c: THREE.Vector3; r: number }[] = [];
  let s = seed * 1000;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 22; i++) {
    craters.push({
      c: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
      r: 0.08 + rnd() * 0.3,
    });
  }
  const rough = material === 'iron' || material === 'gold' ? 0.5 : 1;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let d =
      1 +
      fbm(v.x * 1.4 + seed, v.y * 1.4, v.z * 1.4, 3) *
        (shape === 'irregular' ? 0.45 : shape === 'oblate' ? 0.2 : 0.12);
    d += fbm(v.x * 6, v.y * 6, v.z * 6 + seed, 4) * 0.06 * rough;
    let shade = 0;
    for (const cr of craters) {
      const dist = v.distanceTo(cr.c) / cr.r;
      if (dist < 1.3) {
        const bowl = dist < 1 ? (dist * dist - 1) * 0.35 : 0;
        const rim = Math.exp(-Math.pow((dist - 1) * 5, 2)) * 0.12;
        d += (bowl + rim) * cr.r * rough;
        shade += bowl * 0.8;
      }
    }
    const p = v.clone().multiplyScalar(d);
    if (shape === 'oblate') p.y *= 0.6;
    if (shape === 'irregular') {
      p.x *= 1.5;
      p.z *= 0.85;
    }
    pos.setXYZ(i, p.x, p.y, p.z);
    const n = fbm(v.x * 10, v.y * 10, v.z * 10, 3);
    const c = base.clone().multiplyScalar(0.8 + n * 0.4 + shade * 0.5);
    if (material === 'ice' && n > 0.1) c.lerp(new THREE.Color(0xffffff), 0.5);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const m = MAT_COLORS[material] ?? MAT_COLORS.rock;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: m.metal,
    roughness: m.rough,
    flatShading: material === 'rock',
  });
  return new THREE.Mesh(geo, mat);
}
