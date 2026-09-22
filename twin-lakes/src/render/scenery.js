// Scenery on top of the photo terrain: OpenStreetMap buildings, runway markings and lights with a working
// PAPI, the airport beacon, a windsock, town lights at night, and a GPU forest whose trees stand wherever the
// orthophoto shows canopy.

import * as THREE from '../../vendor/three.module.js';
import { TERRAIN_GLSL, IMAGERY_GLSL, LIGHT_GLSL } from './glsl.js';
import { SHADOW_GLSL } from './terrain-mesh.js';
import { decodeBuildings } from './assets.js';
import { runwayEnd } from '../world/terrain.js';

const KIND_COLOURS = [
  [0.78, 0.74, 0.68], [0.8, 0.76, 0.7], [0.8, 0.76, 0.7], [0.62, 0.6, 0.58], [0.55, 0.5, 0.45],
  [0.72, 0.72, 0.74], [0.75, 0.73, 0.7], [0.62, 0.64, 0.66], [0.66, 0.66, 0.66], [0.7, 0.72, 0.74],
  [0.86, 0.84, 0.8], [0.74, 0.62, 0.52], [0.84, 0.84, 0.82], [0.74, 0.66, 0.6], [0.75, 0.72, 0.68],
];

export function buildBuildings(assets) {
  const list = decodeBuildings(assets.buildings);
  const T = assets.terrain;
  const pos = [], col = [], idx = [];
  let v = 0;
  for (const b of list) {
    const pts = b.pts;
    if (pts.length < 3) continue;
    let base = Infinity;
    for (const [x, z] of pts) base = Math.min(base, T.height(x, z));
    base -= 0.4;
    const top = base + 0.4 + b.h;
    // orientation: make the ring counter-clockwise seen from above (+y)
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], c = pts[(i + 1) % pts.length]; area += a[0] * c[1] - c[0] * a[1]; }
    const ring = area > 0 ? pts : pts.slice().reverse();
    const kc = KIND_COLOURS[b.kind] || KIND_COLOURS[14];
    const shade = 0.9 + ((b.x * 13.1 + b.z * 7.7) % 1 + 1) % 1 * 0.2;
    const wall = kc.map((c) => c * shade);
    const roof = kc.map((c) => c * shade * 0.62);
    // walls
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      pos.push(a[0], base, a[1], c[0], base, c[1], c[0], top, c[1], a[0], top, a[1]);
      for (let k = 0; k < 4; k++) col.push(...(k < 2 ? wall.map((x) => x * 0.8) : wall));
      idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
      v += 4;
    }
    // roof (fan triangulation via ShapeUtils)
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const start = v;
    for (const [x, z] of ring) { pos.push(x, top, z); col.push(...roof); v++; }
    for (const t of tris) idx.push(start + t[0], start + t[2], start + t[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }));
  m.receiveShadow = false;
  m.castShadow = false;
  m.frustumCulled = false;
  return { mesh: m, list };
}

