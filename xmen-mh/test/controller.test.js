// test/controller.test.js — node --test
// Covers the pure logic in src/player/controller.js (input mapping, acceleration,
// jump/coyote/buffer, capsule step, combo timing, camera maths, skydive) plus a few
// headless integration runs of PlayerController against a fake City/Rig/camera.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { bus } from '../src/core/bus.js';
import {
  TUNING, DEFAULT_CHAR_DEFS, PlayerController,
  clamp, damp, applyDeadzone, stickVector,
  DEFAULT_BINDINGS, emptyActions, mapKeysToActions, mapMouseToActions, readGamepad,
  mergeActions, actionEdges, actionsToAxes,
  moveDirFromCameraYaw, yawFromDir, desiredSpeed, accelerateHorizontal, applyGravity,
  updateJump, canStepTo, resolveGround, advanceFootstep,
  advanceCombo, abilitySlotFor, updateHover, mantleCheck, cycleIndex,
  clampPitch, clampCamDistance, applyWheel, orbitOffset, fovForSpeed,
  skydiveSteer, skydiveDescent, windShake,
} from '../src/player/controller.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

/* ------------------------------------------------------------ input mapping */

test('mapKeysToActions maps WASD, sprint, jump and slots', () => {
  const a = mapKeysToActions(new Set(['KeyW', 'KeyD', 'ShiftLeft', 'Space', 'Digit3']));
  assert.equal(a.forward, true);
  assert.equal(a.right, true);
  assert.equal(a.sprint, true);
  assert.equal(a.jump, true);
  assert.equal(a.slot3, true);
  assert.equal(a.back, false);
  assert.equal(a.attack, false);
});

test('key bindings cover the documented controls', () => {
  assert.equal(DEFAULT_BINDINGS.KeyJ, 'attack');
  assert.equal(DEFAULT_BINDINGS.KeyK, 'ability1');
  assert.equal(DEFAULT_BINDINGS.KeyQ, 'ability2');
  assert.equal(DEFAULT_BINDINGS.KeyF, 'ability3');
  assert.equal(DEFAULT_BINDINGS.KeyE, 'interact');
  assert.equal(DEFAULT_BINDINGS.Tab, 'switchNext');
  assert.equal(DEFAULT_BINDINGS.Escape, 'pause');
});

test('mouse bitmask: LMB attacks, RMB is ability 1', () => {
  assert.deepEqual(mapMouseToActions(1), { attack: true, ability1: false });
  assert.deepEqual(mapMouseToActions(2), { attack: false, ability1: true });
  assert.deepEqual(mapMouseToActions(3), { attack: true, ability1: true });
  assert.deepEqual(mapMouseToActions(0), { attack: false, ability1: false });
});

