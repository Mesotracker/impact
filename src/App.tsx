import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sun,
  Moon,
  Play,
  Pause,
  RotateCcw,
  Globe,
  Sliders,
  Eye,
  Crosshair,
  Activity,
  Layers,
  Flame,
  Radio,
  Sparkles,
} from 'lucide-react';
import MapView from './MapView';
import ImpactScene from './ImpactScene';
import TiltedMapScene from './TiltedMapScene';
import AsteroidPreview from './AsteroidPreview';
import { MATERIALS, Params, Results, compute, fmt, arrival } from './physics';
import {
  APPROACH,
  currentPhase,
  getTimelinePhases,
  physTimeAt,
  plumeStatsAt,
  shockKmAt,
  simMaxTau,
} from './timeline';
import { TileTheme } from './mapTiles';

type View = 'fused' | 'map' | '3d' | 'preview';

function SilverSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disp,
  unit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disp: string;
  unit?: string;
}) {
  return (
    <label className="block group">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-medium text-zinc-300 group-hover:text-zinc-100 transition-colors">
          {label}
        </span>
        <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-zinc-800/90 border border-zinc-600/50 text-zinc-100 shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]">
          {disp} {unit && <span className="text-zinc-400 font-normal">{unit}</span>}
        </span>
      </div>
      <div className="relative flex items-center">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => onChange(+e.target.value)}
          className="w-full h-1.5 bg-zinc-700/80 rounded-lg appearance-none cursor-pointer accent-zinc-200 hover:accent-white transition-all shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]"
        />
      </div>
    </label>
  );
}

const fmtTime = (s: number) =>
  s < 60 ? `${s.toFixed(1)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(2)} h`;

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const TILT_PRESETS = [
  { label: 'Top-down', tilt: 0 },
  { label: 'Oblique', tilt: 45 },
  { label: 'Cinematic', tilt: 65 },
  { label: 'Horizon', tilt: 80 },
];

const AMBIENT_PRESETS = [
  { label: 'Tactical', value: 0.85, icon: Moon },
  { label: 'Balanced', value: 1.35, icon: Sun },
  { label: 'Bright Daylight', value: 1.85, icon: Sparkles },
];

