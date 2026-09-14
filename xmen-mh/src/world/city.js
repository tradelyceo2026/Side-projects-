// src/world/city.js — Agent B — Mountain Home, Arkansas.
//
// Builds the whole city out of src/data/city.json: gentle Ozark heightfield, road
// strips with sidewalks and dashed centre lines, extruded building footprints with
// canvas facades, instanced trees / street lamps / parked cars, water, lawns, the
// ASUMH campus and its "X" sign.
//
// Everything above the `City` class is pure (no DOM, no canvas). Canvas textures are
// created lazily inside build() and degrade to flat colours when there is no document,
// so the whole city can be built and tested head-lessly under `node --test`.

import * as THREE from '../../vendor/three.module.js';

/* ================================================================== *
 * 0. tunables
 * ================================================================== */

export const CITY_DEFAULTS = {
  quality: 'high',
  seed: 20250914,
  terrainAmplitude: 12,        // ±12 m across the 5 km bbox
  terrainScale: 1400,
  roadLift: 0.14,              // road surface above the flattened terrain
  sidewalkWidth: 2.4,
  curbHeight: 0.16,
  colliderCell: 32,            // uniform AABB grid cell, metres
  roadSampleStep: 12,
  roadSmoothWindow: 5,         // ±5 samples ≈ ±60 m running mean → level streets
  treeBudget: { high: 3600, medium: 2000, low: 800 },
  terrainSegments: { high: 192, medium: 128, low: 88 },
  treeChunk: 900,              // metres; instanced tree groups toggled by distance
  treeCullDistance: 1750,
  downtownRadius: 240,
};

export const DISTRICT = {
  DOWNTOWN: 'downtown',
  STRIP: 'strip',
  RESIDENTIAL: 'residential',
  CAMPUS: 'campus',
};

export const REQUIRED_POIS = [
  'courthouse', 'asumh', 'hospital', 'walmart', 'high_school',
  'lake', 'airport', 'downtown', 'park', 'landing_zone',
];

/* ================================================================== *
 * 1. scalar / rng / noise
 * ================================================================== */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic 0..1 hash of an integer lattice point. */
export function hash2i(ix, iz, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** mulberry32 — small deterministic RNG so every build looks identical. */
export function makeRng(seed = 1) {
  let a = (seed | 0) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise on the unit lattice, returns 0..1. */
export function makeValueNoise2D(seed = 1337) {
  return function noise(x, z) {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = x - x0, fz = z - z0;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash2i(x0, z0, seed), b = hash2i(x0 + 1, z0, seed);
    const c = hash2i(x0, z0 + 1, seed), d = hash2i(x0 + 1, z0 + 1, seed);
    const top = a + (b - a) * sx;
    const bot = c + (d - c) * sx;
    return top + (bot - top) * sz;
  };
}

/**
 * Gentle Ozark heightfield: three octaves of value noise whose weights sum to 1,
 * so |height| is provably <= amplitude everywhere.
 */
export function createTerrainSampler(opts = {}) {
  const seed = opts.seed ?? CITY_DEFAULTS.seed;
  const amplitude = opts.amplitude ?? CITY_DEFAULTS.terrainAmplitude;
  const scale = opts.scale ?? CITY_DEFAULTS.terrainScale;
  const n1 = makeValueNoise2D(seed);
  const n2 = makeValueNoise2D(seed + 7919);
  const n3 = makeValueNoise2D(seed + 104729);
  const fn = function terrain(x, z) {
    let v = (n1(x / scale, z / scale) * 2 - 1) * 0.62;
    v += (n2(x / (scale * 0.37), z / (scale * 0.37)) * 2 - 1) * 0.27;
    v += (n3(x / (scale * 0.13), z / (scale * 0.13)) * 2 - 1) * 0.11;
    return v * amplitude;
  };
  fn.amplitude = amplitude;
  fn.seed = seed;
  return fn;
}

/* ================================================================== *
 * 2. polygon / polyline geometry (pure)
 * ================================================================== */

/** Signed shoelace area of a [[x,z],...] ring. Positive = CCW in the (x,z) plane. */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

export function polygonBounds(poly) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of poly) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, minZ, maxX, maxZ };
}

export function polygonCentroid(poly) {
  const a = polygonArea(poly);
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const p of poly) { sx += p[0]; sz += p[1]; }
    return [sx / poly.length, sz / poly.length];
  }
  let cx = 0, cz = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const cr = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * cr;
    cz += (p[1] + q[1]) * cr;
  }
  return [cx / (6 * a), cz / (6 * a)];
}

