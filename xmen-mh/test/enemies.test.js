import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { bus } from '../src/core/bus.js';
import {
  ENEMY_KINDS,
  Enemy,
  EnemyManager,
  onPlayerDamage,
  distance2D,
  normalize2D,
  canSensePlayer,
  nextEnemyState,
  steerAroundObstacles,
  pickWanderTarget,
  applyDamage,
  fallDamage,
  pickControlledTarget,
  knockbackFrom,
  pointNearLine,
} from '../src/enemies.js';

// --- fakes -------------------------------------------------------------

function fakeCity({ ground = 0, blockAt = null } = {}) {
  return {
    getGroundHeight: () => ground,
    collideCapsule: (pos, r, h, out) => {
      out.x = pos.x; out.y = pos.y; out.z = pos.z;
      if (!blockAt) return false;
      const dx = pos.x - blockAt.x, dz = pos.z - blockAt.z;
      const d = Math.hypot(dx, dz);
      if (d < blockAt.radius) {
        // push the probed point out to the edge of the (circular) obstacle
        const push = blockAt.radius - d + 0.01;
        const nx = d < 1e-6 ? 1 : dx / d;
        const nz = d < 1e-6 ? 0 : dz / d;
        out.x = pos.x + nx * push;
        out.z = pos.z + nz * push;
        return true;
      }
      return false;
    },
    nearestRoadPoint: (x, z) => ({ x, z, roadId: 1 }),
    poi: () => null,
  };
}

function fakeRigFactory() {
  return () => ({ group: new THREE.Group(), setAnim() {}, update() {}, dispose() {} });
}

function fakeState(overrides = {}) {
  return {
    time: 0,
    timeScale: 1,
    player: { pos: new THREE.Vector3(0, 0, 0), hp: 100, maxHp: 100 },
    ...overrides,
  };
}

// --- pure helpers --------------------------------------------------------