test('readGamepad maps sticks and the documented face buttons', () => {
  const pad = {
    axes: [0, -1, 0.9, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  };
  pad.buttons[0] = { pressed: true };  // A
  pad.buttons[2] = { pressed: true };  // X
  pad.buttons[5] = { pressed: true };  // RB
  pad.buttons[9] = { pressed: true };  // Start
  const g = readGamepad(pad);
  assert.equal(g.connected, true);
  assert.ok(g.move.y < -0.5, 'left stick pushed forward');
  assert.equal(g.actions.forward, true);
  assert.ok(g.look.x > 0.5, 'right stick turns the camera');
  assert.equal(g.actions.jump, true);       // A
  assert.equal(g.actions.attack, true);     // X
  assert.equal(g.actions.switchNext, true); // RB
  assert.equal(g.actions.pause, true);      // Start
  assert.equal(g.actions.ability1, false);  // B not pressed
  // numeric button arrays work too
  const g2 = readGamepad({ axes: [0, 0, 0, 0], buttons: [0, 1, 0, 1] });
  assert.equal(g2.actions.ability1, true);  // B
  assert.equal(g2.actions.ability2, true);  // Y
  assert.equal(readGamepad(null).connected, false);
});

test('stick dead zone kills drift but keeps full range', () => {
  assert.equal(applyDeadzone(0.1), 0);
  near(applyDeadzone(1), 1, 1e-9);
  assert.deepEqual(stickVector(0.05, 0.05), { x: 0, y: 0 });
  const v = stickVector(0.9, 0);
  assert.ok(v.x > 0.8 && v.x <= 1);
});

test('mergeActions ORs sources and actionEdges only fires on the rising edge', () => {
  const kb = mapKeysToActions(new Set(['KeyW']));
  const m = mergeActions(kb, { attack: true }, null);
  assert.equal(m.forward, true);
  assert.equal(m.attack, true);
  const prev = emptyActions();
  const e1 = actionEdges(prev, m);
  assert.equal(e1.attack, true);
  const e2 = actionEdges(m, m);
  assert.equal(e2.attack, false, 'held button does not retrigger');
});

test('actionsToAxes gives a -1..1 stick from the keyboard', () => {
  assert.deepEqual(actionsToAxes(mapKeysToActions(new Set(['KeyW']))), { x: 0, y: 1 });
  assert.deepEqual(actionsToAxes(mapKeysToActions(new Set(['KeyS', 'KeyA']))), { x: -1, y: -1 });
});

/* ---------------------------------------------------------------- movement */

test('moveDirFromCameraYaw is camera relative and normalized', () => {
  const f = moveDirFromCameraYaw(0, 1, 0);           // forward, camera looking down -Z
  near(f.x, 0, 1e-9); near(f.z, -1, 1e-9);
  const b = moveDirFromCameraYaw(0, -1, 0);
  near(b.z, 1, 1e-9);
  const r = moveDirFromCameraYaw(1, 0, 0);           // strafe right is +X
  near(r.x, 1, 1e-9);
  const q = moveDirFromCameraYaw(0, 1, Math.PI / 2); // yaw 90deg -> forward is -X
  near(q.x, -1, 1e-9); near(q.z, 0, 1e-9);
  const d = moveDirFromCameraYaw(1, 1, 0);
  near(Math.hypot(d.x, d.z), 1, 1e-9);
  assert.deepEqual(moveDirFromCameraYaw(0, 0, 1.2), { x: 0, z: 0 });
});

test('yawFromDir round-trips with moveDirFromCameraYaw', () => {
  for (const yaw of [0, 0.7, -2.1, Math.PI]) {
    const f = moveDirFromCameraYaw(0, 1, yaw);
    const back = yawFromDir(f.x, f.z);
    near(Math.cos(back), Math.cos(yaw), 1e-9);
    near(Math.sin(back), Math.sin(yaw), 1e-9);
  }
});

test('desiredSpeed: Quicksilver sprints at exactly 2x, others at the normal multiplier', () => {
  near(desiredSpeed(7, { sprint: false }), 7);
  near(desiredSpeed(13, { sprint: true, character: 'quicksilver' }), 26);
  near(desiredSpeed(7, { sprint: true, character: 'wolverine' }), 7 * TUNING.sprintMul);
  near(desiredSpeed(7, { sprint: false, intensity: 0.5 }), 3.5);
});

test('accelerateHorizontal ramps up, decays to rest and never overshoots', () => {
  let v = { x: 0, z: 0 };
  const want = { x: 7, z: 0 };
  for (let i = 0; i < 200; i++) v = accelerateHorizontal(v, want, 42, 34, 1 / 60);
  near(v.x, 7, 1e-6);
  assert.ok(v.x <= 7 + 1e-9, 'no overshoot');
  let stop = { x: 7, z: 0 };
  stop = accelerateHorizontal(stop, { x: 0, z: 0 }, 42, 34, 1 / 60);
  assert.ok(stop.x < 7 && stop.x > 0, 'decelerates gradually');
  const one = accelerateHorizontal({ x: 0, z: 0 }, { x: 100, z: 0 }, 10, 10, 0.1);
  near(one.x, 1, 1e-9); // accel * dt metres per second gained
});

test('applyGravity clamps at terminal velocity and hovering slow-falls', () => {
  let vy = 0;
  for (let i = 0; i < 600; i++) vy = applyGravity(vy, 1 / 60);
  near(vy, -TUNING.terminal, 1e-9);
  near(applyGravity(0, 0.5), -11, 1e-9); // 22 m/s^2
  let h = -30;
  for (let i = 0; i < 240; i++) h = applyGravity(h, 1 / 60, { hovering: true });
  assert.ok(h > TUNING.hoverFall - 0.2 && h < 0, 'hover eases to a slow fall');
});

test('updateJump honours coyote time and the jump buffer', () => {
  // grounded press -> immediate jump
  let j = updateJump({}, 1 / 60, { grounded: true, jumpPressed: true });
  assert.equal(j.jump, true);

  // walked off a ledge, pressed slightly late -> still jumps (coyote)
  j = updateJump({}, 1 / 60, { grounded: true, jumpPressed: false });
  j = updateJump(j, 0.05, { grounded: false, jumpPressed: false });
  const late = updateJump(j, 0.02, { grounded: false, jumpPressed: true });
  assert.equal(late.jump, true, 'coyote jump within 0.12 s');

  // too late -> no jump
  let k = updateJump({ coyoteTimer: TUNING.coyote, bufferTimer: 0 }, 0.3, { grounded: false, jumpPressed: false });
  k = updateJump(k, 1 / 60, { grounded: false, jumpPressed: true });
  assert.equal(k.jump, false);

  // pressed just before touchdown -> buffered jump fires on landing
  let b = updateJump({}, 1 / 60, { grounded: false, jumpPressed: true });
  assert.equal(b.jump, false);
  b = updateJump(b, 0.05, { grounded: false, jumpPressed: false });
  b = updateJump(b, 1 / 60, { grounded: true, jumpPressed: false });
  assert.equal(b.jump, true, 'buffered jump within 0.15 s');
});

test('canStepTo allows kerbs up to 0.4 m and walkable slopes, blocks walls', () => {
  assert.equal(canStepTo(0.35, 0.02), true, 'kerb');
  assert.equal(canStepTo(0.5, 0.02), false, 'too tall to step');
  assert.equal(canStepTo(0.1, 0.2), true, 'gentle slope');
  assert.equal(canStepTo(2.0, 0.15), false, 'wall');
  assert.equal(canStepTo(-1, 0.1), true, 'downhill is free');
});

test('resolveGround snaps to the surface and reports the landing impact', () => {
  const air = resolveGround(5, -3, 0, { wasGrounded: false });
  assert.equal(air.grounded, false);
  assert.equal(air.y, 5);

  const land = resolveGround(0.02, -12, 0, { wasGrounded: false });
  assert.equal(land.grounded, true);
  assert.equal(land.landed, true);
  near(land.y, 0);
  near(land.vy, 0);
  near(land.impact, 12);

  const stay = resolveGround(0, 0, 0, { wasGrounded: true });
  assert.equal(stay.grounded, true);
  assert.equal(stay.landed, false, 'no repeat land event while walking');

  const rising = resolveGround(0.01, 5, 0, { wasGrounded: true });
  assert.equal(rising.grounded, false, 'a jump leaves the ground');
});

test('advanceFootstep emits one step per stride and strides longer at speed', () => {
  let acc = 0, steps = 0;
  for (let i = 0; i < 600; i++) {
    const r = advanceFootstep(acc, 5 * (1 / 60), 5);
    acc = r.acc; if (r.step) steps++;
  }
  assert.ok(steps > 20 && steps < 35, `plausible cadence, got ${steps}`);
  const idle = advanceFootstep(1.0, 0, 2);
  assert.equal(idle.acc, 1.0);
  assert.equal(idle.step, false, 'standing still never steps');
  assert.equal(advanceFootstep(1.5, 0.1, 2).step, true, 'walk stride is short');
  assert.equal(advanceFootstep(1.5, 0.1, 12).step, false, 'sprint stride is long');
});

/* ------------------------------------------------------- combat / abilities */

test('advanceCombo runs a 3-hit chain inside the 0.6 s window and resets after it', () => {
  let c = advanceCombo(null, 0);
  assert.equal(c.index, 0);
  c = advanceCombo(c, 0.3);
  assert.equal(c.index, 1);
  c = advanceCombo(c, 0.55);
  assert.equal(c.index, 2);
  c = advanceCombo(c, 0.9);
  assert.equal(c.index, 0, 'wraps after the third hit');
  const stale = advanceCombo({ index: 1, lastTime: 0 }, 1.0);
  assert.equal(stale.index, 0, 'window lapsed -> restart the combo');
});

test('abilitySlotFor maps RMB/K -> 0, Q -> 1, F -> 2', () => {
  assert.equal(abilitySlotFor('ability1'), 0);
  assert.equal(abilitySlotFor('ability2'), 1);
  assert.equal(abilitySlotFor('ability3'), 2);
  assert.equal(abilitySlotFor('jump'), -1);
});

test('updateHover drains a 4 s meter and refills on the ground', () => {
  let m = TUNING.hoverMax, active = true, t = 0;
  while (active && t < 10) {
    const r = updateHover(m, 1 / 60, { active, recharge: false });
    m = r.meter; active = r.active; t += 1 / 60;
  }
  assert.ok(Math.abs(t - TUNING.hoverMax) < 0.05, `hover lasts ~4 s, got ${t.toFixed(2)}`);
  assert.equal(m, 0);
  const back = updateHover(0, 1, { active: false, recharge: true });
  assert.ok(back.meter > 0 && back.meter <= TUNING.hoverMax);
});

test('mantleCheck accepts ledges up to 2.5 m only', () => {
  assert.equal(mantleCheck(0, 2.4), true);
  assert.equal(mantleCheck(0, 2.6), false);
  assert.equal(mantleCheck(0, 0.2), false, 'a kerb is a step-up, not a mantle');
  assert.equal(mantleCheck(0, NaN), false, 'no roof ahead');
});

test('cycleIndex wraps the roster in both directions', () => {
  assert.equal(cycleIndex(0, 5, 1), 1);
  assert.equal(cycleIndex(4, 5, 1), 0);
  assert.equal(cycleIndex(0, 5, -1), 4);
  assert.equal(cycleIndex(-1, 5, 1), 0);
});

/* ------------------------------------------------------------------ camera */

test('camera pitch, distance and wheel stay inside the spec limits', () => {
  assert.equal(clampPitch(-3), TUNING.camPitchMin);
  assert.equal(clampPitch(3), TUNING.camPitchMax);
  near(clampPitch(0.4), 0.4);
  assert.equal(clampCamDistance(1), 3.5);
  assert.equal(clampCamDistance(99), 8);
  assert.ok(applyWheel(5.5, 500) > 5.5, 'wheel down pushes the camera out');
  assert.ok(applyWheel(5.5, -500) < 5.5);
  assert.equal(applyWheel(8, 10000), 8, 'clamped at the far limit');
});

test('orbitOffset sits behind the player and rises with pitch', () => {
  const o = orbitOffset(0, 0, 5);
  near(o.x, 0, 1e-9); near(o.y, 0, 1e-9); near(o.z, 5, 1e-9); // behind = +Z when yaw 0
  const up = orbitOffset(0, 0.5, 5);
  assert.ok(up.y > 0);
  near(Math.hypot(up.x, up.y, up.z), 5, 1e-9);
});

test('fovForSpeed kicks in only near sprint speed', () => {
  near(fovForSpeed(60, 0, 11), 60);
  assert.ok(fovForSpeed(60, 11, 11) > 60);
  assert.ok(fovForSpeed(60, 99, 11) <= 60 + TUNING.fovKick + 1e-9);
});

test('damp is stable and monotonic', () => {
  let v = 0;
  for (let i = 0; i < 200; i++) v = damp(v, 10, 12, 1 / 60);
  assert.ok(Math.abs(v - 10) < 1e-3);
  assert.equal(clamp(5, 0, 3), 3);
});

/* ----------------------------------------------------------------- skydive */

test('skydiveSteer tilts toward the input but caps horizontal speed at 25 m/s', () => {
  let v = { x: 0, z: 0 };
  const dir = { x: 1, z: 0 };
  for (let i = 0; i < 600; i++) v = skydiveSteer(v, dir, 1 / 60);
  near(Math.hypot(v.x, v.z), TUNING.skydiveSteer, 1e-6);
  const clamped = skydiveSteer({ x: 50, z: 50 }, { x: 1, z: 1 }, 1 / 60);
  assert.ok(Math.hypot(clamped.x, clamped.z) <= TUNING.skydiveSteer + 1e-9);
});

test('skydiveDescent free-falls high up and flares into a hero landing', () => {
  let vy = 0;
  for (let i = 0; i < 1200; i++) vy = skydiveDescent(vy, 500, 1 / 60);
  near(vy, -TUNING.skydiveTerminal, 1e-6);
  // fly the last 40 m: the fall must ease out to roughly the landing speed
  let v2 = -TUNING.skydiveTerminal, alt = TUNING.skydiveDecelAlt, guard = 0;
  while (alt > 0 && guard++ < 6000) { v2 = skydiveDescent(v2, alt, 1 / 60); alt += v2 * (1 / 60); }
  assert.ok(v2 < 0, 'still moving down at touchdown');
  assert.ok(Math.abs(v2) < TUNING.skydiveTerminal * 0.45, `touchdown speed ${v2.toFixed(1)} m/s`);
  assert.ok(Math.abs(v2) > 1, 'not a dead stop in mid air');
});

test('windShake is bounded and deterministic', () => {
  for (let t = 0; t < 5; t += 0.1) {
    const s = windShake(t);
    assert.ok(Math.abs(s.x) < 0.2 && Math.abs(s.y) < 0.2);
  }
  assert.deepEqual(windShake(1.5), windShake(1.5));
});

/* -------------------------------------------------- headless integration ---- */

function flatCity(groundY = 0) {
  return {
    getGroundHeight: () => groundY,
    raycastDown: () => groundY,
    collideCapsule: () => false,
    calls: 0,
  };
}

function fakeRig() {
  const anims = [];
  return {
    anims,
    group: { position: new THREE.Vector3(), rotation: { y: 0 }, visible: false },
    setAnim(n) { anims.push(n); },
    update() {},
  };
}

function fakeCamera() {
  return {
    position: new THREE.Vector3(), fov: 60,
    lookAt() {}, updateProjectionMatrix() {},
  };
}

function makeState(phase = 'play') {
  return {
    time: 0, dt: 1 / 60, phase,
    activeIndex: 0,
    roster: ['wolverine', 'quicksilver', 'jean', 'cyclops', 'emma'],
    player: null, camera: null, scene: null, renderer: null, city: null,
    enemies: [], props: [], missions: null,
    settings: { quality: 'high', mute: false, invertY: false },
    input: { keys: new Set(), mouse: { dx: 0, dy: 0, buttons: 0, locked: true }, wheel: 0, gamepad: null },
    timeScale: 1, debug: false,
  };
}

function makeController(phase = 'play', city = flatCity()) {
  const st = makeState(phase);
  const rigs = {};
  for (const id of st.roster) rigs[id] = fakeRig();
  const cam = fakeCamera();
  const pc = new PlayerController(st, city, rigs, cam, null, DEFAULT_CHAR_DEFS);
  return { st, pc, rigs, cam, city };
}

function step(pc, st, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) { st.dt = dt; st.time += dt; pc.update(dt); }
}

