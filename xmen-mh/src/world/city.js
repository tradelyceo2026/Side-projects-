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
  lampSpacing: 55,             // metres between street lamps on primary roads
  maxLamps: 1400,
  maxCars: 700,
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

/**
 * Resample a polyline at (roughly) fixed spacing. Every original vertex is kept, so
 * corners are never cut and the total length is preserved exactly.
 */
export function resamplePolyline(pts, step = 12) {
  const clean = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-4) clean.push([p[0], p[1]]);
  }
  if (clean.length < 2) return clean;
  const out = [[clean[0][0], clean[0][1]]];
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1], b = clean[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    }
  }
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

/* ================================================================== *
 * 7. road classes
 * ================================================================== */

export const ROAD_CLASS = {
  primary:     { lift: 0.16, width: 14, sidewalk: true,  dash: true,  lamps: true,  parking: false },
  secondary:   { lift: 0.14, width: 11, sidewalk: true,  dash: true,  lamps: false, parking: true },
  tertiary:    { lift: 0.12, width: 9,  sidewalk: false, dash: true,  lamps: false, parking: true },
  residential: { lift: 0.10, width: 7,  sidewalk: false, dash: false, lamps: false, parking: true },
  service:     { lift: 0.08, width: 5,  sidewalk: false, dash: false, lamps: false, parking: false },
};
export const roadClass = (c) => ROAD_CLASS[c] || ROAD_CLASS.residential;

/** Which facade material a building uses, given its kind and district. */
export function facadeKeyFor(kind, district) {
  switch (kind) {
    case 'house': return 'siding';
    case 'campus': return 'campusStone';
    case 'hospital': return 'hospital';
    case 'church': return 'church';
    case 'civic': return 'civic';
    case 'industrial': return 'metal';
    case 'commercial':
    default:
      if (district === DISTRICT.DOWNTOWN) return 'brick';
      if (district === DISTRICT.CAMPUS) return 'campusStone';
      return district === DISTRICT.STRIP ? 'stripRetail' : 'brick';
  }
}

/* ================================================================== *
 * 8. City
 * ================================================================== */

export class City {
  constructor(scene, cityJson, opts = {}) {
    this.scene = scene;
    this.json = cityJson || {};
    this.opts = Object.assign({}, CITY_DEFAULTS, opts);
    this.quality = this.opts.quality || 'high';

    const bb = this.json.bbox || { minX: -2500, maxX: 2500, minZ: -2500, maxZ: 2500 };
    this.bounds = { minX: bb.minX, maxX: bb.maxX, minZ: bb.minZ, maxZ: bb.maxZ };

    this.group = new THREE.Group();
    this.group.name = 'city';

    this.terrain = createTerrainSampler({
      seed: this.opts.seed,
      amplitude: this.opts.terrainAmplitude,
      scale: this.opts.terrainScale,
    });
    this.field = new FlattenField(this.terrain, 48);

    this.buildingGrid = new AabbGrid(this.opts.colliderCell);
    this.roadGrid = new AabbGrid(this.opts.colliderCell);
    this.buildings = [];
    this.roads = [];
    this.waterBodies = [];
    this.pois = new Map();
    this.missingPois = [];

    this.textures = {};
    this.materials = {};
    this.meshes = [];
    this.treeChunks = [];
    this._waterAnim = [];
    this._coarseRoad = [];
    this._rng = makeRng(this.opts.seed ^ 0x5f3a);

    // reusable scratch so per-frame queries allocate nothing
    this._q1 = []; this._q2 = []; this._q3 = [];
    this._vTmp = new THREE.Vector3();
    this._mTmp = new THREE.Matrix4();
    this._qTmp = new THREE.Quaternion();
    this._sTmp = new THREE.Vector3(1, 1, 1);
    this._cTmp = new THREE.Color();

    this._stripRoads = [];
    this.built = false;
    this.stats = { draws: 0, triangles: 0, trees: 0, lamps: 0, cars: 0, buildings: 0 };
  }

  /* ---------------- public API (see docs/SPEC.md) ---------------- */

  build() {
    if (this.built) return this;
    this.textures = makeCityTextures();
    this._makeMaterials();
    this._prepareRoads();
    this._prepareWater();
    this._prepareBuildings();
    this._preparePois();

    this._buildTerrain();
    this._buildRoads();
    this._buildGreen();
    this._buildWater();
    this._buildBuildings();
    this._buildCampus();
    this._buildTrees();
    this._buildLamps();
    this._buildCars();

    this.scene.add(this.group);
    this.built = true;
    return this;
  }

  getGroundHeight(x, z) {
    return this.field.height(x, z, this._q1);
  }

  raycastDown(x, y, z) {
    let best = this.getGroundHeight(x, z);
    const hits = this.buildingGrid.queryPoint(x, z, this._q2);
    for (let i = 0; i < hits.length; i++) {
      const b = hits[i];
      if (b.top > y + 0.75) continue;              // roof is above the probe
      if (b.top <= best) continue;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (b.poly && !pointInPolygon(x, z, b.poly)) continue;
      best = b.top;
    }
    return best;
  }