/** A lights texture over the near grid for towns at night (from building footprints). */
export function makeLightsTexture(assets, list) {
  const g = assets.world.grids.near;
  const W = 2048, H = Math.round(W * g.h / g.w);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  for (const b of list) {
    const x = (b.x - g.x0) / g.w * W, y = (b.z - g.z0) / g.h * H;
    const r = 1.2 + Math.min(4, b.h / 4);
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(x - r * 2.2, y - r * 2.2, r * 4.4, r * 4.4);
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false;
  return { texture: t, rect: new THREE.Vector4(g.x0, g.z0, g.w, g.h) };
}

/** Runway surface with FAA markings drawn procedurally, following the terrain. */
export function buildRunways(assets, shared) {
  const T = assets.terrain;
  const group = new THREE.Group();
  const digits = digitAtlas();
  for (const r of assets.world.runways) {
    if (!/paved|asphalt|concrete/.test(r.surface || '')) continue;
    const e = runwayEnd(r, 'a');
    const L = r.length, Wd = r.width;
    const ux = Math.sin(e.course), uz = -Math.cos(e.course);
    const rx = Math.cos(e.course), rz = Math.sin(e.course);
    const pos = [], uv = [], idx = [];
    const ns = Math.ceil(L / 6);
    for (let i = 0; i <= ns; i++) {
      const along = (i / ns) * L;
      for (const side of [-1, 1]) {
        const x = e.x + ux * along + rx * side * Wd / 2, z = e.z + uz * along + rz * side * Wd / 2;
        pos.push(x, T.height(x, z) + 0.06, z);
        uv.push(side * Wd / 2, along);
      }
      if (i < ns) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const identA = e.ident, identB = runwayEnd(r, 'b').ident;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uLen: { value: L }, uWidth: { value: Wd }, tDigits: { value: digits },
        uIdentA: { value: new THREE.Vector2(+identA[0], +identA[1]) }, uIdentB: { value: new THREE.Vector2(+identB[0], +identB[1]) } },
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec2 vUv; varying vec3 vWorld;
        void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <logdepthbuf_pars_fragment>
        ${LIGHT_GLSL}
        uniform float uLen; uniform float uWidth; uniform sampler2D tDigits; uniform vec2 uIdentA; uniform vec2 uIdentB;
        varying vec2 vUv; varying vec3 vWorld;
        float digit(vec2 p, float d) {
          // p in [0,1]^2 inside the digit cell; atlas has 10 digits side by side
          if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, vec2(1.0)))) return 0.0;
          return texture(tDigits, vec2((d + p.x) / 10.0, p.y)).r;
        }
        float markings(vec2 q, vec2 ident) {
          // q.x across (m, 0 = centreline), q.y along from this threshold (m)
          float m = 0.0;
          float ax = abs(q.x);
          // threshold bars: 8 bars, 45 m long, starting 6 m in
          if (q.y > 6.0 && q.y < 51.0 && ax > 1.8 && ax < uWidth / 2.0 - 1.5) {
            float k = mod(ax - 1.8, 3.4);
            m = max(m, step(k, 1.75));
          }
          // runway number, 18 m tall, 36 m past the bars
          vec2 nq = vec2(q.x, q.y - 57.0);
          if (nq.y > 0.0 && nq.y < 18.0) {
            float s = 18.0;
            m = max(m, digit(vec2((nq.x + 7.2) / 6.2, nq.y / s), ident.x));
            m = max(m, digit(vec2((nq.x - 1.0) / 6.2, nq.y / s), ident.y));
          }
          // aiming point: two 45 m x 9 m blocks 305 m from the threshold
          if (q.y > 305.0 && q.y < 350.0 && ax > 5.5 && ax < 9.0) m = 1.0;
          // touchdown zone: 3 bar pairs at 150 m and 450 m, 2 at 600 m
          for (int i = 0; i < 3; i++) {
            float y0 = i == 0 ? 150.0 : (i == 1 ? 450.0 : 600.0);
            if (q.y > y0 && q.y < y0 + 22.0 && ax > 5.5 && ax < 8.0) m = 1.0;
          }
          return m;
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec2 q = vUv;           // x across, y along from the 'a' threshold
          float ax = abs(q.x);
          vec3 asph = vec3(0.10, 0.10, 0.105) * (0.85 + 0.3 * vnoise(q * vec2(0.8, 0.25)));
          // tyre marks near both touchdown zones
          float rub = smoothstep(4.0, 0.0, ax) * (smoothstep(120.0, 250.0, q.y) * smoothstep(700.0, 400.0, q.y)
                    + smoothstep(uLen - 120.0, uLen - 250.0, q.y) * smoothstep(uLen - 700.0, uLen - 400.0, q.y));
          asph *= 1.0 - 0.45 * rub * vnoise(q * vec2(3.0, 0.2));
          float m = 0.0;
          // edge stripes and centreline: 36 m stripes, 24 m gaps
          if (ax > uWidth / 2.0 - 1.3 && ax < uWidth / 2.0 - 0.4) m = 1.0;
          if (ax < 0.45 && q.y > 110.0 && q.y < uLen - 110.0 && mod(q.y - 110.0, 60.0) < 36.0) m = 1.0;
          m = max(m, markings(q, uIdentA));
          m = max(m, markings(vec2(-q.x, uLen - q.y), uIdentB));
          vec3 alb = mix(asph, vec3(0.8), m * 0.92);
          float ndl = max(uSunDir.y, 0.0);
          vec3 col = alb * (uSunColor * ndl + uAmbient);
          col = aerial(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  return group;
}

function digitAtlas() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 640, 96);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 94px "DIN Condensed", "Arial Narrow", Arial, sans-serif';
  for (let d = 0; d < 10; d++) {
    g.save(); g.translate(d * 64 + 32, 50); g.scale(0.72, 1.0); g.fillText(String(d), 0, 0); g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Runway edge, threshold and end lights, PAPI and the airport beacon, as sized glow points. */
export function buildLights(assets, shared) {
  const T = assets.terrain;
  const pos = [], col = [], kind = [], dir = [];
  const add = (x, z, y, c, k = 0, d = [0, 0, 0]) => { pos.push(x, y, z); col.push(...c); kind.push(k); dir.push(...d); };
  for (const r of assets.world.runways) {
    if (!/paved|asphalt|concrete/.test(r.surface || '')) continue;
    for (const endName of ['a', 'b']) {
      const e = runwayEnd(r, endName);
      const ux = Math.sin(e.course), uz = -Math.cos(e.course), rx = Math.cos(e.course), rz = Math.sin(e.course);
      const hw = e.width / 2 + 3;
      // threshold: green facing the approach, red facing away (drawn as green; the far end adds red)
      for (let k = -3; k <= 3; k++) {
        const x = e.x + rx * k * (hw / 3) - ux * 1, z = e.z + rz * k * (hw / 3) - uz * 1;
        add(x, z, T.height(x, z) + 0.4, [0.1, 1.0, 0.25], 1, [-ux, 0, -uz]);
        add(x, z, T.height(x, z) + 0.4, [1.0, 0.1, 0.05], 1, [ux, 0, uz]);
      }
      // PAPI: four boxes, left side, 300 m in; 3.0° path. kind 2 with the transition angle in dir.y
      if (r.icao === 'KBPK' || r.length > 1400) {
        [2.5, 2.83, 3.17, 3.5].forEach((ang, i) => {
          const x = e.x + ux * 300 - rx * (hw + 15 + i * 9), z = e.z + uz * 300 - rz * (hw + 15 + i * 9);
          add(x, z, T.height(x, z) + 0.8, [1, 1, 1], 2, [-ux, ang, -uz]);
        });
      }
    }
    // edge lights every 60 m
    const e = runwayEnd(r, 'a');
    const ux = Math.sin(e.course), uz = -Math.cos(e.course), rx = Math.cos(e.course), rz = Math.sin(e.course);
    for (let d = 0; d <= r.length; d += 60) for (const s of [-1, 1]) {
      const x = e.x + ux * d + rx * s * (e.width / 2 + 3), z = e.z + uz * d + rz * s * (e.width / 2 + 3);
      add(x, z, T.height(x, z) + 0.4, [1.0, 0.92, 0.75], 0);
    }
  }
  // KBPK rotating beacon (green / white), north-east of the ramp
  const bx = 420, bz = -170;
  add(bx, bz, T.height(bx, bz) + 22, [1, 1, 1], 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('kind', new THREE.Float32BufferAttribute(kind, 1));
  g.setAttribute('ldir', new THREE.Float32BufferAttribute(dir, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uPx: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      #include <common>
        #include <logdepthbuf_pars_vertex>
      uniform vec3 uCam; uniform float uNight; uniform float uTime; uniform float uPx;
      attribute vec3 color; attribute float kind; attribute vec3 ldir;
      varying vec3 vCol; varying float vA;
      void main() {
        vec3 c = color;
        float a = 1.0;
        vec3 toCam = uCam - position;
        float d = length(toCam);
        if (kind > 0.5 && kind < 1.5) {        // directional threshold/end light
          a = smoothstep(-0.2, 0.3, dot(normalize(vec3(toCam.x, 0.0, toCam.z)), ldir));
        } else if (kind > 1.5 && kind < 2.5) { // PAPI: white above its angle, red below
          float ang = degrees(asin(clamp(toCam.y / d, -1.0, 1.0)));
          c = ang > ldir.y ? vec3(1.0, 1.0, 1.0) : vec3(1.0, 0.08, 0.05);
          a = smoothstep(-0.2, 0.4, dot(normalize(vec3(toCam.x, 0.0, toCam.z)), normalize(vec3(ldir.x, 0.0, ldir.z))));
        } else if (kind > 2.5) {               // beacon: alternating green / white flashes
          float ph = fract(uTime / 5.0);
          float az = atan(toCam.x, toCam.z) / 6.2831 + 0.5;
          float f = fract(ph * 2.0 + az);
          a = smoothstep(0.1, 0.0, abs(f - 0.05));
          c = fract(ph * 2.0 + az + 0.5) < 0.5 ? vec3(0.2, 1.0, 0.4) : vec3(1.0);
        }
        float vis = kind > 1.5 && kind < 2.5 ? 1.0 : mix(0.15, 1.0, uNight);
        vCol = c; vA = a * vis;
        vec4 mv = viewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(2400.0 / d, 2.0, 18.0) * uPx * (kind > 2.5 ? 2.5 : 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <logdepthbuf_pars_fragment>
      varying vec3 vCol; varying float vA;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p);
        float core = exp(-r * 6.0);
        gl_FragColor = vec4(vCol * core * vA * 2.0, 1.0);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 30;
  return pts;
}

/** Trees placed on the GPU around the camera from the orthophoto's canopy colour. */
export function buildForest(worldUniforms, shared) {
  const layers = [];
  for (const [spacing, grid, rMin, rMax] of [[7.5, 220, 0, 800], [22, 170, 700, 1850]]) {
    const g = new THREE.InstancedBufferGeometry();
    // two crossed quads, unit size, base at y = 0
    const p = [], uv = [];
    for (const rot of [0, Math.PI / 2]) {
      const c = Math.cos(rot), s = Math.sin(rot);
      const q = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
      for (const [x, y] of q) { p.push(x * c, y, x * s); uv.push(x + 0.5, y); }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    g.instanceCount = grid * grid;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...worldUniforms, ...shared, uSpacing: { value: spacing }, uGrid: { value: grid },
        uRMin: { value: rMin }, uRMax: { value: rMax } },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${TERRAIN_GLSL}
        ${IMAGERY_GLSL}
        ${LIGHT_GLSL}
        uniform float uSpacing; uniform float uGrid; uniform float uRMin; uniform float uRMax;
        varying vec2 vUv; varying vec3 vCol; varying vec3 vWorld; varying float vKeep;
        void main() {
          float id = float(gl_InstanceID);
          vec2 cell = vec2(mod(id, uGrid), floor(id / uGrid)) - uGrid * 0.5;
          vec2 base = floor(uCam.xz / uSpacing) + cell;
          float h1 = hash12(base * 1.37 + 3.1), h2 = hash12(base * 2.11 + 7.7), h3 = hash12(base * 0.73 + 1.9);
          vec2 xz = (base + vec2(h1, h2)) * uSpacing;
          float dist = distance(xz, uCam.xz);
          vec3 img = imageryLod(xz, 1.0);
          float forest = forestFromColour(img);
          float keep = step(h3, forest * 1.1) * step(uRMin, dist) * step(dist, uRMax);
          if (waterDistance(xz) < 6.0) keep = 0.0;
          float fade = smoothstep(uRMax, uRMax * 0.82, dist) * (uRMin > 0.0 ? smoothstep(uRMin, uRMin + 120.0, dist) : 1.0);
          float h = mix(11.0, 22.0, h2) * (uRMin > 0.0 ? 1.1 : 1.0) * fade * keep;
          float w = h * mix(0.55, 0.8, h1);
          float ang = h3 * 6.2831;
          vec3 lp = vec3(position.x * cos(ang) - position.z * sin(ang), position.y, position.x * sin(ang) + position.z * cos(ang));
          vec3 wp = vec3(xz.x, terrainHeight(xz) - 0.5, xz.y) + vec3(lp.x * w, lp.y * h, lp.z * w);
          vUv = uv;
          vCol = img * mix(0.8, 1.25, h1);
          vWorld = wp;
          vKeep = keep;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          if (keep < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <logdepthbuf_pars_fragment>
        ${LIGHT_GLSL}
        ${SHADOW_GLSL}
        varying vec2 vUv; varying vec3 vCol; varying vec3 vWorld; varying float vKeep;
        void main() {
          #include <logdepthbuf_fragment>
          // canopy silhouette: a lumpy ellipse on a short trunk
          vec2 p = vUv * 2.0 - 1.0;
          float yy = vUv.y;
          float crown = length(vec2(p.x * 1.0, (yy - 0.58) / 0.42));
          float lump = vnoise(vUv * 9.0 + vWorld.xz * 0.05) * 0.35;
          bool trunk = yy < 0.22 && abs(p.x) < 0.06;
          if (crown > 1.0 - lump * 0.6 && !trunk) discard;
          vec3 alb = trunk ? vec3(0.08, 0.06, 0.045) : vCol * (0.75 + 0.5 * yy) * (0.8 + 0.4 * vnoise(vUv * 14.0));
          float sh = sunShadow(vWorld, vec3(0.0, 1.0, 0.0)) * cloudShadow(vWorld.xz);
          vec3 col = alb * (uSunColor * (0.35 + 0.5 * max(uSunDir.y, 0.0)) * sh + uAmbient * 1.1);
          col = aerial(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    layers.push(mesh);
  }
  const group = new THREE.Group();
  layers.forEach((l) => group.add(l));
  return group;
}

/** Windsock at KBPK, pointing downwind. */
export function buildWindsock(assets) {
  const T = assets.terrain;
  const g = new THREE.Group();
  const x = -120, z = 60;
  g.position.set(x, T.height(x, z), z);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 6, 8), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
  pole.position.y = 3;
  g.add(pole);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.45, 3.2, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0xff6a00, side: THREE.DoubleSide }));
  sock.rotation.x = Math.PI / 2;
  sock.position.z = 1.6;
  const pivot = new THREE.Group();
  pivot.position.y = 5.8;
  pivot.add(sock);
  g.add(pivot);
  g.userData.pivot = pivot;
  return g;
}
