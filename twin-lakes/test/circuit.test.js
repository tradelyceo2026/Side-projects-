// End to end: the demo pilot flies KBPK -> both dams -> KBPK on the real terrain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flyCircuit } from '../scripts/headless.mjs';
import { loadTerrain } from '../src/world/load-node.js';

const terrain = loadTerrain();

for (const [label, windDir, windKt] of [['calm', 0, 0], ['11 kt crosswind', 300, 12]]) {
  test(`full circuit, ${label}: takeoff, both dams, approach, landing, stop`, { timeout: 300000 }, () => {
    const r = flyCircuit({ windDir, windKt, verbose: false, terrain });
    assert.ok(r.ok, `crashed: ${r.crashed} phase ${r.phase}`);
    assert.ok(r.touchdown.vsFpm > -400, `touchdown ${r.touchdown.vsFpm} fpm`);
    assert.ok(r.touchdown.alongM > 60 && r.touchdown.alongM < 600, `touchdown ${r.touchdown.alongM} m past threshold`);
    assert.ok(Math.abs(r.touchdown.crossM) < 8, `touchdown ${r.touchdown.crossM} m off centreline`);
    assert.ok(Math.abs(r.stop.crossM) < 5 && r.stop.alongM < 1400);
    assert.ok(r.timeline.some((l) => l.note === 'passed Norfork Dam'));
  });
}