  collideCapsule(pos, radius, height, out) {
    const r = radius + 0.05;
    const boxes = this.buildingGrid.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r, this._q3);
    if (boxes.length === 0) {
      if (out) { if (out.set) out.set(pos.x, pos.y, pos.z); else { out.x = pos.x; out.y = pos.y; out.z = pos.z; } }
      return false;
    }
    return resolveCapsuleBoxes(pos, radius, height, boxes, out);
  }

  nearestRoadPoint(x, z) {
    let best = null, bestD = Infinity;
    for (const radius of [24, 80, 240, 700]) {
      const near = this.roadGrid.queryRadius(x, z, radius, this._q2);
      for (let i = 0; i < near.length; i++) {
        const s = near[i];
        const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best) break;
    }
    if (!best) {
      for (let i = 0; i < this._coarseRoad.length; i++) {
        const s = this._coarseRoad[i];
        const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    if (!best) return { x, z, roadId: -1 };
    return { x: best.x, z: best.z, roadId: best.roadId };
  }

  poi(id) { return this.pois.get(id) || null; }

  /** LOD + water shimmer. Allocation-free. */
  update(dt, playerPos) {
    for (let i = 0; i < this._waterAnim.length; i++) {
      const m = this._waterAnim[i];
      if (m.map) { m.map.offset.x += dt * 0.0045; m.map.offset.y += dt * 0.0032; }
      if (m.normalMap) { m.normalMap.offset.x -= dt * 0.0075; m.normalMap.offset.y += dt * 0.0061; }
    }
    if (!playerPos || this.treeChunks.length === 0) return;
    const cull = this.opts.treeCullDistance;
    const cull2 = cull * cull;
    for (let i = 0; i < this.treeChunks.length; i++) {
      const c = this.treeChunks[i];
      const dx = c.cx - playerPos.x, dz = c.cz - playerPos.z;
      const visible = dx * dx + dz * dz < cull2;
      if (c.mesh.visible !== visible) c.mesh.visible = visible;
    }
  }

  districtAt(x, z) {
    const campus = this.pois.get('asumh');
    if (campus) {
      const r = (campus.radius || 200) * 1.15;
      if ((x - campus.x) ** 2 + (z - campus.z) ** 2 < r * r) return DISTRICT.CAMPUS;
    }
    if (x * x + z * z < this.opts.downtownRadius ** 2) return DISTRICT.DOWNTOWN;
    for (let i = 0; i < this._stripRoads.length; i++) {
      const r = this._stripRoads[i];
      for (let j = 0; j < r.samples.length; j += 3) {
        const s = r.samples[j];
        if ((s.x - x) ** 2 + (s.z - z) ** 2 < 140 * 140) return DISTRICT.STRIP;
      }
    }
    return DISTRICT.RESIDENTIAL;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    for (const t of Object.values(this.textures)) if (t && t.dispose) t.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
    this.built = false;
  }

  /* ---------------- materials ---------------- */

  _makeMaterials() {
    const T = this.textures;
    const std = (color, map, extra) => new THREE.MeshStandardMaterial(Object.assign({
      color, map: map || null, roughness: 0.92, metalness: 0.0,
    }, extra || {}));
    const offset = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 };

    this.materials = {
      terrain: std(0xffffff, T.grass, { vertexColors: true, roughness: 1.0 }),
      asphalt: std(T.asphalt ? 0xffffff : 0x44464a, T.asphalt, offset),
      dash: new THREE.MeshBasicMaterial({
        color: 0xe8d98a, map: T.dash || null, transparent: true, alphaTest: 0.35,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
      }),
      concrete: std(T.concrete ? 0xffffff : 0xb0aea7, T.concrete, Object.assign({ side: THREE.DoubleSide }, offset)),
      lawn: std(T.lawn ? 0xffffff : 0x56763c, T.lawn, offset),
      water: std(T.water ? 0xffffff : 0x33718c, T.water, {
        normalMap: T.waterNormal || null, transparent: true, opacity: 0.88,
        roughness: 0.15, metalness: 0.15, side: THREE.DoubleSide,
      }),
      roofShingle: std(T.roof ? 0xffffff : 0x5a4a3e, T.roof),
      roofFlat: std(T.gravelRoof ? 0xffffff : 0x6f6d66, T.gravelRoof),
      trim: std(0xf3efe6, null, { vertexColors: true, roughness: 0.8 }),
      tree: std(0xffffff, null, { vertexColors: true, roughness: 0.95 }),
      lamp: std(0xffffff, null, { vertexColors: true, roughness: 0.55, metalness: 0.3 }),
      lampGlass: new THREE.MeshStandardMaterial({ color: 0xffe9b8, emissive: 0xffd88a, emissiveIntensity: 1.1, roughness: 0.3 }),
      car: std(0xffffff, null, { vertexColors: true, roughness: 0.45, metalness: 0.25 }),
      sign: std(0xffffff, null, { vertexColors: true, roughness: 0.5, metalness: 0.1, emissive: 0x102040, emissiveIntensity: 0.35 }),
    };
    for (const key of Object.keys(FACADE_PAINTERS)) {
      this.materials[key] = std(this.textures[key] ? 0xffffff : 0xb9b3a6, this.textures[key], { roughness: 0.95 });
    }
    if (this.materials.water.normalMap) this.materials.water.normalScale = new THREE.Vector2(0.35, 0.35);
    this._waterAnim.push(this.materials.water);
  }

  _addMesh(builder, material, name, renderOrder = 0) {
    if (!builder || builder.isEmpty) return null;
    const geom = builder.toGeometry();
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = name;
    mesh.renderOrder = renderOrder;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.stats.draws++;
    this.stats.triangles += builder.triangleCount;
    return mesh;
  }

  /* ---------------- preparation passes ---------------- */

  _prepareRoads() {
    const step = this.opts.roadSampleStep;
    const roads = Array.isArray(this.json.roads) ? this.json.roads : [];
    this._stripRoads = [];
    for (const raw of roads) {
      const pts0 = (raw.pts || raw.points || []).filter((p) => Array.isArray(p) && p.length >= 2);
      if (pts0.length < 2) continue;
      const spec = roadClass(raw.class);
      const simplified = douglasPeucker(pts0, 1.0);
      const pts = resamplePolyline(simplified, step);
      if (pts.length < 2) continue;
      const base = pts.map((p) => this.terrain(p[0], p[1]));
      const smooth = smoothSeries(base, this.opts.roadSmoothWindow);
      const width = raw.width > 0 ? raw.width : spec.width;
      const y = smooth.map((h) => h + spec.lift);
      const samples = [];
      for (let i = 0; i < pts.length; i++) {
        const s = { x: pts[i][0], z: pts[i][1], y: y[i], roadId: raw.id ?? -1, width, cls: raw.class || 'residential' };
        samples.push(s);
        const half = width * 0.5 + 1.5;
        this.roadGrid.insert(s, s.x - half, s.z - half, s.x + half, s.z + half);
        if (i % 5 === 0) this._coarseRoad.push(s);
        this.field.addPad(s.x, s.z, s.y, width * 0.5 + 9);
      }
      const road = { id: raw.id ?? -1, name: raw.name || '', cls: raw.class || 'residential', spec, width, pts, y, samples };
      this.roads.push(road);
      const nm = (raw.name || '').toLowerCase();
      if (road.cls === 'primary' || nm.includes('62') || nm.includes('412')) this._stripRoads.push(road);
    }
  }

  _prepareWater() {
    const water = Array.isArray(this.json.water) ? this.json.water : [];
    for (const w of water) {
      const poly = (w.poly || []).filter((p) => Array.isArray(p) && p.length >= 2);
      if (poly.length < 3) continue;
      let minH = Infinity;
      for (const p of poly) minH = Math.min(minH, this.terrain(p[0], p[1]));
      const bed = minH - 2.2;
      const surface = bed + 1.9;
      const b = polygonBounds(poly);
      const stepX = Math.max(30, (b.maxX - b.minX) / 12);
      const stepZ = Math.max(30, (b.maxZ - b.minZ) / 12);
      for (let x = b.minX; x <= b.maxX + stepX; x += stepX) {
        for (let z = b.minZ; z <= b.maxZ + stepZ; z += stepZ) {
          if (pointInPolygon(x, z, poly)) this.field.addPad(x, z, bed, Math.max(stepX, stepZ) * 0.9);
        }
      }
      this.waterBodies.push({ name: w.name || '', poly, bounds: b, surface, bed });
    }
  }

  _prepareBuildings() {
    const list = Array.isArray(this.json.buildings) ? this.json.buildings : [];
    for (const raw of list) {
      let poly = (raw.poly || []).filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [p[0], p[1]]);
      if (poly.length > 3) {
        const first = poly[0], last = poly[poly.length - 1];
        if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) poly.pop();
      }
      if (poly.length < 3) continue;
      if (Math.abs(polygonArea(poly)) < 6) continue;
      const bounds = polygonBounds(poly);
      const centroid = polygonCentroid(poly);
      const padY = this.field.height(centroid[0], centroid[1], this._q1);
      const kind = raw.kind || 'house';
      const h = Math.max(2.6, raw.height || (kind === 'house' ? 5.5 : 8));
      const rec = {
        id: raw.id ?? this.buildings.length,
        name: raw.name || '',
        kind,
        poly,
        bounds,
        centroid,
        height: h,
        base: padY - 0.45,
        top: padY + h,
        padY,
        minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ,
        area: Math.abs(polygonArea(poly)),
      };
      rec.district = this.districtAt(centroid[0], centroid[1]);
      // OSM tags nearly every block on the square as a bare `building=yes`, which arrives
      // here as 'house'. On the courthouse square they are storefronts: brick, flat roof,
      // two storeys — otherwise downtown renders as a cul-de-sac of vinyl-sided cottages.
      if (rec.kind === 'house' && rec.district === DISTRICT.DOWNTOWN) {
        rec.kind = 'commercial';
        rec.height = Math.max(rec.height, 7.5);
        rec.top = rec.padY + rec.height;
      }
      rec.facade = facadeKeyFor(rec.kind, rec.district);
      this.buildings.push(rec);
      this.buildingGrid.insert(rec, rec.minX, rec.minZ, rec.maxX, rec.maxZ);
      let radius = 0;
      for (const p of poly) radius = Math.max(radius, Math.hypot(p[0] - centroid[0], p[1] - centroid[1]));
      this.field.addPad(centroid[0], centroid[1], padY, radius + 5);
    }
    this.stats.buildings = this.buildings.length;
  }

  _preparePois() {
    for (const p of (this.json.pois || [])) {
      if (!p || !p.id) continue;
      this.pois.set(p.id, { id: p.id, name: p.name || p.id, x: p.x || 0, z: p.z || 0, radius: p.radius || 60, kind: p.kind || '' });
    }
    // never let a missing POI crash a consumer — synthesise a downtown fallback
    for (const id of REQUIRED_POIS) {
      if (this.pois.has(id)) continue;
      this.missingPois.push(id);
      this.pois.set(id, { id, name: id, x: 0, z: 0, radius: 60, kind: 'fallback', synthetic: true });
    }
  }

  /* ---------------- terrain ---------------- */

  _buildTerrain() {
    const segs = this.opts.terrainSegments[this.quality] || 128;
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const n = segs + 1;
    const dx = (maxX - minX) / segs, dz = (maxZ - minZ) / segs;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const col = new Float32Array(n * n * 3);
    const tint = makeValueNoise2D(this.opts.seed + 555);
    const scratch = [];
    let k = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = minX + i * dx, z = minZ + j * dz;
        const y = this.field.height(x, z, scratch);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = x / 18; uv[k * 2 + 1] = z / 18;
        const t = tint(x / 260, z / 260);
        const dry = smoothstep(2, 9, y) * 0.45;
        col[k * 3] = lerp(0.74, 1.06, t) + dry * 0.35;
        col[k * 3 + 1] = lerp(0.92, 1.08, t) + dry * 0.12;
        col[k * 3 + 2] = lerp(0.70, 0.92, t) + dry * 0.05;
        k++;
      }
    }
    const idx = new Uint32Array(segs * segs * 6);
    let m = 0;
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[m++] = a; idx[m++] = c; idx[m++] = b;
        idx[m++] = b; idx[m++] = c; idx[m++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.materials.terrain);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.terrainMesh = mesh;
    this.stats.draws++;
    this.stats.triangles += segs * segs * 2;
  }

  /* ---------------- roads, sidewalks, plaza ---------------- */

  _buildRoads() {
    const asphalt = new MeshBuilder();
    const dash = new MeshBuilder();
    const concrete = new MeshBuilder();
    const SW = this.opts.sidewalkWidth, CURB = this.opts.curbHeight;

    for (const road of this.roads) {
      const { pts, y, width, spec } = road;
      const rib = roadRibbonPolylines(pts, y, width, 0);
      asphalt.addRibbon(rib.left, rib.right, 8, null, true);

      if (spec.dash && width >= 7) {
        const cl = pts.map((p, i) => [p[0], y[i] + 0.03, p[1]]);
        const l = offsetPolyline(pts, -0.18), r = offsetPolyline(pts, 0.18);
        const dl = cl.map((p, i) => [l[i][0], p[1], l[i][1]]);
        const dr = cl.map((p, i) => [r[i][0], p[1], r[i][1]]);
        dash.addRibbon(dl, dr, 6, null, true);
      }
      if (spec.sidewalk) {
        for (const side of [-1, 1]) {
          const s = sidewalkPolylines(pts, y, width, side, SW, CURB, 0);
          concrete.addRibbon(s.walkL, s.walkR, 6, null, true);
          concrete.addRibbon(s.curbL, s.curbR, 6, null, false);
        }
      }
    }

    // courthouse square: a paved plaza around the origin
    const plaza = [];
    const R = 46;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      plaza.push([Math.cos(a) * R, Math.sin(a) * R]);
    }
    concrete.addPolygonCap(plaza, 0, true, 6, null, (x, z) => this.getGroundHeight(x, z) + 0.09);

    this._addMesh(asphalt, this.materials.asphalt, 'roads');
    this._addMesh(concrete, this.materials.concrete, 'sidewalks');
    this._addMesh(dash, this.materials.dash, 'road-markings', 1);
  }

  /* ---------------- lawns / parks ---------------- */

  _buildGreen() {
    const lawn = new MeshBuilder();
    this.greens = [];
    for (const g of (this.json.green || [])) {
      const poly = (g.poly || []).filter((p) => Array.isArray(p) && p.length >= 2);
      if (poly.length < 3) continue;
      const rec = { kind: g.kind || 'grass', name: g.name || '', poly, bounds: polygonBounds(poly), area: Math.abs(polygonArea(poly)) };
      this.greens.push(rec);
      if (rec.kind === 'forest') continue;                     // forests are just trees on terrain
      lawn.addPolygonCap(poly, 0, true, 10, null, (x, z) => this.getGroundHeight(x, z) + 0.06);
    }
    this._addMesh(lawn, this.materials.lawn, 'lawns');
  }

  /* ---------------- water ---------------- */

  _buildWater() {
    if (this.waterBodies.length === 0) return;
    const mb = new MeshBuilder();
    for (const w of this.waterBodies) mb.addPolygonCap(w.poly, w.surface, true, 26);
    const mesh = this._addMesh(mb, this.materials.water, 'water', 2);
    if (mesh) mesh.receiveShadow = false;
  }

  /* ---------------- buildings ---------------- */

  _buildBuildings() {
    const byFacade = new Map();
    const roofFlat = new MeshBuilder();
    const roofShingle = new MeshBuilder();
    const trim = new MeshBuilder(true);
    const WHITE = [1, 1, 1];

    for (const b of this.buildings) {
      let mb = byFacade.get(b.facade);
      if (!mb) { mb = new MeshBuilder(); byFacade.set(b.facade, mb); }

      if (b.kind === 'house') {
        mb.addPrismWalls(b.poly, b.base, b.top, 4, 3.0);
        addGableRoof(roofShingle, b.bounds, b.top, null, { maxRise: 2.9 });
      } else if (b.kind === 'church') {
        mb.addPrismWalls(b.poly, b.base, b.top, 4, 3.4);
        addGableRoof(roofShingle, b.bounds, b.top, null, { maxRise: 4.2 });
        const towerX = b.bounds.minX + Math.min(3.2, (b.bounds.maxX - b.bounds.minX) * 0.3);
        const towerZ = b.bounds.minZ + Math.min(3.2, (b.bounds.maxZ - b.bounds.minZ) * 0.3);
        addSteeple(trim, towerX, towerZ, b.top - 0.4, Math.max(5, b.height * 0.9), WHITE);
      } else {
        const parapet = b.height > 5 ? 0.75 : 0.35;
        mb.addPrismWalls(b.poly, b.base, b.top + parapet, 4, 3.2);
        roofFlat.addPolygonCap(b.poly, b.top, true, 6);
        if (b.kind === 'hospital' || b.kind === 'campus' || b.area > 900) {
          // rooftop plant boxes give the walkable roofs some silhouette
          const c = b.centroid;
          trim.addBox(c[0], b.top + 1.1, c[1], Math.min(8, (b.maxX - b.minX) * 0.3),
            2.2, Math.min(8, (b.maxZ - b.minZ) * 0.3), [0.72, 0.72, 0.70], 3);
        }
      }
    }
    for (const [key, mb] of byFacade) this._addMesh(mb, this.materials[key] || this.materials.brick, 'buildings-' + key);
    this._addMesh(roofFlat, this.materials.roofFlat, 'roofs-flat');
    this._addMesh(roofShingle, this.materials.roofShingle, 'roofs-pitched');
    this._addMesh(trim, this.materials.trim, 'building-trim');
  }

  /* ---------------- ASUMH campus: lawns, paths, the X sign ---------------- */

  _buildCampus() {
    const campus = this.pois.get('asumh');
    if (!campus) return;
    const R = campus.radius || 200;
    const lawn = new MeshBuilder();
    const paths = new MeshBuilder();
    const ring = [];
    const segs = 56;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      ring.push([campus.x + Math.cos(a) * R * 0.92, campus.z + Math.sin(a) * R * 0.92]);
    }
    lawn.addPolygonCap(ring, 0, true, 12, null, (x, z) => this.getGroundHeight(x, z) + 0.05);

    // a ring path plus four radial spokes
    const ringPts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      ringPts.push([campus.x + Math.cos(a) * R * 0.55, campus.z + Math.sin(a) * R * 0.55]);
    }
    const rY = ringPts.map((p) => this.getGroundHeight(p[0], p[1]) + 0.10);
    const rib = roadRibbonPolylines(ringPts, rY, 3.0, 0);
    paths.addRibbon(rib.left, rib.right, 5, null, true);
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * Math.PI * 2 + Math.PI / 4;
      const spoke = [];
      for (let t = 0; t <= 8; t++) {
        const r = (t / 8) * R * 0.9;
        spoke.push([campus.x + Math.cos(a) * r, campus.z + Math.sin(a) * r]);
      }
      const sy = spoke.map((p) => this.getGroundHeight(p[0], p[1]) + 0.10);
      const sr = roadRibbonPolylines(spoke, sy, 2.6, 0);
      paths.addRibbon(sr.left, sr.right, 5, null, true);
    }
    this._addMesh(lawn, this.materials.lawn, 'campus-lawn');
    this._addMesh(paths, this.materials.concrete, 'campus-paths');
    this._buildXSign(campus, R);
  }

  _buildXSign(campus, R) {
    const near = this.nearestRoadPoint(campus.x, campus.z);
    let dirX = near.x - campus.x, dirZ = near.z - campus.z;
    const L = Math.hypot(dirX, dirZ) || 1;
    dirX /= L; dirZ /= L;
    const ex = campus.x + dirX * (R * 0.86);
    const ez = campus.z + dirZ * (R * 0.86);
    const y = this.getGroundHeight(ex, ez);
    const yaw = Math.atan2(dirX, dirZ);

    const mb = new MeshBuilder(true);
    const GOLD = [0.95, 0.78, 0.22], BLUE = [0.12, 0.20, 0.42], STONE = [0.78, 0.75, 0.68];
    mb.addBox(ex, y + 1.1, ez, 0.45, 2.2, 0.45, STONE, 2, yaw);       // plinth
    const boardY = y + 3.6;
    const place = (rotZ, len) => {
      const geom = new THREE.BoxGeometry(len, 0.45, 0.34);
      const m = new THREE.Matrix4().makeRotationZ(rotZ);
      m.premultiply(new THREE.Matrix4().makeRotationY(yaw));
      m.premultiply(new THREE.Matrix4().makeTranslation(ex, boardY, ez));
      appendGeometry(mb, geom, m, GOLD);
      geom.dispose();
    };
    // backing board + the X itself
    const board = new THREE.BoxGeometry(3.4, 3.4, 0.18);
    const bm = new THREE.Matrix4().makeRotationY(yaw);
    bm.premultiply(new THREE.Matrix4().makeTranslation(ex, boardY, ez));
    appendGeometry(mb, board, bm, BLUE);
    board.dispose();
    place(Math.PI / 4, 3.9);
    place(-Math.PI / 4, 3.9);
    const mesh = this._addMesh(mb, this.materials.sign, 'x-sign');
    this.xSign = mesh;
    this.xSignPos = new THREE.Vector3(ex, boardY, ez);
  }

  /* ---------------- scatter helpers ---------------- */

  /** True when (x,z) is on a road surface or inside a building footprint. */
  _blocked(x, z, margin = 1.0) {
    const near = this.roadGrid.queryPoint(x, z, this._q2);
    for (let i = 0; i < near.length; i++) {
      const s = near[i];
      if ((s.x - x) ** 2 + (s.z - z) ** 2 < (s.width * 0.5 + margin + 1.5) ** 2) return true;
    }
    const b = this.buildingGrid.queryPoint(x, z, this._q3);
    for (let i = 0; i < b.length; i++) {
      const r = b[i];
      if (x > r.minX - margin && x < r.maxX + margin && z > r.minZ - margin && z < r.maxZ + margin) return true;
    }
    return false;
  }

  _inBounds(x, z) {
    return x > this.bounds.minX && x < this.bounds.maxX && z > this.bounds.minZ && z < this.bounds.maxZ;
  }

  _inWater(x, z) {
    for (let i = 0; i < this.waterBodies.length; i++) {
      const w = this.waterBodies[i];
      if (x < w.bounds.minX || x > w.bounds.maxX || z < w.bounds.minZ || z > w.bounds.maxZ) continue;
      if (pointInPolygon(x, z, w.poly)) return true;
    }
    return false;
  }

  _instance(geom, material, list, name, chunk = null) {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geom, material, list.length);
    im.name = name;
    im.castShadow = false;
    im.receiveShadow = true;
    const q = this._qTmp, s = this._sTmp, v = this._vTmp, m = this._mTmp;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      q.setFromAxisAngle(UP_AXIS, t.yaw || 0);
      s.set(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1);
      v.set(t.x, t.y, t.z);
      m.compose(v, q, s);
      im.setMatrixAt(i, m);
      if (t.color) im.setColorAt(i, this._cTmp.setRGB(t.color[0], t.color[1], t.color[2]));
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    this.group.add(im);
    this.meshes.push(im);
    this.stats.draws++;
    const tris = (geom.index ? geom.index.count : geom.getAttribute('position').count) / 3;
    this.stats.triangles += tris * list.length;
    if (chunk) this.treeChunks.push({ mesh: im, cx: chunk.cx, cz: chunk.cz });
    return im;
  }

  /* ---------------- trees ---------------- */

  _treeGeometry(species) {
    const mb = new MeshBuilder(true);
    const TRUNK = [0.33, 0.25, 0.17];
    const trs = (x, y, z, sx, sy, sz) => new THREE.Matrix4()
      .makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
    if (species === 0) {                              // white oak
      const trunk = new THREE.CylinderGeometry(0.17, 0.28, 3.6, 6, 1);
      appendGeometry(mb, trunk, trs(0, 1.8, 0, 1, 1, 1), TRUNK);
      trunk.dispose();
      const blob = new THREE.IcosahedronGeometry(2.6, 0);
      appendGeometry(mb, blob, trs(0, 5.0, 0, 1.05, 0.82, 1.05), [0.29, 0.45, 0.21]);
      appendGeometry(mb, blob, trs(1.1, 6.1, -0.5, 0.62, 0.55, 0.62), [0.33, 0.50, 0.24]);
      appendGeometry(mb, blob, trs(-1.0, 5.6, 0.7, 0.55, 0.48, 0.55), [0.25, 0.40, 0.19]);
      blob.dispose();
    } else {                                          // shortleaf pine
      const trunk = new THREE.CylinderGeometry(0.13, 0.24, 2.6, 6, 1);
      appendGeometry(mb, trunk, trs(0, 1.3, 0, 1, 1, 1), TRUNK);
      trunk.dispose();
      const cone = new THREE.ConeGeometry(1.0, 1.0, 7, 1);
      appendGeometry(mb, cone, trs(0, 4.6, 0, 2.0, 5.6, 2.0), [0.17, 0.32, 0.21]);
      appendGeometry(mb, cone, trs(0, 7.6, 0, 1.35, 3.8, 1.35), [0.20, 0.36, 0.23]);
      cone.dispose();
    }
    return mb.toGeometry();
  }

  _buildTrees() {
    const budget = this.opts.treeCount ?? (this.opts.treeBudget[this.quality] ?? 2000);
    if (budget <= 0) return;
    const rng = makeRng(this.opts.seed + 4242);
    const spots = [];

    // 1. green areas (forest densest, then park, then plain grass)
    const density = { forest: 1 / 170, park: 1 / 420, grass: 1 / 900 };
    for (const g of (this.greens || [])) {
      const want = Math.min(900, Math.floor(g.area * (density[g.kind] ?? density.grass)));
      let tries = 0;
      for (let made = 0; made < want && tries < want * 8; tries++) {
        const x = lerp(g.bounds.minX, g.bounds.maxX, rng());
        const z = lerp(g.bounds.minZ, g.bounds.maxZ, rng());
        if (!pointInPolygon(x, z, g.poly)) continue;
        if (this._inWater(x, z) || this._blocked(x, z, 1.5)) continue;
        spots.push({ x, z, species: g.kind === 'forest' ? (rng() < 0.55 ? 1 : 0) : (rng() < 0.25 ? 1 : 0) });
        made++;
      }
    }

    // 2. street trees / residential yards
    for (const road of this.roads) {
      if (road.cls !== 'residential' && road.cls !== 'tertiary') continue;
      for (let i = 0; i < road.samples.length; i++) {
        if (rng() > 0.42) continue;
        const s = road.samples[i];
        const side = rng() < 0.5 ? -1 : 1;
        const off = road.width * 0.5 + 5 + rng() * 9;
        const nb = road.samples[Math.min(i + 1, road.samples.length - 1)];
        let dx = nb.x - s.x, dz = nb.z - s.z;
        const L = Math.hypot(dx, dz) || 1;
        dx /= L; dz /= L;
        const x = s.x + dz * off * side, z = s.z - dx * off * side;
        if (!this._inBounds(x, z) || this._inWater(x, z) || this._blocked(x, z, 1.5)) continue;
        spots.push({ x, z, species: rng() < 0.3 ? 1 : 0 });
      }
    }

    // 3. fill the countryside outside the built-up area
    const hillWant = Math.max(0, Math.floor(budget * 0.35));
    for (let i = 0, made = 0; made < hillWant && i < hillWant * 6; i++) {
      const x = lerp(this.bounds.minX, this.bounds.maxX, rng());
      const z = lerp(this.bounds.minZ, this.bounds.maxZ, rng());
      if (Math.hypot(x, z) < 420) continue;
      if (this._inWater(x, z) || this._blocked(x, z, 3)) continue;
      spots.push({ x, z, species: rng() < 0.5 ? 1 : 0 });
      made++;
    }

    // trim to budget, then bucket into chunks for distance culling
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = spots[i]; spots[i] = spots[j]; spots[j] = t;
    }
    spots.length = Math.min(spots.length, budget);

    const cs = this.opts.treeChunk;
    const chunks = new Map();
    for (const sp of spots) {
      const cx = Math.floor(sp.x / cs), cz = Math.floor(sp.z / cs);
      const key = cx + ',' + cz + ',' + sp.species;
      let c = chunks.get(key);
      if (!c) {
        c = { cx: (cx + 0.5) * cs, cz: (cz + 0.5) * cs, species: sp.species, list: [] };
        chunks.set(key, c);
      }
      const s = 0.75 + rng() * 0.65;
      c.list.push({ x: sp.x, y: this.getGroundHeight(sp.x, sp.z) - 0.15, z: sp.z, yaw: rng() * Math.PI * 2, s });
    }
    const geoms = [this._treeGeometry(0), this._treeGeometry(1)];
    this._treeGeoms = geoms;
    for (const c of chunks.values()) {
      this._instance(geoms[c.species], this.materials.tree, c.list, 'trees', c);
      this.stats.trees += c.list.length;
    }
  }

  /* ---------------- street lamps ---------------- */

  _buildLamps() {
    if (this.quality === 'low') return;
    const posts = [], heads = [];
    let flip = 0;
    for (const road of this.roads) {
      if (!road.spec.lamps) continue;
      const stride = Math.max(1, Math.round(this.opts.lampSpacing / this.opts.roadSampleStep));
      for (let i = 1; i < road.samples.length - 1; i += stride) {
        const s = road.samples[i], nb = road.samples[i + 1] || road.samples[i - 1];
        let dx = nb.x - s.x, dz = nb.z - s.z;
        const L = Math.hypot(dx, dz) || 1;
        dx /= L; dz /= L;
        const side = (flip++ % 2) ? 1 : -1;
        const off = road.width * 0.5 + 1.8;
        const x = s.x + dz * off * side, z = s.z - dx * off * side;
        if (!this._inBounds(x, z)) continue;
        const yaw = Math.atan2(-dz * side, dx * side);
        posts.push({ x, y: s.y, z, yaw, s: 1 });
        heads.push({ x: x + dz * -1.35 * side, y: s.y + 7.85, z: z + dx * 1.35 * side, yaw, s: 1 });
      }
    }
    if (!posts.length) return;
    if (posts.length > this.opts.maxLamps) {           // keep the busiest stretches, drop the rest
      const keep = Math.max(1, Math.round(posts.length / this.opts.maxLamps));
      const p2 = [], h2 = [];
      for (let i = 0; i < posts.length; i++) if (i % keep === 0) { p2.push(posts[i]); h2.push(heads[i]); }
      posts.length = 0; heads.length = 0;
      posts.push(...p2); heads.push(...h2);
    }
    const mb = new MeshBuilder(true);
    const GREY = [0.34, 0.35, 0.37];
    const post = new THREE.CylinderGeometry(0.085, 0.13, 8, 6, 1);
    appendGeometry(mb, post, new THREE.Matrix4().makeTranslation(0, 4, 0), GREY);
    post.dispose();
    mb.addBox(0, 8.0, -0.7, 0.12, 0.12, 1.6, GREY, 1);
    mb.addBox(0, 7.86, -1.35, 0.34, 0.22, 0.7, GREY, 1);
    this._instance(mb.toGeometry(), this.materials.lamp, posts, 'street-lamps');
    const glass = new THREE.BoxGeometry(0.3, 0.1, 0.6);
    this._instance(glass, this.materials.lampGlass, heads, 'street-lamp-glass');
    this.stats.lamps = posts.length;
  }

  /* ---------------- parked cars ---------------- */

  _buildCars() {
    if (this.quality === 'low') return;
    const rng = makeRng(this.opts.seed + 909);
    const palette = [
      [0.82, 0.82, 0.84], [0.12, 0.13, 0.15], [0.60, 0.13, 0.13], [0.16, 0.28, 0.50],
      [0.36, 0.40, 0.35], [0.72, 0.68, 0.58], [0.20, 0.42, 0.32],
    ];
    const cars = [];
    const push = (x, z, yaw, y) => {
      if (!this._inBounds(x, z) || this._inWater(x, z)) return;
      cars.push({ x, y, z, yaw, s: 1, color: palette[Math.floor(rng() * palette.length)] });
    };

    // kerbside parking along the slower roads
    for (const road of this.roads) {
      if (!road.spec.parking) continue;
      const stride = Math.max(1, Math.round(11 / this.opts.roadSampleStep));
      for (let i = 1; i < road.samples.length - 1; i += stride) {
        if (rng() > 0.34) continue;
        const s = road.samples[i], nb = road.samples[i + 1];
        let dx = nb.x - s.x, dz = nb.z - s.z;
        const L = Math.hypot(dx, dz) || 1;
        dx /= L; dz /= L;
        const side = rng() < 0.5 ? -1 : 1;
        const off = road.width * 0.5 - 1.3;
        push(s.x + dz * off * side, s.z - dx * off * side, Math.atan2(dx, dz), s.y + 0.06);
      }
    }
    // lots beside the big-box stores, the hospital and the campus
    for (const b of this.buildings) {
      if (b.area < 700) continue;
      const rows = b.area > 3000 ? 2 : 1;
      const y0 = b.padY;
      for (let r = 0; r < rows; r++) {
        const z = b.maxZ + 7 + r * 6.5;
        for (let x = b.minX + 2; x < b.maxX - 2; x += 3.0) {
          if (rng() > 0.35) continue;
          if (this._blocked(x, z, 0.4)) continue;
          push(x, z, 0, y0 + 0.06);
        }
      }
    }
    if (!cars.length) return;
    if (cars.length > this.opts.maxCars) {             // spread the trim over the whole map
      for (let i = cars.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = cars[i]; cars[i] = cars[j]; cars[j] = t;
      }
      cars.length = this.opts.maxCars;
    }
    const mb = new MeshBuilder(true);
    mb.addBox(0, 0.62, 0, 1.85, 0.72, 4.25, [1, 1, 1], 2);          // body (tinted per instance)
    mb.addBox(0, 1.22, -0.25, 1.62, 0.66, 2.15, [0.30, 0.34, 0.38], 2);  // cabin
    for (const [wx, wz] of [[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]]) {
      mb.addBox(wx, 0.32, wz, 0.24, 0.62, 0.62, [0.07, 0.07, 0.08], 1);
    }
    this._instance(mb.toGeometry(), this.materials.car, cars, 'parked-cars');
    this.stats.cars = cars.length;
  }
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);

/* ================================================================== *
 * 9. convenience
 * ================================================================== */

/** Build a City from a parsed city.json and add it to the scene. */
export function buildCityFromJson(scene, json, opts = {}) {
  const city = new City(scene, json, opts);
  city.build();
  return city;
}

/** Fetch src/data/city.json and build. Browser-only (uses fetch). */
export async function loadCity(scene, url = '../data/city.json', opts = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('city.json load failed: ' + res.status);
  return buildCityFromJson(scene, await res.json(), opts);
}

export default City;
