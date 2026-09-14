import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bus } from '../src/core/bus.js';
import { MissionManager, placeCollectibles } from '../src/missions.js';
import { STORY } from '../src/story.js';

// --- fakes ------------------------------------------------------------------

function makeCity() {
  const pois = {
    courthouse: { id: 'courthouse', name: 'Courthouse', x: 0, z: 0, radius: 40 },
    asumh: { id: 'asumh', name: 'ASUMH', x: 300, z: -200, radius: 150 },
    hospital: { id: 'hospital', name: 'Hospital', x: -400, z: 150, radius: 80 },
    walmart: { id: 'walmart', name: 'Walmart', x: 900, z: 50, radius: 100 },
    high_school: { id: 'high_school', name: 'High School', x: -150, z: 600, radius: 90 },
    lake: { id: 'lake', name: 'Lake', x: 1200, z: -800, radius: 120 },
    airport: { id: 'airport', name: 'Airport', x: 1800, z: 300, radius: 150 },
    downtown: { id: 'downtown', name: 'Downtown', x: 0, z: 0, radius: 60 },
    park: { id: 'park', name: 'Park', x: 150, z: 150, radius: 70 },
    landing_zone: { id: 'landing_zone', name: 'LZ', x: 20, z: 10, radius: 30 },
  };
  return {
    poi: (id) => pois[id] || null,
    getGroundHeight: () => 0,
    raycastDown: () => 5,
    nearestRoadPoint: (x, z) => ({ x, z, roadId: 1 }),
    bounds: { minX: -2500, maxX: 2500, minZ: -2500, maxZ: 2500 },
  };
}

function makeEnemies() {
  let nextId = 1;
  const list = [];
  return {
    spawnWave({ kind, count }) {
      for (let i = 0; i < count; i++) list.push({ id: nextId++, kind, hp: 10, state: 'idle' });
    },
    all: () => list,
    nearest: () => null,
    killAll(kind) {
      for (const e of list) {
        if (e.kind === kind && e.state !== 'dead') {
          e.state = 'dead';
          bus.emit('enemy_dead', { enemy: e });
        }
      }
    },
  };
}

function makeState() {
  return {
    time: 0, dt: 0, phase: 'play',
    player: { pos: { x: 0, y: 0, z: 0 }, character: 'wolverine' },
  };
}

function runFor(mgr, totalSeconds, step = 0.25) {
  let t = 0;
  while (t < totalSeconds) { mgr.update(step); t += step; }
}

// --- story data sanity -------------------------------------------------------

test('STORY has six main missions and six side characters', () => {
  assert.equal(STORY.missions.length, 6);
  assert.equal(STORY.sideCharacters.length, 6);
  for (const sc of STORY.sideCharacters) {
    assert.ok(sc.id && sc.at && Array.isArray(sc.lines) && sc.lines.length >= 3 && sc.lines.length <= 5, `${sc.id} lines`);
    assert.ok(sc.rigSpec && sc.rigSpec.outfit, `${sc.id} rigSpec`);
    assert.ok(sc.mission && Array.isArray(sc.mission.objectives) && sc.mission.objectives.length >= 2 && sc.mission.objectives.length <= 3, `${sc.id} mission`);
  }
  const m4 = STORY.missions.find((m) => m.id === 'm4');
  const m5 = STORY.missions.find((m) => m.id === 'm5');
  assert.equal(m4.requires, 'quicksilver');
  assert.equal(m5.requires, 'jean');
});

// --- collectibles -------------------------------------------------------------

test('placeCollectibles returns 25 valid points', () => {
  const city = makeCity();
  const pts = placeCollectibles(city);
  assert.equal(pts.length, 25);
  for (const p of pts) {
    assert.equal(typeof p.x, 'number');
    assert.equal(typeof p.y, 'number');
    assert.equal(typeof p.z, 'number');
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  }
  const ids = new Set(pts.map((p) => p.id));
  assert.equal(ids.size, 25, 'ids should be unique');
});

// --- M1 end-to-end -------------------------------------------------------------

test('M1 Drop Zone runs to completion as the player walks to the mansion', () => {
  const city = makeCity();
  const enemies = makeEnemies();
  const state = makeState();
  const mgr = new MissionManager(state, city, enemies, bus);

  const objectiveEvents = [];
  const missionStarts = [];
  const missionCompletes = [];
  const offObj = bus.on('objective_update', (p) => objectiveEvents.push(p));
  const offStart = bus.on('mission_start', (p) => missionStarts.push(p));
  const offComplete = bus.on('mission_complete', (p) => missionCompletes.push(p));

  mgr.start('m1');
  assert.deepEqual(missionStarts[0], { id: 'm1' });
  assert.equal(state.phase, 'dialog', 'intro dialog should hold the phase');

  // fast-forward through the two-line intro dialog
  runFor(mgr, 20);
  assert.equal(state.phase, 'play', 'phase restored after intro dialog');
  assert.ok(objectiveEvents.some((e) => e.missionId === 'm1' && e.done === false), 'objective announced');

  // walk the player to the ASUMH poi (the mission's only objective)
  const asumh = city.poi('asumh');
  state.player.pos.x = asumh.x;
  state.player.pos.z = asumh.z;
  runFor(mgr, 5);

  assert.ok(objectiveEvents.some((e) => e.missionId === 'm1' && e.done === true), 'objective completed');
  assert.ok(missionCompletes.some((e) => e.id === 'm1'), 'm1 reported complete');
  assert.ok(mgr.completedIds().includes('m1'));

  // outro dialog + auto-chain into m2 should have fired
  runFor(mgr, 20);
  assert.ok(missionStarts.some((e) => e.id === 'm2'), 'm2 auto-started after m1 outro');

  offObj(); offStart(); offComplete();
});

// --- M4 requires flag -----------------------------------------------------------

test('M4 Highway 62 gates on Quicksilver and nags with a toast until switched', () => {
  const city = makeCity();
  const enemies = makeEnemies();
  const state = makeState();
  state.player.character = 'wolverine';
  const mgr = new MissionManager(state, city, enemies, bus);

  const toasts = [];
  const offToast = bus.on('toast', (p) => toasts.push(p));

  mgr.start('m4');
  assert.equal(mgr.current().mission.id, 'm4');
  assert.ok(toasts.some((t) => /quicksilver/i.test(t.text)), 'initial nag toast');
  assert.equal(state.phase, 'play', 'no dialog until requirement met');

  toasts.length = 0;
  mgr.update(0.5); // still wolverine — should stay pending, no dialog started
  assert.equal(mgr.current().objective.type, 'requires');

  state.player.character = 'quicksilver';
  mgr.update(0.5); // now satisfied — should begin intro dialog
  assert.equal(state.phase, 'dialog', 'mission begins once Quicksilver is active');

  offToast();
});