export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function triSign(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

export function pointInTriangle(px, pz, a, b, c) {
  const d1 = triSign(px, pz, a[0], a[1], b[0], b[1]);
  const d2 = triSign(px, pz, b[0], b[1], c[0], c[1]);
  const d3 = triSign(px, pz, c[0], c[1], a[0], a[1]);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation of a simple polygon (no holes).
 * Returns a flat index list into `poly`; triangles are wound CCW in the (x,z) plane
 * (positive shoelace). Consumers flip when they want an up-facing normal.
 */
export function earClip(poly) {
  const n = poly.length;
  if (n < 3) return [];
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  if (polygonArea(poly) < 0) idx.reverse();
  const out = [];
  let guard = 0;
  const maxGuard = n * n + 64;
  while (idx.length > 2) {
    if (guard++ > maxGuard) break;
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const L = idx.length;
      const ia = idx[(i + L - 1) % L], ib = idx[i], ic = idx[(i + 1) % L];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (triSign(a[0], a[1], b[0], b[1], c[0], c[1]) <= 1e-9) continue; // reflex / collinear
      let ok = true;
      for (let j = 0; j < L; j++) {
        const ip = idx[j];
        if (ip === ia || ip === ib || ip === ic) continue;
        if (pointInTriangle(poly[ip][0], poly[ip][1], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length > 2) { // degenerate remainder: fan it so nothing disappears
    for (let i = 1; i < idx.length - 1; i++) out.push(idx[0], idx[i], idx[i + 1]);
  }
  return out;
}

/** Perpendicular distance from p to segment a-b, in the (x,z) plane. */
export function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 1e-12 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + vx * t, cz = az + vz * t;
  const dx = px - cx, dz = pz - cz;
  return { d: Math.hypot(dx, dz), x: cx, z: cz, t };
}

/** Douglas-Peucker simplification of a [[x,z],...] polyline. */
export function douglasPeucker(pts, epsilon = 1) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegmentDistance(pts[i][0], pts[i][1], pts[s][0], pts[s][1], pts[e][0], pts[e][1]).d;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Resample a polyline at (roughly) fixed spacing; always keeps both endpoints. */
export function resamplePolyline(pts, step = 12) {
  const clean = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-4) clean.push([p[0], p[1]]);
  }
  if (clean.length < 2) return clean;
  const out = [[clean[0][0], clean[0][1]]];
  let carry = 0;
  for (let i = 1; i < clean.length; i++) {
    const ax = clean[i - 1][0], az = clean[i - 1][1];
    const bx = clean[i][0], bz = clean[i][1];
    const segLen = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= segLen) {
      const u = t / segLen;
      out.push([ax + (bx - ax) * u, az + (bz - az) * u]);
      t += step;
    }
    carry = (carry + segLen) % step;
  }
  const last = clean[clean.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.25) out.push([last[0], last[1]]);
  else { out[out.length - 1] = [last[0], last[1]]; }
  return out;
}

/** Running mean over an array of numbers — used to level streets along their centreline. */
export function smoothSeries(values, window = 5) {
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -window; k <= window; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      s += values[j]; c++;
    }
    out[i] = s / c;
  }
  return out;
}

/**
 * Offset a polyline sideways by `dist` (positive = right of travel direction in the
 * (x,z) plane, i.e. +dist rotates the direction by -90°). Uses averaged segment
 * normals with a clamped miter so corners do not blow up.
 */
export function offsetPolyline(pts, dist) {
  const n = pts.length;
  if (n < 2) return pts.map((p) => [p[0], p[1]]);
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
    const L = Math.hypot(dx, dz) || 1;
    segN.push([dz / L, -dx / L]); // right-hand normal
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = segN[Math.max(0, i - 1)];
    const b = segN[Math.min(segN.length - 1, i)];
    let nx = a[0] + b[0], nz = a[1] + b[1];
    const L = Math.hypot(nx, nz);
    if (L < 1e-6) { nx = b[0]; nz = b[1]; }
    else {
      const cosHalf = clamp(L / 2, 0.35, 1); // clamp the miter at ~2.85x
      nx = (nx / L) / cosHalf;
      nz = (nz / L) / cosHalf;
    }
    out.push([pts[i][0] + nx * dist, pts[i][1] + nz * dist]);
  }
  return out;
}

/* ================================================================== *
 * 3. uniform AABB grid + capsule resolution (pure)
 * ================================================================== */

