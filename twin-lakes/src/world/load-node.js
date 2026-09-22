// Load the world in Node (tests and the headless flight).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Terrain, GRID_ORDER } from './terrain.js';
import { parsePNG, unfilterPNG, heightsFromU16 } from './png.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

export function loadTerrain() {
  const world = JSON.parse(fs.readFileSync(path.join(DATA, 'world.json'), 'utf8'));
  const arrays = {};
  for (const name of GRID_ORDER) {
    const m = world.grids[name];
    const png = (k) => {
      const info = parsePNG(new Uint8Array(fs.readFileSync(path.join(DATA, `${name}_${k}.png`))));
      return unfilterPNG(info, new Uint8Array(zlib.inflateSync(info.idat)));
    };
    arrays[name] = {
      H: heightsFromU16(png('h'), world.h_unit),
      W: heightsFromU16(png('w'), world.h_unit),
      L: png('lc'),
    };
    void m;
  }
  return new Terrain(world, arrays);
}
