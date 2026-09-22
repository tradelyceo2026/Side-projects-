// CDLOD terrain and water (F. Strugar, "Continuous Distance-Dependent Level of Detail for Rendering
// Heightmaps", 2010): a quadtree of instanced grid patches chosen by distance each frame, with vertices
// morphing toward the next coarser grid before the switch, so there are no cracks and no popping.

import * as THREE from '../../vendor/three.module.js';
import { TERRAIN_GLSL, IMAGERY_GLSL, LIGHT_GLSL } from './glsl.js';
import { GRID_ORDER } from '../world/terrain.js';

const GRID_N = 32;          // quads per full patch side
const LEAF = 96;            // metres, finest patch (3 m vertex spacing)
const LEVELS = 12;          // LEAF * 2^11 = 196,608 m root
const ROOT = LEAF * 2 ** (LEVELS - 1);
const MAX_INSTANCES = 1600;

function gridGeometry(n) {
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { pos[k++] = i / n; pos[k++] = j / n; pos[k++] = 0; }
  const idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    // alternate the diagonal so the morph collapses symmetrically
    if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
  }
  g.setIndex(idx);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const inst = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 4), 4);
  inst.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aNode', inst);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export function makeWorldTextures(assets, renderer) {
  const { world, terrain, images } = assets;
  const tex = {};
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const name of GRID_ORDER) {
    const g = terrain.g[name];
    const fl = (arr) => {
      const t = new THREE.DataTexture(arr, g.hn[0], g.hn[1], THREE.RedFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.flipY = false;
      t.needsUpdate = true;
      return t;
    };
    tex[`H${name}`] = fl(g.H);
    tex[`W${name}`] = fl(g.W);
    const l = new THREE.DataTexture(g.L, g.lcn[0], g.lcn[1], THREE.RedFormat, THREE.UnsignedByteType);
    l.minFilter = l.magFilter = THREE.NearestFilter;
    l.flipY = false;
    l.unpackAlignment = 1;
    l.needsUpdate = true;
    tex[`L${name}`] = l;
    const im = new THREE.Texture(images[name]);
    im.flipY = false;
    im.colorSpace = THREE.SRGBColorSpace;
    im.anisotropy = aniso;
    im.minFilter = THREE.LinearMipmapLinearFilter;
    im.magFilter = THREE.LinearFilter;
    im.generateMipmaps = true;
    im.needsUpdate = true;
    tex[`Img${name}`] = im;
  }
  const u = {};
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  for (const name of GRID_ORDER) {
    const g = world.grids[name];
    u[`tH${name}`] = { value: tex[`H${name}`] };
    u[`tW${name}`] = { value: tex[`W${name}`] };
    u[`tL${name}`] = { value: tex[`L${name}`] };
    u[`tImg${cap(name)}`] = { value: tex[`Img${name}`] };
    u[`g${cap(name)}`] = { value: new THREE.Vector4(g.x0, g.z0, g.w, g.h) };
    u[`r${cap(name)}`] = { value: new THREE.Vector3(g.h_res, g.lc_res, g.sdf_scale) };
  }
  return { tex, uniforms: u };
}

const COMMON_VERT = /* glsl */`
attribute vec4 aNode;            // x0, z0, size, lod
uniform float uGridDim;
uniform float uMorphStart[${LEVELS}];
uniform float uMorphEnd[${LEVELS}];
varying vec3 vWorld;
varying float vMorph;
varying float vLod;

vec2 morphedXZ(out float morph) {
  vec2 gp = position.xy;
  vec2 wp = aNode.xy + gp * aNode.z;
  int lod = int(aNode.w + 0.5);
  float h0 = SURFACE(wp);
  float dist = distance(vec3(wp.x, h0, wp.y), uCam);
  morph = clamp((dist - uMorphStart[lod]) / (uMorphEnd[lod] - uMorphStart[lod]), 0.0, 1.0);
  vec2 fracPart = fract(gp * uGridDim * 0.5) * 2.0 / uGridDim;
  return wp - fracPart * aNode.z * morph;
}
`;

function morphUniforms() {
  const start = [], end = [];
  for (let l = 0; l < LEVELS; l++) {
    const r = LEAF * 2 ** l * 2.4;
    end.push(r);
    start.push(r * 0.72);
  }
  return { start, end };
}