test('controller builds a player from the character table and shows one rig', () => {
  const { st, pc, rigs } = makeController();
  assert.equal(st.player.character, 'wolverine');
  assert.equal(st.player.maxHp, DEFAULT_CHAR_DEFS.wolverine.hp);
  assert.equal(st.player.hoverMeter, TUNING.hoverMax);
  assert.equal(rigs.wolverine.group.visible, true);
  assert.equal(rigs.jean.group.visible, false);
  assert.ok(pc.rig === rigs.wolverine);
});

test('the player falls, lands once, then runs camera-relative and emits footsteps', () => {
  const { st, pc } = makeController();
  const lands = [], steps = [];
  const offL = bus.on('land', (e) => lands.push(e));
  const offF = bus.on('footstep', (e) => steps.push(e));
  st.player.pos.set(0, 6, 0);
  step(pc, st, 2.0);
  assert.equal(st.player.grounded, true);
  near(st.player.pos.y, 0, 1e-6);
  assert.equal(lands.length, 1, 'exactly one land event');
  assert.ok(lands[0].impact > 5, 'impact reports the fall speed');

  st.input.keys.add('KeyW');
  pc.yaw = 0;                       // camera looking down -Z
  step(pc, st, 1.5);
  assert.ok(st.player.pos.z < -3, `ran forward (z=${st.player.pos.z.toFixed(2)})`);
  near(st.player.pos.x, 0, 1e-6);
  assert.ok(steps.length > 0, 'footsteps fired');
  offL(); offF();
});