/** Uniform spatial hash of axis-aligned rectangles in the (x,z) plane. */
export class AabbGrid {
  constructor(cell = CITY_DEFAULTS.colliderCell) {
    this.cell = cell;
    this.map = new Map();
    this.items = [];
    this._stamp = 0;
    this.maxHalf = 0;
  }

  static key(cx, cz) { return cx + ',' + cz; }

  /** item must be an object; {minX,minZ,maxX,maxZ} are read from it if not supplied. */
  insert(item, minX = item.minX, minZ = item.minZ, maxX = item.maxX, maxZ = item.maxZ) {
    const c = this.cell;
    const x0 = Math.floor(minX / c), x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c), z1 = Math.floor(maxZ / c);
    item._stamp = -1;
    this.items.push(item);
    this.maxHalf = Math.max(this.maxHalf, (maxX - minX) * 0.5, (maxZ - minZ) * 0.5);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = AabbGrid.key(cx, cz);
        let bucket = this.map.get(k);
        if (!bucket) { bucket = []; this.map.set(k, bucket); }
        bucket.push(item);
      }
    }
    return item;
  }

  /** Collects unique items overlapping the rectangle into `out` (cleared first). */
  query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    const c = this.cell;
    const stamp = ++this._stamp;
    const x0 = Math.floor(minX / c), x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c), z1 = Math.floor(maxZ / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.map.get(AabbGrid.key(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const it = bucket[i];
          if (it._stamp === stamp) continue;
          it._stamp = stamp;
          out.push(it);
        }
      }
    }
    return out;
  }

  queryPoint(x, z, out = []) { return this.query(x, z, x, z, out); }

  /** Cells within `radius` of a point (used by nearest-road / nearest-pad lookups). */
  queryRadius(x, z, radius, out = []) { return this.query(x - radius, z - radius, x + radius, z + radius, out); }
}

/**
 * Resolves a vertical capsule out of a list of boxes {minX,minZ,maxX,maxZ,base,top}.
 * `pos` is the capsule's foot position. Writes the corrected x/z into `out` and
 * returns true if anything moved. Pure: no THREE types required (duck-typed vectors).
 */
export function resolveCapsuleBoxes(pos, radius, height, boxes, out) {
  let x = pos.x, z = pos.z;
  const y = pos.y;
  const feet = y, head = y + height;
  let hit = false;
  const r2 = radius * radius;
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (head <= b.base + 0.02) continue;      // entirely below the box
      if (feet >= b.top - 0.05) continue;       // standing on or above the roof
      const cx = clamp(x, b.minX, b.maxX);
      const cz = clamp(z, b.minZ, b.maxZ);
      const dx = x - cx, dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = radius - d;
        x += (dx / d) * push;
        z += (dz / d) * push;
      } else {
        // centre is inside the rectangle: leave by the nearest face
        const pL = x - b.minX, pR = b.maxX - x, pN = z - b.minZ, pS = b.maxZ - z;
        const m = Math.min(pL, pR, pN, pS);
        if (m === pL) x = b.minX - radius;
        else if (m === pR) x = b.maxX + radius;
        else if (m === pN) z = b.minZ - radius;
        else z = b.maxZ + radius;
      }
      moved = true; hit = true;
    }
    if (!moved) break;
  }
  if (out) {
    if (typeof out.set === 'function') out.set(x, y, z);
    else { out.x = x; out.y = y; out.z = z; }
  }
  return hit;
}

/**
 * The terrain "flattening" field: a set of pads (x, z, height, radius) dropped under
 * roads and buildings. Sampling blends the base heightfield toward the pads so streets
 * and lots are level while the hills between them stay gentle.
 */
export class FlattenField {
  constructor(terrainFn, cell = 48) {
    this.terrain = terrainFn;
    this.cell = cell;
    this.grid = new AabbGrid(cell);
    this.maxRadius = 0;
    this.count = 0;
  }

  addPad(x, z, h, r) {
    const pad = { x, z, h, r, minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r };
    this.grid.insert(pad);
    if (r > this.maxRadius) this.maxRadius = r;
    this.count++;
    return pad;
  }

  height(x, z, scratch = []) {
    const base = this.terrain(x, z);
    if (this.count === 0) return base;
    const pads = this.grid.queryPoint(x, z, scratch);
    if (pads.length === 0) return base;
    let wsum = 0, hsum = 0, wmax = 0;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      const d = Math.hypot(x - p.x, z - p.z);
      if (d >= p.r) continue;
      const w = 1 - smoothstep(p.r * 0.45, p.r, d);
      if (w <= 0) continue;
      wsum += w; hsum += w * p.h;
      if (w > wmax) wmax = w;
    }
    if (wsum <= 0) return base;
    const flat = hsum / wsum;
    return base * (1 - wmax) + flat * wmax;
  }
}

