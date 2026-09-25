import { MutableRefObject, useEffect, useRef } from 'react';
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
  physTimeAt,
  plumeAnimDuration,
  plumeTimeScale,
  plumeBrightnessFactor,
} from './timeline';

interface Props {
  p: Params;
  r: Results;
  tauRef: MutableRefObject<number>;
}

export default function ImpactScene({ p, r, tauRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e1320);
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 2500);
    cam.position.set(78, 32, 78);
    const ctr = new OrbitControls(cam, renderer.domElement);
    ctr.target.set(0, 12, 0);
    ctr.enableDamping = true;
    ctr.maxPolarAngle = Math.PI * 0.49;
    ctr.maxDistance = 450;
    ctr.minDistance = 8;

    const maxKm = r.lightDamage * 1.15;
    const k2u = 60 / maxKm; // km -> scene units
    const craterR = r.airburst ? 0 : Math.max((r.craterD / 2) * k2u, 1.2);

    // Genuinely wider large explosions: scaled to actual physical fireball radius
    const physicalFireballRadius = Math.max(r.fireball * k2u, 1.0);
    const surgeMax = THREE.MathUtils.clamp(
      Math.max(r.overpressure * k2u, r.fireball * k2u * 1.35),
      4,
      Math.min(r.lightDamage * k2u * 0.95, 52)
    );
    const scale = THREE.MathUtils.clamp(physicalFireballRadius / 5.5, 0.65, 4.2);

    const burstH = r.airburst ? Math.max(physicalFireballRadius * 0.6, 6) : 0;
    const animDur = plumeAnimDuration(r.mt);
    const timeScale = plumeTimeScale(r.mt);
    const spanScale = animDur / REF_ANIM;
    const brightness = plumeBrightnessFactor(r.mt);
    const U = { uT: { value: 0 }, uFlash: { value: 0 }, uShock: { value: 0 }, uFire: { value: 0 } };
    const Uc = { uT: { value: 0 } };

    // Sky with balanced ambient dome
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1200, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: U,
        vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `uniform float uFlash,uFire; varying vec3 vP; void main(){ float h=normalize(vP).y;
          vec3 c=mix(vec3(.16,.21,.32),vec3(.04,.06,.12),smoothstep(0.,.5,h));
          c+=vec3(1.,.55,.25)*uFire*.4*exp(-max(h,0.)*3.5); c+=vec3(.95,.98,1.)*uFlash*1.2; gl_FragColor=vec4(c,1.);}`,
      })
    );
    scene.add(sky);

    // Ground with clear ambient lighting
    const gGeo = new THREE.PlaneGeometry(600, 600, 300, 300);
    gGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(
      gGeo,
      new THREE.ShaderMaterial({
        uniforms: {
          ...U,
          uCR: { value: craterR },
          uThermal: { value: r.thermal * k2u },
          uOver: { value: r.overpressure * k2u },
        },
        vertexShader: `uniform float uCR,uT; varying vec3 vW; void main(){ vec3 p=position; float d=length(p.xz);
          if(uCR>0.){ float g=smoothstep(0.,1.5,uT); float x=d/uCR; float bowl = x<1.? (x*x-1.)*uCR*.35 : 0.; float rim=exp(-pow((x-1.)*3.,2.))*uCR*.12; p.y+=(bowl+rim)*g; }
          vW=p; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
        fragmentShader: `${GLSL_NOISE} uniform float uT,uFlash,uFire,uShock,uThermal,uOver,uCR; varying vec3 vW;
          void main(){ vec2 q=vW.xz; float d=length(q); float n=fbm3(vec3(q*.05,0.)); float n2=fbm3(vec3(q*.4,1.));
            vec3 col=mix(vec3(.20,.26,.22),vec3(.30,.28,.24),n)*(.85+.45*n2);
            vec2 g=abs(fract(q*.25)-.5); float road=smoothstep(.47,.5,max(g.x,g.y))*step(.45,n);
            col+=vec3(1.,.85,.45)*road*.45*step(uShock,d)*(d<uOver*3.?1.:0.25);
            float burnt=step(d,uThermal)*step(d,uShock); col=mix(col,vec3(.06,.05,.04)+vec3(.32,.10,0.)*n2*uFire*2.2,burnt*.85);
            if(d<uCR*1.15) col=mix(col,vec3(.10,.06,.05)+vec3(1.,.4,.08)*max(0.,1.-uT*.05)*(1.-d/uCR),smoothstep(0.1,1.2,uT));
            vec3 N=normalize(cross(dFdx(vW),dFdy(vW))); vec3 L=normalize(vec3(0.,16.,0.)-vW);
            float lam=max(dot(N,L),0.); float atten=1./(1.+d*d*.0018);
            vec3 lit=col*(.92+vec3(1.,.65,.3)*lam*uFire*7.*atten+uFlash*3.5);
            lit+=vec3(.85,.94,1.)*exp(-pow((d-uShock)*.6,2.))*.45*step(.5,uShock)*(1.-smoothstep(18.,30.,uT));
            float fog=smoothstep(140.,420.,length(vW.xz-cameraPosition.xz)); lit=mix(lit,vec3(.08,.11,.18),fog);
            gl_FragColor=vec4(lit,1.);}`,
      })
    );
    scene.add(ground);

    // Hazard Distance rings
    const ringDefs: [number, number][] = [
      [r.fireball, 0xfde047],
      [r.overpressure, 0xef4444],
      [r.thermal, 0xf97316],
      [r.lightDamage, 0x38bdf8],
    ];
    const rings = ringDefs.map(([km, c]) => {
      const pts = Array.from({ length: 129 }, (_, i) => {
        const a = (i / 128) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * km * k2u, 0.4, Math.sin(a) * km * k2u);
      });
      const l = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.65, linewidth: 2 })
      );
      scene.add(l);
      return { l, R: km * k2u };
    });

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
    const trSeed = new Float32Array(TRAIL * 3).map(() => Math.random());
    trGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    trGeo.setAttribute('aS', new THREE.BufferAttribute(trSeed, 3));
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

    scene.add(new THREE.AmbientLight(0xa5b8d0, 1.4));
    scene.add(new THREE.HemisphereLight(0xe5f0ff, 0x243548, 0.85));
    const sunL = new THREE.DirectionalLight(0xffffff, 1.8);
    sunL.position.set(50, 90, 30);
    scene.add(sunL);
    const fireLight = new THREE.PointLight(0xffaa55, 0, 600, 1.25);
    fireLight.position.copy(impactPt).y += 6;
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

          vec3 getExplosionColor(float temp, float t, float rNorm) {
            vec3 cFlash = mix(vec3(0.35, 0.60, 1.0), vec3(1.0, 1.0, 1.0), smoothstep(0.35, 0.95, temp));
            cFlash = mix(vec3(0.80, 0.15, 0.90), cFlash, smoothstep(0.08, 0.45, temp));

            vec3 cFire = mix(vec3(0.04, 0.02, 0.02), vec3(0.80, 0.08, 0.02), smoothstep(0.02, 0.28, temp));
            cFire = mix(cFire, vec3(1.0, 0.42, 0.05), smoothstep(0.28, 0.55, temp));
            cFire = mix(cFire, vec3(1.0, 0.90, 0.30), smoothstep(0.55, 0.80, temp));
            cFire = mix(cFire, vec3(1.0, 1.0, 0.96), smoothstep(0.80, 0.98, temp));

            vec3 cCool = mix(vec3(0.07, 0.06, 0.07), vec3(0.92, 0.22, 0.04), smoothstep(0.18, 0.65, temp));
            cCool = mix(cCool, vec3(1.0, 0.72, 0.18), smoothstep(0.65, 0.92, temp));
            cCool = mix(cCool, vec3(1.0, 0.98, 0.85), smoothstep(0.92, 1.0, temp));

            float flashWeight = smoothstep(0.65, 0.0, t);
            float coolWeight = smoothstep(2.0, 7.5, t);

            vec3 col = mix(cFire, cFlash, flashWeight * 0.88);
            col = mix(col, cCool, coolWeight * 0.72);

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
    cring.position.y = 0.6;
    scene.add(cring);

    // Multi-Frame Buoyancy Mushroom Plume
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
            float rad = R0 + rm * cos(ph); float yOff = rm * sin(ph);
            float ceiling = smoothstep(10.0, 22.0, t);
            if (yOff > 0.0) yOff *= mix(1.15, 0.58, ceiling);
            p = vec3(rad * cos(th), H + yOff, rad * sin(th));
            vNrm = normalize(vec3(cos(ph) * cos(th), sin(ph) + 0.25, cos(ph) * sin(th)));
            vShade = 0.52 + 0.48 * sin(ph);
            float innerCore = smoothstep(0.3, -0.7, cos(ph)) * (1.0 - aS.z * 0.5);
            vHeat = clamp(exp(-t / 6.5) * (0.7 + 0.6 * innerCore), 0.0, 1.0);
            vCore = innerCore; sizeMul = 1.15 + 0.45 * aS.z + diss * 1.1;
          } else if (aS.w < 0.79) {
            float f = fract(aS.y + vortT * 0.10 * (0.75 + 0.5 * aS.z));
            float y = f * max(H - 1.2 * uSc, 0.2);
            float basePedestal = 1.5 * exp(-f * 5.0);
            float capJoin = 1.1 * smoothstep(0.65, 1.0, f);
            float stemR = (0.85 + 1.75 * aS.z) * uSc * (0.75 + basePedestal + capJoin) * smoothstep(0.15, 2.2, t);
            float swirl = th + vortT * 0.45 * (1.0 - 0.5 * f) + f * 2.4;
            float rib = 1.0 + 0.22 * sin(swirl * 5.0 - vortT * 1.2) * sin(f * 12.0);
            stemR *= rib; p = vec3(cos(swirl) * stemR, y, sin(swirl) * stemR);
            vNrm = normalize(vec3(cos(swirl), 0.18, sin(swirl)));
            vShade = 0.42 + 0.3 * f;
            vHeat = clamp(exp(-t / 5.5) * (1.0 - f * 0.55) * (1.0 - aS.z * 0.4), 0.0, 1.0);
            vCore = 1.0 - aS.z; sizeMul = (0.85 + 0.4 * f) * (1.0 + diss * 0.9);
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
            vCore = 0.2; regAlpha = smoothstep(2.0, 5.0, t) * (1.0 - smoothstep(16.0, 28.0, t));
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
            vCore = 0.0; regAlpha = smoothstep(0.4, 2.0, t) * (1.0 - smoothstep(14.0, 23.0, t));
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
      eVel = new Float32Array(EN * 3),
      ePos = new Float32Array(EN * 3);
    const down = new THREE.Vector2(-dir.x, -dir.z).normalize();
    const asym = Math.cos(th) * 0.8;
    for (let i = 0; i < EN; i++) {
      let a = Math.random() * Math.PI * 2;
      if (Math.random() < asym * 0.6) a = Math.atan2(down.y, down.x) + (Math.random() - 0.5) * 1.6;
      const elev = ((25 + Math.random() * 45) * Math.PI) / 180;
      const sp = (8 + Math.pow(Math.random(), 2) * 38) * Math.min(1.5, scale);
      const vx = Math.cos(a) * Math.cos(elev) * sp,
        vz = Math.sin(a) * Math.cos(elev) * sp,
        vy = Math.sin(elev) * sp;
      eVel.set([vx, vy, vz], i * 3);
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
    ejGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
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

    // Base Surge
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
          float r = Rs * pow(aS.y, 0.38) * lobe;
          float headBillow = smoothstep(0.55, 1.0, aS.y) * (1.8 + Rs * 0.07);
          float y = aS.z * aS.z * (1.4 + headBillow) * (1.0 + 0.35 * sin(th * 7.0 - t * 1.4)) + diss * aS.w * 3.5;
          vec3 p = vec3(cos(th) * r + max(0.0, t - 6.0) * 0.18 * diss, y, sin(th) * r);
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

    // Screen-space refraction post-process
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
    const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
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
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const tau = tauRef.current;
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

      // Shockwave dome & condensation ring
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
        (l.material as THREE.LineBasicMaterial).opacity = Rs >= R ? 0.95 : 0.45;
      });

      tmp.set(0, burstH * 0.3, 0).project(cam);
      postU.uC.value.set(tmp.x * 0.5 + 0.5, tmp.y * 0.5 + 0.5);
      right
        .setFromMatrixColumn(cam.matrixWorld, 0)
        .multiplyScalar(Rs)
        .add(new THREE.Vector3(0, burstH * 0.3, 0))
        .project(cam);
      postU.uR.value = Math.hypot((right.x - tmp.x) * 0.5 * postU.uAsp.value, (right.y - tmp.y) * 0.5);
      postU.uS.value = tau >= 0 && tmp.z < 1 ? decay * 1.5 : 0;

      ctr.update();
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      rt.dispose();
      el.innerHTML = '';
    };
  }, [p, r]);

  return <div ref={ref} className="absolute inset-0" />;
}
export { physTimeAt };