test('distance2D / normalize2D', () => {
  assert.equal(distance2D({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
  const n = normalize2D({ x: 3, z: 4 });
  assert.ok(Math.abs(n.x - 0.6) < 1e-9);
  assert.ok(Math.abs(n.z - 0.8) < 1e-9);
  assert.deepEqual(normalize2D({ x: 0, z: 0 }), { x: 0, z: 0 });
});

test('canSensePlayer respects radius', () => {
  assert.equal(canSensePlayer({ x: 0, z: 0 }, { x: 10, z: 0 }, 15), true);
  assert.equal(canSensePlayer({ x: 0, z: 0 }, { x: 20, z: 0 }, 15), false);
});

test('nextEnemyState: idle -> chase -> attack -> chase -> patrol', () => {
  let s = nextEnemyState('idle', { time: 0, hp: 10, distToPlayer: 10, senseRadius: 30, attackRange: 2 });
  assert.equal(s, 'chase');
  s = nextEnemyState('chase', { time: 0, hp: 10, distToPlayer: 1, senseRadius: 30, attackRange: 2 });
  assert.equal(s, 'attack');
  s = nextEnemyState('attack', { time: 0, hp: 10, distToPlayer: 3, senseRadius: 30, attackRange: 2 });
  assert.equal(s, 'chase'); // within 1.25x range still counted as "far" here (3 > 2*1.25=2.5)
  s = nextEnemyState('chase', {
    time: 10, hp: 10, distToPlayer: 100, senseRadius: 30, attackRange: 2,
    lastSeenAt: 0, rememberDuration: 5,
  });
  assert.equal(s, 'patrol');
});

test('nextEnemyState: chase remembers player briefly after losing sense', () => {
  const s = nextEnemyState('chase', {
    time: 2, hp: 10, distToPlayer: 100, senseRadius: 30, attackRange: 2,
    lastSeenAt: 0, rememberDuration: 5,
  });
  assert.equal(s, 'chase');
});

test('nextEnemyState: dead overrides everything', () => {
  assert.equal(nextEnemyState('attack', { hp: 0, distToPlayer: 1, senseRadius: 30, attackRange: 2 }), 'dead');
  assert.equal(nextEnemyState('dead', { hp: 50, distToPlayer: 1, senseRadius: 30, attackRange: 2 }), 'dead');
});

test('nextEnemyState: controlled overrides, then resolves on expiry', () => {
  assert.equal(nextEnemyState('idle', { hp: 10, time: 1, controlledUntil: 5, distToPlayer: 100, senseRadius: 10, attackRange: 2 }), 'controlled');
  const resolved = nextEnemyState('controlled', { hp: 10, time: 6, controlledUntil: 5, distToPlayer: 5, senseRadius: 10, attackRange: 2 });
  assert.equal(resolved, 'chase');
});

test('nextEnemyState: stagger holds until staggerUntil passes', () => {
  assert.equal(nextEnemyState('chase', { hp: 10, time: 1, staggerUntil: 2, distToPlayer: 1, senseRadius: 10, attackRange: 2 }), 'stagger');
  assert.equal(nextEnemyState('stagger', { hp: 10, time: 3, staggerUntil: 2, distToPlayer: 100, senseRadius: 10, attackRange: 2 }), 'idle');
});

test('steerAroundObstacles passes through when no collision', () => {
  const probe = () => false;
  const dir = normalize2D({ x: 1, z: 0 });
  const out = steerAroundObstacles({ x: 0, z: 0 }, dir, 0.5, 1.8, probe, 2);
  assert.deepEqual(out, dir);
});

test('steerAroundObstacles deflects around a collision', () => {
  const city = fakeCity({ blockAt: { x: 2, z: 0.5, radius: 1 } });
  const dir = normalize2D({ x: 1, z: 0 });
  const out = steerAroundObstacles({ x: 0, z: 0 }, dir, 0.5, 1.8, city.collideCapsule, 2);
  assert.notDeepEqual(out, dir);
  const mag = Math.hypot(out.x, out.z);
  assert.ok(Math.abs(mag - 1) < 1e-6);
});

test('pickWanderTarget is deterministic given an rng and stays within radius', () => {
  const rng = (() => { const seq = [0.25, 0.5]; let i = 0; return () => seq[i++ % seq.length]; })();
  const t = pickWanderTarget({ x: 0, z: 0 }, 10, null, rng);
  assert.ok(distance2D({ x: 0, z: 0 }, t) <= 10 + 1e-9);
});

test('pickWanderTarget snaps to road points when provided', () => {
  const t = pickWanderTarget({ x: 0, z: 0 }, 10, (x, z) => ({ x: 99, z: 99 }));
  assert.deepEqual(t, { x: 99, z: 99 });
});

test('applyDamage reduces hp and flags death at 0', () => {
  assert.deepEqual(applyDamage(60, 10), { hp: 50, dead: false });
  assert.deepEqual(applyDamage(10, 50), { hp: 0, dead: true });
});

test('fallDamage: none below safe speed, scales above it', () => {
  assert.equal(fallDamage(5), 0);
  assert.equal(fallDamage(8), 0);
  assert.equal(fallDamage(12), Math.round((12 - 8) * 4));
});

test('pickControlledTarget finds nearest other living enemy', () => {
  const me = { pos: { x: 0, z: 0 }, isDead: false };
  const near = { pos: { x: 2, z: 0 }, isDead: false };
  const far = { pos: { x: 20, z: 0 }, isDead: false };
  const dead = { pos: { x: 1, z: 0 }, isDead: true };
  const target = pickControlledTarget(me, [me, dead, far, near]);
  assert.equal(target, near);
});

test('knockbackFrom points away from a positional source', () => {
  const kb = knockbackFrom({ x: 5, z: 0 }, { pos: { x: 0, z: 0 } }, 10);
  assert.ok(Math.abs(kb.x - 10) < 1e-9);
  assert.ok(Math.abs(kb.z) < 1e-9);
});

test('knockbackFrom falls back to a default direction with no source info', () => {
  assert.deepEqual(knockbackFrom({ x: 0, z: 0 }, null, 5), { x: 0, z: 5 });
});

test('pointNearLine detects a point within the beam corridor', () => {
  const origin = { x: 0, z: 0 };
  const dir = { x: 0, z: 1 };
  assert.equal(pointNearLine(origin, dir, { x: 1, z: 10 }, 3, 40), true);
  assert.equal(pointNearLine(origin, dir, { x: 10, z: 10 }, 3, 40), false);
  assert.equal(pointNearLine(origin, dir, { x: 0, z: -5 }, 3, 40), false); // behind
});

// --- EnemyManager integration --------------------------------------------

test('spawn creates each kind with correct stats and emits enemy_spawn', () => {
  const city = fakeCity();
  const mgr = new EnemyManager(new THREE.Scene(), city, fakeRigFactory());
  let spawnedEvents = [];
  const off = bus.on('enemy_spawn', (p) => spawnedEvents.push(p));

  const thug = mgr.spawn('thug', 5, 5);
  const drone = mgr.spawn('drone', 0, 0);
  const sentinel = mgr.spawn('sentinel', -5, -5);
  off();

  assert.equal(thug.kind, 'thug'); assert.equal(thug.hp, ENEMY_KINDS.thug.hp);
  assert.equal(drone.kind, 'drone'); assert.equal(drone.hp, ENEMY_KINDS.drone.hp);
  assert.equal(sentinel.kind, 'sentinel'); assert.equal(sentinel.hp, ENEMY_KINDS.sentinel.hp);
  assert.equal(spawnedEvents.length, 3);
  assert.equal(mgr.all().length, 3);
  assert.ok(drone.mesh.userData.rotors.length === 2);
});

test('nearest finds the closest living enemy within maxDist', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity(), fakeRigFactory());
  const a = mgr.spawn('thug', 10, 0);
  const b = mgr.spawn('thug', 3, 0);
  const found = mgr.nearest({ x: 0, z: 0 }, 50);
  assert.equal(found, b);
  assert.equal(mgr.nearest({ x: 0, z: 0 }, 2), null);
  void a;
});

test('takeDamage reduces hp, staggers, and emits hit', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity(), fakeRigFactory());
  const thug = mgr.spawn('thug', 0, 0);
  const hits = [];
  const off = bus.on('hit', (p) => hits.push(p));
  thug.update(0.016, fakeState()); // establish _t
  thug.takeDamage(20, 'player');
  off();
  assert.equal(thug.hp, 40);
  assert.equal(thug.state, 'stagger');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].damage, 20);
});