export class TerrainRenderer {
  constructor(assets, renderer, shared) {
    this.assets = assets;
    this.shared = shared;   // uniforms shared with everything (sun, sky, fog, shadow...)
    const { uniforms } = makeWorldTextures(assets, renderer);
    this.worldUniforms = uniforms;
    const mr = morphUniforms();
    this.ranges = mr.end;
    this.geomFull = gridGeometry(GRID_N);
    this.geomHalf = gridGeometry(GRID_N / 2);
    const base = { ...uniforms, ...shared, uMorphStart: { value: mr.start }, uMorphEnd: { value: mr.end } };

    this.terrainMatFull = this._terrainMaterial(base, GRID_N);
    this.terrainMatHalf = this._terrainMaterial(base, GRID_N / 2);
    this.waterMatFull = this._waterMaterial(base, GRID_N);
    this.waterMatHalf = this._waterMaterial(base, GRID_N / 2);

    this.group = new THREE.Group();
    const mk = (geo, mat, order) => {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = order;
      this.group.add(m);
      return m;
    };
    mk(this.geomFull, this.terrainMatFull, 0);
    mk(this.geomHalf, this.terrainMatHalf, 0);
    this.waterFull = mk(this.geomFull, this.waterMatFull, 5);
    this.waterHalf = mk(this.geomHalf, this.waterMatHalf, 5);
    this._frustum = new THREE.Frustum();
    this._box = new THREE.Box3();
    this._m = new THREE.Matrix4();
    this.stats = { nodes: 0 };
  }

