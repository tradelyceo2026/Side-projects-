// test/abilities.test.js — node --test, no DOM, no WebGL.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { bus } from '../src/core/bus.js';
import {
  ABILITIES, useAbility, releaseAbility, updateAbilities,
  abilityCooldown, abilityState, resetAbilities, getHeld, getBeam,
} from '../src/abilities.js';
import {
  meleeAttack, damageEntity, applyRegen, PhysicsProp, MELEE, PROP_KINDS,
} from '../src/combat.js';

/* ------------------------------------------------------------------ fakes */

function fakeCity(groundY = 0) {
  return {
    getGroundHeight: () => groundY,
    raycastDown: () => groundY,
    collideCapsule: () => false,
    nearestRoadPoint: (x, z) => ({ x, z, roadId: 1 }),
    bounds: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 },
  };
}

function fakeEnemy(id, x, y, z, hp = 100) {
  const e = {
    id, kind: 'thug', hp, maxHp: hp, state: 'idle',
    pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(),
    takeDamage(n) { this.hp = Math.max(0, this.hp - n); if (this.hp <= 0) this.state = 'dead'; },
  };
  return e;
}

function fakeRig() {
  const calls = [];
  return {
    calls,
    setClaws(v) { calls.push(['claws', v]); this.claws = v; },
    setDiamond(v) { calls.push(['diamond', v]); this.diamond = v; },
    setVisorGlow(v) { calls.push(['visor', v]); this.visor = v; },
    setAnim(n) { calls.push(['anim', n]); },
  };
}

function fakeState(character = 'wolverine') {
  const s = {
    time: 0, dt: 0, phase: 'play', activeIndex: 0,
    roster: ['wolverine', 'quicksilver', 'jean', 'cyclops', 'emma'],
    player: {
      character, pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(),
      yaw: 0, hp: 100, maxHp: 160, grounded: true,
    },
    enemies: [], props: [], city: fakeCity(), timeScale: 1, scene: null,
  };
  resetAbilities(s);
  return s;
}

/** ctx aimed straight down -Z (north). */
function makeCtx(s, rig = fakeRig()) {
  return {
    player: s.player, rig, camera: null, city: s.city,
    enemies: s.enemies, props: s.props, dir: new THREE.Vector3(0, 0, -1),
  };
}

function step(s, dt, n = 1) {
  for (let i = 0; i < n; i++) { s.time += dt; s.dt = dt; updateAbilities(s, dt); }
}

function capture(evt) {
  const got = [];
  const off = bus.on(evt, (p) => got.push(p));
  return { got, off };
}

/* ------------------------------------------------------------------ table */

test('ABILITIES exposes every id with the HUD fields', () => {
  const ids = ['claws', 'regen', 'dash', 'slowmo', 'telekinesis', 'hover', 'blast', 'sweep', 'diamond', 'psychic'];
  for (const id of ids) {
    const a = ABILITIES[id];
    assert.ok(a, `${id} missing`);
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.cooldown, 'number');
    assert.equal(typeof a.icon, 'string');
    assert.ok(a.icon.length >= 1 && a.icon.length <= 2, `${id} icon must be 1-2 glyphs`);
    assert.equal(typeof a.describe, 'string');
    assert.equal(typeof a.hold, 'boolean');
  }
  assert.equal(ABILITIES.hover.cooldown, 0);
  assert.equal(ABILITIES.dash.cooldown, 2);
  assert.equal(ABILITIES.slowmo.cooldown, 15);
  assert.equal(ABILITIES.diamond.cooldown, 14);
  assert.equal(ABILITIES.psychic.cooldown, 12);
});

/* ------------------------------------------------------------------ cooldowns */

test('cooldown blocks re-fire and drains to ready', () => {
  const s = fakeState('quicksilver');
  const ctx = makeCtx(s);
  assert.equal(useAbility(s, 'dash', ctx), true);
  assert.equal(useAbility(s, 'dash', ctx), false, 'second dash must be blocked');
  assert.ok(abilityCooldown('dash') > 0.9);
  step(s, 0.1, 10);                    // 1 s
  assert.ok(abilityCooldown('dash') > 0.4 && abilityCooldown('dash') < 0.6);
  step(s, 0.1, 12);                    // past 2 s
  assert.equal(abilityCooldown('dash'), 0);
  assert.equal(useAbility(s, 'dash', ctx), true);
});