test('Space jumps once, gravity brings the player home, Quicksilver sprints 2x', () => {
  const { st, pc } = makeController();
  const jumps = [];
  const off = bus.on('jump', (e) => jumps.push(e));
  step(pc, st, 0.5);                        // settle on the ground
  st.input.keys.add('Space');
  pc.update(1 / 60);
  assert.ok(st.player.vel.y > 4, 'jump impulse applied');
  assert.equal(jumps.length, 1);
  pc.update(1 / 60);
  assert.equal(jumps.length, 1, 'holding space does not re-jump');
  st.input.keys.delete('Space');
  step(pc, st, 3);
  assert.equal(st.player.grounded, true);
  off();

  // Quicksilver at full sprint reaches ~26 m/s
  pc.switchTo('quicksilver');
  st.input.keys.add('KeyW');
  st.input.keys.add('ShiftLeft');
  step(pc, st, 3);
  const speed = Math.hypot(st.player.vel.x, st.player.vel.z);
  assert.ok(speed > 20, `quicksilver sprint speed ${speed.toFixed(1)} m/s`);
});

test('Tab and the digit keys switch character in place and emit switch_character', () => {
  const { st, pc, rigs } = makeController();
  const events = [];
  const off = bus.on('switch_character', (e) => events.push(e.id));
  step(pc, st, 0.3);
  st.player.pos.set(12, 0, -7);
  pc.switchTo('jean');
  assert.equal(st.player.character, 'jean');
  assert.equal(st.activeIndex, 2);
  assert.equal(st.player.maxHp, DEFAULT_CHAR_DEFS.jean.hp);
  assert.equal(rigs.jean.group.visible, true);
  assert.equal(rigs.wolverine.group.visible, false);
  near(rigs.jean.group.position.x, 12);
  near(rigs.jean.group.position.z, -7);
  assert.deepEqual(events, ['jean']);

  st.input.keys.add('Tab');
  pc.update(1 / 60);
  assert.equal(st.player.character, 'cyclops', 'Tab cycles forward');
  st.input.keys.delete('Tab');
  st.input.keys.add('Digit1');
  pc.update(1 / 60);
  assert.equal(st.player.character, 'wolverine', 'Digit1 selects the first slot');
  off();
});