export default function App() {
  const [p, setP] = useState<Params>({
    lat: 38.8951,
    lng: -77.0364,
    diameter: 180,
    density: 3000,
    velocity: 22,
    angle: 45,
    shape: 'sphere',
    material: 'rock',
  });
  const [view, setView] = useState<View>('preview');
  const [sim, setSim] = useState<{ p: Params; r: Results } | null>(null);
  const [tau, setTau] = useState(-APPROACH);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tiltUi, setTiltUi] = useState(55);
  const [ambientLight, setAmbientLight] = useState(1.4);
  const [tileTheme, setTileTheme] = useState<TileTheme>('dark');

  const tauRef = useRef(-APPROACH);
  const tiltRef = useRef(55);
  const dynMaxTau = sim ? simMaxTau(sim.r.mt) : APPROACH + 45;

  const setTauBoth = (next: number, maxOverride?: number) => {
    const max = maxOverride ?? dynMaxTau;
    const clamped = Math.max(-APPROACH, Math.min(max, next));
    tauRef.current = clamped;
    setTau(clamped);
  };

  const setTiltBoth = (next: number) => {
    const clamped = Math.max(0, Math.min(85, next));
    tiltRef.current = clamped;
    setTiltUi(clamped);
  };

  const live = useMemo(() => compute(p), [p]);
  const set = (k: Partial<Params>) => setP(o => ({ ...o, ...k }));

  useEffect(() => {
    if (!sim || !playing) return;
    const localMax = simMaxTau(sim.r.mt);
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const next = tauRef.current + dt * speed;
      if (next >= localMax) {
        tauRef.current = localMax;
        setTau(localMax);
        setPlaying(false);
        return;
      }
      tauRef.current = next;
      setTau(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sim, playing, speed]);

  const simulate = () => {
    const sp = { ...p };
    const sr = compute(sp);
    setSim({ p: sp, r: sr });
    setTauBoth(-APPROACH, simMaxTau(sr.mt));
    setPlaying(true);
    setView('fused');
  };

  const togglePlay = () => {
    if (!sim) return;
    if (!playing && tauRef.current >= dynMaxTau - 0.1) {
      setTauBoth(-APPROACH);
    }
    setPlaying(v => !v);
  };

  const scrubTo = (val: number) => {
    setTauBoth(val);
    if (view === 'preview' && sim) setView('fused');
  };

  const r = sim?.r;
  const shockKm = sim && tau > 0 ? shockKmAt(tau, sim.r) : 0;
  const tPhys = sim && tau > 0 ? physTimeAt(tau, sim.r) : 0;
  const plume = sim
    ? plumeStatsAt(tau, sim.r)
    : { heightKm: 0, capRadiusKm: 0, integrity: 0, ageSeconds: 0, lifeSeconds: 0 };
  const phase = currentPhase(tau, sim?.r.mt ?? 1);
  const phases = useMemo(() => (sim ? getTimelinePhases(sim.r.mt) : []), [sim]);

  const zones = r
    ? [
        { n: 'Crater rim', km: r.craterD / 2, c: 'bg-purple-400', border: 'border-purple-400/40' },
        { n: 'Thermal fireball', km: r.fireball, c: 'bg-amber-300', border: 'border-amber-300/40' },
        { n: '5 psi structural collapse', km: r.overpressure, c: 'bg-red-500', border: 'border-red-500/40' },
        { n: '3rd-degree thermal burns', km: r.thermal, c: 'bg-orange-500', border: 'border-orange-500/40' },
        { n: '1 psi glass shattering', km: r.lightDamage, c: 'bg-yellow-400', border: 'border-yellow-400/40' },
      ].filter(z => z.km > 0)
    : [];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#090c12] text-zinc-200 font-sans">
      {/* Precision Silver Sidebar */}
      <aside className="flex w-84 shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-zinc-400/25 bg-gradient-to-b from-[#181d26] via-[#12161f] to-[#0c0e14] p-4 shadow-[4px_0_24px_rgba(0,0,0,0.5)]">
        {/* Silver Brand Header */}
        <div className="border-b border-zinc-400/20 pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-300/40 bg-gradient-to-br from-zinc-100 via-zinc-300 to-zinc-400 shadow-[0_2px_8px_rgba(255,255,255,0.2)]">
                <Crosshair className="h-4 w-4 text-zinc-950" />
              </span>
              <h1 className="font-['Chakra_Petch',sans-serif] text-xl font-bold tracking-wider bg-gradient-to-r from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent drop-shadow-sm">
                IMPACTSIM-V1
              </h1>
            </div>
            <span className="rounded-full border border-zinc-500/40 bg-zinc-800/80 px-2 py-0.5 font-mono text-[9px] font-semibold text-zinc-300 shadow-sm">
              MIL-SPEC
            </span>
          </div>
          <p className="mt-1 font-mono text-[10px] text-zinc-400 tracking-tight">
            Orbital Impactor Telemetry & Blast Propagation Engine
          </p>
        </div>

        {/* Target Location Card */}
        <section className="space-y-2 rounded-xl border border-zinc-400/25 bg-gradient-to-b from-[#1c222e]/90 to-[#141822]/90 p-3 shadow-[0_4px_16px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.12)]">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              <Globe className="h-3.5 w-3.5 text-zinc-300" />
              <span>Target Ground Zero</span>
            </h2>
            <span className="font-mono text-[10px] text-cyan-300 bg-cyan-950/60 border border-cyan-500/30 px-1.5 py-0.2 rounded">
              GPS LOCK
            </span>
          </div>
          <div className="h-36 overflow-hidden rounded-lg border border-zinc-600/40 shadow-inner">
            <MapView
              lat={p.lat}
              lng={p.lng}
              onPick={(lat, lng) => set({ lat, lng })}
              results={null}
              shockKm={0}
            />
          </div>
          <div className="flex items-center justify-between font-mono text-[11px] text-zinc-300">
            <div>
              <span className="text-zinc-400">LAT:</span> {p.lat.toFixed(4)}°
            </div>
            <div>
              <span className="text-zinc-400">LNG:</span> {p.lng.toFixed(4)}°
            </div>
            <span className="text-[10px] text-zinc-400">(click map to relocate)</span>
          </div>
        </section>

        {/* Impactor Physics Parameters Card */}
        <section className="space-y-3 rounded-xl border border-zinc-400/25 bg-gradient-to-b from-[#1c222e]/90 to-[#141822]/90 p-3.5 shadow-[0_4px_16px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.12)]">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              <Sliders className="h-3.5 w-3.5 text-zinc-300" />
              <span>Impactor Parameters</span>
            </h2>
            <span className="font-mono text-[10px] text-amber-300">
              KE: {fmt(live.mt)} Mt
            </span>
          </div>

          <SilverSlider
            label="Diameter"
            value={p.diameter}
            min={10}
            max={2000}
            step={10}
            onChange={v => set({ diameter: v })}
            disp={p.diameter >= 1000 ? `${(p.diameter / 1000).toFixed(2)} km` : `${p.diameter} m`}
          />

          <SilverSlider
            label="Impact Velocity"
            value={p.velocity}
            min={11}
            max={72}
            step={0.5}
            onChange={v => set({ velocity: v })}
            disp={`${p.velocity} km/s`}
          />

          <SilverSlider
            label="Trajectory Entry Angle"
            value={p.angle}
            min={15}
            max={90}
            step={1}
            onChange={v => set({ angle: v })}
            disp={`${p.angle}°`}
          />

          {/* Material Selector with Silver Bevel */}
          <div className="space-y-1">
            <span className="text-xs font-medium text-zinc-300">Composition & Density</span>
            <select
              value={p.material}
              onChange={e =>
                set({ material: e.target.value, density: MATERIALS[e.target.value].density })
              }
              className="w-full rounded-lg border border-zinc-500/40 bg-zinc-800/90 px-2.5 py-1.5 text-xs text-zinc-100 font-mono shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)] focus:border-zinc-300 focus:outline-none"
            >
              {Object.entries(MATERIALS).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label} ({m.density} kg/m³)
                </option>
              ))}
            </select>
          </div>

          {/* Shape Selector Chips */}
          <div className="space-y-1">
            <span className="text-xs font-medium text-zinc-300">Geometry</span>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                ['sphere', 'Spherical'],
                ['oblate', 'Oblate'],
                ['irregular', 'Irregular'],
              ].map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => set({ shape: k })}
                  className={`rounded-lg py-1.5 text-xs font-medium transition-all ${
                    p.shape === k
                      ? 'border border-zinc-200 bg-gradient-to-b from-zinc-100 via-zinc-200 to-zinc-400 text-zinc-950 font-semibold shadow-[0_2px_8px_rgba(255,255,255,0.2)]'
                      : 'border border-zinc-600/40 bg-zinc-800/60 text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Master Silver Trigger Button */}
        <button
          onClick={simulate}
          className="group relative flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-gradient-to-b from-zinc-100 via-zinc-200 to-zinc-400 py-3.5 font-['Chakra_Petch',sans-serif] text-sm font-bold tracking-wider text-zinc-950 shadow-[0_4px_20px_rgba(255,255,255,0.25),inset_0_1px_1px_rgba(255,255,255,0.9),inset_0_-2px_4px_rgba(0,0,0,0.3)] transition-all hover:brightness-105 active:scale-[0.99] cursor-pointer"
        >
          <Flame className="h-4 w-4 text-orange-600" />
          <span>INITIALIZE IMPACT SIMULATION</span>
        </button>

        {/* Live Calculation Preview Banner */}
        <div className="rounded-lg border border-zinc-500/20 bg-zinc-900/60 p-2.5 font-mono text-[11px] text-zinc-300">
          <div className="flex justify-between">
            <span className="text-zinc-400">Total Mass:</span>
            <span className="text-zinc-200">{fmt(live.mass)} kg</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">Calculated Yield:</span>
            <span className="text-amber-300 font-semibold">{fmt(live.mt)} Mt TNT</span>
          </div>
        </div>
      </aside>

      {/* Main View Area */}
      <main className="relative flex flex-1 flex-col overflow-hidden">
        {/* Sleek Silver Navigation Bar */}
        <header className="z-10 flex flex-wrap items-center justify-between border-b border-zinc-400/25 bg-gradient-to-r from-[#181d26] via-[#141822] to-[#181d26] px-4 py-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
          <div className="flex items-center gap-1.5">
            {(
              [
                ['fused', '🌐 3D Fused Map', Layers],
                ['map', '2D Tactical Grid', Globe],
                ['3d', 'Classic 3D Scene', Radio],
                ['preview', 'Bolide Preview', Eye],
              ] as [View, string, any][]
            ).map(([k, l, Icon]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                disabled={k !== 'preview' && !sim}
                className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all disabled:opacity-30 cursor-pointer ${
                  view === k
                    ? 'border border-zinc-200 bg-gradient-to-b from-zinc-100 via-zinc-200 to-zinc-300 text-zinc-950 font-bold shadow-[0_2px_10px_rgba(255,255,255,0.2),inset_0_1px_0_rgba(255,255,255,0.8)]'
                    : 'border border-zinc-600/30 bg-zinc-800/40 text-zinc-300 hover:bg-zinc-700/50 hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{l}</span>
              </button>
            ))}
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-2">
            {sim && (
              <button
                onClick={() => {
                  setTauBoth(-APPROACH);
                  setPlaying(true);
                  setView('fused');
                }}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-400/30 bg-zinc-800/70 px-3 py-1.5 text-xs font-semibold text-zinc-200 shadow-sm hover:bg-zinc-700 hover:text-white transition-all cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5 text-orange-400" />
                <span>Reset Detonation</span>
              </button>
            )}
          </div>
        </header>

        {/* 3D Map View Ambient Light & Camera Toolbar */}
        {view === 'fused' && sim && (
          <div className="z-10 flex flex-wrap items-center gap-4 border-b border-zinc-400/20 bg-gradient-to-r from-zinc-950/95 via-zinc-900/95 to-zinc-950/95 px-5 py-2 font-mono text-[11px] backdrop-blur-md shadow-sm">
            {/* Tilt Control */}
            <div className="flex items-center gap-2">
              <span className="text-zinc-400 uppercase tracking-wider text-[10px] font-semibold">
                Camera Tilt:
              </span>
              <span className="w-8 text-zinc-100 font-bold">{tiltUi.toFixed(0)}°</span>
              <input
                type="range"
                min={0}
                max={85}
                step={1}
                value={tiltUi}
                onChange={e => setTiltBoth(+e.target.value)}
                className="h-1.5 w-28 cursor-pointer accent-zinc-200 bg-zinc-700 rounded-lg"
                title="Camera elevation angle"
              />
              <div className="flex gap-1">
                {TILT_PRESETS.map(pr => (
                  <button
                    key={pr.label}
                    onClick={() => setTiltBoth(pr.tilt)}
                    className={`rounded px-1.5 py-0.5 text-[10px] transition-all cursor-pointer ${
                      Math.abs(tiltUi - pr.tilt) < 3
                        ? 'border border-zinc-300 bg-zinc-200 text-zinc-950 font-bold'
                        : 'border border-zinc-700 bg-zinc-800/80 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {pr.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="h-4 w-[1px] bg-zinc-700/60" />

            {/* Ambient Light Control (Requested explicitly: "make the base map in 3d map view have ambient light because its too dark to see right now") */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 text-zinc-300">
                <Sun className="h-3.5 w-3.5 text-amber-300" />
                <span className="text-zinc-400 uppercase tracking-wider text-[10px] font-semibold">
                  Map Ambient Fill:
                </span>
              </div>
              <span className="w-10 text-amber-300 font-bold">{Math.round(ambientLight * 100)}%</span>
              <input
                type="range"
                min={0.5}
                max={2.5}
                step={0.05}
                value={ambientLight}
                onChange={e => setAmbientLight(+e.target.value)}
                className="h-1.5 w-28 cursor-pointer accent-amber-300 bg-zinc-700 rounded-lg"
                title="Adjust map surface ambient brightness"
              />
              <div className="flex gap-1">
                {AMBIENT_PRESETS.map(amb => {
                  const Icon = amb.icon;
                  return (
                    <button
                      key={amb.label}
                      onClick={() => setAmbientLight(amb.value)}
                      className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] transition-all cursor-pointer ${
                        Math.abs(ambientLight - amb.value) < 0.1
                          ? 'border border-amber-300/80 bg-amber-400 text-zinc-950 font-bold'
                          : 'border border-zinc-700 bg-zinc-800/80 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      <Icon className="h-2.5 w-2.5" />
                      <span>{amb.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="h-4 w-[1px] bg-zinc-700/60" />

            {/* Basemap Style Toggle (Dark vs High-Vis Daylight) */}
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-zinc-400 uppercase tracking-wider text-[10px] font-semibold">
                Map Layer:
              </span>
              <button
                onClick={() => setTileTheme('dark')}
                className={`rounded px-2 py-0.5 text-[10px] transition-all cursor-pointer ${
                  tileTheme === 'dark'
                    ? 'border border-zinc-300 bg-zinc-200 text-zinc-950 font-bold shadow-sm'
                    : 'border border-zinc-700 bg-zinc-800/80 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Tactical Dark
              </button>
              <button
                onClick={() => setTileTheme('voyager')}
                className={`rounded px-2 py-0.5 text-[10px] transition-all cursor-pointer ${
                  tileTheme === 'voyager'
                    ? 'border border-zinc-300 bg-zinc-200 text-zinc-950 font-bold shadow-sm'
                    : 'border border-zinc-700 bg-zinc-800/80 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                High-Vis Daylight
              </button>
            </div>
          </div>
        )}

        {/* Viewport Canvas Container */}
        <div className="relative flex-1 overflow-hidden bg-black">
          {view === 'preview' && <AsteroidPreview p={p} r={live} />}
          {view === 'map' && sim && (
            <MapView
              lat={sim.p.lat}
              lng={sim.p.lng}
              onPick={() => {}}
              results={sim.r}
              shockKm={shockKm}
            />
          )}
          {view === '3d' && sim && <ImpactScene p={sim.p} r={sim.r} tauRef={tauRef} />}
          {view === 'fused' && sim && (
            <TiltedMapScene
              p={sim.p}
              r={sim.r}
              tauRef={tauRef}
              tiltRef={tiltRef}
              onTiltChange={setTiltUi}
              ambientLevel={ambientLight}
              tileTheme={tileTheme}
            />
          )}

          {/* Top-Left Telemetry Glass HUD */}
          {sim && view !== 'preview' && (
            <div className="pointer-events-none absolute left-4 top-4 z-[1000] space-y-1.5 rounded-xl border border-zinc-400/40 bg-zinc-900/85 p-3.5 font-mono text-xs shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.2)] backdrop-blur-md">
              <div className="flex items-center gap-2 border-b border-zinc-700/60 pb-1.5">
                <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse shadow-[0_0_8px_rgba(249,115,22,0.8)]" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-100">
                  {phase.label}
                </span>
                <span className="ml-auto text-[10px] text-zinc-400">TELEMETRY</span>
              </div>
              <div className="text-3xl font-black tracking-tight text-white drop-shadow">
                {tau < 0 ? `T${tau.toFixed(2)} s` : `T+ ${fmtTime(tPhys)}`}
              </div>
              <div className="text-[11px] text-zinc-300 font-sans">{phase.desc}</div>

              <div className="grid grid-cols-2 gap-x-5 gap-y-1 pt-1.5 border-t border-zinc-700/60 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">Shockwave R:</span>
                  <span className="font-bold text-cyan-300">{shockKm.toFixed(2)} km</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">Plume Alt:</span>
                  <span className="font-bold text-amber-300">{plume.heightKm.toFixed(1)} km</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">Anvil Cap R:</span>
                  <span className="font-bold text-zinc-200">{plume.capRadiusKm.toFixed(1)} km</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">Vortex Density:</span>
                  <span className="font-bold text-emerald-300">{plume.integrity}%</span>
                </div>
                <div className="col-span-2 text-[10px] text-zinc-400 pt-0.5">
                  Cloud Life: {tau <= 0 ? '0s' : fmtTime(plume.ageSeconds)} of ~{fmtTime(plume.lifeSeconds)} real-world dispersal
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Silver Replay & Interactive Timeline Transport Bar */}
        {sim && (
          <div className="z-20 border-t border-zinc-400/25 bg-gradient-to-r from-[#181d26]/95 via-[#131720]/95 to-[#181d26]/95 px-5 py-3 shadow-[0_-4px_20px_rgba(0,0,0,0.5)] backdrop-blur-md">
            <div className="flex flex-wrap items-center gap-4">
              {/* Transport Buttons with Polished Silver Accents */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setTauBoth(-APPROACH);
                    setPlaying(true);
                  }}
                  title="Rewind to Atmospheric Entry"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-500/40 bg-zinc-800/80 text-zinc-200 shadow-sm hover:bg-zinc-700 hover:text-white transition-all cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>

                <button
                  onClick={togglePlay}
                  className="flex h-8 min-w-[90px] items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-gradient-to-b from-zinc-100 via-zinc-200 to-zinc-400 px-3 text-xs font-bold text-zinc-950 shadow-[0_2px_8px_rgba(255,255,255,0.25)] hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer"
                >
                  {playing ? (
                    <>
                      <Pause className="h-3.5 w-3.5 fill-current" />
                      <span>PAUSE</span>
                    </>
                  ) : tau >= dynMaxTau - 0.1 ? (
                    <>
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>REPLAY</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5 fill-current" />
                      <span>PLAY</span>
                    </>
                  )}
                </button>
              </div>

              {/* Scrubber & Phase Selector */}
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-200">
                      DETONATION TIMELINE:
                    </span>
                    <span className="font-bold text-orange-400">
                      {tau >= 0 ? `+${tau.toFixed(1)}s` : `${tau.toFixed(1)}s`}
                    </span>
                    <span className="text-zinc-500">
                      (Total Anim: {dynMaxTau.toFixed(0)}s)
                    </span>
                  </div>
                  <span className="text-zinc-400 text-[10px]">
                    Phase: <strong className="text-zinc-200">{phase.label}</strong>
                  </span>
                </div>

                <input
                  type="range"
                  min={-APPROACH}
                  max={dynMaxTau}
                  step={0.05}
                  value={tau}
                  onChange={e => {
                    setPlaying(false);
                    scrubTo(+e.target.value);
                  }}
                  className="h-2 w-full cursor-pointer accent-orange-500 bg-zinc-700/80 rounded-lg shadow-inner"
                />

                {/* Quick-Jump Milestone Phase Buttons */}
                <div className="flex flex-wrap items-center justify-between gap-1 pt-0.5">
                  {phases.map(ph => {
                    const active = phase.id === ph.id;
                    return (
                      <button
                        key={ph.id}
                        onClick={() => {
                          setPlaying(false);
                          scrubTo(ph.tau);
                        }}
                        title={`${ph.label}: ${ph.desc}`}
                        className={`rounded-md px-2 py-0.5 font-mono text-[10px] transition-all cursor-pointer ${
                          active
                            ? 'border border-orange-400/80 bg-orange-500/25 text-orange-200 font-bold shadow-[0_0_8px_rgba(249,115,22,0.4)]'
                            : 'border border-zinc-700/60 bg-zinc-800/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                        }`}
                      >
                        {ph.short} ({ph.tau >= 0 ? `+${ph.tau.toFixed(1)}s` : `${ph.tau.toFixed(1)}s`})
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Speed Controller */}
              <div className="flex items-center gap-1 rounded-lg border border-zinc-500/30 bg-zinc-900/80 p-1">
                <span className="px-1.5 font-mono text-[10px] uppercase text-zinc-400">
                  Rate
                </span>
                {SPEEDS.map(s => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={`rounded px-2 py-0.5 font-mono text-xs transition-all cursor-pointer ${
                      speed === s
                        ? 'border border-zinc-300 bg-gradient-to-b from-zinc-100 to-zinc-300 text-zinc-950 font-bold shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Right Silver Telemetry & Impact Report Panel */}
      {r && sim && (
        <aside className="w-84 shrink-0 space-y-3.5 overflow-y-auto border-l border-zinc-400/25 bg-gradient-to-b from-[#181d26] via-[#12161f] to-[#0c0e14] p-4 text-sm shadow-[-4px_0_24px_rgba(0,0,0,0.5)]">
          <div className="flex items-center justify-between border-b border-zinc-400/20 pb-2">
            <h2 className="flex items-center gap-1.5 font-['Chakra_Petch',sans-serif] text-sm font-bold uppercase tracking-wider text-zinc-100">
              <Activity className="h-4 w-4 text-orange-400" />
              <span>Detonation Impact Report</span>
            </h2>
            <span className="font-mono text-[10px] text-zinc-400">FINALIZED</span>
          </div>

          {/* Kinetic Energy Yield Card */}
          <div className="rounded-xl border border-zinc-400/30 bg-gradient-to-br from-zinc-800/90 via-zinc-900/90 to-red-950/60 p-3.5 shadow-[0_4px_16px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.15)]">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Kinetic Energy Equivalent</span>
              <span className="font-mono text-[10px] text-zinc-500">{r.energyJ.toExponential(2)} J</span>
            </div>
            <div className="font-mono text-3xl font-black tracking-tight text-amber-300 mt-1">
              {fmt(r.mt)} <span className="text-sm font-semibold text-zinc-300">Megatons</span>
            </div>
            <div className="mt-2.5 rounded-lg border border-zinc-600/40 bg-zinc-900/80 p-2 text-xs text-zinc-300 font-mono">
              ≈ <strong className="text-red-300">{fmt(r.tsar, 2)}</strong> Tsar Bombas (50 Mt)
              <br />≈ <strong className="text-red-300">{fmt(r.hiroshima, 0)}</strong> Hiroshima Devices
            </div>
          </div>

          {r.airburst && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 p-2.5 text-xs text-amber-200">
              ⚠ Atmospheric Airburst: Bolide disrupted at altitude. No primary ground crater formed.
            </div>
          )}

          {/* Precision Physical Diagnostics Grid */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <SilverStatCard label="Crater Diameter" value={r.craterD ? `${fmt(r.craterD)} km` : '—'} />
            <SilverStatCard label="Crater Depth" value={r.craterDepth ? `${fmt(r.craterDepth * 1000, 0)} m` : '—'} />
            <SilverStatCard label="Fireball Radius" value={`${fmt(r.fireball)} km`} highlight />
            <SilverStatCard label="Seismic Shock" value={r.magnitude > 0 ? `M ${r.magnitude.toFixed(1)} Richter` : '—'} />
            <SilverStatCard label="Plume Max Alt" value={`${fmt(plume.heightKm, 1)} km`} />
            <SilverStatCard label="Cloud Stability" value={`${plume.integrity}%`} />
            <SilverStatCard label="Dispersal Span" value={fmtTime(plume.lifeSeconds)} />
            <SilverStatCard label="Elapsed Time" value={tau <= 0 ? '—' : fmtTime(plume.ageSeconds)} />
          </div>

          {/* Blast Damage Zones & Arrival */}
          <div className="space-y-2 pt-1">
            <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              Thermal & Overpressure Radii
            </h3>
            <div className="space-y-1.5">
              {zones.map(z => {
                const t = arrival(z.km, r.mt);
                const hit = tPhys >= t && tau > 0;
                return (
                  <div
                    key={z.n}
                    className={`flex items-center gap-2.5 rounded-lg p-2.5 transition-all ${
                      hit
                        ? 'border border-red-500/50 bg-red-950/40 shadow-[0_0_12px_rgba(239,68,68,0.2)]'
                        : 'border border-zinc-700/40 bg-zinc-900/60'
                    }`}
                  >
                    <span className={`h-3 w-3 shrink-0 rounded-full ${z.c} shadow-sm`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-zinc-100 truncate">{z.n}</div>
                      <div className="font-mono text-[11px] text-zinc-400">Radius = {fmt(z.km)} km</div>
                    </div>
                    <div
                      className={`font-mono text-[11px] font-semibold text-right ${
                        hit ? 'text-red-300' : 'text-zinc-500'
                      }`}
                    >
                      {hit ? '✓ DETONATED' : `T+ ${fmtTime(t)}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Shockwave Radial Arrival Matrix */}
          <div className="space-y-1.5 pt-1">
            <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              Shock Arrival by Distance
            </h3>
            <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px]">
              {[1, 2, 5, 10, 20, 50, 100, 200, 500]
                .filter(d => d <= r.lightDamage * 1.5 || d <= 5)
                .map(d => {
                  const t = arrival(d, r.mt);
                  const hit = tPhys >= t && tau > 0;
                  return (
                    <div
                      key={d}
                      className={`rounded-lg border p-1.5 text-center transition-all ${
                        hit
                          ? 'border-cyan-500/50 bg-cyan-950/40 text-cyan-200 font-bold'
                          : 'border-zinc-700/40 bg-zinc-900/60 text-zinc-400'
                      }`}
                    >
                      <div>{d} km</div>
                      <div className="text-[10px] text-zinc-400">{fmtTime(t)}</div>
                    </div>
                  );
                })}
            </div>
          </div>

          <p className="text-[10px] leading-relaxed text-zinc-400 border-t border-zinc-700/50 pt-2">
            Physics calculations grounded in Collins, Melosh & Marcus (2005) Hydrodynamic Scaling. The 3D fused map
            drapes real street and satellite tiles over true-scale digital topography with full ambient illumination.
          </p>
        </aside>
      )}
    </div>
  );
}

function SilverStatCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-400/20 bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 p-2.5 shadow-sm">
      <div className="text-[10px] uppercase font-semibold text-zinc-400 tracking-wide">{label}</div>
      <div className={`font-mono text-sm font-bold mt-0.5 ${highlight ? 'text-amber-300' : 'text-zinc-100'}`}>
        {value}
      </div>
    </div>
  );
}