test('abilityState reports active effect and remaining time', () => {
  const s = fakeState('emma');
  useAbility(s, 'diamond', makeCtx(s));
  let st = abilityState('diamond');
  assert.equal(st.active, true);
  assert.ok(Math.abs(st.remaining - 6) < 1e-6);
  step(s, 0.5, 4);
  st = abilityState('diamond');
  assert.ok(st.remaining > 3.9 && st.remaining < 4.1);
  assert.equal(abilityState('nonsense').active, false);
});

/* ------------------------------------------------------------------ claws / melee */

test('melee damage table and 110-degree arc', () => {
  const s = fakeState();
  const front = fakeEnemy('front', 0, 0, -2);
  const behind = fakeEnemy('behind', 0, 0, 2);
  const far = fakeEnemy('far', 0, 0, -5);
  s.enemies.push(front, behind, far);
  const ctx = makeCtx(s);
  const hits = meleeAttack(s, ctx, 0);
  assert.deepEqual(hits.map((e) => e.id), ['front']);
  assert.equal(front.hp, 100 - MELEE.damage[0]);
  assert.equal(behind.hp, 100);
  assert.equal(far.hp, 100);
  meleeAttack(s, ctx, 1);
  assert.equal(front.hp, 100 - 18 - 22);
});

test('claws multiply melee damage by 1.6 and apply 5 dps bleed for 3 s', () => {
  const s = fakeState();
  const rig = fakeRig();
  const ctx = makeCtx(s, rig);
  const e = fakeEnemy('e1', 0, 0, -2, 200);
  s.enemies.push(e);

  meleeAttack(s, ctx, 0);
  assert.equal(e.hp, 200 - 18);

  assert.equal(useAbility(s, 'claws', ctx), true);
  assert.deepEqual(rig.calls.at(-1), ['claws', true]);
  const before = e.hp;
  meleeAttack(s, ctx, 0);
  assert.ok(Math.abs((before - e.hp) - 18 * 1.6) < 1e-6, 'claw hit should be 28.8');
  assert.ok(e.bleed && e.bleed.dps === 5 && Math.abs(e.bleed.t - 3) < 1e-6);

  const hpAfterHit = e.hp;
  step(s, 0.1, 10);                     // 1 s of bleed
  assert.ok(Math.abs((hpAfterHit - e.hp) - 5) < 1e-6, 'bleed ticks 5 hp/s');
  step(s, 0.1, 30);                     // bleed expires after 3 s total
  assert.ok(Math.abs((hpAfterHit - e.hp) - 15) < 1e-6);
  assert.equal(e.bleed, null);

  // claws retract after 8 s
  step(s, 0.5, 12);
  assert.equal(s.player.clawsTimer, 0);
  assert.deepEqual(rig.calls.at(-1), ['claws', false]);
});

test('third combo hit knocks the target back', () => {
  const s = fakeState();
  const e = fakeEnemy('e', 0, 0, -2);
  s.enemies.push(e);
  meleeAttack(s, makeCtx(s), 2);
  assert.equal(e.hp, 100 - 30);
  assert.ok(e.vel.z < -1, 'pushed away along the attack direction');
  assert.ok(e.vel.y > 0);
  assert.equal(e.state, 'stagger');
});

/* ------------------------------------------------------------------ regen */

test('regen heals 40 hp over 4 s, capped at maxHp', () => {
  const s = fakeState();
  s.player.hp = 100; s.player.maxHp = 160;
  assert.equal(useAbility(s, 'regen', makeCtx(s)), true);
  step(s, 0.1, 20);                      // 2 s
  assert.ok(Math.abs(s.player.hp - 120) < 1e-6);
  step(s, 0.1, 30);                      // past 4 s
  assert.ok(Math.abs(s.player.hp - 140) < 1e-6);
  assert.equal(s.player.regen, null);
  assert.equal(applyRegen(s, 0.1), 0);

  s.player.hp = 150;
  s.player.regen = { t: 4, rate: 10 };
  step(s, 0.5, 10);
  assert.equal(s.player.hp, 160, 'never overheals');
});

/* ------------------------------------------------------------------ dash */

