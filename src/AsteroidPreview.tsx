import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildAsteroid } from './AsteroidMesh';
import { Params, Results, fmt } from './physics';

export default function AsteroidPreview({ p, r }: { p: Params; r: Results }) {
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef<{ scene: THREE.Scene; mesh?: THREE.Mesh } | null>(null);

  useEffect(() => {
    const el = ref.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    cam.position.set(0, 0.6, 4.2);
    const sun = new THREE.DirectionalLight(0xfff2dd, 3.2);
    sun.position.set(4, 2, 3);
    scene.add(sun, new THREE.AmbientLight(0x7788aa, 0.9));
    // starfield
    const sg = new THREE.BufferGeometry();
    const sp = new Float32Array(1500 * 3).map(() => (Math.random() - 0.5) * 60);
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.06, color: 0xcccccc })));
    const ctr = new OrbitControls(cam, renderer.domElement);
    ctr.enableDamping = true;
    ctr.autoRotate = true;
    ctr.autoRotateSpeed = 1.2;
    ctr.minDistance = 2;
    ctr.maxDistance = 10;
    st.current = { scene };
    let raf = 0;
    const resize = () => {
      const w = el.clientWidth,
        h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (st.current?.mesh) {
        st.current.mesh.rotation.x += 0.002;
        st.current.mesh.rotation.z += 0.001;
      }
      ctr.update();
      renderer.render(scene, cam);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      el.innerHTML = '';
    };
  }, []);

  useEffect(() => {
    const s = st.current;
    if (!s) return;
    if (s.mesh) {
      s.scene.remove(s.mesh);
      s.mesh.geometry.dispose();
    }
    s.mesh = buildAsteroid(p.shape, p.material);
    s.scene.add(s.mesh);
  }, [p.shape, p.material]);

  return (
    <div className="relative h-full w-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-900/60 via-[#0c0f16] to-[#06080d]">
      <div ref={ref} className="absolute inset-0" />
      {/* Precision Silver Telemetry HUD */}
      <div className="pointer-events-none absolute inset-0 p-5 font-mono text-[11px] text-zinc-300">
        <div className="absolute left-5 top-5 space-y-1.5 rounded-lg border border-zinc-400/30 bg-zinc-900/80 p-3 shadow-[0_4px_20px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.15)] backdrop-blur-md">
          <div className="flex items-center gap-2 border-b border-zinc-700/60 pb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-200">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
            <span>BOLIDE TARGET TELEMETRY</span>
          </div>
          <div><span className="text-zinc-500">DIAMETER ..</span> <span className="text-zinc-100 font-semibold">{p.diameter >= 1000 ? (p.diameter / 1000).toFixed(2) + ' km' : p.diameter + ' m'}</span></div>
          <div><span className="text-zinc-500">MASS ......</span> <span className="text-zinc-100 font-semibold">{fmt(r.mass)} kg</span></div>
          <div><span className="text-zinc-500">DENSITY ...</span> <span className="text-zinc-100 font-semibold">{p.density} kg/m³</span></div>
          <div><span className="text-zinc-500">GEOMETRY ..</span> <span className="text-zinc-100 font-semibold uppercase">{p.shape}</span></div>
        </div>

        <div className="absolute right-5 top-5 space-y-1.5 text-right rounded-lg border border-zinc-400/30 bg-zinc-900/80 p-3 shadow-[0_4px_20px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.15)] backdrop-blur-md">
          <div className="flex items-center justify-end gap-2 border-b border-zinc-700/60 pb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-200">
            <span>APPROACH DYNAMICS</span>
            <span className="h-1.5 w-1.5 rounded-full bg-orange-400 animate-pulse" />
          </div>
          <div><span className="text-zinc-500">V_REL ...</span> <span className="text-zinc-100 font-semibold">{p.velocity} km/s</span></div>
          <div><span className="text-zinc-500">ENTRY ...</span> <span className="text-zinc-100 font-semibold">{p.angle}°</span></div>
          <div><span className="text-zinc-500">YIELD ...</span> <span className="text-amber-300 font-bold">{fmt(r.mt)} Mt</span></div>
        </div>

        <div className="absolute bottom-5 left-5 rounded border border-zinc-500/20 bg-zinc-900/60 px-3 py-1.5 text-[10px] text-zinc-400 backdrop-blur-sm">
          LEFT-DRAG TO ORBIT · SCROLL TO ZOOM · RIGHT-DRAG TO PAN
        </div>

        {/* Reticle brackets */}
        <div className="absolute inset-8 rounded-lg border border-zinc-400/15 pointer-events-none" />
      </div>
    </div>
  );
}
