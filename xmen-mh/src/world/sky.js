// Sky dome, sun/hemisphere lighting, exponential fog and a handful of drifting
// cloud puffs. Warm late-afternoon Ozark light by default, with a simple
// 3-keyframe day cycle exposed through setTimeOfDay(h).
import * as THREE from '../../vendor/three.module.js';

// ---------------------------------------------------------------------------
// Pure colour math (no THREE/DOM) — kept separate so it can be unit tested.
// Colours are plain [r,g,b] arrays in 0..1. Hours wrap at 24.
// ---------------------------------------------------------------------------
const KEYFRAMES = [
  { h: 6, top: [0.20, 0.34, 0.55], horizon: [1.00, 0.75, 0.56], sun: [1.00, 0.86, 0.68], sunIntensity: 1.6, hemiSky: [0.55, 0.62, 0.82], hemiGround: [0.35, 0.30, 0.25], fog: 0.85, elev: 15 },
  { h: 17, top: [0.09, 0.20, 0.46], horizon: [1.00, 0.58, 0.34], sun: [1.00, 0.68, 0.38], sunIntensity: 2.1, hemiSky: [0.45, 0.46, 0.65], hemiGround: [0.42, 0.32, 0.22], fog: 1.0, elev: 35 },
  { h: 21, top: [0.02, 0.03, 0.10], horizon: [0.18, 0.11, 0.19], sun: [0.28, 0.24, 0.34], sunIntensity: 0.15, hemiSky: [0.07, 0.08, 0.17], hemiGround: [0.05, 0.05, 0.06], fog: 0.55, elev: 4 },
];

function lerp(a, b, t) { return a + (b - a) * t; }
function lerp3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

function mixKeyframes(a, b, t) {
  return {
    top: lerp3(a.top, b.top, t),
    horizon: lerp3(a.horizon, b.horizon, t),
    sun: lerp3(a.sun, b.sun, t),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
    hemiSky: lerp3(a.hemiSky, b.hemiSky, t),
    hemiGround: lerp3(a.hemiGround, b.hemiGround, t),
    fog: lerp(a.fog, b.fog, t),
    elev: lerp(a.elev, b.elev, t),
  };
}

/** Interpolate the sky palette for a given hour (0..24) across the 3 keyframes. */
export function timeOfDayColors(hour) {
  const h = ((hour % 24) + 24) % 24;
  const n = KEYFRAMES.length;
  for (let i = 0; i < n; i++) {
    const cur = KEYFRAMES[i];
    const next = KEYFRAMES[(i + 1) % n];
    const curH = cur.h;
    const nextH = next.h > curH ? next.h : next.h + 24;
    const hh = h >= curH ? h : h + 24;
    if (hh >= curH && hh < nextH) {
      const t = (hh - curH) / (nextH - curH);
      return mixKeyframes(cur, next, t);
    }
  }
  return mixKeyframes(KEYFRAMES[n - 1], KEYFRAMES[0], 0);
}

const AZIMUTH_DEG = -55; // fixed warm side-light direction

/** Direction the sun shines FROM, as a unit [x,y,z], given a mixed palette's elev. */
export function sunDirection(elevDeg, azimDeg = AZIMUTH_DEG) {
  const e = (elevDeg * Math.PI) / 180;
  const a = (azimDeg * Math.PI) / 180;
  const ce = Math.cos(e);
  return [ce * Math.sin(a), Math.sin(e), ce * Math.cos(a)];
}

