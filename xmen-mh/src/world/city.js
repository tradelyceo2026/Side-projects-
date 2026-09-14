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
