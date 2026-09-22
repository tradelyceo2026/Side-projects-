// Load the world in the browser. The single-file build embeds every data file as base64 in
// window.__TL_DATA; the dev page fetches them from data/.

import { Terrain, GRID_ORDER } from '../world/terrain.js';
import { parsePNG, unfilterPNG, heightsFromU16 } from '../world/png.js';

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function rawBytes(name) {
  const emb = globalThis.__TL_DATA;
  if (emb && emb[name]) return b64ToBytes(emb[name]);
  for (const base of ['data/', '../data/']) {
    try {
      const r = await fetch(`${base}${name}`);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch { /* try the next location */ }
  }
  throw new Error(`missing data/${name}`);
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function image(name) {
  const bytes = await rawBytes(name);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  // row 0 of every image is the north edge (z0); textures use flipY = false so v = (z - z0) / h
  if (globalThis.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/**
 * @param {(msg: string, frac: number) => void} progress
 * @returns {Promise<{world, terrain: Terrain, images: Record<string, ImageBitmap>, buildings: Uint8Array}>}
 */
export async function loadWorld(progress = () => {}) {
  const worldBytes = await rawBytes('world.json');
  const world = JSON.parse(new TextDecoder().decode(worldBytes));
  const arrays = {};
  const images = {};
  let done = 0;
  const total = GRID_ORDER.length * 4 + 1;
  const tick = (msg) => progress(msg, ++done / total);
  const png = async (file) => {
    const info = parsePNG(await rawBytes(file));
    return unfilterPNG(info, await inflate(info.idat));
  };
  await Promise.all(GRID_ORDER.map(async (name) => {
    const [h, w, lc] = await Promise.all(['h', 'w', 'lc'].map(async (k) => {
      const v = await png(`${name}_${k}.png`);
      tick(`${name} ${k === 'h' ? 'terrain' : k === 'w' ? 'water' : 'shorelines'}`);
      return v;
    }));
    arrays[name] = { H: heightsFromU16(h, world.h_unit), W: heightsFromU16(w, world.h_unit), L: lc };
    images[name] = await image(`${name}.jpg`);
    tick(`${name} imagery`);
  }));
  const buildings = JSON.parse(new TextDecoder().decode(await rawBytes('buildings.json')));
  tick('buildings');
  return { world, terrain: new Terrain(world, arrays), images, buildings };
}

/** Expand buildings.json into [{x, z, h, kind, pts:[[x,z]...]}]. */
export function decodeBuildings(json) {
  return json.buildings.map((b) => {
    const [x, z, h, kind] = b;
    const pts = [];
    for (let i = 4; i + 1 < b.length; i += 2) pts.push([x + b[i] / 2, z + b[i + 1] / 2]);
    return { x, z, h, kind, pts };
  });
}