test('dash covers 25 m in 0.25 s and knocks enemies down', () => {
  const s = fakeState('quicksilver');
  const e = fakeEnemy('goon', 0, 0, -10);
  s.enemies.push(e);
  const ctx = makeCtx(s);
  assert.equal(useAbility(s, 'dash', ctx), true);
  step(s, 1 / 60, 20);                   // > 0.25 s
  assert.ok(Math.abs(s.player.pos.z + 25) < 0.01, `travelled ${-s.player.pos.z} m`);
  assert.equal(e.knockedDown, true);
  assert.equal(e.state, 'stagger');
  assert.equal(e.hp, 100, 'dash knocks down but does not damage');
  assert.equal(s.player.dashing, false);
});

/* ------------------------------------------------------------------ slow-mo */

test('slow-mo sets timeScale 0.25 for 3 s then eases back to 1', () => {
  const s = fakeState('quicksilver');
  assert.equal(useAbility(s, 'slowmo', makeCtx(s)), true);
  assert.equal(s.timeScale, 0.25);
  step(s, 0.1, 25);                      // 2.5 s in
  assert.equal(s.timeScale, 0.25);
  step(s, 0.1, 8);                       // 3.3 s: easing
  assert.ok(s.timeScale > 0.25 && s.timeScale < 1, `mid-ease ${s.timeScale}`);
  step(s, 0.1, 8);                       // done
  assert.equal(s.timeScale, 1);
});

/* ------------------------------------------------------------------ telekinesis */

test('telekinesis grabs the nearest prop in the cone, floats it, then throws at 28 m/s', () => {
  const s = fakeState('jean');
  const mesh = new THREE.Object3D();
  mesh.position.set(0, 0.45, -5);
  const prop = new PhysicsProp(mesh, 35, { kind: 'crate', size: PROP_KINDS.crate.size });
  const behind = new PhysicsProp(Object.assign(new THREE.Object3D(), {}), 35, { kind: 'crate', size: PROP_KINDS.crate.size });
  behind.pos.set(0, 0.45, 4);
  s.props.push(prop, behind);
  const ctx = makeCtx(s);

  assert.equal(useAbility(s, 'telekinesis', ctx), true);
  assert.equal(prop.held, true);
  assert.equal(behind.held, false, 'objects outside the 60-degree cone are ignored');
  assert.equal(getHeld(), prop);

  step(s, 1 / 60, 60);                   // 1 s of following
  assert.ok(Math.abs(prop.pos.z + 2.5) < 0.2, `held 2.5 m in front, got ${prop.pos.z}`);
  assert.ok(Math.abs(prop.pos.y - 1.5) < 0.2, `held at 1.5 m, got ${prop.pos.y}`);

  assert.equal(useAbility(s, 'telekinesis', ctx), true, 'second press throws');
  assert.equal(getHeld(), null);
  assert.equal(prop.held, false);
  assert.ok(Math.abs(prop.vel.length() - 28) < 1e-6, `throw speed ${prop.vel.length()}`);
  assert.ok(prop.vel.z < -27, 'thrown along the camera direction');
  assert.ok(abilityCooldown('telekinesis') > 0);
});

test('telekinesis holds an enemy as controlled at 10 dps and clearing held throws it', () => {
  const s = fakeState('jean');
  const e = fakeEnemy('tk', 0, 0, -6);
  s.enemies.push(e);
  const ctx = makeCtx(s);
  assert.equal(useAbility(s, 'telekinesis', ctx), true);
  assert.equal(e.state, 'controlled');
  assert.equal(e.controlledBy, 'jean');
  step(s, 0.1, 10);                      // 1 s held
  assert.ok(Math.abs((100 - e.hp) - 10) < 1e-6, `held enemy takes 10 dps, hp ${e.hp}`);

  e.held = false;                        // somebody else cleared the flag -> throw
  step(s, 0.1);
  assert.equal(getHeld(), null);
  assert.ok(Math.abs(e.vel.length() - 28) < 1e-6);
});

/* ------------------------------------------------------------------ cyclops */

test('optic blast does 45 dps to the nearest enemy and is capped at 60 m', () => {
  const s = fakeState('cyclops');
  const rig = fakeRig();
  const ctx = makeCtx(s, rig);
  const near = fakeEnemy('near', 0, 0, -10, 500);
  const far = fakeEnemy('far', 0, 0, -70, 500);
  s.enemies.push(near, far);

  assert.equal(useAbility(s, 'blast', ctx), true);
  assert.equal(rig.visor, 1);
  step(s, 0.1, 10);                      // 1 s of beam
  assert.ok(Math.abs((500 - near.hp) - 45) < 1e-6, `hp ${near.hp}`);
  assert.equal(far.hp, 500, 'nothing past 60 m is hit');
  const beam = getBeam();
  assert.equal(beam.active, true);
  assert.ok(beam.length <= 60 && beam.length > 9);

  assert.equal(releaseAbility(s, 'blast'), true);
  assert.equal(rig.visor, 0);
  assert.equal(getBeam().active, false);
  assert.ok(abilityCooldown('blast') > 0);

  // aimed at nothing, the beam reaches its 60 m cap
  s.enemies.length = 0;
  step(s, 1);
  useAbility(s, 'blast', ctx);
  step(s, 1 / 60);
  assert.ok(Math.abs(getBeam().length - 60) < 1e-6);
  releaseAbility(s, 'blast');
});