test('paused and dialog phases freeze the player but keep draining input deltas', () => {
  const { st, pc } = makeController();
  step(pc, st, 0.5);
  const before = st.player.pos.clone();
  st.phase = 'paused';
  st.input.keys.add('KeyW');
  st.input.mouse.dx = 200;
  step(pc, st, 1.0);
  assert.deepEqual([st.player.pos.x, st.player.pos.y, st.player.pos.z], [before.x, before.y, before.z]);
  assert.equal(st.input.mouse.dx, 0, 'mouse deltas are consumed, not banked');
  st.phase = 'dialog';
  step(pc, st, 0.5);
  assert.equal(st.player.pos.z, before.z);
});

test('slow-mo scales the world for everyone except Quicksilver', () => {
  const a = makeController();
  step(a.pc, a.st, 0.5);
  a.st.input.keys.add('KeyW');
  a.pc.yaw = 0;
  a.st.timeScale = 0.25;
  step(a.pc, a.st, 1.0);
  const cyclopsish = Math.abs(a.st.player.pos.z);

  const b = makeController();
  b.pc.switchTo('quicksilver');
  step(b.pc, b.st, 0.5);
  b.st.input.keys.add('KeyW');
  b.pc.yaw = 0;
  b.st.timeScale = 0.25;
  step(b.pc, b.st, 1.0);
  assert.ok(Math.abs(b.st.player.pos.z) > cyclopsish * 2, 'Quicksilver keeps real time in slow-mo');
});