/* ================================================================== *
 * 4. mesh building (pure array accumulation, geometry made at the end)
 * ================================================================== */

/** Accumulates triangles into flat arrays; `toGeometry()` makes one BufferGeometry. */
export class MeshBuilder {
  constructor(useColor = false) {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.useColor = useColor;
  }

  get vertexCount() { return this.pos.length / 3; }
  get triangleCount() { return this.idx.length / 3; }
  get isEmpty() { return this.idx.length === 0; }

  _push(p, n, u, c) {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.uv.push(u[0], u[1]);
    if (this.useColor) this.col.push(c ? c[0] : 1, c ? c[1] : 1, c ? c[2] : 1);
  }

  /** a,b,c are [x,y,z]; uvs are [u,v]; `ref` flips the winding so the normal faces it. */
  addTri(a, b, c, ua = [0, 0], ub = [1, 0], uc = [1, 1], color = null, ref = null) {
    let A = a, B = b, C = c, UA = ua, UB = ub, UC = uc;
    let nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
    let ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
    let nz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (ref && nx * ref[0] + ny * ref[1] + nz * ref[2] < 0) {
      B = c; C = b; UB = uc; UC = ub;
      nx = -nx; ny = -ny; nz = -nz;
    }
    const L = Math.hypot(nx, ny, nz) || 1;
    const n = [nx / L, ny / L, nz / L];
    const base = this.vertexCount;
    this._push(A, n, UA, color);
    this._push(B, n, UB, color);
    this._push(C, n, UC, color);
    this.idx.push(base, base + 1, base + 2);
    return this;
  }

  addQuad(a, b, c, d, uvs = null, color = null, ref = null) {
    const U = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
    this.addTri(a, b, c, U[0], U[1], U[2], color, ref);
    this.addTri(a, c, d, U[0], U[2], U[3], color, ref);
    return this;
  }

  /** Two matching 3D polylines become a ribbon (roads, sidewalks, paths, curbs). */
  addRibbon(left, right, uvScale = 8, color = null, faceUp = true, vStart = 0) {
    const ref = faceUp ? [0, 1, 0] : null;
    let v = vStart;
    for (let i = 0; i < left.length - 1; i++) {
      const l0 = left[i], l1 = left[i + 1], r0 = right[i], r1 = right[i + 1];
      const step = Math.hypot(l1[0] - l0[0], l1[2] - l0[2]);
      const v1 = v + step / uvScale;
      this.addQuad(l0, l1, r1, r0,
        [[0, v], [0, v1], [1, v1], [1, v]], color, ref);
      v = v1;
    }
    return this;
  }

  /** Horizontal cap over a polygon at height y. */
  addPolygonCap(poly, y, up = true, uvScale = 8, color = null, heightFn = null) {
    const tris = earClip(poly);
    const ref = up ? [0, 1, 0] : [0, -1, 0];
    for (let i = 0; i < tris.length; i += 3) {
      const P = [poly[tris[i]], poly[tris[i + 1]], poly[tris[i + 2]]];
      const V = P.map((p) => [p[0], heightFn ? heightFn(p[0], p[1]) : y, p[1]]);
      const U = P.map((p) => [p[0] / uvScale, p[1] / uvScale]);
      this.addTri(V[0], V[1], V[2], U[0], U[1], U[2], color, ref);
    }
    return this;
  }