test('lethal damage kills, emits enemy_dead, and removes from all() immediately', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity(), fakeRigFactory());
  const thug = mgr.spawn('thug', 0, 0);
  let died = null;
  const off = bus.on('enemy_dead', (p) => { died = p; });
  thug.update(0.016, fakeState());
  thug.takeDamage(1000, 'player');
  off();
  assert.equal(thug.isDead, true);
  assert.equal(died.enemy, thug);
  assert.equal(mgr.all().includes(thug), false);
});

test('dead enemies are fully removed from the manager after the fade window', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity(), fakeRigFactory());
  const thug = mgr.spawn('thug', 0, 0);
  const state = fakeState();
  mgr.update(0.016, state);
  thug.takeDamage(1000, 'player');
  assert.equal(mgr._enemies.length, 1);
  state.time = 10; // well past the 4s fade window
  mgr.update(0.016, state);
  assert.equal(mgr._enemies.length, 0);
});

test('held enemies do not move even if vel is set', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity(), fakeRigFactory());
  const thug = mgr.spawn('thug', 0, 0);
  thug.held = true;
  thug.vel.set(5, 0, 5);
  const before = thug.pos.clone();
  const state = fakeState({ player: { pos: new THREE.Vector3(100, 0, 100), hp: 100 } });
  for (let i = 0; i < 10; i++) mgr.update(0.05, state);
  assert.ok(thug.pos.distanceTo(before) < 1e-9);
});