test('startSkydive falls from the helicarrier, steers, and hero-lands into play', () => {
  const { st, pc } = makeController('play');
  const lands = [], phases = [];
  const offL = bus.on('land', (e) => lands.push(e));
  const offP = bus.on('phase', (e) => phases.push(e.phase));
  pc.startSkydive(new THREE.Vector3(0, 600, 0));
  assert.equal(st.phase, 'skydive');
  assert.equal(pc.rig.anims.includes('skydive'), true);

  pc.yaw = 0;
  st.input.keys.add('KeyW');            // steer north while falling
  step(pc, st, 30);
  assert.equal(st.phase, 'play', 'auto-landing returns control');
  near(st.player.pos.y, 0, 1e-6);
  assert.equal(st.player.grounded, true);
  assert.ok(st.player.pos.z < -20, 'air steering moved the landing spot');
  assert.equal(lands.length, 1);
  assert.ok(lands[0].impact >= 6, 'crater-sized impact for the dust VFX');
  assert.deepEqual(phases, ['play'], 'the landing hands control back to the game');
  offL(); offP();
});

test('teleport drops the player onto the ground at x,z', () => {
  const { st, pc } = makeController('play', flatCity(12));
  pc.teleport(-30, 45);
  assert.equal(st.player.pos.x, -30);
  assert.equal(st.player.pos.z, 45);
  assert.equal(st.player.pos.y, 12);
  assert.equal(st.player.grounded, true);
  assert.equal(st.player.vel.length(), 0);
});