// ---------------------------------------------------------------------------
function skyDomeShader() {
  return {
    uniforms: {
      topColor: { value: new THREE.Color(0x0a1633) },
      bottomColor: { value: new THREE.Color(0xffb277) },
      offset: { value: 380 },
      exponent: { value: 0.6 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
      }
    `,
  };
}

// ---------------------------------------------------------------------------
export function createSky(scene, renderer) {
  if (renderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  // Gradient dome
  const shader = skyDomeShader();
  const domeMat = new THREE.ShaderMaterial({
    uniforms: shader.uniforms,
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3500, 24, 16), domeMat);
  dome.frustumCulled = false;
  scene.add(dome);

  // Lights
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 900;
  sun.shadow.camera.left = -150;
  sun.shadow.camera.right = 150;
  sun.shadow.camera.top = 150;
  sun.shadow.camera.bottom = -150;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0x88aadd, 0x554433, 0.8);
  scene.add(hemi);

  scene.fog = new THREE.FogExp2(0xffb277, 0.0008);

  // Cloud puffs — a handful of low-poly instanced blobs drifting on the wind.
  const CLOUD_COUNT = 30;
  const cloudGeo = new THREE.IcosahedronGeometry(1, 1);
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
    roughness: 1,
    fog: true,
    emissive: 0x33241a,
    emissiveIntensity: 0.15,
  });
  const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, CLOUD_COUNT);
  clouds.frustumCulled = false;
  const cloudBase = [];
  const LOOP = 5200;
  for (let i = 0; i < CLOUD_COUNT; i++) {
    cloudBase.push({
      x: (Math.random() - 0.5) * 4000,
      y: 320 + Math.random() * 480,
      z: (Math.random() - 0.5) * 4000,
      phase: Math.random() * LOOP,
      scale: 26 + Math.random() * 40,
      squash: 0.45 + Math.random() * 0.25,
    });
  }
  scene.add(clouds);

  const wind = { x: 0.6, z: 0.25 };
  const windLen = Math.hypot(wind.x, wind.z) || 1;
  const windDir = { x: wind.x / windLen, z: wind.z / windLen };
  const windSpeed = 3.2; // m/s

  const m4 = new THREE.Matrix4();
  const q0 = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const posScratch = new THREE.Vector3();
  let cloudTime = 0;

  function applyTimeOfDay(pal) {
    domeMat.uniforms.topColor.value.setRGB(...pal.top);
    domeMat.uniforms.bottomColor.value.setRGB(...pal.horizon);
    sun.color.setRGB(...pal.sun);
    sun.intensity = pal.sunIntensity;
    hemi.color.setRGB(...pal.hemiSky);
    hemi.groundColor.setRGB(...pal.hemiGround);
    hemi.intensity = 0.5 + 0.4 * pal.fog;
    const fogColor = new THREE.Color(...pal.horizon);
    scene.fog.color.copy(fogColor);
    scene.fog.density = 0.00045 + 0.0006 * pal.fog;
    const [dx, dy, dz] = sunDirection(pal.elev);
    sky.sunDir.set(dx, dy, dz);
  }

  const sky = {
    sun,
    sunDir: new THREE.Vector3(0.4, 0.7, 0.35),
    setTimeOfDay(h) {
      applyTimeOfDay(timeOfDayColors(h));
    },
    update(dt, playerPos) {
      cloudTime += dt * windSpeed;
      const p = playerPos || sun.target.position;
      if (playerPos) {
        sun.target.position.copy(playerPos);
        sun.position.set(
          playerPos.x + sky.sunDir.x * 400,
          playerPos.y + sky.sunDir.y * 400,
          playerPos.z + sky.sunDir.z * 400
        );
        sun.target.updateMatrixWorld();
      }
      for (let i = 0; i < CLOUD_COUNT; i++) {
        const c = cloudBase[i];
        const d = (c.phase + cloudTime) % LOOP;
        const cx = c.x + windDir.x * d;
        const cz = c.z + windDir.z * d;
        // wrap into a box roughly centred on the player so clouds are always around
        const wx = ((((cx - p.x + 2600) % 5200) + 5200) % 5200) - 2600 + p.x;
        const wz = ((((cz - p.z + 2600) % 5200) + 5200) % 5200) - 2600 + p.z;
        m4.compose(posScratch.set(wx, c.y, wz), q0, scl.set(c.scale, c.scale * c.squash, c.scale));
        clouds.setMatrixAt(i, m4);
      }
      clouds.instanceMatrix.needsUpdate = true;
    },
  };

  sky.setTimeOfDay(17); // default: warm late-afternoon Ozark light
  return sky;
}
