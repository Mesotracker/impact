import { MutableRefObject, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { buildAsteroid } from './AsteroidMesh';
import { GLSL_NOISE } from './noise';
import { Params, Results } from './physics';
import {
  APPROACH,
  REF_ANIM,
  shockAnimSpan,
  shockKmAt,
  plumeAnimDuration,
  plumeTimeScale,
  plumeBrightnessFactor,
} from './timeline';
import { buildMapCanvas, TileTheme } from './mapTiles';
import { Compass, Eye, Layers, Maximize2, Minimize2, Move, Navigation2 } from 'lucide-react';

interface Props {
  p: Params;
  r: Results;
  tauRef: MutableRefObject<number>;
  tiltRef: MutableRefObject<number>;
  onTiltChange?: (tilt: number) => void;
  ambientLevel?: number;
  tileTheme?: TileTheme;
}

const clampTilt = (d: number) => Math.max(5, Math.min(88, d));

export default function TiltedMapScene({
  p,
  r,
  tauRef,
  tiltRef,
  onTiltChange,
  ambientLevel = 1.35,
  tileTheme = 'dark',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const threeMountRef = useRef<HTMLDivElement>(null);
  const leafletMiniRef = useRef<HTMLDivElement>(null);
  const leafletMiniMap = useRef<L.Map | null>(null);
  const miniShockRef = useRef<L.Circle | null>(null);
  const camRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  const [tilt, setTilt] = useState(clampTilt(tiltRef.current ?? 55));
  const [azim, setAzim] = useState(45);
  const [zActive, setZActive] = useState(false);
  const [activeLayer, setActiveLayer] = useState<'osm' | 'satellite' | 'voyager' | 'dark'>(
    tileTheme === 'voyager' ? 'voyager' : 'dark'
  );
  const [miniExpanded, setMiniExpanded] = useState(false);
  const [viewAnglePreset, setViewAnglePreset] = useState<'slant' | 'top' | 'ground'>('slant');

  const cb = useRef(onTiltChange);
  cb.current = onTiltChange;

  // 1. Initialize Interactive Leaflet Tactical Radar (Minimap / HUD)
  useEffect(() => {
    if (!leafletMiniRef.current) return;
    const leaflet = (window as any).L || L;

    // Destroy existing instance if any
    if (leafletMiniMap.current) {
      leafletMiniMap.current.remove();
      leafletMiniMap.current = null;
    }

    const maxDamageKm = Math.max(r.lightDamage * 1.25, 8);
    let initialZoom = 11;
    if (maxDamageKm > 100) initialZoom = 7;
    else if (maxDamageKm > 50) initialZoom = 8;
    else if (maxDamageKm > 25) initialZoom = 9;
    else if (maxDamageKm > 12) initialZoom = 10;
    else initialZoom = 11;

    const m = leaflet.map(leafletMiniRef.current, {
      center: [p.lat, p.lng],
      zoom: initialZoom,
      zoomControl: true,
      attributionControl: false,
      preferCanvas: true,
    });
    leafletMiniMap.current = m;

    const getTileUrl = (type: string) => {
      switch (type) {
        case 'satellite':
          return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
        case 'osm':
          return 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
        case 'voyager':
          return 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        default:
          return 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
      }
    };

    const tileLayer = leaflet.tileLayer(getTileUrl(activeLayer), {
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(m);

    const layerGroup = leaflet.layerGroup().addTo(m);

    // Damage zone circles on the real Leaflet basemap
    const zones: [number, string, string][] = [
      [r.lightDamage, '#eab308', '1 psi (Light Damage)'],
      [r.thermal, '#f97316', '3rd-Degree Burns'],
      [r.overpressure, '#ef4444', '5 psi (Structural Collapse)'],
      [r.fireball, '#fde047', 'Thermal Fireball'],
      [r.craterD / 2, '#a855f7', 'Crater Rim'],
    ];

    zones
      .filter(([km]) => km > 0)
      .sort((a, b) => b[0] - a[0])
      .forEach(([km, col, name]) => {
        leaflet
          .circle([p.lat, p.lng], {
            radius: km * 1000,
            color: col,
            weight: 2,
            fillColor: col,
            fillOpacity: 0.18,
          })
          .addTo(layerGroup)
          .bindTooltip(`${name}: ${km.toFixed(2)} km`);
      });

    // Real-time expanding shockwave ring on the real Leaflet basemap
    const shock = leaflet
      .circle([p.lat, p.lng], {
        radius: 1,
        color: '#38bdf8',
        weight: 2.5,
        fill: false,
        dashArray: '5 6',
      })
      .addTo(layerGroup);
    miniShockRef.current = shock;

    // Ground Zero Pulsing Reticle
    const icon = leaflet.divIcon({
      className: '',
      html: '<div class="epi"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    leaflet
      .marker([p.lat, p.lng], { icon })
      .addTo(layerGroup)
      .bindTooltip(`Ground Zero<br>${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`);

    setTimeout(() => m.invalidateSize(), 150);

    return () => {
      m.remove();
      leafletMiniMap.current = null;
    };
  }, [p.lat, p.lng, r, activeLayer]);

  // Trigger resize observer for Leaflet minimap when expanded/minimized
  useEffect(() => {
    setTimeout(() => leafletMiniMap.current?.invalidateSize(), 200);
  }, [miniExpanded]);

  // 2. Initialize Ground-Attached 3D Fused Map with OrbitControls
  useEffect(() => {
    const el = threeMountRef.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c1017);

    const cam = new THREE.PerspectiveCamera(48, el.clientWidth / el.clientHeight, 0.1, 2800);
    camRef.current = cam;

    // Strict Ground Zero Anchor at (0, 0, 0)
    // The camera orbits strictly around Ground Zero on the ground!
    const ctr = new OrbitControls(cam, renderer.domElement);
    controlsRef.current = ctr;
    ctr.target.set(0, 0, 0); // GROUND ZERO IS LOCKED AT (0, 0, 0)
    ctr.enableDamping = true;
    ctr.dampingFactor = 0.08;
    ctr.maxPolarAngle = Math.PI * 0.485; // Prevent camera from going beneath ground plane
    ctr.minPolarAngle = THREE.MathUtils.degToRad(3); // Overhead limit
    ctr.minDistance = 8;
    ctr.maxDistance = 550;

    // Scene Scaling Calibrated to Kilometer Physical Damage Extent
    const maxKm = Math.max(r.lightDamage * 1.15, 8);
    const k2u = 60 / maxKm; // km -> Three.js scene units
    const physicalFireballRadius = Math.max(r.fireball * k2u, 1.2);
    const craterR = r.airburst ? 0 : Math.max((r.craterD / 2) * k2u, 1.2);
    const surgeMax = THREE.MathUtils.clamp(
      Math.max(r.overpressure * k2u, r.fireball * k2u * 1.35),
      4,
      Math.min(r.lightDamage * k2u * 0.95, 52)
    );
    const scale = THREE.MathUtils.clamp(physicalFireballRadius / 5.2, 0.7, 4.2);
    const burstH = r.airburst ? Math.max(physicalFireballRadius * 0.6, 6) : 0;
    const animDur = plumeAnimDuration(r.mt);
    const timeScale = plumeTimeScale(r.mt);
    const spanScale = animDur / REF_ANIM;
    const brightness = plumeBrightnessFactor(r.mt);

    // Initial camera position at 55 degree slant
    const initialDist = 125;
    const initTiltRad = THREE.MathUtils.degToRad(clampTilt(tiltRef.current ?? 55));
    const initAzimRad = THREE.MathUtils.degToRad(45);
    cam.position.set(
      initialDist * Math.sin(initTiltRad) * Math.sin(initAzimRad),
      initialDist * Math.cos(initTiltRad),
      initialDist * Math.sin(initTiltRad) * Math.cos(initAzimRad)
    );
    ctr.update();

    const U = {
      uT: { value: 0 },
      uFlash: { value: 0 },
      uShock: { value: 0 },
      uFire: { value: 0 },
      uAmbient: { value: ambientLevel },
    };
    const Uc = { uT: { value: 0 } };

    // ==========================================
    // 3. PHYSICAL 3D GROUND PLANE (DRAPED WITH REAL MAP TILES)
    // ==========================================
    const planeExtent = 120; // 120 scene units covers the entire blast radius
    const groundGeo = new THREE.PlaneGeometry(planeExtent, planeExtent, 128, 128);
    groundGeo.rotateX(-Math.PI / 2); // Lay flat on XZ plane at y = 0

    // Fetch and stitch real map tiles centered on Ground Zero (lat, lng)
    const mapExtentKm = planeExtent / k2u;
    const themeToUse: TileTheme = tileTheme === 'voyager' ? 'voyager' : 'dark';
    let mapCancelled = false;

    const { initial: mapInit, promise: mapPromise } = buildMapCanvas(
      p.lat,
      p.lng,
      mapExtentKm,
      themeToUse,
      undefined,
      () => mapCancelled,
      () => {
        if (mapTexture) mapTexture.needsUpdate = true;
      }
    );

    const mapTexture = new THREE.CanvasTexture(mapInit.canvas);
    mapTexture.wrapS = THREE.ClampToEdgeWrapping;
    mapTexture.wrapT = THREE.ClampToEdgeWrapping;
    mapTexture.colorSpace = THREE.SRGBColorSpace;
    mapTexture.generateMipmaps = true;
    mapTexture.minFilter = THREE.LinearMipmapLinearFilter;

    mapPromise.then(() => {
      if (!mapCancelled && mapTexture) {
        mapTexture.needsUpdate = true;
      }
    });

    const groundMat = new THREE.ShaderMaterial({
      uniforms: {
        ...U,
        uMap: { value: mapTexture },
        uCR: { value: craterR },
        uThermal: { value: r.thermal * k2u },
        uOver: { value: r.overpressure * k2u },
        uLight: { value: r.lightDamage * k2u },
      },
      vertexShader: `
        uniform float uCR, uT;
        varying vec3 vW;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          float d = length(p.xz);
          if (uCR > 0.0) {
            float g = smoothstep(0.0, 1.5, uT);
            float x = d / uCR;
            float bowl = x < 1.0 ? (x * x - 1.0) * uCR * 0.38 : 0.0;
            float rim = exp(-pow((x - 1.0) * 3.2, 2.0)) * uCR * 0.14;
            p.y += (bowl + rim) * g;
          }
          vW = p;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uAmbient, uT, uFlash, uFire, uShock, uThermal, uOver, uLight;
        varying vec3 vW;
        varying vec2 vUv;

        void main() {
          vec2 q = vW.xz;
          float d = length(q);

          // Sample real map canvas (roads, terrain, labels, tiles)
          vec4 mapCol = texture2D(uMap, vUv);

          // Dynamic ambient lighting boost & shadow-lifting
          vec3 baseMap = pow(mapCol.rgb, vec3(0.78)) * 1.35 * uAmbient;

          // Thermal radiation ground charring (permanent surface scouring)
          float burn = smoothstep(uThermal * 1.1, uThermal * 0.25, d) * smoothstep(0.0, 1.0, uT);
          vec3 charred = mix(baseMap, vec3(0.12, 0.09, 0.07), burn * 0.85);

          // Thermal incandescent ground glow immediately post-impact
          vec3 fireGlow = vec3(1.0, 0.55, 0.15) * uFire * exp(-d / max(uOver * 0.9, 2.5));

          // Shockwave sweep ring passing across the ground
          float sw = exp(-pow((d - uShock) / 1.5, 2.0)) * 0.7;
          vec3 shockRing = vec3(0.55, 0.85, 1.0) * sw;

          // Tactically distinct damage radius boundary rings on the ground
          float rLight = exp(-pow((d - uLight) / 0.55, 2.0)) * 0.65;
          float rTherm = exp(-pow((d - uThermal) / 0.55, 2.0)) * 0.75;
          float rOver  = exp(-pow((d - uOver) / 0.55, 2.0)) * 0.85;

          vec3 finalCol = charred + fireGlow + shockRing;
          finalCol += vec3(1.0, 0.90, 0.30) * rLight; // 1 psi window shattering
          finalCol += vec3(1.0, 0.50, 0.10) * rTherm; // 3rd degree burns
          finalCol += vec3(1.0, 0.22, 0.22) * rOver;  // 5 psi structural collapse
          finalCol += vec3(0.95, 0.98, 1.0) * uFlash * 1.25; // Detonation flash

          gl_FragColor = vec4(finalCol, 1.0);
        }
      `,
    });

    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.position.set(0, 0, 0); // Positioned flat at Ground Zero
    scene.add(groundMesh);

    // Deep Horizon Ground Skirt
    const skirtGeo = new THREE.RingGeometry(planeExtent * 0.49, 320, 64);
    skirtGeo.rotateX(-Math.PI / 2);
    const skirtMat = new THREE.MeshBasicMaterial({ color: 0x090c12, side: THREE.DoubleSide });
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.position.y = -0.05;
    scene.add(skirt);

    // Atmospheric Sky Dome with horizon illumination
    const skyGeo = new THREE.SphereGeometry(600, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { ...U, uFlash: U.uFlash, uFire: U.uFire },
      vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `
        uniform float uFlash, uFire, uAmbient; varying vec3 vP;
        void main() {
          float h = normalize(vP).y;
          vec3 c = mix(vec3(0.14, 0.18, 0.28) * uAmbient, vec3(0.04, 0.05, 0.09) * uAmbient, smoothstep(0.0, 0.55, h));
          c += vec3(1.0, 0.55, 0.2) * uFire * 0.45 * exp(-max(h, 0.0) * 3.5);
          c += vec3(0.95, 0.98, 1.0) * uFlash * 1.2;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    scene.add(sky);

    // Atmospheric Sunlight & Ambient
    const ambL = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambL);
    const sunL = new THREE.DirectionalLight(0xfff8ee, 1.7);
    sunL.position.set(60, 110, 40);
    scene.add(sunL);

    const fireLight = new THREE.PointLight(0xff9944, 0, 700, 1.3);
    fireLight.position.set(0, burstH + 8, 0);
    scene.add(fireLight);

    // ==========================================
    // 4. BOLIDE ASTEROID & HYPERSONIC PLASMA TRAIL
    // ==========================================
    const ast = buildAsteroid(p.shape, p.material);
    (ast.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0xff5500);
    (ast.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.7;
    ast.scale.setScalar(1.4);
    const th = (p.angle * Math.PI) / 180;
    const dir = new THREE.Vector3(-Math.cos(th), Math.sin(th), -0.3 * Math.cos(th)).normalize();
    const impactPt = new THREE.Vector3(0, burstH, 0);
    const startPt = impactPt.clone().addScaledVector(dir, 190);
    scene.add(ast);

    const TRAIL = 600;
    const trGeo = new THREE.BufferGeometry();
    trGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    trGeo.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(TRAIL * 3).map(() => Math.random()), 3));
    const trMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uHead: { value: new THREE.Vector3() }, uDir: { value: dir }, uVis: { value: 1 } },
      vertexShader: `
        attribute vec3 aS; uniform vec3 uHead, uDir; varying float vA;
        void main() {
          float t = aS.x;
          vec3 p = uHead + uDir * t * 45.0 + (aS.yzx - 0.5) * (0.5 + t * 3.5);
          vA = 1.0 - t;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (8.0 + 22.0 * (1.0 - t)) * (60.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform float uVis; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * vA * uVis * 0.55;
          gl_FragColor = vec4(mix(vec3(1.0, 0.3, 0.05), vec3(1.0, 0.95, 0.8), vA * vA) * a, a);
        }
      `,
    });
    const trail = new THREE.Points(trGeo, trMat);
    trail.frustumCulled = false;
    scene.add(trail);

    // ==========================================
    // 5. ATTACHED VOLUMETRIC MULTI-SPECTRAL FIREBALL
    // ==========================================
    const fbUni = {
      uC: { value: new THREE.Vector3(0, burstH, 0) },
      uR: { value: 1 },
      uHeat: { value: 1 },
      uT: Uc.uT,
      uBright: { value: brightness },
    };
    const fireball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        uniforms: fbUni,
        vertexShader: `
          varying vec3 vPos;
          void main() {
            vPos = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
          }
        `,
        fragmentShader: `${GLSL_NOISE}
          uniform vec3 uC; uniform float uR, uHeat, uT, uBright; varying vec3 vPos;
          void main() {
            vec3 p = vPos - uC; float d = length(p);
            float nr = d / max(uR, 0.001);
            if (nr > 1.25) discard;
            float n = fbm3(p * (0.35 / max(uR, 0.1)) + vec3(0.0, -uT * 0.45, 0.0));
            float shell = smoothstep(1.15, 0.45, nr + (n - 0.5) * 0.42);

            // Temporal Spectral Gradient across Frames
            vec3 flashWhite = vec3(1.0, 0.98, 0.95);
            vec3 goldCore   = vec3(1.0, 0.82, 0.28);
            vec3 flameRed   = vec3(0.98, 0.28, 0.04);
            vec3 darkEjecta = vec3(0.14, 0.10, 0.09);

            vec3 spectralCol;
            if (uHeat > 0.8) {
              spectralCol = mix(goldCore, flashWhite, (uHeat - 0.8) * 5.0);
            } else if (uHeat > 0.4) {
              spectralCol = mix(flameRed, goldCore, (uHeat - 0.4) * 2.5);
            } else {
              spectralCol = mix(darkEjecta, flameRed, uHeat * 2.5);
            }

            vec3 core = spectralCol * (1.8 + uHeat * 2.2) * uBright;
            float alpha = shell * clamp(uHeat * 1.5, 0.0, 0.92);
            gl_FragColor = vec4(core, alpha);
          }
        `,
      })
    );
    scene.add(fireball);

    // ==========================================
    // 6. VOLUMETRIC TOROIDAL VORTEX MUSHROOM CLOUD PLUME
    // ==========================================
    const PN = 32000;
    const plGeo = new THREE.BufferGeometry();
    const plSeed = new Float32Array(PN * 4);
    const plSeed2 = new Float32Array(PN * 4);
    for (let i = 0; i < PN; i++) {
      plSeed[i * 4 + 0] = Math.random();
      plSeed[i * 4 + 1] = Math.random();
      plSeed[i * 4 + 2] = Math.random();
      plSeed[i * 4 + 3] = Math.random();
      plSeed2[i * 4 + 0] = Math.random();
      plSeed2[i * 4 + 1] = Math.random();
      plSeed2[i * 4 + 2] = Math.random();
      plSeed2[i * 4 + 3] = Math.random();
    }
    plGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PN * 3), 3));
    plGeo.setAttribute('aS', new THREE.BufferAttribute(plSeed, 4));
    plGeo.setAttribute('aS2', new THREE.BufferAttribute(plSeed2, 4));

    const plMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        ...U,
        uT: Uc.uT,
        uSc: { value: scale },
        uB: { value: burstH },
        uBright: { value: brightness },
      },
      vertexShader: `${GLSL_NOISE}
        const float TAU = 6.2831853;
        uniform float uT, uSc, uB, uBright;
        attribute vec4 aS, aS2;
        varying float vHeat, vA, vShade, vDiss, vSeed, vCore;
        varying vec3 vNrm;

        void main() {
          float t = uT; vSeed = aS.x;
          float diss = smoothstep(12.0, 36.0, t + aS.z * 6.0);
          float H_rise = (0.8 + 36.0 * (1.0 - exp(-t / 6.2))) * uSc;
          float H = uB + H_rise;
          float R0 = (0.5 + 24.0 * (1.0 - exp(-t / 8.5))) * uSc * (1.0 + diss * 0.35);
          float rmBase = (0.4 + 11.0 * (1.0 - exp(-t / 7.2))) * uSc * (1.0 + diss * 0.3);

          float th = aS.x * TAU;
          float vortT = t * 1.5;
          float ph = aS.y * TAU + vortT * (0.4 + 0.3 * (1.0 - aS.z));

          vec3 p = vec3(0.0);
          float regAlpha = 1.0;
          float sizeMul = 1.0;

          if (aS.w < 0.48) {
            // Toroidal Anvil Cap
            float billowAmp = 0.22 * smoothstep(0.4, 2.5, t);
            float lobe = sin(th * 6.0 + aS2.x * TAU + vortT * 0.25) * cos(ph * 3.0) + 0.6 * cos(th * 11.0 - ph * 4.0 + aS2.y * TAU);
            float rm = rmBase * sqrt(0.12 + 0.88 * aS.z) * (1.0 + billowAmp * lobe);
            float rad = R0 + rm * cos(ph);
            float yOff = rm * sin(ph);
            float ceiling = smoothstep(10.0, 22.0, t);
            if (yOff > 0.0) yOff *= mix(1.15, 0.58, ceiling);
            p = vec3(rad * cos(th), H + yOff, rad * sin(th));
            vNrm = normalize(vec3(cos(ph) * cos(th), sin(ph) + 0.25, cos(ph) * sin(th)));
            vShade = 0.52 + 0.48 * sin(ph);
            float innerCore = smoothstep(0.3, -0.7, cos(ph)) * (1.0 - aS.z * 0.5);
            vHeat = clamp(exp(-t / 6.5) * (0.7 + 0.6 * innerCore), 0.0, 1.0);
            vCore = innerCore;
            sizeMul = 1.15 + 0.45 * aS.z + diss * 1.1;
          } else if (aS.w < 0.79) {
            // Central Stem rooted strictly at Ground Zero
            float f = fract(aS.y + vortT * 0.10 * (0.75 + 0.5 * aS.z));
            float y = f * max(H - 1.2 * uSc, 0.2);
            float basePedestal = 1.5 * exp(-f * 5.0);
            float capJoin = 1.1 * smoothstep(0.65, 1.0, f);
            float stemR = (0.85 + 1.75 * aS.z) * uSc * (0.75 + basePedestal + capJoin) * smoothstep(0.15, 2.2, t);
            float swirl = th + vortT * 0.45 * (1.0 - 0.5 * f) + f * 2.4;
            float rib = 1.0 + 0.22 * sin(swirl * 5.0 - vortT * 1.2) * sin(f * 12.0);
            stemR *= rib;
            p = vec3(cos(swirl) * stemR, y, sin(swirl) * stemR);
            vNrm = normalize(vec3(cos(swirl), 0.18, sin(swirl)));
            vShade = 0.42 + 0.3 * f;
            vHeat = clamp(exp(-t / 5.5) * (1.0 - f * 0.55) * (1.0 - aS.z * 0.4), 0.0, 1.0);
            vCore = 1.0 - aS.z;
            sizeMul = (0.85 + 0.4 * f) * (1.0 + diss * 0.9);
            regAlpha = 1.0 - smoothstep(16.0 + f * 10.0, 27.0 + f * 12.0, t);
          } else if (aS.w < 0.89) {
            // Toroidal Condensation Collar
            float collarH = H * (0.42 + 0.12 * aS2.z);
            float collarR = (2.2 + 5.5 * (1.0 - exp(-max(0.0, t - 2.0) / 5.0)) * sqrt(aS.y)) * uSc;
            float wave = sin(th * 8.0 + aS2.x * TAU) * 0.4 * uSc;
            p = vec3(cos(th) * (collarR + wave), collarH + (aS.z - 0.5) * 2.2 * uSc, sin(th) * (collarR + wave));
            vNrm = normalize(vec3(cos(th) * 0.6, 0.8, sin(th) * 0.6));
            vShade = 0.72 + 0.2 * aS.z;
            vHeat = clamp(exp(-t / 4.5) * 0.35, 0.0, 1.0);
            vCore = 0.2;
            regAlpha = smoothstep(2.0, 5.0, t) * (1.0 - smoothstep(16.0, 28.0, t));
            sizeMul = 0.95 + diss * 0.6;
          } else {
            // Ground-Level Toroidal Inflow Skirt
            float inflowT = 10.0 * (1.0 - exp(-t / 7.0));
            float f = fract(aS.y + inflowT * 0.22);
            float maxInR = (6.0 + 18.0 * (1.0 - exp(-t / 4.5))) * uSc;
            float rad = mix(maxInR, 1.4 * uSc, pow(f, 0.75));
            float y = pow(f, 2.2) * 4.5 * uSc * aS.z + 0.25;
            p = vec3(cos(th) * rad, y, sin(th) * rad);
            vNrm = normalize(vec3(cos(th) * 0.4, 0.9, sin(th) * 0.4));
            vShade = 0.38 + 0.25 * aS.z;
            vHeat = clamp(exp(-t / 4.0) * f * 0.5, 0.0, 1.0);
            vCore = 0.0;
            regAlpha = smoothstep(0.4, 2.0, t) * (1.0 - smoothstep(14.0, 23.0, t));
            sizeMul = 0.85;
          }

          vec3 np = p * (0.13 / uSc) + vec3(0.0, -vortT * 0.22, vortT * 0.1);
          vec3 turb = vec3(fbm3(np + vec3(1.7, 0.0, 0.0)) - 0.5, fbm3(np + vec3(0.0, 3.1, 0.0)) - 0.5, fbm3(np + vec3(0.0, 0.0, 5.3)) - 0.5);
          p += turb * (1.6 * smoothstep(0.5, 6.0, t) + diss * 12.5) * uSc;

          vDiss = clamp(diss + (1.0 - regAlpha) * 0.85, 0.0, 1.0);
          float emerge = smoothstep(0.08, 0.9, uT);
          vA = emerge * regAlpha * pow(1.0 - diss, 1.65);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (13.0 + 20.0 * aS.z) * uSc * sizeMul * (42.0 / max(-mv.z, 1.0));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `${GLSL_NOISE}
        uniform float uT, uBright; varying float vHeat, vA, vShade, vDiss, vSeed, vCore; varying vec3 vNrm;
        void main() {
          if (vA <= 0.003) discard;
          vec2 uv = gl_PointCoord - 0.5; float d = length(uv); if (d > 0.5) discard;
          float n = fbm3(vec3(uv * 3.6, vSeed * 12.0 + uT * 0.12));
          float erode = mix(0.12, 0.44, vDiss);
          float puff = smoothstep(0.5, erode, d + (n - 0.5) * (0.24 + vDiss * 0.32));
          if (puff <= 0.005) discard;
          vec3 spN = normalize(vec3(uv * 2.1, sqrt(max(0.0, 0.25 - dot(uv, uv))) * 2.0));
          vec3 N = normalize(mix(vNrm, spN, 0.55));
          vec3 sunDir = normalize(vec3(0.55, 0.78, 0.35));
          float sunLit = clamp(dot(N, sunDir) * 0.5 + 0.5, 0.0, 1.0);

          vec3 darkAsh = vec3(0.08, 0.07, 0.08);
          vec3 litCloud = mix(vec3(0.48, 0.42, 0.38), vec3(0.72, 0.68, 0.62), vDiss * 0.5);
          vec3 smoke = mix(darkAsh, litCloud, clamp(vShade * 0.55 + sunLit * 0.55 + (n - 0.5) * 0.25, 0.0, 1.0)) * clamp(uBright, 1.0, 1.35);

          float crevice = clamp(1.15 - n * 1.1 + vCore * 0.35, 0.0, 1.0);
          float fireFactor = clamp(vHeat * crevice * 1.35, 0.0, 1.0);
          vec3 ember = mix(vec3(0.95, 0.15, 0.02), vec3(1.0, 0.70, 0.20), fireFactor);
          vec3 whiteCore = mix(ember, vec3(1.0, 0.98, 0.88), pow(fireFactor, 2.2));

          vec3 col = mix(smoke, whiteCore * 2.2 * uBright, pow(fireFactor, 1.35));
          float alpha = puff * vA * 0.36 * clamp(0.7 + 0.3 * uBright, 0.7, 1.25);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    const plume = new THREE.Points(plGeo, plMat);
    plume.frustumCulled = false;
    scene.add(plume);

    // ==========================================
    // 7. BALLISTIC EJECTA CURTAIN
    // ==========================================
    const EN = 16000,
      g = 9.8,
      kd = 0.35;
    const eSeed = new Float32Array(EN * 4),
      eVel = new Float32Array(EN * 3);
    const down = new THREE.Vector2(-dir.x, -dir.z).normalize();
    const asym = Math.cos(th) * 0.8;
    for (let i = 0; i < EN; i++) {
      let a = Math.random() * Math.PI * 2;
      if (Math.random() < asym * 0.6) a = Math.atan2(down.y, down.x) + (Math.random() - 0.5) * 1.6;
      const elev = ((25 + Math.random() * 45) * Math.PI) / 180;
      const sp = (8 + Math.pow(Math.random(), 2) * 38) * Math.min(1.5, scale);
      eVel.set([Math.cos(a) * Math.cos(elev) * sp, Math.sin(elev) * sp, Math.sin(a) * Math.cos(elev) * sp], i * 3);
      const vy = eVel[i * 3 + 1];
      const y = (t: number) => ((vy + g / kd) / kd) * (1 - Math.exp(-kd * t)) - (g * t) / kd;
      let lo = 0.01,
        hi = 30;
      for (let j = 0; j < 30; j++) {
        const m = (lo + hi) / 2;
        if (y(m) > 0) lo = m;
        else hi = m;
      }
      eSeed.set([lo, Math.random(), Math.random(), Math.random()], i * 4);
    }
    const ejGeo = new THREE.BufferGeometry();
    ejGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EN * 3), 3));
    ejGeo.setAttribute('aV', new THREE.BufferAttribute(eVel, 3));
    ejGeo.setAttribute('aS', new THREE.BufferAttribute(eSeed, 4));
    const ejMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...U, uT: Uc.uT, uB: { value: burstH }, uOn: { value: r.airburst ? 0.25 : 1 } },
      vertexShader: `
        uniform float uT, uB; attribute vec3 aV; attribute vec4 aS; varying float vHot, vA;
        void main() {
          float t = min(max(uT - aS.y * 0.4, 0.0), aS.x);
          float e = 1.0 - exp(-${kd.toFixed(2)} * t);
          vec3 p = vec3(aV.x / ${kd.toFixed(2)} * e, ((aV.y + ${(g / kd).toFixed(3)}) / ${kd.toFixed(2)}) * e - ${(g / kd).toFixed(3)} * t, aV.z / ${kd.toFixed(2)} * e);
          p.y = max(p.y, 0.05) + uB * 0.0;
          vHot = clamp(1.0 - uT * 0.22, 0.0, 1.0) * aS.z;
          vA = step(0.001, uT) * (1.0 - smoothstep(22.0, 36.0, uT));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (2.0 + 4.0 * aS.w) * (60.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform float uOn; varying float vHot, vA;
        void main() {
          float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
          gl_FragColor = vec4(mix(vec3(0.3, 0.25, 0.2), vec3(1.0, 0.6, 0.2) * 2.0, vHot), vA * uOn);
        }
      `,
    });
    const ejecta = new THREE.Points(ejGeo, ejMat);
    ejecta.frustumCulled = false;
    scene.add(ejecta);

    // ==========================================
    // 8. RADIAL PYROCLASTIC BASE SURGE ON GROUND
    // ==========================================
    const SN = 8000;
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SN * 3), 3));
    sGeo.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(SN * 4).map(() => Math.random()), 4));
    const sMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...U, uT: Uc.uT, uMax: { value: surgeMax } },
      vertexShader: `${GLSL_NOISE}
        uniform float uT, uMax; attribute vec4 aS; varying float vA, vDiss, vSeed;
        void main() {
          float t = max(uT - 0.35, 0.0); vSeed = aS.w;
          float diss = smoothstep(18.0 + aS.z * 5.0, 38.0 + aS.z * 6.0, t); vDiss = diss;
          float Rs = uMax * (1.0 - exp(-t / 4.5)) * (1.0 + diss * 0.25);
          float th = aS.x * 6.2831853 + (aS.z - 0.5) * t * 0.06;
          float lobe = 1.0 + 0.14 * sin(th * 9.0 + aS.w * 6.28) * cos(t * 0.5);
          float rr = Rs * pow(aS.y, 0.38) * lobe;
          float headBillow = smoothstep(0.55, 1.0, aS.y) * (1.8 + Rs * 0.07);
          float y = aS.z * aS.z * (1.4 + headBillow) * (1.0 + 0.35 * sin(th * 7.0 - t * 1.4)) + diss * aS.w * 3.5;
          vec3 p = vec3(cos(th) * rr + max(0.0, t - 6.0) * 0.18 * diss, y, sin(th) * rr);
          vA = smoothstep(0.0, 1.2, t) * pow(1.0 - diss, 1.7) * (0.35 + aS.y * 0.65);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (18.0 + 26.0 * aS.w) * (1.0 + diss * 0.85) * (40.0 / max(-mv.z, 1.0));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `${GLSL_NOISE}
        uniform float uT; varying float vA, vDiss, vSeed;
        void main() {
          if (vA <= 0.003) discard;
          vec2 uv = gl_PointCoord - 0.5; float d = length(uv); if (d > 0.5) discard;
          float n = fbm3(vec3(uv * 3.2, vSeed * 9.0 + uT * 0.1));
          float puff = smoothstep(0.5, 0.12 + vDiss * 0.3, d + (n - 0.5) * (0.22 + vDiss * 0.25));
          vec3 col = mix(vec3(0.30, 0.25, 0.22), vec3(0.58, 0.50, 0.44), n * 0.7 + uv.y * -0.5 + 0.3);
          gl_FragColor = vec4(col, puff * vA * 0.24);
        }
      `,
    });
    const surge = new THREE.Points(sGeo, sMat);
    surge.frustumCulled = false;
    scene.add(surge);

    // ==========================================
    // 9. EXPANDING 3D SHOCKWAVE DOME & CONDENSATION CLOUD
    // ==========================================
    const domeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uA: { value: 0 } },
      vertexShader: `varying vec3 vN; void main(){ vN=normalize(normalMatrix*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `
        uniform float uA; varying vec3 vN;
        void main() {
          float rim = pow(1.0 - abs(vN.z), 3.2);
          gl_FragColor = vec4(vec3(0.5, 0.85, 1.0) * (rim * 0.85 + 0.15) * uA, (rim * 0.75 + 0.05) * uA);
        }
      `,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5), domeMat);
    scene.add(dome);

    const wilson = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.25, 24, 64),
      new THREE.MeshBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0, depthWrite: false })
    );
    wilson.rotation.x = Math.PI / 2;
    scene.add(wilson);

    // ==========================================
    // 10. RESIZE & RENDER LOOP
    // ==========================================
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

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const tau = tauRef.current;

      // Update camera controls strictly before reading or rendering
      ctr.update();

      // Read current camera elevation & azimuth for UI HUD and compass
      const camOffset = cam.position.clone().sub(ctr.target);
      const curDist = camOffset.length();
      if (curDist > 0.001) {
        const curTiltDeg = THREE.MathUtils.radToDeg(Math.acos(camOffset.y / curDist));
        const curAzimDeg = (THREE.MathUtils.radToDeg(Math.atan2(camOffset.x, camOffset.z)) + 360) % 360;
        setTilt(Math.round(curTiltDeg));
        setAzim(Math.round(curAzimDeg));
        tiltRef.current = curTiltDeg;
        cb.current?.(curTiltDeg);
      }

      // Pre-impact atmospheric entry
      if (tau < 0) {
        const f = THREE.MathUtils.clamp((tau + APPROACH) / APPROACH, 0, 1);
        const e = f * f;
        ast.position.lerpVectors(startPt, impactPt, e);
        ast.rotation.set(f * 5.2, f * 3.8, f * 2.1);
        ast.visible = true;
        trMat.uniforms.uHead.value.copy(ast.position);
        trMat.uniforms.uVis.value = Math.min(1, f * 3);
      } else {
        ast.visible = false;
        trMat.uniforms.uVis.value = Math.max(0, 1 - tau * 2);
      }

      const t = Math.max(tau, 0);
      const tw = t * timeScale;
      U.uT.value = t;
      U.uFlash.value = tau >= 0 ? Math.exp(-tw * 5.5) * 1.4 * Math.min(brightness, 1.45) : 0;
      const heat = tau >= 0 ? Math.exp(-tw / 5.2) * brightness : 0;
      U.uFire.value = Math.min(heat, 1.6);
      Uc.uT.value = tw;
      fireLight.intensity = heat * 3400;

      // Volumetric Fireball rooted at Ground Zero
      const fbExpansion = tau >= 0 ? 1 - Math.exp(-tw * 2.2) : 0;
      const fbR = tau >= 0 ? physicalFireballRadius * fbExpansion * (1 + tw * 0.02) : 0.001;
      const rise = (0.8 + 35.5 * (1 - Math.exp(-tw / 6.2))) * scale * Math.min(1, tw / 0.9);
      fbUni.uC.value.set(0, burstH + rise * 0.85, 0);
      fbUni.uR.value = fbR;
      fbUni.uHeat.value = heat;
      fireball.visible = tau >= 0 && heat > 0.03;

      // 3D Volumetric Shockwave Dome anchored at Ground Zero
      const shockKm = tau >= 0 ? shockKmAt(Math.min(tau, shockAnimSpan(r.mt) * 1.8), r) : 0;
      const Rs = shockKm * k2u;
      U.uShock.value = Rs;
      const shockFade = 1 - THREE.MathUtils.smoothstep(tau, 15 * spanScale, 24 * spanScale);
      const decay = (1 / (1 + Math.pow(Rs / 18, 2))) * shockFade;
      dome.visible = tau >= 0 && Rs > 0.1 && decay > 0.005;
      dome.scale.set(Rs, Rs * 0.85, Rs);
      dome.position.y = burstH * 0.3;
      domeMat.uniforms.uA.value = decay * 1.6;

      const wf = Math.max(0, 1 - t / (3.2 * spanScale)) * (t > 0.25 * spanScale ? 1 : t / (0.25 * spanScale));
      wilson.visible = tau >= 0 && wf > 0;
      wilson.scale.set(Rs * 0.7 + 0.1, Rs * 0.45 + 0.1, Rs * 0.7 + 0.1);
      (wilson.material as THREE.MeshBasicMaterial).opacity = wf * 0.25;

      // Synchronize Real Leaflet Minimap Shockwave Circle
      if (miniShockRef.current) {
        miniShockRef.current.setRadius(Math.max(1, shockKm * 1000));
        (miniShockRef.current as any).setStyle({
          opacity: decay > 0.01 ? 0.95 : 0.4,
          weight: decay > 0.05 ? 3.5 : 2,
        });
      }

      renderer.render(scene, cam);
    };

    loop();

    return () => {
      mapCancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      mapTexture.dispose();
      el.innerHTML = '';
    };
  }, [p.lat, p.lng, r, ambientLevel, tileTheme]);

  // Preset Angle Handlers that rotate camera strictly around Ground Zero
  const setPresetAngle = (mode: 'slant' | 'top' | 'ground') => {
    setViewAnglePreset(mode);

    let targetTilt = 55;
    if (mode === 'top') targetTilt = 8;
    else if (mode === 'ground') targetTilt = 80;
    else targetTilt = 55;

    tiltRef.current = targetTilt;
    setTilt(targetTilt);
    cb.current?.(targetTilt);

    const cam = camRef.current;
    const ctr = controlsRef.current;
    if (cam && ctr) {
      const curDist = cam.position.distanceTo(ctr.target) || 125;
      const tiltRad = THREE.MathUtils.degToRad(targetTilt);
      const azimRad = THREE.MathUtils.degToRad(azim);
      cam.position.set(
        curDist * Math.sin(tiltRad) * Math.sin(azimRad),
        curDist * Math.cos(tiltRad),
        curDist * Math.sin(tiltRad) * Math.cos(azimRad)
      );
      ctr.target.set(0, 0, 0);
      ctr.update();
    }
  };

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-[#0c1017]">
      {/* 1. THREE.JS 3D FUSED MAP (Ground Plane + Explosion 100% Attached) */}
      <div ref={threeMountRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" />

      {/* 2. REAL INTERACTIVE LEAFLET TACTICAL RADAR (Minimap / HUD) */}
      <div
        className={`absolute z-30 transition-all duration-300 font-mono text-xs ${
          miniExpanded
            ? 'inset-4 sm:inset-10 rounded-2xl border border-zinc-400/50 bg-zinc-950/95 shadow-[0_16px_50px_rgba(0,0,0,0.85)] p-3'
            : 'right-4 bottom-4 w-72 h-64 rounded-xl border border-zinc-500/40 bg-zinc-900/90 shadow-[0_8px_30px_rgba(0,0,0,0.7)] p-2 backdrop-blur-md'
        }`}
      >
        <div className="flex items-center justify-between border-b border-zinc-700/60 pb-1.5 mb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
            <span className="font-bold text-[11px] text-zinc-100 uppercase tracking-wider">
              Tactical Leaflet Radar
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setMiniExpanded(!miniExpanded)}
              className="flex h-5 w-5 items-center justify-center rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors cursor-pointer"
              title={miniExpanded ? 'Minimize Radar' : 'Maximize Radar'}
            >
              {miniExpanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            </button>
          </div>
        </div>

        {/* Real Leaflet Map Container with full drag, zoom, and layer controls */}
        <div className="relative h-[calc(100%-48px)] w-full overflow-hidden rounded-lg border border-zinc-700/60">
          <div ref={leafletMiniRef} className="h-full w-full" />
        </div>

        {/* Basemap Style Toggles */}
        <div className="flex items-center justify-between pt-1.5 text-[10px] text-zinc-400">
          <div className="flex items-center gap-1">
            {(['osm', 'satellite', 'voyager', 'dark'] as const).map(lay => (
              <button
                key={lay}
                onClick={() => setActiveLayer(lay)}
                className={`rounded px-1.5 py-0.5 uppercase font-semibold transition-all cursor-pointer ${
                  activeLayer === lay
                    ? 'bg-zinc-200 text-zinc-950 font-bold'
                    : 'bg-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                {lay}
              </button>
            ))}
          </div>
          <span className="text-[9px]">DRAG & ZOOM REAL MAP</span>
        </div>
      </div>

      {/* 3. SILVER 3D NAVIGATION & COMPASS HUD (Top-Right) */}
      <div className="absolute right-4 top-4 z-20 flex flex-col items-end gap-2 font-mono text-[11px]">
        {/* Ground Attachment Status Card */}
        <div className="flex items-center gap-2 rounded-xl border border-zinc-400/40 bg-zinc-900/90 px-3 py-1.5 shadow-[0_4px_20px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.2)] backdrop-blur-md">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
          <span className="font-semibold text-zinc-200">GROUND ZERO LOCKED</span>
          <span className="text-[10px] text-zinc-400">
            {p.lat.toFixed(2)}°, {p.lng.toFixed(2)}°
          </span>
        </div>

        {/* Elevation Angle Presets */}
        <div className="flex items-center gap-1 rounded-xl border border-zinc-400/40 bg-zinc-900/90 p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.5)] backdrop-blur-md">
          <span className="px-1.5 text-[10px] font-bold text-zinc-400 uppercase">View:</span>
          {[
            ['top', '90° Aerial'],
            ['slant', '55° Slant'],
            ['ground', '18° Surface'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setPresetAngle(id as any)}
              className={`rounded px-2 py-1 text-[10px] font-semibold transition-all cursor-pointer ${
                viewAnglePreset === id
                  ? 'border border-zinc-300 bg-gradient-to-b from-zinc-100 to-zinc-300 text-zinc-950 font-bold shadow-sm'
                  : 'border border-zinc-700/70 bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Silver Compass Rose */}
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-zinc-400/40 bg-gradient-to-b from-zinc-800 to-zinc-950 shadow-[0_4px_16px_rgba(0,0,0,0.5),inset_0_1px_2px_rgba(255,255,255,0.3)] backdrop-blur-md">
          <div
            className="relative h-10 w-10 transition-transform duration-75"
            style={{ transform: `rotate(${-azim}deg)` }}
          >
            <div className="absolute inset-x-0 top-0 text-center text-[10px] font-black text-red-400 drop-shadow">N</div>
            <div className="absolute left-1/2 top-3 h-4 w-[2px] -translate-x-1/2 bg-gradient-to-b from-red-400 via-zinc-200 to-zinc-500 rounded-full" />
            <div className="absolute inset-x-0 bottom-0 text-center text-[9px] font-bold text-zinc-400">S</div>
          </div>
        </div>
      </div>

      {/* 4. GROUND-LOCK ORBIT HINT (Bottom-Left) */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-xl border border-zinc-400/40 bg-zinc-900/85 px-3 py-1.5 font-mono text-[11px] shadow-[0_4px_16px_rgba(0,0,0,0.5)] backdrop-blur-md text-zinc-300">
        <Move className="h-3.5 w-3.5 text-cyan-400" />
        <span>Orbit: Left-drag · Pan: Right-drag · Zoom: Scroll wheel · Explosion rigidly locked to ground</span>
      </div>
    </div>
  );
}