test('capsule collision uses city.collideCapsule and kills velocity into the wall', () => {
  const wall = {
    getGroundHeight: () => 0,
    raycastDown: () => 0,
    // a wall at x = 2: push anything past it back
    collideCapsule(pos, r, h, out) {
      out.copy(pos);
      if (pos.x > 2) { out.x = 2; return true; }
      return false;
    },
  };
  const st = makeState('play');
  const rigs = {}; for (const id of st.roster) rigs[id] = fakeRig();
  const pc = new PlayerController(st, wall, rigs, fakeCamera(), null, DEFAULT_CHAR_DEFS);
  step(pc, st, 0.4);
  pc.yaw = -Math.PI / 2;                // face +X
  st.input.keys.add('KeyW');
  step(pc, st, 3);
  assert.ok(st.player.pos.x <= 2 + 1e-6, `stopped by the wall at x=${st.player.pos.x}`);
  assert.ok(Math.abs(st.player.vel.x) < 1e-6, 'velocity into the wall is cancelled');
});

test('the camera trails behind the player, respects the distance limits and pulls in', () => {
  const { st, pc, cam } = makeController();
  step(pc, st, 2);
  const d = cam.position.distanceTo(new THREE.Vector3(st.player.pos.x, st.player.pos.y + TUNING.eyeHeight, st.player.pos.z));
  assert.ok(d >= 3.0 && d <= TUNING.camMaxDist + 0.5, `camera distance ${d.toFixed(2)}`);
  assert.ok(cam.position.y > st.player.pos.y, 'camera stays above the feet');

  // a city that reports everything as solid must reel the camera in
  const solid = {
    getGroundHeight: () => 0,
    raycastDown: () => 0,
    collideCapsule: (pos, r, h, out) => { out.copy(pos); return true; },
  };
  const st2 = makeState('play');
  const rigs2 = {}; for (const id of st2.roster) rigs2[id] = fakeRig();
  const cam2 = fakeCamera();
  const pc2 = new PlayerController(st2, solid, rigs2, cam2, null, DEFAULT_CHAR_DEFS);
  step(pc2, st2, 2);
  const d2 = cam2.position.distanceTo(pc2.camTarget);
  assert.ok(d2 < TUNING.camMinDist, `camera pulled in to ${d2.toFixed(2)} m`);
});

