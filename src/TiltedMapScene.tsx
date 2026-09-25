import { MutableRefObject, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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

interface Props {
  p: Params;
  r: Results;
  tauRef: MutableRefObject<number>;
  tiltRef: MutableRefObject<number>;
  onTiltChange?: (tilt: number) => void;
  ambientLevel?: number;
  tileTheme?: TileTheme;
}

const clampTilt = (d: number) => Math.max(0, Math.min(85, d));

function niceGridKm(extentKm: number) {
  const raw = extentKm / 8;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return m * pow;
}

export default function TiltedMapScene({
  p,
  r,
  tauRef,
  tiltRef,
  onTiltChange,
  ambientLevel = 1.35,
  tileTheme = 'dark',
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [mapState, setMapState] = useState({
    loading: false,
    loaded: 1,
    total: 1,
    zoom: 0,
    extentKm: 0,
    synthetic: false,
    theme: tileTheme,
  });
  const [zActive, setZActive] = useState(false);
  const [azimUi, setAzimUi] = useState(45);
  const ambientUniformRef = useRef<THREE.IUniform<number>>({ value: ambientLevel });
  const cb = useRef(onTiltChange);
  cb.current = onTiltChange;

  useEffect(() => {
    ambientUniformRef.current.value = ambientLevel;
  }, [ambientLevel]);

  useEffect(() => {
    const el = ref.current!;
    let cancelled = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    el.appendChild(renderer.domElement);
    const canvas = renderer.domElement;
    canvas.style.display = 'block';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e1320);
    scene.fog = new THREE.Fog(0x0e1320, 350, 1800);

    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 3500);

    // Physical unit scaling
    const maxKm = r.lightDamage * 1.15;
    const k2u = 60 / maxKm; // km -> scene units
    const craterR = r.airburst ? 0 : Math.max((r.craterD / 2) * k2u, 1.2);

    // Genuinely wider large explosions: scaled to actual physical fireball radius
    const physicalFireballRadius = Math.max(r.fireball * k2u, 1.0);
    // Base surge expands across the blast/thermal destruction zone
    const surgeMax = THREE.MathUtils.clamp(
      Math.max(r.overpressure * k2u, r.fireball * k2u * 1.35),
      4,
      Math.min(r.lightDamage * k2u * 0.95, 52)
    );
    // Plume scale proportional to genuine fireball radius, bounded within explosion zone
    const scale = THREE.MathUtils.clamp(physicalFireballRadius / 5.5, 0.65, 4.2);

    const burstH = r.airburst ? Math.max(physicalFireballRadius * 0.6, 6) : 0;
    const animDur = plumeAnimDuration(r.mt);
    const timeScale = plumeTimeScale(r.mt);
    const spanScale = animDur / REF_ANIM;
    const brightness = plumeBrightnessFactor(r.mt);
    const desiredExtentKm = Math.max(r.lightDamage * 2.8, r.thermal * 2.4, 8);
    const U = { uT: { value: 0 }, uFlash: { value: 0 }, uShock: { value: 0 }, uFire: { value: 0 } };
    const Uc = { uT: { value: 0 } };

    // Orbit / tilt state
    const orbit = {
      tilt: clampTilt(tiltRef.current ?? 55),
      azim: 45,
      radius: 120,
      target: new THREE.Vector3(0, 6, 0),
    };
    const ctr = new OrbitControls(cam, canvas);
    ctr.enableDamping = true;
    ctr.dampingFactor = 0.08;
    ctr.maxPolarAngle = THREE.MathUtils.degToRad(85);
    ctr.minPolarAngle = 0;
    ctr.maxDistance = 800;
    ctr.minDistance = 6;
    ctr.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    ctr.target.copy(orbit.target);

    function applyOrbit() {
      const phi = THREE.MathUtils.degToRad(orbit.tilt);
      const theta = THREE.MathUtils.degToRad(orbit.azim);
      cam.position.set(
        orbit.target.x + orbit.radius * Math.sin(phi) * Math.sin(theta),
        orbit.target.y + orbit.radius * Math.cos(phi),
        orbit.target.z + orbit.radius * Math.sin(phi) * Math.cos(theta)
      );
      ctr.target.copy(orbit.target);
      cam.lookAt(orbit.target);
    }

    // Sky with gentle atmospheric horizon gradient
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1800, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: U,
        vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `uniform float uFlash,uFire; varying vec3 vP; void main(){ float h=normalize(vP).y;
          vec3 c=mix(vec3(.16,.21,.32),vec3(.04,.06,.12),smoothstep(0.,.5,h));
          c+=vec3(1.,.55,.25)*uFire*.4*exp(-max(h,0.)*3.5); c+=vec3(.95,.98,1.)*uFlash*1.2; gl_FragColor=vec4(c,1.);}`,
      })
    );
    scene.add(sky);

    // Outer horizon ground
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(3600, 3600).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x121826 })
    );
    outer.position.y = -0.3;
    scene.add(outer);

    // Instant Map Initialization (Zero wait time!)
    const gridKm = niceGridKm(desiredExtentKm);

    const { initial, promise } = buildMapCanvas(
      p.lat,
      p.lng,
      desiredExtentKm,
      tileTheme,
      (loaded, total) => {
        if (!cancelled) setMapState(s => ({ ...s, loading: loaded < total, loaded, total }));
      },
      () => cancelled,
      () => {
        if (mapMat.uniforms.uMap.value) {
          mapMat.uniforms.uMap.value.needsUpdate = true;
        }
      }
    );

    // Create CanvasTexture immediately from pre-rendered vector basemap
    const mapTex = new THREE.CanvasTexture(initial.canvas);
    mapTex.colorSpace = THREE.SRGBColorSpace;
    mapTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    mapTex.needsUpdate = true;

    const mapUniforms = {
      ...U,
      uCR: { value: craterR },
      uThermal: { value: r.thermal * k2u },
      uOver: { value: r.overpressure * k2u },
      uFireballZone: { value: physicalFireballRadius },
      uMap: { value: mapTex },
      uHasMap: { value: 1.0 },
      uCell: { value: gridKm * k2u },
      uFogN: { value: 400 },
      uFogF: { value: 1800 },
      uAmbient: ambientUniformRef.current,
    };

    const mapMat = new THREE.ShaderMaterial({
      uniforms: mapUniforms,
      vertexShader: `uniform float uCR,uT; varying vec3 vW; varying vec2 vUv;
        void main(){ vUv=uv; vec3 p=position; float d=length(p.xz);
          if(uCR>0.){ float g=smoothstep(0.,1.5,uT); float x=d/uCR;
            float bowl = x<1.? (x*x-1.)*uCR*.35 : 0.;
            float rim=exp(-pow((x-1.)*3.,2.))*uCR*.12; p.y+=(bowl+rim)*g; }
          vec4 w=modelMatrix*vec4(p,1.); vW=w.xyz;
          gl_Position=projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `${GLSL_NOISE}
        uniform sampler2D uMap; uniform float uT,uFlash,uFire,uShock,uThermal,uOver,uFireballZone,uCR,uHasMap,uCell,uFogN,uFogF,uAmbient;
        varying vec3 vW; varying vec2 vUv;
        void main(){
          vec3 rawCol = texture2D(uMap,vUv).rgb;
          
          // Enhanced Ambient Light & Gamma Lift
          vec3 liftedCol = pow(rawCol, vec3(0.74));
          vec3 mapCol = liftedCol * (1.35 * max(uAmbient, 0.45));

          vec2 q=vW.xz; float d=length(q);
          // Adaptive km grid for spatial distance perception
          vec2 gcell=abs(fract(q/max(uCell,0.001))-0.5);
          float grid=smoothstep(0.485,0.5,max(gcell.x,gcell.y));
          vec3 col=mapCol + vec3(0.28,0.38,0.52)*grid*0.48;

          // Thermal scorch where shock wave has propagated
          float n2=fbm3(vec3(q*.4,1.));
          float burnt=step(d,uThermal)*step(d,uShock);
          col=mix(col,vec3(.07,.05,.04)+vec3(.32,.10,0.)*n2*uFire*2.2,burnt*.85);

          // Molten crater interior with fiery cracks
          if(d<uCR*1.15) col=mix(col,vec3(.10,.06,.05)+vec3(1.,.4,.08)*max(0.,1.-uT*.05)*(1.-d/max(uCR,0.001)),smoothstep(0.1,1.2,uT));

          vec3 N=normalize(cross(dFdx(vW),dFdy(vW)));
          vec3 L=normalize(vec3(0.,16.,0.)-vW);
          float lam=max(dot(N,L),0.); float atten=1./(1.+d*d*.0018);

          // Multi-frame explosion ground illumination (violet flash -> yellow/orange fire -> amber embers)
          vec3 flashCol = vec3(0.7, 0.85, 1.0) * uFlash * 3.5;
          vec3 fireGlow = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.85, 0.3), smoothstep(0.5, 0.05, uT)) * lam * uFire * 7.5 * atten;

          vec3 ambientFill = vec3(0.72, 0.78, 0.92) * uAmbient;
          vec3 lit=col*(ambientFill + fireGlow + flashCol);

          // Shock front luminous ring
          lit+=vec3(.85,.94,1.)*exp(-pow((d-uShock)*.6,2.))*.45*step(.5,uShock)*(1.-smoothstep(18.,30.,uT));

          float fog=smoothstep(uFogN,uFogF,length(vW-cameraPosition));
          lit=mix(lit,vec3(.08,.11,.18),fog);
          gl_FragColor=vec4(lit,1.);}`,
    });

    const estWorld = THREE.MathUtils.clamp(desiredExtentKm * k2u, 50, 480);
    const mapMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(estWorld, estWorld, 220, 220).rotateX(-Math.PI / 2),
      mapMat
    );
    mapMesh.position.y = 0;
    scene.add(mapMesh);

    orbit.radius = THREE.MathUtils.clamp(estWorld * 0.95, 70, 280);
    applyOrbit();

    setMapState({
      loading: false,
      loaded: initial.loaded,
      total: initial.total,
      zoom: initial.zoom,
      extentKm: initial.extentKm,
      synthetic: initial.synthetic,
      theme: initial.theme,
    });

    // Handle progressive live tile completion
    promise.then(res => {
      if (cancelled) return;
      mapTex.needsUpdate = true;
      const worldSize = THREE.MathUtils.clamp(res.extentKm * k2u, 40, 560);
      mapMesh.geometry.dispose();
      mapMesh.geometry = new THREE.PlaneGeometry(worldSize, worldSize, 220, 220).rotateX(-Math.PI / 2);
      const gk = niceGridKm(res.extentKm);
      mapUniforms.uCell.value = gk * k2u;
      mapUniforms.uFogN.value = worldSize * 1.5;
      mapUniforms.uFogF.value = worldSize * 4.2;
      setMapState({
        loading: false,
        loaded: res.loaded,
        total: res.total,
        zoom: res.zoom,
        extentKm: res.extentKm,
        synthetic: res.synthetic,
        theme: res.theme,
      });
    }).catch(() => {
      if (!cancelled) setMapState(s => ({ ...s, loading: false }));
    });

    // Hazard rings
    const ringDefs: [number, number, string][] = [
      [r.fireball, 0xfde047, 'Fireball'],
      [r.overpressure, 0xef4444, '5 psi'],
      [r.thermal, 0xf97316, '3rd-deg burns'],
      [r.lightDamage, 0x38bdf8, '1 psi'],
    ];
    const rings = ringDefs
      .filter(([km]) => km > 0)
      .map(([km, c]) => {
        const pts = Array.from({ length: 180 }, (_, i) => {
          const a = (i / 180) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a) * km * k2u, 0.5, Math.sin(a) * km * k2u);
        });
        const l = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.7, linewidth: 2 })
        );
        scene.add(l);
        return { l, R: km * k2u };
      });

    // Epicenter beacon
    const beaconMat = new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.55, 36, 12, 1, true), beaconMat);
    beacon.position.y = 18;
    scene.add(beacon);

    const beaconRing = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.25, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xfb923c,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    beaconRing.position.y = 0.45;
    scene.add(beaconRing);

    // Asteroid + plasma trail
    const ast = buildAsteroid(p.shape, p.material);
    (ast.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0xff5500);
    (ast.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6;
    ast.scale.setScalar(1.3);
    const th = (p.angle * Math.PI) / 180;
    const dir = new THREE.Vector3(-Math.cos(th), Math.sin(th), -0.3 * Math.cos(th)).normalize();
    const impactPt = new THREE.Vector3(0, burstH, 0);
    const startPt = impactPt.clone().addScaledVector(dir, 180);
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
      vertexShader: `attribute vec3 aS; uniform vec3 uHead,uDir; varying float vA; void main(){ float t=aS.x; vec3 p=uHead+uDir*t*40.+ (aS.yzx-.5)*(0.5+t*3.);
        vA=1.-t; vec4 mv=modelViewMatrix*vec4(p,1.); gl_PointSize=(8.+20.*(1.-t))*(60./-mv.z); gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `uniform float uVis; varying float vA; void main(){ float d=length(gl_PointCoord-.5); float a=smoothstep(.5,0.,d)*vA*uVis*.5;
        gl_FragColor=vec4(mix(vec3(1.,.3,.05),vec3(1.,.95,.8),vA*vA)*a,a);}`,
    });
    const trail = new THREE.Points(trGeo, trMat);
    trail.frustumCulled = false;
    scene.add(trail);

    // Boosted ambient & hemisphere fill lights
    scene.add(new THREE.AmbientLight(0xa8bccf, 1.45));
    scene.add(new THREE.HemisphereLight(0xe5f0ff, 0x243548, 0.9));
    const sunL = new THREE.DirectionalLight(0xfff8ee, 1.85);
    sunL.position.set(50, 90, 30);
    scene.add(sunL);

    const fireLight = new THREE.PointLight(0xffaa55, 0, 600, 1.25);
    fireLight.position.set(0, burstH + 8, 0);
    scene.add(fireLight);

    // Volumetric Multi-Frame & Multi-Color Fireball
    const fbUni = {
      uC: { value: new THREE.Vector3() },
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
        vertexShader: `varying vec3 vW; void main(){ vW=(modelMatrix*vec4(position,1.)).xyz; gl_Position=projectionMatrix*viewMatrix*vec4(vW,1.);}`,
        fragmentShader: `${GLSL_NOISE}
          uniform vec3 uC; uniform float uR,uHeat,uT,uBright; varying vec3 vW;

          // Multi-stage explosion color progression across thermal frames
          vec3 getExplosionColor(float temp, float t, float rNorm) {
            // Frame 0: Contact & Detonation Flash (< 0.25s) - Actinic blue-violet, electric cyan & solar white (>20,000K)
            vec3 cFlash = mix(vec3(0.35, 0.60, 1.0), vec3(1.0, 1.0, 1.0), smoothstep(0.35, 0.95, temp));
            cFlash = mix(vec3(0.80, 0.15, 0.90), cFlash, smoothstep(0.08, 0.45, temp));

            // Frame 1 & 2: Hydrodynamic Fireball (0.25s - 2.5s) - Searing white, lemon gold, blaze orange & crimson shock boundary
            vec3 cFire = mix(vec3(0.04, 0.02, 0.02), vec3(0.80, 0.08, 0.02), smoothstep(0.02, 0.28, temp));
            cFire = mix(cFire, vec3(1.0, 0.42, 0.05), smoothstep(0.28, 0.55, temp));
            cFire = mix(cFire, vec3(1.0, 0.90, 0.30), smoothstep(0.55, 0.80, temp));
            cFire = mix(cFire, vec3(1.0, 1.0, 0.96), smoothstep(0.80, 0.98, temp));

            // Frame 3 & 4: Cooling Turbulent Plasma & Soot (2.5s - 12s) - Molten fissures in dark charcoal billows
            vec3 cCool = mix(vec3(0.07, 0.06, 0.07), vec3(0.92, 0.22, 0.04), smoothstep(0.18, 0.65, temp));
            cCool = mix(cCool, vec3(1.0, 0.72, 0.18), smoothstep(0.65, 0.92, temp));
            cCool = mix(cCool, vec3(1.0, 0.98, 0.85), smoothstep(0.92, 1.0, temp));

            // Temporal blending across explosion frames
            float flashWeight = smoothstep(0.65, 0.0, t);
            float coolWeight = smoothstep(2.0, 7.5, t);

            vec3 col = mix(cFire, cFlash, flashWeight * 0.88);
            col = mix(col, cCool, coolWeight * 0.72);

            // Ionization corona (magenta/violet fringe at fireball envelope)
            float edgeFringe = smoothstep(0.72, 0.98, rNorm) * smoothstep(1.05, 0.95, rNorm);
            col += vec3(0.65, 0.12, 0.85) * edgeFringe * smoothstep(2.8, 0.1, t) * 1.3;

            return col;
          }

          void main(){
            vec3 ro=cameraPosition; vec3 rd=normalize(vW-ro); vec3 oc=ro-uC; float b=dot(oc,rd); float c=dot(oc,oc)-uR*uR; float h=b*b-c; if(h<0.) discard;
            h=sqrt(h); float t0=max(-b-h,0.), t1=-b+h; float st=(t1-t0)/42.; vec3 acc=vec3(0.); float T=1.;
            for(int i=0;i<42;i++){
              vec3 p=(ro+rd*(t0+st*(float(i)+.5))-uC)/uR; float r=length(p);
              float n=fbm3(p*2.6+vec3(0.,-uT*.8,uT*.2)); float dens=smoothstep(1.,.42,r+(n-.5)*.85)*smoothstep(0.,.12,uHeat);
              if(dens>.001){
                float temp=clamp(uHeat*(1.28-r*.9)+(n-.5)*.5*uHeat,0.,1.);
                vec3 e=getExplosionColor(temp, uT, r) * (0.5+temp*3.2) * uBright;
                float a=dens*st/uR*3.6; acc+=T*e*a; T*=1.-clamp(a,0.,1.); if(T<.02) break;
              }
            }
            gl_FragColor=vec4(acc,1.-T);
          }`,
      })
    );
    fireball.frustumCulled = false;
    scene.add(fireball);

    // Shock dome + condensation ring + Wilson cloud
    const domeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uA: { value: 0 } },
      vertexShader: `varying vec3 vN,vV; void main(){ vec4 w=modelMatrix*vec4(position,1.); vN=normalize(mat3(modelMatrix)*normal); vV=normalize(cameraPosition-w.xyz); gl_Position=projectionMatrix*viewMatrix*w;}`,
      fragmentShader: `uniform float uA; varying vec3 vN,vV; void main(){ float f=pow(1.-abs(dot(vN,vV)),2.8); gl_FragColor=vec4(vec3(.75,.90,1.),f*uA);}`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    scene.add(dome);
    const wilson = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })
    );
    scene.add(wilson);
    const ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uA: { value: 0 }, uT: U.uT },
      vertexShader: `varying vec2 vU; void main(){ vU=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `${GLSL_NOISE} uniform float uA,uT; varying vec2 vU; void main(){ vec2 q=vU-.5; float r=length(q)*2.; float a=atan(q.y,q.x);
        float band=smoothstep(.86,.97,r)*smoothstep(1.,.97,r); float n=fbm3(vec3(a*6.,r*10.,uT)); gl_FragColor=vec4(vec3(.94),band*uA*(.45+n));}`,
    });
    const cring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMat);
    cring.rotation.x = -Math.PI / 2;
    cring.position.y = 0.7;
    scene.add(cring);

    // Multi-Frame Mushroom Plume (scaled to fill designated explosion zone)
    const PN = 20000;
    const plGeo = new THREE.BufferGeometry();
    plGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PN * 3), 3));
    plGeo.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(PN * 4).map(() => Math.random()), 4));
    plGeo.setAttribute('aS2', new THREE.BufferAttribute(new Float32Array(PN * 3).map(() => Math.random()), 3));
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
        uniform float uT, uSc, uB; attribute vec4 aS; attribute vec3 aS2;
        varying float vHeat, vA, vShade, vDiss, vSeed, vCore; varying vec3 vNrm;
        void main(){
          float t = max(uT - 0.12, 0.0); float TAU = 6.2831853; float th = aS.x * TAU; vSeed = aS2.x;
          float grow = smoothstep(0.0, 1.8, t);
          float rise = 1.0 - exp(-t / 6.2);
          float H = (0.8 + 35.5 * rise) * uSc * smoothstep(0.0, 0.9, t) + uB * 0.6;
          float vortT = 18.0 * (1.0 - exp(-t / 13.0));
          float dissStart = 19.0 + aS2.y * 6.0;
          float diss = smoothstep(dissStart, dissStart + 21.0, t);
          vec3 p = vec3(0.0); float sizeMul = 1.0; float regAlpha = 1.0;
          if (aS.w < 0.54) {
            float anvilSpread = max(0.0, t - 10.0) * 0.45 * (1.0 - exp(-max(0.0, t - 10.0) * 0.12));
            float R0 = (0.6 + 7.4 * (1.0 - exp(-t / 6.0)) + anvilSpread * (0.65 + 0.75 * aS2.z)) * uSc * grow;
            float rmBase = (0.8 + 4.4 * (1.0 - exp(-t / 5.2)) + max(0.0, t - 12.0) * 0.14) * uSc * grow;
            float ph = aS.y * TAU - vortT * (1.45 - 0.55 * aS.z);
            float billowAmp = smoothstep(0.4, 5.0, t) * (0.28 + 0.18 * sin(t * 0.4 + aS2.x * 6.0));
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
            float stemCutoff = smoothstep(16.0 + f * 10.0, 27.0 + f * 12.0, t);
            regAlpha = 1.0 - stemCutoff;
          } else if (aS.w < 0.89) {
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
            float inflowT = 10.0 * (1.0 - exp(-t / 7.0));
            float f = fract(aS.y + inflowT * 0.22);
            float maxInR = (6.0 + 18.0 * (1.0 - exp(-t / 4.5))) * uSc;
            float rad = mix(maxInR, 1.4 * uSc, pow(f, 0.75));
            float y = pow(f, 2.2) * 4.5 * uSc * aS.z + 0.35;
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
          float billowStrength = (1.6 * smoothstep(0.5, 6.0, t) + diss * 12.5) * uSc;
          p += turb * billowStrength;
          float altNorm = pow(clamp(p.y / (26.0 * uSc), 0.0, 1.6), 1.35);
          float windTime = max(0.0, t - 5.0);
          vec3 windDir = normalize(vec3(1.0, 0.05, 0.36));
          p += windDir * (windTime * (0.28 + 0.65 * diss) * altNorm * uSc);
          vDiss = clamp(diss + (1.0 - regAlpha) * 0.85, 0.0, 1.0);
          float emerge = smoothstep(0.08, 0.9, uT);
          vA = emerge * regAlpha * pow(1.0 - diss, 1.65);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (13.0 + 20.0 * aS.z) * uSc * sizeMul * (42.0 / max(-mv.z, 1.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `${GLSL_NOISE}
        uniform float uT, uBright; varying float vHeat, vA, vShade, vDiss, vSeed, vCore; varying vec3 vNrm;
        void main(){
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

          // Rich pyroclastic color spectrum
          vec3 darkAsh = vec3(0.08, 0.07, 0.08);
          vec3 litCloud = mix(vec3(0.48, 0.42, 0.38), vec3(0.72, 0.68, 0.62), vDiss * 0.5);
          vec3 smoke = mix(darkAsh, litCloud, clamp(vShade * 0.55 + sunLit * 0.55 + (n - 0.5) * 0.25, 0.0, 1.0)) * clamp(uBright, 1.0, 1.35);

          // Multi-color interior core embers (violet-blue early -> orange-gold peak -> deep ruby)
          float crevice = clamp(1.15 - n * 1.1 + vCore * 0.35, 0.0, 1.0);
          float fireFactor = clamp(vHeat * crevice * 1.35, 0.0, 1.0);
          vec3 ember = mix(vec3(0.95, 0.15, 0.02), vec3(1.0, 0.70, 0.20), fireFactor);
          vec3 whiteCore = mix(ember, vec3(1.0, 0.98, 0.88), pow(fireFactor, 2.2));

          vec3 col = mix(smoke, whiteCore * 2.2 * uBright, pow(fireFactor, 1.35));
          float alpha = puff * vA * 0.36 * clamp(0.7 + 0.3 * uBright, 0.7, 1.25);
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    const plume = new THREE.Points(plGeo, plMat);
    plume.frustumCulled = false;
    scene.add(plume);

    // Ballistic ejecta
    const EN = 18000,
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
      vertexShader: `uniform float uT,uB; attribute vec3 aV; attribute vec4 aS; varying float vHot,vA;
        void main(){ float t=min(max(uT-aS.y*.4,0.),aS.x); float e=1.-exp(-${kd.toFixed(2)}*t);
          vec3 p=vec3(aV.x/${kd.toFixed(2)}*e,((aV.y+${(g / kd).toFixed(3)})/${kd.toFixed(2)})*e-${(g / kd).toFixed(3)}*t,aV.z/${kd.toFixed(2)}*e);
          p.y=max(p.y,0.05)+uB*0.; vHot=clamp(1.-uT*.22,0.,1.)*aS.z; vA=step(0.001,uT)*(1.-smoothstep(22.,36.,uT));
          vec4 mv=modelViewMatrix*vec4(p,1.); gl_PointSize=(2.+4.*aS.w)*(60./-mv.z); gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `uniform float uOn; varying float vHot,vA; void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard;
        gl_FragColor=vec4(mix(vec3(.3,.25,.2),vec3(1.,.6,.2)*2.,vHot),vA*uOn);}`,
    });
    const ejecta = new THREE.Points(ejGeo, ejMat);
    ejecta.frustumCulled = false;
    scene.add(ejecta);

    // Base surge bounded within the explosion footprint
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
        void main(){
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
        }`,
      fragmentShader: `${GLSL_NOISE}
        uniform float uT; varying float vA, vDiss, vSeed;
        void main(){
          if (vA <= 0.003) discard;
          vec2 uv = gl_PointCoord - 0.5; float d = length(uv); if (d > 0.5) discard;
          float n = fbm3(vec3(uv * 3.2, vSeed * 9.0 + uT * 0.1));
          float puff = smoothstep(0.5, 0.12 + vDiss * 0.3, d + (n - 0.5) * (0.22 + vDiss * 0.25));
          vec3 col = mix(vec3(0.30, 0.25, 0.22), vec3(0.58, 0.50, 0.44), n * 0.7 + uv.y * -0.5 + 0.3);
          gl_FragColor = vec4(col, puff * vA * 0.24);
        }`,
    });
    const surge = new THREE.Points(sGeo, sMat);
    surge.frustumCulled = false;
    scene.add(surge);

    // Screen-space refraction post-process with chromatic aberration
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    const postU = {
      tD: { value: rt.texture },
      uC: { value: new THREE.Vector2(0.5, 0.5) },
      uR: { value: 0 },
      uS: { value: 0 },
      uAsp: { value: 1 },
      uFlash: U.uFlash,
    };
    const postScene = new THREE.Scene();
    postScene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.ShaderMaterial({
          uniforms: postU,
          depthTest: false,
          vertexShader: `varying vec2 vU; void main(){ vU=uv; gl_Position=vec4(position.xy,0.,1.);}`,
          fragmentShader: `uniform sampler2D tD; uniform vec2 uC; uniform float uR,uS,uAsp,uFlash; varying vec2 vU;
            void main(){ vec2 d=vU-uC; d.x*=uAsp; float dist=length(d); float w=.035+uR*.05;
              float k=exp(-pow((dist-uR)/w,2.))*uS; vec2 n=dist>0.?normalize(d):vec2(0.); n.x/=uAsp;
              float inner=smoothstep(uR,uR-w*2.,dist)*uS*.25; vec2 off=n*(k*.028 - inner*.004);
              vec3 c=vec3(texture2D(tD,vU-off*1.35).r,texture2D(tD,vU-off).g,texture2D(tD,vU-off*.65).b);
              c+=vec3(.65,.75,.95)*k*.15; c+=uFlash*vec3(.9, .95, 1.)*.85; vec2 v=vU-.5; c*=1.-dot(v,v)*.55;
              gl_FragColor=vec4(c,1.);}`,
        })
      )
    );
    const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Z + drag tilt
    let zHeld = false;
    let zDragging = false;
    let startX = 0,
      startY = 0,
      startTilt = 0,
      startAzim = 0;
    let lastUiPush = 0;
    const pushUi = (force = false) => {
      const now = performance.now();
      if (!force && now - lastUiPush < 180) return;
      lastUiPush = now;
      tiltRef.current = orbit.tilt;
      cb.current?.(orbit.tilt);
      setAzimUi(Math.round(((orbit.azim % 360) + 360) % 360));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'KeyZ' && !e.repeat) {
        zHeld = true;
        ctr.enableRotate = false;
        ctr.enablePan = false;
        canvas.style.cursor = 'ns-resize';
        setZActive(true);
      }
    };
    const resetZ = () => {
      if (!zHeld && !zDragging) return;
      zHeld = false;
      zDragging = false;
      ctr.enableRotate = true;
      ctr.enablePan = true;
      ctr.enabled = true;
      canvas.style.cursor = '';
      setZActive(false);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyZ') resetZ();
    };
    const onBlur = () => resetZ();
    const onPointerDown = (e: PointerEvent) => {
      if (zHeld && e.button === 0) {
        zDragging = true;
        ctr.enabled = false;
        startX = e.clientX;
        startY = e.clientY;
        startTilt = orbit.tilt;
        startAzim = orbit.azim;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!zDragging) return;
      orbit.tilt = clampTilt(startTilt + (e.clientY - startY) * 0.3);
      orbit.azim = startAzim - (e.clientX - startX) * 0.25;
      applyOrbit();
      pushUi();
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onPointerUp = () => {
      if (zDragging) {
        zDragging = false;
        ctr.enabled = true;
        pushUi(true);
      }
    };
    const onDblClick = () => {
      orbit.tilt = 55;
      applyOrbit();
      pushUi(true);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    canvas.addEventListener('pointerdown', onPointerDown, true);
    canvas.addEventListener('pointermove', onPointerMove, true);
    canvas.addEventListener('pointerup', onPointerUp, true);
    canvas.addEventListener('pointercancel', onPointerUp, true);
    canvas.addEventListener('dblclick', onDblClick);

    const resize = () => {
      const w = el.clientWidth,
        h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      rt.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      postU.uAsp.value = w / h;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const tmp = new THREE.Vector3(),
      right = new THREE.Vector3();
    const off = new THREE.Vector3();
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const tau = tauRef.current;

      mapUniforms.uAmbient.value = ambientUniformRef.current.value;

      if (!zDragging) {
        const ext = clampTilt(tiltRef.current ?? orbit.tilt);
        if (Math.abs(ext - orbit.tilt) > 0.02) {
          orbit.tilt = ext;
          applyOrbit();
        } else {
          off.copy(cam.position).sub(ctr.target);
          const rr = Math.max(off.length(), 0.001);
          const phi = Math.acos(THREE.MathUtils.clamp(off.y / rr, -1, 1));
          orbit.tilt = THREE.MathUtils.radToDeg(phi);
          orbit.azim = THREE.MathUtils.radToDeg(Math.atan2(off.x, off.z));
          orbit.radius = rr;
          orbit.target.copy(ctr.target);
          if (Math.abs(orbit.tilt - tiltRef.current) > 0.08) pushUi();
        }
      }

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
      fireLight.intensity = heat * 3200;

      // Fireball genuinely scales to the physical fireball zone radius
      const fbExpansion = tau >= 0 ? 1 - Math.exp(-tw * 2.2) : 0;
      const fbR = tau >= 0 ? physicalFireballRadius * fbExpansion * (1 + tw * 0.02) : 0.001;
      const rise = (0.8 + 35.5 * (1 - Math.exp(-tw / 6.2))) * scale * Math.min(1, tw / 0.9);
      fbUni.uC.value.set(0, burstH + rise * 0.85, 0);
      fbUni.uR.value = fbR;
      fbUni.uHeat.value = heat;
      fireball.visible = tau >= 0 && heat > 0.03;

      const shockKm = tau >= 0 ? shockKmAt(Math.min(tau, shockAnimSpan(r.mt) * 1.8), r) : 0;
      const Rs = shockKm * k2u;
      U.uShock.value = Rs;
      const shockFade = 1 - THREE.MathUtils.smoothstep(tau, 15 * spanScale, 24 * spanScale);
      const decay = (1 / (1 + Math.pow(Rs / 18, 2))) * shockFade;
      dome.visible = tau >= 0 && Rs > 0.1 && decay > 0.005;
      dome.scale.set(Rs, Rs * 0.85, Rs);
      dome.position.y = burstH * 0.3;
      domeMat.uniforms.uA.value = decay * 1.6;
      ringMat.uniforms.uA.value = tau >= 0 ? decay * 1.3 : 0;
      cring.scale.setScalar(Math.max(Rs * 1.02, 0.01));

      const wf = Math.max(0, 1 - t / (3.2 * spanScale)) * (t > 0.25 * spanScale ? 1 : t / (0.25 * spanScale));
      wilson.visible = tau >= 0 && wf > 0;
      wilson.scale.set(Rs * 0.7 + 0.1, Rs * 0.45 + 0.1, Rs * 0.7 + 0.1);
      (wilson.material as THREE.MeshBasicMaterial).opacity = wf * 0.25;

      rings.forEach(({ l, R }) => {
        (l.material as THREE.LineBasicMaterial).opacity = Rs >= R ? 0.95 : 0.55;
      });

      const pulse = 1 + Math.sin(performance.now() * 0.004) * 0.12;
      beaconRing.scale.setScalar(pulse);
      beaconMat.opacity = 0.4 + Math.sin(performance.now() * 0.004) * 0.15;

      tmp.set(0, burstH * 0.3, 0).project(cam);
      postU.uC.value.set(tmp.x * 0.5 + 0.5, tmp.y * 0.5 + 0.5);
      right
        .setFromMatrixColumn(cam.matrixWorld, 0)
        .multiplyScalar(Rs)
        .add(new THREE.Vector3(0, burstH * 0.3, 0))
        .project(cam);
      postU.uR.value = Math.hypot((right.x - tmp.x) * 0.5 * postU.uAsp.value, (right.y - tmp.y) * 0.5);
      postU.uS.value = tau >= 0 && tmp.z < 1 ? decay * 1.5 : 0;

      if (!zDragging) ctr.update();
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    };
    loop();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointerdown', onPointerDown, true);
      canvas.removeEventListener('pointermove', onPointerMove, true);
      canvas.removeEventListener('pointerup', onPointerUp, true);
      canvas.removeEventListener('pointercancel', onPointerUp, true);
      canvas.removeEventListener('dblclick', onDblClick);
      renderer.dispose();
      rt.dispose();
      el.innerHTML = '';
    };
  }, [p, r, tileTheme]);

  const pct = mapState.total ? Math.round((mapState.loaded / mapState.total) * 100) : 0;

  return (
    <div className="absolute inset-0">
      <div ref={ref} className="absolute inset-0" />

      {/* Top-Right Map Status & Silver Nav Compass */}
      <div className="pointer-events-none absolute right-4 top-4 z-[1000] flex flex-col items-end gap-2 font-mono text-[11px]">
        <div className="inline-block rounded-lg border border-zinc-400/40 bg-zinc-900/85 px-3 py-2 text-right shadow-[0_4px_20px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.2)] backdrop-blur-md">
          {mapState.loading ? (
            <div className="flex items-center justify-end gap-1.5 text-cyan-300">
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
              <span>Enhancing live tiles… {mapState.loaded}/{mapState.total} ({pct}%)</span>
            </div>
          ) : mapState.synthetic ? (
            <div className="text-amber-300">
              Tactical Vector Map · {mapState.extentKm.toFixed(1)} km extent
            </div>
          ) : (
            <div className="text-zinc-200 font-semibold">
              Live Map Grid z{mapState.zoom} · {mapState.extentKm.toFixed(1)} km across
            </div>
          )}
          <div className="text-[10px] text-zinc-400">
            {mapState.synthetic ? 'Instant Cartographic Terrain' : '© OpenStreetMap contributors · © CARTO'}
          </div>
        </div>

        {/* Silver Titanium Compass Rose */}
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-zinc-400/40 bg-gradient-to-b from-zinc-800 to-zinc-950 shadow-[0_4px_16px_rgba(0,0,0,0.5),inset_0_1px_2px_rgba(255,255,255,0.3)] backdrop-blur-md">
          <div className="relative h-10 w-10 transition-transform duration-75" style={{ transform: `rotate(${azimUi}deg)` }}>
            <div className="absolute inset-x-0 top-0 text-center text-[10px] font-black text-red-400 drop-shadow">N</div>
            <div className="absolute left-1/2 top-3 h-4 w-[2px] -translate-x-1/2 bg-gradient-to-b from-red-400 via-zinc-200 to-zinc-500 rounded-full" />
            <div className="absolute inset-x-0 bottom-0 text-center text-[9px] font-bold text-zinc-400">S</div>
          </div>
        </div>
      </div>

      {/* Silver Navigation Guide Pill */}
      <div
        className={`pointer-events-none absolute bottom-4 left-1/2 z-[1000] -translate-x-1/2 flex items-center gap-2 rounded-full border px-4 py-1.5 font-mono text-[11px] shadow-[0_4px_16px_rgba(0,0,0,0.5)] backdrop-blur-md transition-all ${
          zActive
            ? 'border-orange-400/80 bg-orange-950/90 text-orange-200 shadow-[0_0_15px_rgba(249,115,22,0.4)]'
            : 'border-zinc-400/40 bg-zinc-900/85 text-zinc-200'
        }`}
      >
        <span
          className={`rounded px-1.5 py-0.5 font-bold shadow-sm ${
            zActive
              ? 'bg-gradient-to-b from-orange-400 to-orange-600 text-white'
              : 'bg-gradient-to-b from-zinc-200 to-zinc-400 text-zinc-950'
          }`}
        >
          Z
        </span>
        <span>+ drag ↕ tilt · left-drag orbit · right-drag pan · scroll zoom · dbl-click reset</span>
      </div>

      {/* Loading Progress Bar */}
      {mapState.loading && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] h-1 bg-zinc-800">
          <div
            className="h-full bg-gradient-to-r from-cyan-400 via-zinc-200 to-cyan-300 transition-all shadow-[0_0_8px_rgba(34,211,238,0.8)]"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
