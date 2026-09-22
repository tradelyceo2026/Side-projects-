// The real-world data: KBPK, the lakes and the blending between grids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTerrain } from '../src/world/load-node.js';
import { runwayEnd, runwayFrame } from '../src/world/terrain.js';

const T = loadTerrain();

test('KBPK runway 5/23 matches the airport directory (5,001 ft, heading ~052/232)', () => {
  const r = T.runway('KBPK');
  assert.ok(Math.abs(r.length / 0.3048 - 5001) < 60, `length ${r.length / 0.3048} ft`);
  const e = runwayEnd(r, 'a');
  assert.equal(e.ident, '23');
  assert.equal(runwayEnd(r, 'b').ident, '05');
  const fieldFt = Math.max(r.elev_a, r.elev_b) / 0.3048;
  assert.ok(Math.abs(fieldFt - 928) < 25, `field elevation ${fieldFt} ft (published 928)`);
});

test('runway surface is smooth enough to roll on', () => {
  const e = runwayEnd(T.runway('KBPK'), 'a');
  let prev = null, worst = 0;
  for (let d = 0; d <= e.length; d += 5) {
    const x = e.x + Math.sin(e.course) * d, z = e.z - Math.cos(e.course) * d;
    const h = T.height(x, z);
    if (prev !== null) worst = Math.max(worst, Math.abs(h - prev));
    prev = h;
    assert.ok(Math.abs(runwayFrame(e, x, z).cross) < 1e-6);
  }
  assert.ok(worst < 0.12, `step ${worst} m per 5 m`);
});

test('lake levels are the reservoirs\' normal pools', () => {
  const ft = (m) => m / 0.3048;
  assert.ok(Math.abs(ft(T.world.lake_levels.bull_shoals) - 654) < 6, 'Bull Shoals ~654 ft');
  assert.ok(Math.abs(ft(T.world.lake_levels.norfork) - 552) < 12, 'Norfork ~552 ft');
});

test('water where the lakes are, land where the airport is', () => {
  const nd = T.world.dams.find((d) => d.name === 'Norfork Dam');
  assert.ok(T.waterDistance(0, 0) > 50, 'KBPK is dry');   // the inset SDF saturates at 63.5 m
  // just upstream (north-east) of Norfork Dam is lake
  let found = null;
  for (let r = 100; r < 1500 && !found; r += 50) for (let a = 0; a < 6.28 && !found; a += 0.2) {
    const x = nd.x + Math.cos(a) * r, z = nd.z + Math.sin(a) * r;
    if (T.waterDistance(x, z) < -20 && Math.abs(T.waterLevel(x, z) - T.world.lake_levels.norfork) < 0.5) found = [x, z];
  }
  assert.ok(found, 'Norfork Lake behind the dam');
  // the lake bed is below the surface
  assert.ok(T.height(...found) < T.waterLevel(...found) - 1);
});

test('grids blend without steps at their edges', () => {
  for (const name of ['inset', 'near']) {
    const g = T.world.grids[name];
    const z = g.z0 + g.h / 2;
    let worst = 0;
    for (let x = g.x0 - 3000; x < g.x0 + 3000; x += 16) {
      worst = Math.max(worst, Math.abs(T.height(x + 16, z) - T.height(x, z)));
    }
    assert.ok(worst < 12, `${name} edge: ${worst} m per 16 m`);
  }
});