test('releasing a held enemy lets it fly and take fall damage on landing', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity({ ground: 0 }), fakeRigFactory());
  const thug = mgr.spawn('thug', 0, 0, undefined);
  thug.pos.y = 20;
  thug.held = true;
  const state = fakeState({ player: { pos: new THREE.Vector3(100, 0, 100), hp: 100 } });
  mgr.update(0.016, state); // still held
  thug.held = false;
  thug.vel.set(0, -25, 0); // release with a big downward velocity -> should hurt on landing
  const hpBefore = thug.hp;
  for (let i = 0; i < 200 && !thug.isDead && thug.airborne !== false; i++) {
    state.time += 0.05;
    mgr.update(0.05, state);
    if (!thug.airborne) break;
  }
  assert.equal(thug.airborne, false);
  assert.ok(thug.pos.y <= 0.0001);
  assert.ok(thug.hp < hpBefore, `expected fall damage, hp went from ${hpBefore} to ${thug.hp}`);
});

test('controlled enemy attacks the nearest other enemy instead of idling', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity(), fakeRigFactory());
  const a = mgr.spawn('thug', 0, 0);
  const b = mgr.spawn('thug', 1, 0); // within thug attackRange (1.8) already
  const state = fakeState({ player: { pos: new THREE.Vector3(1000, 0, 1000), hp: 100 } });
  a.controlledUntil = 5;
  const bHpBefore = b.hp;
  for (let i = 0; i < 40; i++) { state.time += 0.05; mgr.update(0.05, state); }
  assert.equal(a.state, 'controlled');
  assert.ok(b.hp < bHpBefore, 'controlled enemy should have damaged the other enemy');
});

test('spawnWave spawns the requested count around a point', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity(), fakeRigFactory());
  const wave = mgr.spawnWave({ kind: 'drone', count: 3, around: { x: 10, z: 10 }, radius: 5 });
  assert.equal(wave.length, 3);
  assert.equal(mgr.all().length, 3);
  for (const d of wave) assert.ok(distance2D(d.pos, { x: 10, z: 10 }) <= 5 + 1e-6);
});

test('clear() disposes and empties the manager', () => {
  const scene = new THREE.Scene();
  const mgr = new EnemyManager(scene, fakeCity(), fakeRigFactory());
  mgr.spawn('thug', 0, 0);
  mgr.spawn('drone', 1, 1);
  assert.equal(scene.children.length, 2);
  mgr.clear();
  assert.equal(mgr.all().length, 0);
  assert.equal(scene.children.length, 0);
});

test('onPlayerDamage hook intercepts damage dealt to the player; default subtracts hp', () => {
  const mgr = new EnemyManager(new THREE.Scene(), fakeCity(), fakeRigFactory());
  const thug = mgr.spawn('thug', 0, 0.9);
  const state = fakeState({ player: { pos: new THREE.Vector3(0, 0, 0), hp: 100 } });

  const calls = [];
  onPlayerDamage((amount, info) => { calls.push(amount); });
  // thug starts idle; player already within sense+attack range -> chase -> attack -> windup 0.5s -> hit
  for (let i = 0; i < 60; i++) { state.time += 0.05; mgr.update(0.05, state); }
  assert.ok(calls.length >= 1, 'hook should have been called at least once');
  assert.equal(calls[0], ENEMY_KINDS.thug.meleeDamage);
  assert.equal(state.player.hp, 100, 'default subtraction must not run once a hook is registered');

  onPlayerDamage(null); // restore default
  const state2 = fakeState({ player: { pos: new THREE.Vector3(0, 0, 0), hp: 100 } });
  const thug2 = mgr.spawn('thug', 0, 0.9);
  for (let i = 0; i < 60; i++) { state2.time += 0.05; mgr.update(0.05, state2); }
  assert.ok(state2.player.hp < 100, 'default handler should subtract hp once no hook is registered');
  void thug2;
});
