// Terrain, water and projection for the Twin Lakes world. Used by the flight model (CPU) and mirrored
// exactly by the terrain shader (GPU) so the wheels meet the ground that is drawn.
//
// Three nested grids: far (256 m), near (32 m) and inset (8 m, the airport and Mountain Home). Each
// sample blends toward the finer grid across a band inside that grid's edge, so there are no seams.

export const GRID_ORDER = ['far', 'near', 'inset'];
export const BLEND = { near: [200, 2500], inset: [100, 700] };   // metres inside the grid edge

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Undo the row-delta uint16 coding written by scripts/process_data.py. */
export function decodeHeights(bytes, nx, ny, unit) {
  const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, nx * ny);
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    let acc = 0;
    const o = y * nx;
    for (let x = 0; x < nx; x++) {
      acc = (acc + u16[o + x]) & 0xffff;
      out[o + x] = acc / unit;
    }
  }
  return out;
}

export class Projection {
  constructor(origin) { Object.assign(this, origin); }
  toLocal(lat, lon) { return [(lon - this.lon) * this.kx, -(lat - this.lat) * this.kz]; }
  toLatLon(x, z) { return [this.lat - z / this.kz, this.lon + x / this.kx]; }
}

function bilinear(arr, nx, ny, fx, fy) {
  fx = Math.min(nx - 1, Math.max(0, fx));
  fy = Math.min(ny - 1, Math.max(0, fy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = arr[y0 * nx + x0], b = arr[y0 * nx + x1], c = arr[y1 * nx + x0], d = arr[y1 * nx + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export class Terrain {
  /**
   * @param {object} world  parsed data/world.json
   * @param {object} arrays { far: {H: Float32Array heights, W: Float32Array water level, L: Uint8Array water
   *                          distance}, near: ..., inset: ... }
   */
  constructor(world, arrays) {
    this.world = world;
    this.proj = new Projection(world.origin);
    this.g = {};
    for (const name of GRID_ORDER) {
      const m = world.grids[name];
      this.g[name] = { ...m, ...arrays[name] };
    }
    this.runways = world.runways;
  }

  /** Blend weight of a finer grid at (x, z). */
  weight(name, x, z) {
    const m = this.g[name];
    const e = Math.min(x - m.x0, m.x0 + m.w - x, z - m.z0, m.z0 + m.h - z);
    const [a, b] = BLEND[name];
    return smoothstep(a, b, e);
  }

  _sample(name, key, x, z) {
    const m = this.g[name];
    if (key === 'L') {
      const n = m.lcn;
      const v = bilinear(m.L, n[0], n[1], (x - m.x0) / m.lc_res - 0.5, (z - m.z0) / m.lc_res - 0.5);
      return (v - 128) * m.sdf_scale;
    }
    const n = m.hn;
    return bilinear(m[key], n[0], n[1], (x - m.x0) / m.h_res - 0.5, (z - m.z0) / m.h_res - 0.5);
  }

  _blend(key, x, z) {
    let v = this._sample('far', key, x, z);
    const wn = this.weight('near', x, z);
    if (wn > 0) v += (this._sample('near', key, x, z) - v) * wn;
    const wi = this.weight('inset', x, z);
    if (wi > 0) v += (this._sample('inset', key, x, z) - v) * wi;
    return v;
  }

  height(x, z) { return this._blend('H', x, z); }
  waterLevel(x, z) { return this._blend('W', x, z); }
  /** Signed distance to the nearest shoreline in metres, negative over water. */
  waterDistance(x, z) { return this._blend('L', x, z); }

  normal(x, z, e = 2) {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const n = [-hx, 2 * e, -hz];
    const l = Math.hypot(n[0], n[1], n[2]);
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  /** Ground query in the shape the flight model expects. */
  ground(x, z) {
    const h = this.height(x, z);
    const sd = this.waterDistance(x, z);
    const water = sd < 0;
    return { h, n: this.normal(x, z), water, waterH: water ? this.waterLevel(x, z) : -1e9 };
  }

  /** Highest of terrain and water surface, for cameras and AGL. */
  surface(x, z) {
    const h = this.height(x, z);
    return this.waterDistance(x, z) < 0 ? Math.max(h, this.waterLevel(x, z)) : h;
  }

  runway(icao, which = 0) {
    return this.runways.filter((r) => r.icao === icao)[which];
  }
}

/**
 * Runway end geometry for landing and takeoff. `end` 'a' is the threshold at r.a (landing toward b).
 * Returns threshold position, elevation, course (rad, true), length, width.
 */
export function runwayEnd(r, end = 'a') {
  const [a, b] = end === 'a' ? [r.a, r.b] : [r.b, r.a];
  const ea = end === 'a' ? r.elev_a : r.elev_b;
  const eb = end === 'a' ? r.elev_b : r.elev_a;
  const course = (Math.atan2(b[0] - a[0], -(b[1] - a[1])) + 2 * Math.PI) % (2 * Math.PI);
  const deg = Math.round(course * 180 / Math.PI / 10) % 36 || 36;
  return { x: a[0], z: a[1], elev: ea, elevFar: eb, course, length: r.length, width: r.width, far: b,
    ident: String(deg).padStart(2, '0') };
}

/** Distance along and across a runway from an end (along positive toward the far end, across positive right). */
export function runwayFrame(end, x, z) {
  const s = Math.sin(end.course), c = Math.cos(end.course);
  const dx = x - end.x, dz = z - end.z;
  return { along: dx * s - dz * c, cross: dx * c + dz * s };
}