  _terrainMaterial(base, dim) {
    return new THREE.ShaderMaterial({
      uniforms: { ...base, uGridDim: { value: dim } },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${TERRAIN_GLSL}
        ${LIGHT_GLSL}
        #define SURFACE terrainHeight
        ${COMMON_VERT}
        void main() {
          float morph;
          vec2 xz = morphedXZ(morph);
          vec3 wp = vec3(xz.x, terrainHeight(xz), xz.y);
          vWorld = wp;
          vMorph = morph;
          vLod = aNode.w;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <logdepthbuf_pars_fragment>
        ${TERRAIN_GLSL}
        ${IMAGERY_GLSL}
        ${LIGHT_GLSL}
        ${SHADOW_GLSL}
        varying vec3 vWorld;
        varying float vMorph;
        varying float vLod;
        void main() {
          #include <logdepthbuf_fragment>
          vec2 p = vWorld.xz;
          float dist = distance(vWorld, uCam);
          // normal from the height field, with a step that grows with distance to avoid aliasing
          float e = clamp(dist * 0.004, 4.0, 200.0);
          float hx = terrainHeight(p + vec2(e, 0.0)) - terrainHeight(p - vec2(e, 0.0));
          float hz = terrainHeight(p + vec2(0.0, e)) - terrainHeight(p - vec2(0.0, e));
          vec3 n = normalize(vec3(-hx, 2.0 * e, -hz));
          vec3 alb = imagery(p);
          // close range: canopy and field texture so the photo does not look like a smear
          float forest = forestFromColour(alb);
          float near = 1.0 - smoothstep(300.0, 2500.0, dist);
          if (near > 0.0) {
            float d1 = fbm(p * 0.35) - 0.5;
            float d2 = vnoise(p * 1.7) - 0.5;
            alb *= 1.0 + near * (forest * (d1 * 0.55 + d2 * 0.35) + (1.0 - forest) * d1 * 0.12);
          }
          float ndl = max(dot(n, uSunDir), 0.0);
          float sh = sunShadow(vWorld, n) * cloudShadow(p);
          vec3 light = uSunColor * ndl * sh + uAmbient * (0.55 + 0.45 * n.y);
          vec3 col = alb * light;
          col += nightLights(p, alb, dist);
          col = aerial(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  }

  _waterMaterial(base, dim) {
    return new THREE.ShaderMaterial({
      uniforms: { ...base, uGridDim: { value: dim } },
      transparent: true,
      depthWrite: true,
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${TERRAIN_GLSL}
        ${LIGHT_GLSL}
        #define SURFACE waterLevel
        ${COMMON_VERT}
        varying float vDepth;
        void main() {
          float morph;
          vec2 xz = morphedXZ(morph);
          float wl = waterLevel(xz);
          vec3 wp = vec3(xz.x, wl, xz.y);
          vWorld = wp;
          vMorph = morph;
          vLod = aNode.w;
          vDepth = wl - terrainHeight(xz);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <logdepthbuf_pars_fragment>
        ${TERRAIN_GLSL}
        ${IMAGERY_GLSL}
        ${LIGHT_GLSL}
        ${SHADOW_GLSL}
        varying vec3 vWorld;
        varying float vMorph;
        varying float vLod;
        varying float vDepth;
        // sum of directional waves, each octave faded out before it aliases (footprint ~ 1.5 mrad per pixel)
        vec2 waveGrad(vec2 p, float t, float dist) {
          vec2 g = vec2(0.0);
          float a = 1.0, fr = 0.045;
          float fp = dist * 0.0015;
          vec2 dirs[5] = vec2[5](vec2(0.8, 0.6), vec2(-0.5, 0.86), vec2(0.97, -0.24), vec2(-0.3, -0.95), vec2(0.6, -0.8));
          for (int i = 0; i < 5; i++) {
            float lambda = 6.2831 / fr;
            float w = 1.0 - smoothstep(0.15 * lambda, 0.6 * lambda, fp);
            vec2 d = dirs[i];
            float ph = dot(d, p) * fr + t * sqrt(9.8 * fr) + float(i) * 1.7;
            g += d * cos(ph) * fr * a * w;
            a *= 0.6; fr *= 1.9;
          }
          return g;
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec2 p = vWorld.xz;
          float sd = waterDistance(p);
          if (sd > 1.5) discard;
          float dist = distance(vWorld, uCam);
          // swell from a few directional waves plus non-periodic value-noise ripples, all band-limited by distance
          vec2 g = waveGrad(p, uTime, dist) * 0.7;
          float e = 0.6;
          float rip = 1.0 - smoothstep(40.0, 900.0, dist);
          vec2 q1 = p * 0.35 + vec2(uTime * 0.35, uTime * 0.2);
          vec2 q2 = p * 0.9 - vec2(uTime * 0.5, -uTime * 0.3);
          float n0 = vnoise(q1), n1 = vnoise(q2);
          g += vec2(vnoise(q1 + vec2(e, 0.0)) - n0, vnoise(q1 + vec2(0.0, e)) - n0) / e * 0.06 * rip;
          g += vec2(vnoise(q2 + vec2(e, 0.0)) - n1, vnoise(q2 + vec2(0.0, e)) - n1) / e * 0.035 * rip;
          vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
          vec3 V = normalize(uCam - vWorld);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          vec3 R = reflect(-V, N);
          R.y = max(R.y, 0.02);
          vec3 refl = skyColour(normalize(R));
          float sh = sunShadow(vWorld, vec3(0.0, 1.0, 0.0)) * cloudShadow(p);
          vec3 H = normalize(uSunDir + V);
          // the unresolved ripples widen the highlight with distance (Toksvig): a glitter path, not a lattice
          float pw = mix(900.0, 60.0, smoothstep(50.0, 4000.0, dist));
          float spec = pow(max(dot(N, H), 0.0), pw) * (pw + 8.0) / 25.0 * 0.06;
          vec3 bottom = imagery(p) * (uSunColor * max(uSunDir.y, 0.0) * sh + uAmbient) * 0.8;
          // the Twin Lakes are clear, blue-green reservoirs
          vec3 deep = vec3(0.010, 0.045, 0.055) * (uSunColor * max(uSunDir.y, 0.0) * 0.6 + uAmbient * 1.4);
          float murk = 1.0 - exp(-max(vDepth, 0.0) / 3.5);
          vec3 body = mix(bottom, deep, murk);
          vec3 col = mix(body, refl, fres) + uSunColor * spec * sh * (1.0 - uNight);
          col = aerial(col, vWorld);
          float alpha = smoothstep(1.5, -1.5, sd);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  }

  /** Choose the patches for this camera. */
  update(camera) {
    const cam = camera.position;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    const full = [], half = [];
    const hmin = 60, hmax = 720;
    const cx = 3268, cz = -4424;       // centre of the data
    const box = this._box;
    const distTo = (x, z, s) => {
      const dx = Math.max(x - cam.x, 0, cam.x - (x + s));
      const dz = Math.max(z - cam.z, 0, cam.z - (z + s));
      const dy = Math.max(hmin - cam.y, 0, cam.y - hmax);
      return Math.hypot(dx, dy, dz);
    };
    const visible = (x, z, s) => {
      box.min.set(x, hmin, z); box.max.set(x + s, hmax, z + s);
      return this._frustum.intersectsBox(box);
    };
    const R = this.ranges;
    const add = (list, x, z, s, lod) => { if (list.length < MAX_INSTANCES) list.push(x, z, s, lod); };
    const select = (x, z, s, lod) => {
      const d = distTo(x, z, s);
      if (d > R[lod]) return false;
      if (!visible(x, z, s)) return true;
      if (lod === 0) { add(full, x, z, s, 0); return true; }
      if (d > R[lod - 1]) { add(full, x, z, s, lod); return true; }
      const h = s / 2;
      for (const [ox, oz] of [[0, 0], [h, 0], [0, h], [h, h]]) {
        if (!select(x + ox, z + oz, h, lod - 1)) {
          if (visible(x + ox, z + oz, h)) add(half, x + ox, z + oz, h, lod);
        }
      }
      return true;
    };
    // cover the horizon with a 3x3 arrangement of roots so the far edge never shows
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const x = cx - ROOT / 2 + i * ROOT, z = cz - ROOT / 2 + j * ROOT;
      if (!select(x, z, ROOT, LEVELS - 1) && visible(x, z, ROOT)) add(full, x, z, ROOT, LEVELS - 1);
    }
    const put = (geo, list) => {
      const a = geo.attributes.aNode;
      a.array.set(list);
      a.needsUpdate = true;
      a.clearUpdateRanges?.();
      geo.instanceCount = list.length / 4;
    };
    put(this.geomFull, full);
    put(this.geomHalf, half);
    this.stats.nodes = (full.length + half.length) / 4;
  }
}

// Sun shadows: the aircraft's shadow map plus a soft terrain horizon test; cloud shadows; town lights at night.
export const SHADOW_GLSL = /* glsl */`
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform float uCloudCover;
uniform float uCloudBase;
uniform vec2 uCloudOffset;
uniform sampler2D tLights;
uniform vec4 uLightsRect;
float sunShadow(vec3 wp, vec3 n) {
  float s = 1.0;
  if (uShadowOn > 0.5) {
    vec4 sc = uShadowMatrix * vec4(wp, 1.0);
    vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
    if (all(greaterThan(c, vec3(0.0))) && all(lessThan(c, vec3(1.0)))) {
      float bias = 0.002;
      float lit = 0.0;
      vec2 ts = 1.0 / vec2(textureSize(tShadow, 0));
      for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
        float dd = texture(tShadow, c.xy + vec2(i, j) * ts).r;
        lit += c.z - bias > dd ? 0.0 : 1.0;
      }
      s = mix(0.25, 1.0, lit / 9.0);
    }
  }
  // the sun sets behind the hills: fade direct light as it nears the local horizon
  s *= smoothstep(-0.02, 0.06, uSunDir.y);
  return s;
}
float cloudDensity(vec2 p) {
  if (uCloudCover < 0.02) return 0.0;
  vec2 q = (p + uCloudOffset) / 2600.0;
  float n = fbm(q) * 0.65 + fbm(q * 3.1 + 5.0) * 0.35;
  return smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.18, n);
}
float cloudShadow(vec2 p) {
  vec2 q = p + uSunDir.xz / max(uSunDir.y, 0.15) * max(uCloudBase - 250.0, 0.0);
  return 1.0 - 0.75 * cloudDensity(q);
}
vec3 nightLights(vec2 p, vec3 alb, float dist) {
  if (uNight < 0.01) return vec3(0.0);
  vec2 uv = (p - uLightsRect.xy) / uLightsRect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  float l = texture(tLights, uv).r;
  float tw = 0.75 + 0.25 * vnoise(p * 0.2 + uTime * 0.3);
  return vec3(1.0, 0.72, 0.42) * l * l * 1.3 * uNight * tw;
}
`;
