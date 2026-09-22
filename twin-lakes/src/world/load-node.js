// Load the world in Node (tests and the headless flight).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Terrain, decodeHeights, GRID_ORDER } from './terrain.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

export function loadTerrain() {
  const world = JSON.parse(fs.readFileSync(path.join(DATA, 'world.json'), 'utf8'));
  const arrays = {};
  for (const name of GRID_ORDER) {
    const m = world.grids[name];
    const raw = (k) => new Uint8Array(zlib.inflateSync(fs.readFileSync(path.join(DATA, `${name}_${k}.bin`))));
    arrays[name] = {
      H: decodeHeights(raw('h'), m.hn[0], m.hn[1], world.h_unit),
      W: decodeHeights(raw('w'), m.hn[0], m.hn[1], world.h_unit),
      L: raw('lc'),
    };
  }
  return new Terrain(world, arrays);
}