  /** Extruded walls around a footprint, from yBase up to yTop. */
  addPrismWalls(poly, yBase, yTop, uScale = 4, vScale = 3.2, color = null) {
    const c = polygonCentroid(poly);
    let u = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1e-5) continue;
      const u1 = u + len / uScale;
      const vTop = (yTop - yBase) / vScale;
      const mx = (p[0] + q[0]) * 0.5 - c[0];
      const mz = (p[1] + q[1]) * 0.5 - c[1];
      this.addQuad(
        [p[0], yBase, p[1]], [q[0], yBase, q[1]], [q[0], yTop, q[1]], [p[0], yTop, p[1]],
        [[u, 0], [u1, 0], [u1, vTop], [u, vTop]], color, [mx, 0, mz],
      );
      u = u1;
    }
    return this;
  }

  addBox(cx, cy, cz, sx, sy, sz, color = null, uvScale = 1, yaw = 0) {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const P = (x, y, z) => [cx + x * cs - z * sn, cy + y, cz + x * sn + z * cs];
    const v = [
      P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz),
      P(-hx, hy, -hz), P(hx, hy, -hz), P(hx, hy, hz), P(-hx, hy, hz),
    ];
    const uv = [[0, 0], [sx / uvScale, 0], [sx / uvScale, sy / uvScale], [0, sy / uvScale]];
    const uvTop = [[0, 0], [sx / uvScale, 0], [sx / uvScale, sz / uvScale], [0, sz / uvScale]];
    const o = (x, y, z) => [x * cs - z * sn, y, x * sn + z * cs];
    this.addQuad(v[4], v[5], v[6], v[7], uvTop, color, o(0, 1, 0));    // top
    this.addQuad(v[0], v[1], v[2], v[3], uvTop, color, o(0, -1, 0));   // bottom
    this.addQuad(v[0], v[1], v[5], v[4], uv, color, o(0, 0, -1));
    this.addQuad(v[3], v[2], v[6], v[7], uv, color, o(0, 0, 1));
    this.addQuad(v[1], v[2], v[6], v[5], uv, color, o(1, 0, 0));
    this.addQuad(v[0], v[3], v[7], v[4], uv, color, o(-1, 0, 0));
    return this;
  }

  /** Four-sided pyramid cap (steeple spires, hip roofs). */
  addPyramid(cx, baseY, cz, halfX, halfZ, apexY, color = null) {
    const apex = [cx, apexY, cz];
    const c = [
      [cx - halfX, baseY, cz - halfZ], [cx + halfX, baseY, cz - halfZ],
      [cx + halfX, baseY, cz + halfZ], [cx - halfX, baseY, cz + halfZ],
    ];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      const mx = (a[0] + b[0]) * 0.5 - cx, mz = (a[2] + b[2]) * 0.5 - cz;
      this.addTri(a, b, apex, [0, 0], [1, 0], [0.5, 1], color, [mx, 0.35, mz]);
    }
    return this;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.useColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Road surface: centreline -> a level ribbon of `width` metres.
 * `heights` is the per-point (already smoothed) centreline height.
 * Returns {left, right} 3D polylines ready for MeshBuilder.addRibbon.
 */
export function roadRibbonPolylines(pts, heights, width, lift = 0) {
  const L = offsetPolyline(pts, -width * 0.5);
  const R = offsetPolyline(pts, width * 0.5);
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const y = heights[i] + lift;
    left.push([L[i][0], y, L[i][1]]);
    right.push([R[i][0], y, R[i][1]]);
  }
  return { left, right };
}

/** Sidewalk + curb ribbons on one side of a road. side = -1 (left) or +1 (right). */
export function sidewalkPolylines(pts, heights, width, side, walkWidth, curb, lift = 0) {
  const inner = offsetPolyline(pts, side * (width * 0.5));
  const outer = offsetPolyline(pts, side * (width * 0.5 + walkWidth));
  const walkL = [], walkR = [], curbL = [], curbR = [];
  for (let i = 0; i < pts.length; i++) {
    const yRoad = heights[i] + lift;
    const yWalk = yRoad + curb;
    walkL.push([inner[i][0], yWalk, inner[i][1]]);
    walkR.push([outer[i][0], yWalk, outer[i][1]]);
    curbL.push([inner[i][0], yRoad - 0.02, inner[i][1]]);
    curbR.push([inner[i][0], yWalk, inner[i][1]]);
  }
  return { walkL, walkR, curbL, curbR };
}

/* ================================================================== *
 * 5. canvas textures (DOM-guarded — null in Node, materials fall back to colour)
 * ================================================================== */