test('sweep burns a 90-degree cone for 60 damage with knockback', () => {
  const s = fakeState('cyclops');
  const inCone = fakeEnemy('in', 3, 0, -3);
  const side = fakeEnemy('side', 8, 0, 1);
  const far = fakeEnemy('far', 0, 0, -20);
  s.enemies.push(inCone, side, far);
  assert.equal(useAbility(s, 'sweep', makeCtx(s)), true);
  assert.equal(inCone.hp, 40);
  assert.equal(side.hp, 100);
  assert.equal(far.hp, 100);
  assert.ok(inCone.vel.lengthSq() > 1);
  assert.equal(abilityCooldown('sweep'), 1);
});

/* ------------------------------------------------------------------ emma */

test('diamond form blocks all damage for 6 s, slows the player, then wears off', () => {
  const s = fakeState('emma');
  const rig = fakeRig();
  s.player.hp = 100;
  assert.equal(useAbility(s, 'diamond', makeCtx(s, rig)), true);
  assert.equal(rig.diamond, true);
  assert.ok(Math.abs(s.player.speedMul - 0.7) < 1e-9);

  assert.equal(damageEntity(s, s.player, 35, 'thug'), 0);
  assert.equal(s.player.hp, 100);

  step(s, 0.5, 13);                      // past 6 s
  assert.equal(rig.diamond, false);
  assert.equal(s.player.invulnerable, false);
  assert.equal(s.player.speedMul, 1);
  assert.equal(damageEntity(s, s.player, 35, 'thug'), 35);
  assert.equal(s.player.hp, 65);
});

test('psychic marks enemies within 12 m as controlled by emma for 5 s', () => {
  const s = fakeState('emma');
  s.time = 10;
  const near = fakeEnemy('a', 0, 0, -5);
  const edge = fakeEnemy('b', 11, 0, 0);
  const out = fakeEnemy('c', 0, 0, 20);
  const dead = fakeEnemy('d', 1, 0, 1, 0);
  dead.state = 'dead';
  s.enemies.push(near, edge, out, dead);

  const toasts = capture('toast');
  assert.equal(useAbility(s, 'psychic', makeCtx(s)), true);
  toasts.off();

  for (const e of [near, edge]) {
    assert.equal(e.state, 'controlled');
    assert.equal(e.controlledBy, 'emma');
    assert.ok(Math.abs(e.controlledUntil - 15) < 1e-6, 'controlledUntil is absolute game time');
  }
  assert.equal(out.state, 'idle');
  assert.equal(out.controlledBy, undefined);
  assert.equal(dead.state, 'dead');
  assert.equal(toasts.got.length, 1);
  assert.ok(/2 minds/.test(toasts.got[0].text));
});

/* ------------------------------------------------------------------ hover + events */

test('hover is a free ability the controller drives', () => {
  const s = fakeState('jean');
  const evts = capture('ability');
  assert.equal(useAbility(s, 'hover', makeCtx(s)), true);
  assert.equal(useAbility(s, 'hover', makeCtx(s)), true, 'no cooldown');
  evts.off();
  assert.equal(evts.got.length, 2);
  assert.equal(evts.got[0].name, 'hover');
  assert.equal(evts.got[0].character, 'jean');
});

test('melee emits hit and sfx events', () => {
  const s = fakeState();
  const e = fakeEnemy('x', 0, 0, -2);
  s.enemies.push(e);
  const hits = capture('hit');
  const sfx = capture('sfx');
  meleeAttack(s, makeCtx(s), 0);
  hits.off(); sfx.off();
  assert.equal(hits.got.length, 1);
  assert.equal(hits.got[0].targetId, 'x');
  assert.equal(hits.got[0].damage, 18);
  assert.equal(hits.got[0].source, 'melee');
  assert.ok(sfx.got.length >= 2);
});