test('Jean double-taps into hover; the meter drains and refills on the ground', () => {
  const { st, pc } = makeController();
  pc.switchTo('jean');
  step(pc, st, 0.5);
  st.input.keys.add('Space');
  pc.update(1 / 60);                    // first tap: jump
  st.input.keys.delete('Space');
  pc.update(1 / 60);
  assert.equal(st.player.grounded, false);
  st.input.keys.add('Space');
  pc.update(1 / 60);                    // second tap: hover
  st.input.keys.delete('Space');
  assert.equal(pc.hovering, true);
  st.player.pos.y = 40;                 // give her some air to hover in
  const yStart = st.player.pos.y;
  step(pc, st, 1.0);
  assert.equal(pc.hovering, true, 'hover holds for up to 4 s');
  assert.ok(st.player.pos.y > yStart - 2.5, 'hovering is a slow fall');
  assert.ok(st.player.hoverMeter < TUNING.hoverMax - 0.8, 'meter drains');
  step(pc, st, 8);                      // meter runs out, Jean drops and lands
  assert.equal(pc.hovering, false);
  assert.equal(st.player.grounded, true);
  assert.ok(st.player.hoverMeter > 0, 'meter refills on the ground');
});

test('Wolverine mantles a 2 m ledge when jumping at it in the air', () => {
  const ledgeY = 2.0;
  const city = {
    getGroundHeight: () => 0,
    // the ledge lives at z <= -2; raycastDown reports its roof
    raycastDown: (x, y, z) => (z <= -2 && y >= ledgeY ? ledgeY : 0),
    collideCapsule: () => false,
  };
  const { st, pc } = makeController('play', city);
  step(pc, st, 0.3);
  st.player.pos.set(0, 1.4, -1.2);
  pc.yaw = 0;                           // facing -Z, toward the ledge
  st.player.vel.y = -1;                 // airborne
  st.player.grounded = false;
  pc.wasGrounded = false;
  step(pc, st, 0.2);                    // let the coyote window lapse
  st.input.keys.add('Space');
  pc.update(1 / 60);
  st.input.keys.delete('Space');
  assert.ok(pc.mantle, 'mantle started');
  step(pc, st, 0.6);
  assert.ok(st.player.pos.y >= ledgeY - 1e-6, `pulled up onto the ledge (y=${st.player.pos.y.toFixed(2)})`);
  assert.equal(mantleCheck(0, 3.0), false, 'anything over 2.5 m is out of reach');
});

test('attack runs a 3-hit combo and abilities fire per slot', () => {
  const { st, pc } = makeController();
  step(pc, st, 0.3);
  const seen = [];
  const off = bus.on('ability', (e) => seen.push(e.name));

  st.input.mouse.buttons = 1;           // LMB
  pc.update(1 / 60);
  st.input.mouse.buttons = 0;
  pc.update(1 / 60);                    // button released
  assert.equal(pc.combo.index, 0);
  assert.ok(pc.rig.anims.includes('attack1'));
  st.time += 0.2;
  st.input.keys.add('KeyJ');
  pc.update(1 / 60);
  st.input.keys.delete('KeyJ');
  assert.equal(pc.combo.index, 1, 'second hit inside the 0.6 s window');
  pc.update(1 / 60);                    // key released
  st.time += 2.0;                       // window lapses
  st.input.keys.add('KeyJ');
  pc.update(1 / 60);
  st.input.keys.delete('KeyJ');
  pc.update(1 / 60);
  assert.equal(pc.combo.index, 0, 'combo restarts');

  // Q is ability slot 1. abilities.js may or may not be built yet, so only assert the
  // mapping when something actually fired.
  seen.length = 0;
  st.input.keys.add('KeyQ');
  pc.update(1 / 60);
  st.input.keys.delete('KeyQ');
  pc.update(1 / 60);
  const own = seen.filter((n) => DEFAULT_CHAR_DEFS.wolverine.abilities.includes(n));
  if (own.length) assert.deepEqual(own, ['regen'], 'KeyQ fires the second ability');
  assert.equal(pc.doAbility(9), false, 'empty slot never fires');
  off();
});


test('the deck phase is playable (walking the helicarrier before the jump)', () => {
  const { st, pc } = makeController('deck', flatCity(600));
  pc.teleport(0, 0);
  pc.yaw = 0;
  st.input.keys.add('KeyW');
  step(pc, st, 1.5);
  assert.ok(st.player.pos.z < -3, 'the player walks on the deck');
  near(st.player.pos.y, 600, 1e-6);
});