export function hasDOM() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function makeCanvas(w, h) {
  if (!hasDOM()) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function canvasTexture(w, h, draw, repeat = 1, anisotropy = 4) {
  const c = makeCanvas(w, h);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = anisotropy;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noiseFill(g, w, h, base, amount, seed = 1) {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const rng = makeRng(seed);
  for (let i = 0; i < (w * h) / 6; i++) {
    const x = Math.floor(rng() * w), y = Math.floor(rng() * h);
    const a = (rng() - 0.5) * amount;
    g.fillStyle = a > 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${-a})`;
    g.fillRect(x, y, 1 + (rng() < 0.15 ? 1 : 0), 1);
  }
}

function windowRow(g, x, y, w, h, cols, lit, rng, glass = '#2c3c4a') {
  const pad = w * 0.14;
  const cw = (w - pad * (cols + 1)) / cols;
  for (let i = 0; i < cols; i++) {
    const wx = x + pad + i * (cw + pad);
    g.fillStyle = lit && rng() < 0.35 ? '#ffe6a8' : glass;
    g.fillRect(wx, y, cw, h);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(wx, y, cw, h * 0.18);
  }
}

/** One canvas facade per building kind. All 256², tiled 4 m × 3.2 m in world space. */
export const FACADE_PAINTERS = {
  brick(g, w, h) {                                    // downtown commercial
    noiseFill(g, w, h, '#8f4536', 0.10, 11);
    const rowH = h / 22;
    g.strokeStyle = 'rgba(230,220,210,0.35)';
    g.lineWidth = 1;
    for (let r = 0; r < 22; r++) {
      const y = r * rowH;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      const off = (r % 2) * (w / 16);
      for (let c = 0; c <= 8; c++) {
        const x = off + c * (w / 8);
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + rowH); g.stroke();
      }
    }
    const rng = makeRng(5);
    windowRow(g, 0, h * 0.18, w, h * 0.30, 2, true, rng, '#22303c');
    windowRow(g, 0, h * 0.62, w, h * 0.26, 2, true, rng, '#22303c');
    g.fillStyle = 'rgba(60,40,32,0.55)';
    g.fillRect(0, h * 0.05, w, h * 0.05);           // cornice band
  },
  siding(g, w, h) {                                   // houses
    noiseFill(g, w, h, '#d8d2c2', 0.07, 23);
    g.strokeStyle = 'rgba(120,115,100,0.35)';
    for (let y = 0; y < h; y += h / 26) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
    const rng = makeRng(31);
    windowRow(g, w * 0.08, h * 0.22, w * 0.84, h * 0.30, 2, true, rng, '#38424c');
    g.fillStyle = '#6d513a';
    g.fillRect(w * 0.40, h * 0.62, w * 0.20, h * 0.38);  // door
    g.fillStyle = '#c9b48f';
    g.fillRect(w * 0.40, h * 0.62, w * 0.20, h * 0.03);
  },
  stripRetail(g, w, h) {                              // US-62 strip stores
    noiseFill(g, w, h, '#cfc6b2', 0.06, 41);
    g.fillStyle = '#2f5d8a';
    g.fillRect(0, 0, w, h * 0.16);                   // sign band
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(w * 0.12, h * 0.055, w * 0.5, h * 0.05);
    const rng = makeRng(53);
    windowRow(g, 0, h * 0.42, w, h * 0.44, 3, false, rng, '#3d5566');
    g.fillStyle = 'rgba(90,80,70,0.4)';
    g.fillRect(0, h * 0.36, w, h * 0.04);
  },
  campusStone(g, w, h) {                              // ASUMH — pale stone + glass
    noiseFill(g, w, h, '#ded5c2', 0.08, 67);
    g.strokeStyle = 'rgba(150,140,120,0.30)';
    for (let r = 0; r < 10; r++) {
      const y = (r * h) / 10;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
    const rng = makeRng(71);
    windowRow(g, 0, h * 0.14, w, h * 0.32, 3, false, rng, '#4a6b7a');
    windowRow(g, 0, h * 0.56, w, h * 0.32, 3, false, rng, '#4a6b7a');
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.fillRect(0, h * 0.50, w, h * 0.03);
  },
  hospital(g, w, h) {                                 // white block with a blue band
    noiseFill(g, w, h, '#f1f3f5', 0.05, 83);
    g.fillStyle = '#2d6ea8';
    g.fillRect(0, h * 0.44, w, h * 0.12);
    const rng = makeRng(89);
    windowRow(g, 0, h * 0.10, w, h * 0.26, 4, true, rng, '#5b7f96');
    windowRow(g, 0, h * 0.64, w, h * 0.26, 4, true, rng, '#5b7f96');
  },
  church(g, w, h) {                                   // white boards + arched glass
    noiseFill(g, w, h, '#f4f1e8', 0.05, 97);
    g.strokeStyle = 'rgba(150,145,130,0.30)';
    for (let y = 0; y < h; y += h / 20) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    for (let i = 0; i < 2; i++) {
      const x = w * (0.22 + i * 0.38), y = h * 0.30, ww = w * 0.18, hh = h * 0.42;
      g.fillStyle = '#3f5f7a';
      g.beginPath();
      g.moveTo(x, y + hh); g.lineTo(x, y + ww * 0.5);
      g.arc(x + ww * 0.5, y + ww * 0.5, ww * 0.5, Math.PI, 0);
      g.lineTo(x + ww, y + hh); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,220,150,0.25)';
      g.fillRect(x, y + hh * 0.5, ww, hh * 0.1);
    }
  },
  civic(g, w, h) {                                    // courthouse / civic stone
    noiseFill(g, w, h, '#c9c2b0', 0.08, 103);
    g.strokeStyle = 'rgba(120,112,96,0.35)';
    for (let r = 0; r < 14; r++) {
      const y = (r * h) / 14;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
    const rng = makeRng(107);
    windowRow(g, 0, h * 0.20, w, h * 0.28, 3, true, rng, '#3a4750');
    windowRow(g, 0, h * 0.60, w, h * 0.24, 3, true, rng, '#3a4750');
  },
  metal(g, w, h) {                                    // industrial ribbed panel
    noiseFill(g, w, h, '#8d9095', 0.07, 109);
    g.strokeStyle = 'rgba(60,64,70,0.4)';
    for (let x = 0; x < w; x += w / 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    g.fillStyle = 'rgba(40,44,50,0.35)';
    g.fillRect(0, h * 0.86, w, h * 0.06);
  },
};

export function makeCityTextures() {
  const tex = {};
  tex.asphalt = canvasTexture(256, 256, (g, w, h) => {
    noiseFill(g, w, h, '#3b3d40', 0.16, 3);
    const rng = makeRng(9);
    for (let i = 0; i < 140; i++) {
      g.fillStyle = `rgba(${20 + rng() * 40 | 0},${20 + rng() * 40 | 0},${22 + rng() * 40 | 0},0.5)`;
      g.fillRect(rng() * w, rng() * h, 2 + rng() * 3, 1 + rng() * 2);
    }
  }, 1);
  tex.dash = canvasTexture(16, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#e8d98a';
    g.fillRect(0, h * 0.12, w, h * 0.55);           // one dash per tile
  }, 1);
  if (tex.dash) { tex.dash.wrapS = THREE.ClampToEdgeWrapping; tex.dash.wrapT = THREE.RepeatWrapping; }
  tex.concrete = canvasTexture(256, 256, (g, w, h) => {
    noiseFill(g, w, h, '#b4b2ab', 0.10, 13);
    g.strokeStyle = 'rgba(90,90,86,0.45)';
    for (let y = 0; y < h; y += h / 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  }, 1);
  tex.grass = canvasTexture(256, 256, (g, w, h) => {
    noiseFill(g, w, h, '#4f6b39', 0.22, 17);
    const rng = makeRng(19);
    for (let i = 0; i < 900; i++) {
      g.strokeStyle = `rgba(${70 + rng() * 50 | 0},${100 + rng() * 60 | 0},${50 + rng() * 40 | 0},0.6)`;
      const x = rng() * w, y = rng() * h;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + rng() * 2 - 1, y - 2 - rng() * 3); g.stroke();
    }
  }, 1);
  tex.lawn = canvasTexture(128, 128, (g, w, h) => {
    noiseFill(g, w, h, '#56763c', 0.14, 29);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let y = 0; y < h; y += 16) g.fillRect(0, y, w, 8);   // mown stripes
  }, 1);
  tex.roof = canvasTexture(128, 128, (g, w, h) => {
    noiseFill(g, w, h, '#5a4a3e', 0.14, 37);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < h; y += h / 10) {
      for (let x = (y / (h / 10)) % 2 * 8; x < w; x += 16) g.fillRect(x, y, 13, 2);
    }
  }, 1);
  tex.gravelRoof = canvasTexture(128, 128, (g, w, h) => {
    noiseFill(g, w, h, '#6f6d66', 0.22, 43);
  }, 1);
  tex.water = canvasTexture(256, 256, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#2b5a72'); grd.addColorStop(0.5, '#3b7d94'); grd.addColorStop(1, '#2b5a72');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    for (let i = 0; i < 70; i++) {
      const y = (i / 70) * h;
      g.beginPath();
      for (let x = 0; x <= w; x += 8) g.lineTo(x, y + Math.sin((x / w) * Math.PI * 4 + i) * 3);
      g.stroke();
    }
  }, 1);
  tex.waterNormal = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#8080ff'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const y = (i / 90) * h;
      g.strokeStyle = `rgba(${120 + (i % 7) * 6},${130 + (i % 5) * 8},255,0.55)`;
      g.beginPath();
      for (let x = 0; x <= w; x += 6) g.lineTo(x, y + Math.sin((x / w) * Math.PI * 6 + i * 0.7) * 4);
      g.stroke();
    }
  }, 1);
  if (tex.waterNormal) tex.waterNormal.colorSpace = THREE.NoColorSpace;
  for (const [k, painter] of Object.entries(FACADE_PAINTERS)) {
    tex[k] = canvasTexture(256, 256, painter, 1);
  }
  return tex;
}

/* ================================================================== *
 * 6. small geometry utilities
 * ================================================================== */

const _m3 = new THREE.Matrix3();
const _v3 = new THREE.Vector3();

/** Copies a BufferGeometry (transformed by `matrix`) into a MeshBuilder. */
export function appendGeometry(mb, geom, matrix = null, color = null) {
  const pos = geom.getAttribute('position');
  const nor = geom.getAttribute('normal');
  const uv = geom.getAttribute('uv');
  const index = geom.getIndex();
  const base = mb.vertexCount;
  if (matrix) _m3.setFromMatrix4(matrix).invert().transpose();
  for (let i = 0; i < pos.count; i++) {
    _v3.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (matrix) _v3.applyMatrix4(matrix);
    mb.pos.push(_v3.x, _v3.y, _v3.z);
    if (nor) {
      _v3.set(nor.getX(i), nor.getY(i), nor.getZ(i));
      if (matrix) _v3.applyMatrix3(_m3).normalize();
      mb.nor.push(_v3.x, _v3.y, _v3.z);
    } else mb.nor.push(0, 1, 0);
    mb.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    if (mb.useColor) mb.col.push(color ? color[0] : 1, color ? color[1] : 1, color ? color[2] : 1);
  }
  if (index) for (let i = 0; i < index.count; i++) mb.idx.push(base + index.getX(i));
  else for (let i = 0; i < pos.count; i++) mb.idx.push(base + i);
  return mb;
}

/** Gable roof over a footprint's bounding rectangle (houses, church nave). */
export function addGableRoof(mb, bounds, eaveY, color = null, opts = {}) {
  const overhang = opts.overhang ?? 0.45;
  const minX = bounds.minX - overhang, maxX = bounds.maxX + overhang;
  const minZ = bounds.minZ - overhang, maxZ = bounds.maxZ + overhang;
  const spanX = maxX - minX, spanZ = maxZ - minZ;
  const rise = clamp(Math.min(spanX, spanZ) * 0.33, 1.1, opts.maxRise ?? 3.4);
  const ridgeY = eaveY + rise;
  if (spanX >= spanZ) {                     // ridge runs east-west
    const zc = (minZ + maxZ) * 0.5;
    const r0 = [minX, ridgeY, zc], r1 = [maxX, ridgeY, zc];
    mb.addQuad([minX, eaveY, minZ], [maxX, eaveY, minZ], r1, r0, null, color, [0, 1, -0.6]);
    mb.addQuad([minX, eaveY, maxZ], [maxX, eaveY, maxZ], r1, r0, null, color, [0, 1, 0.6]);
    mb.addTri([minX, eaveY, minZ], [minX, eaveY, maxZ], r0, [0, 0], [1, 0], [0.5, 1], color, [-1, 0, 0]);
    mb.addTri([maxX, eaveY, minZ], [maxX, eaveY, maxZ], r1, [0, 0], [1, 0], [0.5, 1], color, [1, 0, 0]);
  } else {                                  // ridge runs north-south
    const xc = (minX + maxX) * 0.5;
    const r0 = [xc, ridgeY, minZ], r1 = [xc, ridgeY, maxZ];
    mb.addQuad([minX, eaveY, minZ], [minX, eaveY, maxZ], r1, r0, null, color, [-0.6, 1, 0]);
    mb.addQuad([maxX, eaveY, minZ], [maxX, eaveY, maxZ], r1, r0, null, color, [0.6, 1, 0]);
    mb.addTri([minX, eaveY, minZ], [maxX, eaveY, minZ], r0, [0, 0], [1, 0], [0.5, 1], color, [0, 0, -1]);
    mb.addTri([minX, eaveY, maxZ], [maxX, eaveY, maxZ], r1, [0, 0], [1, 0], [0.5, 1], color, [0, 0, 1]);
  }
  return ridgeY;
}

/** White steeple with a spire and a cross, dropped on a church footprint. */
export function addSteeple(mb, cx, cz, baseY, towerH = 7, color = null) {
  const half = 1.5;
  mb.addBox(cx, baseY + towerH * 0.5, cz, half * 2, towerH, half * 2, color, 3.2);
  const topY = baseY + towerH;
  mb.addPyramid(cx, topY, cz, half * 1.15, half * 1.15, topY + 4.2, color);
  mb.addBox(cx, topY + 5.3, cz, 0.16, 1.6, 0.16, color, 1);
  mb.addBox(cx, topY + 5.7, cz, 0.9, 0.16, 0.16, color, 1);
  return topY + 6.1;
}