test('unknown abilities never fire', () => {
  const s = fakeState();
  assert.equal(useAbility(s, 'magneto', makeCtx(s)), false);
  assert.equal(abilityCooldown('magneto'), 0);
});

/* ------------------------------------------------------------------ props */

test('a thrown prop follows a ballistic arc and comes to rest on the ground', () => {
  const city = fakeCity(3);                       // ground at y = 3
  const mesh = new THREE.Object3D();
  mesh.position.set(0, 3.45, 0);
  const prop = new PhysicsProp(mesh, 35, { kind: 'crate', size: PROP_KINDS.crate.size });
  const s = fakeState();
  s.city = city;

  prop.throwWith(new THREE.Vector3(0, 8, -20));
  let peak = prop.pos.y;
  for (let i = 0; i < 600; i++) {
    prop.update(1 / 60, city, s);
    peak = Math.max(peak, prop.pos.y);
  }
  assert.ok(peak > 4.5, `should arc upward, peak ${peak}`);
  assert.ok(Math.abs(prop.pos.y - (3 + 0.45)) < 1e-6, `rests on the ground, y ${prop.pos.y}`);
  assert.ok(prop.pos.z < -5, 'kept its horizontal travel');
  assert.equal(prop.asleep, true);
  assert.ok(prop.vel.length() < 0.05);
  assert.ok(Math.abs(mesh.position.y - prop.pos.y) < 1e-9, 'mesh follows the body');
});

test('a fast prop smashes enemies within 1.5 m, once each', () => {
  const s = fakeState();
  const e = fakeEnemy('hit-me', 0, 0, -4, 500);
  s.enemies.push(e);
  const mesh = new THREE.Object3D();
  mesh.position.set(0, 0.9, 0);
  const prop = new PhysicsProp(mesh, 35, { kind: 'crate', size: PROP_KINDS.crate.size });
  prop.throwWith(new THREE.Vector3(0, 0, -25));
  for (let i = 0; i < 30; i++) prop.update(1 / 60, s.city, s);
  assert.ok(e.hp < 500, 'took impact damage');
  const once = e.hp;
  for (let i = 0; i < 30; i++) prop.update(1 / 60, s.city, s);
  assert.equal(e.hp, once, 'a single throw only hits each enemy once');
});

test('a slow prop does not hurt anyone', () => {
  const s = fakeState();
  const e = fakeEnemy('safe', 0, 0, -1, 100);
  s.enemies.push(e);
  const mesh = new THREE.Object3D();
  mesh.position.set(0, 0.45, 0);
  const prop = new PhysicsProp(mesh, 35, { kind: 'crate', size: PROP_KINDS.crate.size });
  prop.throwWith(new THREE.Vector3(0, 0, -2));
  for (let i = 0; i < 60; i++) prop.update(1 / 60, s.city, s);
  assert.equal(e.hp, 100);
});

test('held props are suspended and buildings stop a thrown prop', () => {
  const s = fakeState();
  const mesh = new THREE.Object3D();
  mesh.position.set(0, 0.45, 0);
  const prop = new PhysicsProp(mesh, 35, { kind: 'crate', size: PROP_KINDS.crate.size });
  prop.grab();
  prop.held = true;
  prop.vel.set(0, 10, 0);
  const y = prop.pos.y;
  prop.update(0.5, s.city, s);
  assert.equal(prop.pos.y, y, 'no physics while held');

  const wall = Object.assign(fakeCity(0), {
    collideCapsule(pos, r, h, out) { out.copy(pos); out.z = Math.max(pos.z, -3); return pos.z < -3; },
  });
  prop.held = false;
  prop.throwWith(new THREE.Vector3(0, 0, -25));
  for (let i = 0; i < 60; i++) prop.update(1 / 60, wall, s);
  assert.ok(prop.pos.z >= -3.001, `stopped by the wall at ${prop.pos.z}`);
});

test('damageEntity kills the player and flips the phase', () => {
  const s = fakeState();
  s.player.hp = 10;
  const phases = capture('phase');
  const dealt = damageEntity(s, s.player, 40, 'sentinel');
  phases.off();
  assert.equal(dealt, 10);
  assert.equal(s.player.hp, 0);
  assert.equal(s.phase, 'gameover');
  assert.deepEqual(phases.got, [{ phase: 'gameover' }]);
});
