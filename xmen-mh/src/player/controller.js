// src/player/controller.js — Agent D
// Third-person player controller: input, camera-relative locomotion, capsule collision,
// combat/ability dispatch, character switching and the opening skydive.
//
// Everything that is pure math (acceleration, jump machine, capsule step, combo timing,
// input mapping, camera orbit maths) is exported as a side-effect free function and is
// covered by test/controller.test.js. Nothing in this file touches window/document at
// import time — DOM access only happens inside attachInput()/pollGamepad().

import * as THREE from '../../vendor/three.module.js';
import { bus } from '../core/bus.js';

// abilities.js and combat.js are authored in parallel (Agent E). Import them defensively
// so the controller — and its node tests — load even before those modules exist. The
// interfaces used are exactly the ones in docs/SPEC.md.
let _abilities = null;
let _combat = null;
try { _abilities = await import('../abilities.js'); } catch (e) { _abilities = null; }
try { _combat = await import('../combat.js'); } catch (e) { _combat = null; }
function callUseAbility(state, name, ctx) {
  if (_abilities && typeof _abilities.useAbility === 'function') return !!_abilities.useAbility(state, name, ctx);
  return false;
}
function callMelee(state, ctx, comboIndex) {
  if (_combat && typeof _combat.meleeAttack === 'function') return _combat.meleeAttack(state, ctx, comboIndex);
  return false;
}

/* ------------------------------------------------------------------ tuning */

export const TUNING = {
  gravity: 22,              // m/s^2
  terminal: 55,             // m/s downward
  radius: 0.4,              // capsule radius
  height: 1.8,              // capsule height (feet -> top of head)
  eyeHeight: 1.62,          // camera pivot above the feet
  accel: 42,                // m/s^2 ground acceleration
  airAccel: 14,
  decel: 34,
  airDecel: 3,
  stepUp: 0.4,              // kerbs
  slopeTan: 1.19,           // ~50 degrees walkable
  coyote: 0.12,
  jumpBuffer: 0.15,
  comboWindow: 0.6,
  comboHits: 3,
  attackTime: 0.34,
  sprintMul: 1.55,
  quicksilverSprintMul: 2.0,
  hoverMax: 4.0,            // Jean hover meter, seconds
  hoverFall: -1.1,          // m/s while hovering
  hoverRecharge: 0.8,       // meter seconds regained per second on the ground
  mantleMin: 0.6,
  mantleMax: 2.5,           // Wolverine ledge mantle
  mantleTime: 0.35,
  camMinDist: 3.5,
  camMaxDist: 8,
  camPitchMin: -0.9,
  camPitchMax: 1.1,
  camFollow: 12,            // spring stiffness for the look-at target
  camLambda: 14,            // spring stiffness for the camera position
  camRadius: 0.3,
  mouseSens: 0.0024,
  padLookSens: 2.6,
  wheelSens: 0.0032,
  baseFov: 60,
  fovKick: 9,
  skydiveTerminal: 58,
  skydiveSteer: 25,         // max horizontal speed while falling
  skydiveSteerAccel: 14,
  skydiveDecelAlt: 40,      // start the hero landing this far above the ground
  skydiveLandSpeed: 7,
  skydiveCamDist: 9.5,
  skydiveCamPitch: -0.62,
};

// Fallback character metadata; the real table comes from CHARACTERS (Agent C) and is
// passed in as `charDefs`.
export const DEFAULT_CHAR_DEFS = {
  wolverine: { speed: 7, jump: 5.5, hp: 160, abilities: ['claws', 'regen'] },
  quicksilver: { speed: 13, jump: 5, hp: 100, abilities: ['dash', 'slowmo'] },
  jean: { speed: 6.5, jump: 5, hp: 110, abilities: ['telekinesis', 'hover'] },
  cyclops: { speed: 7, jump: 5, hp: 120, abilities: ['blast', 'sweep'] },
  emma: { speed: 6.5, jump: 5, hp: 110, abilities: ['diamond', 'psychic'] },
};

/* ------------------------------------------------------------- pure helpers */

/** Phases in which the player walks around (main.js adds 'deck' for the helicarrier). */
export const PLAYABLE_PHASES = new Set(['play', 'intro', 'deck']);

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/** Frame-rate independent exponential smoothing towards `target`. */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * Math.max(0, dt));
}

/** Radial dead zone for an analogue stick axis. */
export function applyDeadzone(v, dz = 0.18) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/** Dead zone applied to a stick as a 2D vector (keeps diagonals honest). */
export function stickVector(x, y, dz = 0.18) {
  const mag = Math.hypot(x, y);
  if (mag <= dz) return { x: 0, y: 0 };
  const s = Math.min(1, (mag - dz) / (1 - dz)) / mag;
  return { x: x * s, y: y * s };
}

/* ------------------------------------------------------------------- input */

export const ACTIONS = [
  'forward', 'back', 'left', 'right', 'sprint', 'jump', 'attack',
  'ability1', 'ability2', 'ability3', 'interact', 'pause', 'switchNext',
  'slot1', 'slot2', 'slot3', 'slot4', 'slot5',
];

/** event.code -> action name. */
export const DEFAULT_BINDINGS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  Space: 'jump',
  KeyJ: 'attack',
  KeyK: 'ability1',
  KeyQ: 'ability2',
  KeyF: 'ability3',
  KeyE: 'interact',
  Escape: 'pause',
  Tab: 'switchNext',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5',
};

export function emptyActions() {
  const a = {};
  for (const k of ACTIONS) a[k] = false;
  return a;
}

/** Set/array of event.code -> action booleans. Pure. */
export function mapKeysToActions(keys, bindings = DEFAULT_BINDINGS, out = null) {
  const a = out || emptyActions();
  for (const k of ACTIONS) a[k] = false;
  if (!keys) return a;
  const it = typeof keys.forEach === 'function' ? keys : [];
  it.forEach((code) => { const act = bindings[code]; if (act) a[act] = true; });
  return a;
}

/** Mouse button bitmask (MouseEvent.buttons) -> actions. LMB attack, RMB ability1. */
export function mapMouseToActions(buttons = 0) {
  return { attack: (buttons & 1) !== 0, ability1: (buttons & 2) !== 0 };
}

/**
 * Standard-gamepad mapping. Pure: `pad` is any {axes:[], buttons:[]} shape, buttons may
 * be numbers or {pressed, value} objects. Returns move/look vectors plus actions.
 * A = jump, X = attack, B = ability1, Y = ability2, RB = switch, Start = pause,
 * LB = ability3, RT = sprint, left stick = move, right stick = camera.
 */
export function readGamepad(pad, opts = {}) {
  const dz = opts.deadzone ?? 0.18;
  const res = { move: { x: 0, y: 0 }, look: { x: 0, y: 0 }, actions: emptyActions(), connected: false };
  if (!pad || !pad.axes) return res;
  res.connected = true;
  const ax = pad.axes, btns = pad.buttons || [];
  const pressed = (i) => {
    const b = btns[i];
    if (b == null) return false;
    return typeof b === 'number' ? b > 0.5 : (b.pressed === true || (b.value ?? 0) > 0.5);
  };
  const mv = stickVector(ax[0] || 0, ax[1] || 0, dz);
  res.move.x = mv.x; res.move.y = mv.y;
  const lk = stickVector(ax[2] || 0, ax[3] || 0, dz);
  res.look.x = lk.x; res.look.y = lk.y;
  const a = res.actions;
  a.forward = mv.y < -0.15; a.back = mv.y > 0.15;
  a.left = mv.x < -0.15; a.right = mv.x > 0.15;
  a.jump = pressed(0);
  a.ability1 = pressed(1);       // B
  a.attack = pressed(2);         // X
  a.ability2 = pressed(3);       // Y
  a.ability3 = pressed(4);       // LB
  a.switchNext = pressed(5);     // RB
  a.sprint = pressed(7);         // RT
  a.interact = pressed(6) || pressed(10);
  a.pause = pressed(9);          // Start
  return res;
}

/** OR-merge any number of action objects. */
export function mergeActions(...parts) {
  const a = emptyActions();
  for (const p of parts) {
    if (!p) continue;
    for (const k of ACTIONS) if (p[k]) a[k] = true;
  }
  return a;
}

/** Actions that went from false to true. */
export function actionEdges(prev, cur) {
  const e = emptyActions();
  for (const k of ACTIONS) e[k] = !!cur[k] && !(prev && prev[k]);
  return e;
}

/** Analogue move intent from digital actions: {x: strafe, y: forward}. */
export function actionsToAxes(a) {
  return {
    x: (a.right ? 1 : 0) - (a.left ? 1 : 0),
    y: (a.forward ? 1 : 0) - (a.back ? 1 : 0),
  };
}

/* -------------------------------------------------------------- locomotion */

/**
 * Camera-relative movement direction. `ax` is strafe (+right), `ay` is forward (+1).
 * Yaw follows the Three.js convention: forward = (-sin yaw, 0, -cos yaw).
 * Returns a normalized {x, z} (zero vector if there is no input).
 */
export function moveDirFromCameraYaw(ax, ay, yaw) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  // forward (-s, -c), right (c, -s)
  let x = -s * ay + c * ax;
  let z = -c * ay - s * ax;
  const m = Math.hypot(x, z);
  if (m < 1e-6) return { x: 0, z: 0 };
  return { x: x / m, z: z / m };
}

/** rotation.y for an Object3D that should face along (fx, fz). */
export function yawFromDir(fx, fz) { return Math.atan2(-fx, -fz); }

/** Target ground speed for a character. Quicksilver's sprint is a full 2x. */
export function desiredSpeed(baseSpeed, opts = {}) {
  const sprint = !!opts.sprint;
  const intensity = clamp(opts.intensity ?? 1, 0, 1);
  const mul = sprint
    ? (opts.character === 'quicksilver' ? (opts.quicksilverSprintMul ?? TUNING.quicksilverSprintMul)
      : (opts.sprintMul ?? TUNING.sprintMul))
    : 1;
  return baseSpeed * mul * intensity;
}

/** Accelerate/decelerate a horizontal velocity towards `desired`. Pure, allocates one object. */
export function accelerateHorizontal(vel, desired, accel, decel, dt) {
  const dvx = desired.x - vel.x, dvz = desired.z - vel.z;
  const dmag = Math.hypot(dvx, dvz);
  if (dmag < 1e-6) return { x: desired.x, z: desired.z };
  const want = Math.hypot(desired.x, desired.z);
  const cur = Math.hypot(vel.x, vel.z);
  const rate = (want > cur - 1e-6 ? accel : decel) * Math.max(0, dt);
  const t = Math.min(1, rate / dmag);
  return { x: vel.x + dvx * t, z: vel.z + dvz * t };
}

/** Gravity integration with terminal velocity and the Jean hover override. */
export function applyGravity(vy, dt, opts = {}) {
  const g = opts.gravity ?? TUNING.gravity;
  const term = opts.terminal ?? TUNING.terminal;
  if (opts.hovering) {
    const fall = opts.hoverFall ?? TUNING.hoverFall;
    return damp(vy, fall, 6, dt);
  }
  return Math.max(-term, vy - g * dt);
}

/** Jump state machine with coyote time and an input buffer. Pure; returns a new state. */
export function updateJump(j, dt, opts = {}) {
  const coyote = opts.coyote ?? TUNING.coyote;
  const buffer = opts.buffer ?? TUNING.jumpBuffer;
  let coyoteTimer = opts.grounded ? coyote : Math.max(0, (j?.coyoteTimer ?? 0) - dt);
  let bufferTimer = opts.jumpPressed ? buffer : Math.max(0, (j?.bufferTimer ?? 0) - dt);
  let jump = false;
  if (bufferTimer > 0 && coyoteTimer > 0) { jump = true; bufferTimer = 0; coyoteTimer = 0; }
  return { coyoteTimer, bufferTimer, jump };
}

/** Can the capsule walk from its current height up to `supportY` over `horizDist` metres? */
export function canStepTo(rise, horizDist, opts = {}) {
  if (rise <= 0) return true;
  const stepUp = opts.stepUp ?? TUNING.stepUp;
  const slopeTan = opts.slopeTan ?? TUNING.slopeTan;
  return rise <= Math.max(stepUp, horizDist * slopeTan) + 1e-6;
}

/**
 * Snap the capsule onto the support surface. Returns {y, vy, grounded, landed, impact}.
 * `impact` is the downward speed at the moment of landing (0 when already grounded).
 */
export function resolveGround(y, vy, supportY, opts = {}) {
  const skin = opts.skin ?? 0.06;
  const res = { y, vy, grounded: false, landed: false, impact: 0 };
  if (vy <= 0.001 && y <= supportY + skin) {
    res.y = supportY;
    res.vy = 0;
    res.grounded = true;
    res.landed = !opts.wasGrounded;
    res.impact = Math.max(0, -vy);
  }
  return res;
}

/** Footstep accumulator: returns {acc, step} — true once per stride. */
export function advanceFootstep(acc, dist, speed) {
  const stride = speed > 8 ? 2.6 : (speed > 3.5 ? 1.9 : 1.4);
  let a = acc + dist;
  let step = false;
  if (a >= stride) { a -= stride; step = true; }
  return { acc: a, step };
}

/* ----------------------------------------------------------- combat/abilities */

/**
 * Advance the 3-hit melee combo. `combo` is {index, lastTime}; if the previous swing was
 * within `window` seconds the combo continues, otherwise it restarts at hit 0.
 */
export function advanceCombo(combo, t, window = TUNING.comboWindow, maxHits = TUNING.comboHits) {
  const fresh = !combo || combo.lastTime == null || (t - combo.lastTime) > window;
  const index = fresh ? 0 : ((combo.index + 1) % maxHits);
  return { index, lastTime: t };
}

/** Which ability slot a pressed action maps to (right mouse/K = 0, Q = 1, F = 2). */
export function abilitySlotFor(action) {
  if (action === 'ability1') return 0;
  if (action === 'ability2') return 1;
  if (action === 'ability3') return 2;
  return -1;
}

/** Jean's hover meter: drains while hovering, refills on the ground. */
export function updateHover(meter, dt, opts = {}) {
  const max = opts.max ?? TUNING.hoverMax;
  let m = clamp(meter, 0, max);
  let active = !!opts.active;
  if (active) {
    m = Math.max(0, m - dt);
    if (m <= 0) { m = 0; active = false; }
  } else if (opts.recharge) {
    m = Math.min(max, m + dt * (opts.rechargeRate ?? TUNING.hoverRecharge));
  }
  return { meter: m, active };
}

/** Wolverine ledge mantle test: roof must be above the feet but within reach. */
export function mantleCheck(playerY, roofY, opts = {}) {
  if (!Number.isFinite(roofY)) return false;
  const rise = roofY - playerY;
  return rise >= (opts.min ?? TUNING.mantleMin) && rise <= (opts.max ?? TUNING.mantleMax);
}

/** Cycle a roster index (Tab / RB). */
export function cycleIndex(i, len, dir = 1) {
  if (!len) return 0;
  return ((i + dir) % len + len) % len;
}

/* ------------------------------------------------------------------- camera */

export function clampPitch(p, min = TUNING.camPitchMin, max = TUNING.camPitchMax) { return clamp(p, min, max); }

export function clampCamDistance(d) { return clamp(d, TUNING.camMinDist, TUNING.camMaxDist); }

/** Wheel delta -> new orbit distance. */
export function applyWheel(dist, deltaY, sens = TUNING.wheelSens) {
  return clampCamDistance(dist + deltaY * sens);
}

/** Camera offset from the pivot for a yaw/pitch/distance orbit. */
export function orbitOffset(yaw, pitch, dist) {
  const cp = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cp * dist,
    y: Math.sin(pitch) * dist,
    z: Math.cos(yaw) * cp * dist,
  };
}

/** FOV kick with speed. */
export function fovForSpeed(base, speed, refSpeed, kick = TUNING.fovKick) {
  if (refSpeed <= 0) return base;
  const t = clamp((speed - refSpeed * 0.6) / (refSpeed * 0.5), 0, 1);
  return base + kick * t;
}

/* ----------------------------------------------------------------- skydive */

/** Air steering: tilt the horizontal velocity toward `dir` up to `maxHoriz` m/s. */
export function skydiveSteer(vel, dir, dt, opts = {}) {
  const maxH = opts.maxHoriz ?? TUNING.skydiveSteer;
  const accel = opts.accel ?? TUNING.skydiveSteerAccel;
  const desired = { x: dir.x * maxH, z: dir.z * maxH };
  const next = accelerateHorizontal(vel, desired, accel, accel * 0.6, dt);
  const m = Math.hypot(next.x, next.z);
  if (m > maxH) { const s = maxH / m; next.x *= s; next.z *= s; }
  return next;
}

/**
 * Vertical speed during the drop. Above `decelAlt` it is plain gravity capped at terminal;
 * below it the fall eases out so the hero touches down at ~`landSpeed` m/s.
 */
export function skydiveDescent(vy, altitude, dt, opts = {}) {
  const g = opts.gravity ?? TUNING.gravity;
  const term = opts.terminal ?? TUNING.skydiveTerminal;
  const decelAlt = opts.decelAlt ?? TUNING.skydiveDecelAlt;
  const land = Math.abs(opts.landSpeed ?? TUNING.skydiveLandSpeed);
  if (altitude > decelAlt) return Math.max(-term, vy - g * dt);
  const f = clamp(altitude / decelAlt, 0, 1);
  const target = -(land + (term - land) * f);
  return vy + (target - vy) * Math.min(1, dt * 6);
}

/** Camera shake offset for the wind buffet during the dive (deterministic, no RNG state). */
export function windShake(t, amount = 1) {
  return {
    x: (Math.sin(t * 13.1) * 0.6 + Math.sin(t * 29.7) * 0.25) * 0.12 * amount,
    y: (Math.sin(t * 17.3) * 0.5 + Math.sin(t * 7.9) * 0.3) * 0.10 * amount,
  };
}

/* ------------------------------------------------------------------- input */

/**
 * Wire keyboard / mouse / pointer-lock / wheel into `state.input`.
 * Browser only — never called from tests. Returns a detach() function.
 * state.input gains: keys (Set of event.code), mouse {dx, dy, buttons, locked},
 * wheel (accumulated deltaY, consumed each frame), gamepad (index or null).
 */
export function attachInput(state, domElement) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const el = domElement || document.body;
  const input = state.input || (state.input = {});
  if (!input.keys) input.keys = new Set();
  if (!input.mouse) input.mouse = { dx: 0, dy: 0, buttons: 0, locked: false };
  input.wheel = 0;
  input.gamepad = input.gamepad ?? null;

  const stopKeys = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const onKeyDown = (e) => {
    if (e.repeat) return;
    input.keys.add(e.code);
    if (stopKeys.has(e.code)) e.preventDefault();
  };
  const onKeyUp = (e) => { input.keys.delete(e.code); };
  const onBlur = () => { input.keys.clear(); input.mouse.buttons = 0; input.mouse.dx = 0; input.mouse.dy = 0; };
  const onMouseDown = (e) => { input.mouse.buttons = e.buttons; };
  const onMouseUp = (e) => { input.mouse.buttons = e.buttons; };
  const onMouseMove = (e) => {
    if (!input.mouse.locked) return;
    input.mouse.dx += e.movementX || 0;
    input.mouse.dy += e.movementY || 0;
  };
  const onClick = () => {
    if (document.pointerLockElement !== el && el.requestPointerLock) {
      try { el.requestPointerLock(); } catch (err) { /* user gesture required */ }
    }
  };
  const onLockChange = () => {
    input.mouse.locked = document.pointerLockElement === el;
    if (!input.mouse.locked) { input.mouse.buttons = 0; input.mouse.dx = 0; input.mouse.dy = 0; }
  };
  const onWheel = (e) => { input.wheel += e.deltaY || 0; e.preventDefault(); };
  const onContext = (e) => e.preventDefault();
  const onPadConnect = (e) => { input.gamepad = e.gamepad ? e.gamepad.index : 0; };
  const onPadDisconnect = () => { input.gamepad = null; };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  el.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  el.addEventListener('click', onClick);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onContext);
  document.addEventListener('pointerlockchange', onLockChange);
  window.addEventListener('gamepadconnected', onPadConnect);
  window.addEventListener('gamepaddisconnected', onPadDisconnect);

  return function detach() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    el.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
    el.removeEventListener('click', onClick);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('contextmenu', onContext);
    document.removeEventListener('pointerlockchange', onLockChange);
    window.removeEventListener('gamepadconnected', onPadConnect);
    window.removeEventListener('gamepaddisconnected', onPadDisconnect);
  };
}

/** Browser-only gamepad poll; returns the raw pad object or null. */
export function pollGamepadPad(state) {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  let pads;
  try { pads = navigator.getGamepads(); } catch (e) { return null; }
  if (!pads) return null;
  const idx = state?.input?.gamepad;
  if (idx != null && pads[idx]) return pads[idx];
  for (const p of pads) if (p && p.connected) { if (state?.input) state.input.gamepad = p.index; return p; }
  return null;
}

/* --------------------------------------------------------- PlayerController */

export class PlayerController {
  /**
   * @param {object} state  src/core/state.js
   * @param {object} city   City instance (collideCapsule/getGroundHeight/raycastDown)
   * @param {object} rigs   {id: Rig}
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   * @param {object} charDefs {id: {speed, jump, hp, abilities}} — CHARACTERS from Agent C
   */
  constructor(state, city, rigs, camera, domElement, charDefs = null) {
    this.state = state;
    this.city = city;
    this.rigs = rigs || {};
    this.camera = camera;
    this.domElement = domElement || null;
    // accepts either the table itself or an options bag { charDefs, tuning }
    const opts = (charDefs && charDefs.charDefs) ? charDefs : null;
    this.charDefs = (opts ? opts.charDefs : charDefs) || DEFAULT_CHAR_DEFS;
    this.tuning = { ...TUNING, ...((opts && opts.tuning) || {}) };

    const roster = state.roster || Object.keys(this.charDefs);
    const id = roster[state.activeIndex || 0] || roster[0];
    const def = this.def(id);

    if (!state.player) {
      state.player = {
        pos: new THREE.Vector3(0, 0, 0),
        vel: new THREE.Vector3(0, 0, 0),
        yaw: 0,
        hp: def.hp, maxHp: def.hp,
        grounded: false,
        character: id,
        hoverMeter: this.tuning.hoverMax,
      };
    } else {
      const p = state.player;
      if (!p.pos) p.pos = new THREE.Vector3();
      if (!p.vel) p.vel = new THREE.Vector3();
      p.character = p.character || id;
      p.maxHp = p.maxHp || def.hp;
      p.hp = p.hp ?? def.hp;
      p.hoverMeter = p.hoverMeter ?? this.tuning.hoverMax;
      p.yaw = p.yaw || 0;
      p.grounded = !!p.grounded;
    }
    // per-character hp is remembered across switches
    this.hpById = {};
    for (const rid of roster) this.hpById[rid] = this.def(rid).hp;
    this.hpById[state.player.character] = state.player.hp;

    // camera / input runtime
    this.yaw = state.player.yaw || 0;
    this.pitch = 0.12;
    this.dist = 5.5;
    this.camTarget = new THREE.Vector3().copy(state.player.pos);
    this.camTarget.y += this.tuning.eyeHeight;
    this.camPos = new THREE.Vector3();
    this.fov = this.tuning.baseFov;
    this.detachInput = null;

    // state machines
    this.prevActions = emptyActions();
    this.actions = emptyActions();
    this.edges = emptyActions();
    this.axes = { x: 0, y: 0 };
    this.jumpState = { coyoteTimer: 0, bufferTimer: 0, jump: false };
    this.combo = { index: -1, lastTime: null };
    this.attackTimer = 0;
    this.doubleJumpUsed = false;
    this.hovering = false;
    this.mantle = null;          // {from: Vector3, to: Vector3, t, dur}
    this.footAcc = 0;
    this.wasGrounded = false;
    this.sprinting = false;
    this.skydive = null;         // {t}
    this.pausePressed = false;
    this.interactPressed = false;

    // scratch vectors (zero per-frame allocation)
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._out = new THREE.Vector3();
    this._dir = new THREE.Vector3();

    this.showOnly(state.player.character);
    this.syncRig();
  }

  /* ---------------------------------------------------------- small helpers */

  def(id) { return (this.charDefs && this.charDefs[id]) || DEFAULT_CHAR_DEFS[id] || { speed: 7, jump: 5, hp: 100, abilities: [] }; }

  get rig() { return this.rigs[this.state.player.character] || null; }

  get activeDef() { return this.def(this.state.player.character); }

  /** Wire browser input; safe to call once from main.js. */
  attach(domElement) {
    this.domElement = domElement || this.domElement;
    if (this.detachInput) this.detachInput();
    this.detachInput = attachInput(this.state, this.domElement);
    return this;
  }

  dispose() { if (this.detachInput) { this.detachInput(); this.detachInput = null; } }

  showOnly(id) {
    for (const key of Object.keys(this.rigs)) {
      const r = this.rigs[key];
      if (r && r.group) r.group.visible = (key === id);
    }
  }

  /** Ground/roof height under a point, roofs only if they are reachable from `fromY`. */
  supportHeight(x, z, fromY) {
    const city = this.city;
    let g = -Infinity;
    if (city && typeof city.getGroundHeight === 'function') {
      const v = city.getGroundHeight(x, z);
      if (Number.isFinite(v)) g = v;
    }
    if (city && typeof city.raycastDown === 'function') {
      const probeY = fromY + this.tuning.stepUp + 0.02;
      const r = city.raycastDown(x, probeY, z);
      if (Number.isFinite(r) && r > g && r <= probeY) g = r;
    }
    return Number.isFinite(g) ? g : 0;
  }

  /** Roof/ledge height a short way in front of the player (Wolverine mantle probe). */
  ledgeAhead(dirX, dirZ, reach = 1.1) {
    const city = this.city;
    if (!city || typeof city.raycastDown !== 'function') return NaN;
    const p = this.state.player.pos;
    const y = p.y + this.tuning.mantleMax + 0.5;
    const r = city.raycastDown(p.x + dirX * reach, y, p.z + dirZ * reach);
    return Number.isFinite(r) ? r : NaN;
  }

  /* -------------------------------------------------------------- per frame */

  update(dt) {
    const st = this.state;
    const p = st.player;
    if (!p) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);

    // Read input every frame so deltas never pile up, even while paused.
    this.readInput();
    const paused = st.phase === 'paused' || st.phase === 'dialog';
    if (paused) { this.consumeLook(); return; }

    const ts = (typeof st.timeScale === 'number' && st.timeScale > 0) ? st.timeScale : 1;
    // Slow-mo bends the world, but Quicksilver keeps real time.
    const pdt = (p.character === 'quicksilver') ? dt : dt * ts;

    this.updateCameraInput(pdt);

    if (st.phase === 'skydive') {
      this.updateSkydive(pdt);
    } else if (PLAYABLE_PHASES.has(st.phase)) {
      this.updateGround(pdt);
      this.updateActionsCombat(pdt);
    }

    this.syncRig();
    this.updateCamera(pdt);
  }

  /** Collapse keyboard + mouse + gamepad into this.actions / this.axes / edges. */
  readInput() {
    const st = this.state;
    const input = st.input || (st.input = { keys: new Set(), mouse: { dx: 0, dy: 0, buttons: 0 } });
    const keyActs = mapKeysToActions(input.keys);
    const mouseActs = mapMouseToActions(input.mouse ? input.mouse.buttons : 0);
    const pad = readGamepad(pollGamepadPad(st));
    this.pad = pad;
    const merged = mergeActions(keyActs, mouseActs, pad.actions);
    this.edges = actionEdges(this.actions, merged);
    this.prevActions = this.actions;
    this.actions = merged;

    const kb = actionsToAxes(keyActs);
    const ax = pad.connected && (Math.abs(pad.move.x) + Math.abs(pad.move.y)) > 0.01
      ? { x: pad.move.x, y: -pad.move.y } : kb;
    const mag = Math.hypot(ax.x, ax.y);
    this.axes = mag > 1 ? { x: ax.x / mag, y: ax.y / mag } : ax;
    this.moveIntensity = Math.min(1, mag);

    // one-shot flags for main.js / HUD
    this.pausePressed = this.edges.pause;
    this.interactPressed = this.edges.interact;
    if (this.edges.pause) input.pausePressed = true;
    if (this.edges.interact) input.interactPressed = true;
  }

  /** Mouse/right-stick look; also drains the accumulated deltas. */
  consumeLook() {
    const input = this.state.input;
    const m = input && input.mouse;
    const look = { dx: 0, dy: 0, wheel: 0 };
    if (m) {
      if (m.locked !== false) { look.dx = m.dx || 0; look.dy = m.dy || 0; }
      m.dx = 0; m.dy = 0;
    }
    if (input) { look.wheel = input.wheel || 0; input.wheel = 0; }
    return look;
  }

  updateCameraInput(dt) {
    const st = this.state;
    const look = this.consumeLook();
    const invert = st.settings && st.settings.invertY ? -1 : 1;
    const sens = this.tuning.mouseSens;
    this.yaw -= look.dx * sens;
    this.pitch -= look.dy * sens * invert;
    if (this.pad && this.pad.connected) {
      const ps = this.tuning.padLookSens * dt;
      this.yaw -= this.pad.look.x * ps;
      this.pitch -= this.pad.look.y * ps * invert;
    }
    this.pitch = clampPitch(this.pitch, this.tuning.camPitchMin, this.tuning.camPitchMax);
    if (look.wheel) this.dist = applyWheel(this.dist, look.wheel, this.tuning.wheelSens);
  }

  /* --------------------------------------------------------- ground motion */

  updateGround(dt) {
    const st = this.state, p = st.player, T = this.tuning;
    const def = this.activeDef;
    const a = this.actions;

    if (this.mantle) { this.updateMantle(dt); return; }

    // --- horizontal intent -------------------------------------------------
    const dir = moveDirFromCameraYaw(this.axes.x, this.axes.y, this.yaw);
    const moving = (dir.x !== 0 || dir.z !== 0);
    this.sprinting = moving && a.sprint && p.grounded;
    const speed = desiredSpeed(def.speed ?? 7, {
      sprint: a.sprint,
      character: p.character,
      intensity: this.moveIntensity ?? 1,
      sprintMul: T.sprintMul,
      quicksilverSprintMul: T.quicksilverSprintMul,
    });
    const desired = { x: dir.x * speed, z: dir.z * speed };
    const accel = p.grounded ? T.accel : T.airAccel;
    const decel = p.grounded ? T.decel : T.airDecel;
    const nv = accelerateHorizontal({ x: p.vel.x, z: p.vel.z }, moving ? desired : { x: 0, z: 0 }, accel, decel, dt);
    p.vel.x = nv.x; p.vel.z = nv.z;

    // --- jump / double jump / hover ---------------------------------------
    const jumpEdge = this.edges.jump;
    const js = updateJump(this.jumpState, dt, { grounded: p.grounded, jumpPressed: jumpEdge, coyote: T.coyote, buffer: T.jumpBuffer });
    this.jumpState = js;
    if (js.jump) {
      p.vel.y = def.jump ?? 5;
      p.grounded = false;
      this.doubleJumpUsed = false;
      this.hovering = false;
      bus.emit('jump', { pos: p.pos.clone() });
    } else if (jumpEdge && !p.grounded) {
      if (p.character === 'jean' && !this.doubleJumpUsed && p.hoverMeter > 0.05) {
        // Jean: second tap becomes hover
        this.doubleJumpUsed = true;
        this.hovering = true;
        p.vel.y = Math.max(p.vel.y, 0.8);
        bus.emit('jump', { pos: p.pos.clone(), hover: true });
      } else if (this.hovering) {
        this.hovering = false;                    // tap again to drop out of hover
      } else if (p.character === 'wolverine') {
        this.tryMantle(dir);
      }
    }
    if (p.character !== 'jean') this.hovering = false;

    const hv = updateHover(p.hoverMeter, dt, {
      active: this.hovering,
      recharge: p.grounded,
      max: T.hoverMax,
      rechargeRate: T.hoverRecharge,
    });
    p.hoverMeter = hv.meter;
    this.hovering = hv.active;

    // --- vertical ----------------------------------------------------------
    const prevVy = p.vel.y;
    const prevY = p.pos.y;
    if (!p.grounded || p.vel.y > 0) {
      p.vel.y = applyGravity(p.vel.y, dt, {
        gravity: T.gravity, terminal: T.terminal,
        hovering: this.hovering, hoverFall: T.hoverFall,
      });
    } else {
      p.vel.y = Math.min(0, p.vel.y);
    }

    // --- integrate + collide ----------------------------------------------
    const oldX = p.pos.x, oldZ = p.pos.z;
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    p.pos.y += p.vel.y * dt;
    this.collide(p);

    // slope / kerb handling on the new footprint
    const horiz = Math.hypot(p.pos.x - oldX, p.pos.z - oldZ);
    const support = this.supportHeight(p.pos.x, p.pos.z, Math.max(prevY, p.pos.y));
    const rise = support - p.pos.y;
    if (rise > 0 && !canStepTo(rise, horiz, T)) {
      // too steep: refuse the horizontal move, keep the old footprint
      p.pos.x = oldX; p.pos.z = oldZ;
      p.vel.x *= 0.2; p.vel.z *= 0.2;
    } else if (rise > 0) {
      p.pos.y = support;                            // step up a kerb / walk a slope
    }
    const ground = this.supportHeight(p.pos.x, p.pos.z, Math.max(prevY, p.pos.y));
    const g = resolveGround(p.pos.y, p.vel.y, ground, { wasGrounded: this.wasGrounded });
    p.pos.y = g.y; p.vel.y = g.vy; p.grounded = g.grounded;
    if (g.landed) {
      const impact = Math.max(g.impact, Math.abs(prevVy));
      this.doubleJumpUsed = false;
      this.hovering = false;
      bus.emit('land', { pos: p.pos.clone(), impact });
    }
    this.wasGrounded = p.grounded;

    // --- footsteps ---------------------------------------------------------
    const hspeed = Math.hypot(p.vel.x, p.vel.z);
    if (p.grounded && hspeed > 0.6) {
      const f = advanceFootstep(this.footAcc, hspeed * dt, hspeed);
      this.footAcc = f.acc;
      if (f.step) bus.emit('footstep', { pos: p.pos.clone(), speed: hspeed });
    } else if (!p.grounded) {
      this.footAcc = 0;
    }

    // --- facing ------------------------------------------------------------
    if (hspeed > 0.4) p.yaw = yawFromDir(p.vel.x, p.vel.z);
    else if (this.attackTimer > 0) p.yaw = this.yaw;
  }

  /** Push the capsule out of buildings and kill the velocity into the wall. */
  collide(p) {
    const city = this.city;
    if (!city || typeof city.collideCapsule !== 'function') return false;
    const out = this._out;
    out.copy(p.pos);
    const hit = city.collideCapsule(p.pos, this.tuning.radius, this.tuning.height, out);
    if (!hit) return false;
    const dx = out.x - p.pos.x, dz = out.z - p.pos.z, dy = out.y - p.pos.y;
    p.pos.copy(out);
    const m = Math.hypot(dx, dz);
    if (m > 1e-5) {
      const nx = dx / m, nz = dz / m;
      const into = p.vel.x * nx + p.vel.z * nz;
      if (into < 0) { p.vel.x -= nx * into; p.vel.z -= nz * into; }
    }
    if (dy > 1e-5 && p.vel.y < 0) p.vel.y = 0;
    return true;
  }

  /** Wolverine: pull up onto a ledge no higher than 2.5 m. */
  tryMantle(dir) {
    const p = this.state.player, T = this.tuning;
    let dx = dir.x, dz = dir.z;
    if (dx === 0 && dz === 0) { dx = -Math.sin(this.yaw); dz = -Math.cos(this.yaw); }
    const roof = this.ledgeAhead(dx, dz, T.radius + 0.7);
    if (!mantleCheck(p.pos.y, roof, { min: T.mantleMin, max: T.mantleMax })) return false;
    this.mantle = {
      from: p.pos.clone(),
      to: new THREE.Vector3(p.pos.x + dx * (T.radius + 0.9), roof + 0.02, p.pos.z + dz * (T.radius + 0.9)),
      t: 0, dur: T.mantleTime,
    };
    p.vel.set(0, 0, 0);
    p.yaw = yawFromDir(dx, dz);
    const r = this.rig; if (r && r.setAnim) r.setAnim('jump', { mantle: true });
    return true;
  }

  updateMantle(dt) {
    const p = this.state.player, m = this.mantle;
    m.t += dt;
    const k = clamp(m.t / m.dur, 0, 1);
    const ease = k * k * (3 - 2 * k);
    p.pos.lerpVectors(m.from, m.to, ease);
    p.pos.y = m.from.y + (m.to.y - m.from.y) * Math.min(1, ease * 1.35);
    if (k >= 1) {
      this.mantle = null;
      p.grounded = true;
      this.wasGrounded = true;
      bus.emit('land', { pos: p.pos.clone(), impact: 1 });
    }
  }

  /* ------------------------------------------------------- combat/abilities */

  updateActionsCombat(dt) {
    const st = this.state, p = st.player;
    if (this.attackTimer > 0) this.attackTimer = Math.max(0, this.attackTimer - dt);

    if (this.edges.attack) this.doAttack();
    for (const act of ['ability1', 'ability2', 'ability3']) {
      if (this.edges[act]) this.doAbility(abilitySlotFor(act));
    }
    if (this.edges.switchNext) this.switchBy(1);
    for (let i = 0; i < 5; i++) {
      if (this.edges['slot' + (i + 1)]) {
        const id = (st.roster || [])[i];
        if (id && id !== p.character) this.switchTo(id);
      }
    }
  }

  /** Direction the player is aiming (camera forward, flattened). */
  aimDir(out = this._dir) {
    out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    return out.normalize();
  }

  ctx() {
    const st = this.state;
    return {
      player: st.player, rig: this.rig, camera: this.camera, city: this.city,
      enemies: st.enemies, props: st.props, dir: this.aimDir().clone(),
      yaw: this.yaw, pitch: this.pitch, controller: this,
    };
  }

  doAttack() {
    const st = this.state, p = st.player;
    this.combo = advanceCombo(this.combo, st.time ?? 0, this.tuning.comboWindow, this.tuning.comboHits);
    this.attackTimer = this.tuning.attackTime;
    p.yaw = this.yaw;
    const r = this.rig;
    if (r && r.setAnim) r.setAnim('attack' + (this.combo.index + 1), { combo: this.combo.index });
    callMelee(st, this.ctx(), this.combo.index);
  }

  doAbility(slot) {
    if (slot < 0) return false;
    const st = this.state, p = st.player;
    const list = this.activeDef.abilities || [];
    const name = list[slot];
    if (!name) return false;
    const ctx = this.ctx();
    const fired = callUseAbility(st, name, ctx);
    if (fired) {
      const r = this.rig; if (r && r.setAnim) r.setAnim('ability', { name });
      // abilities.js emits the 'ability' event itself; only announce it here when that
      // module is missing, so VFX/audio never hear the same cast twice.
      if (!_abilities) bus.emit('ability', { character: p.character, name, pos: p.pos.clone(), dir: ctx.dir });
    }
    return fired;
  }

  /* ----------------------------------------------------- character switching */

  switchBy(dir) {
    const st = this.state;
    const roster = st.roster || Object.keys(this.rigs);
    if (!roster.length) return;
    const i = cycleIndex(roster.indexOf(st.player.character), roster.length, dir);
    this.switchTo(roster[i]);
  }

  switchTo(id) {
    const st = this.state, p = st.player;
    if (!id || id === p.character) return;
    const roster = st.roster || Object.keys(this.rigs);
    const oldRig = this.rig;
    this.hpById[p.character] = p.hp;

    p.character = id;
    st.activeIndex = Math.max(0, roster.indexOf(id));
    const def = this.def(id);
    p.maxHp = def.hp ?? 100;
    p.hp = clamp(this.hpById[id] ?? def.hp ?? 100, 0, p.maxHp);
    p.hoverMeter = this.tuning.hoverMax;
    this.hovering = false;
    this.doubleJumpUsed = false;
    this.combo = { index: -1, lastTime: null };
    this.attackTimer = 0;

    const newRig = this.rigs[id];
    if (newRig && newRig.group) {
      newRig.group.position.copy(p.pos);
      newRig.group.rotation.y = p.yaw;
      newRig.group.visible = true;
    }
    if (oldRig && oldRig.group && oldRig !== newRig) oldRig.group.visible = false;
    this.showOnly(id);
    if (newRig && newRig.setAnim) newRig.setAnim(p.grounded ? 'idle' : 'fall');
    bus.emit('switch_character', { id });
  }

  /* ---------------------------------------------------------------- skydive */

  startSkydive(fromPos) {
    const st = this.state, p = st.player;
    if (fromPos) p.pos.copy(fromPos);
    p.vel.set(0, -2, 0);
    p.grounded = false;
    this.wasGrounded = false;
    this.hovering = false;
    this.doubleJumpUsed = false;
    this.mantle = null;
    this.skydive = { t: 0 };
    st.phase = 'skydive';
    this.dist = this.tuning.skydiveCamDist;
    this.pitch = this.tuning.skydiveCamPitch;
    const r = this.rig; if (r && r.setAnim) r.setAnim('skydive');
    // main.js owns the 'phase' announcement for the jump; the landing below emits its own.
    return this;
  }

  updateSkydive(dt) {
    const st = this.state, p = st.player, T = this.tuning;
    this.skydive = this.skydive || { t: 0 };
    this.skydive.t += dt;

    const dir = moveDirFromCameraYaw(this.axes.x, this.axes.y, this.yaw);
    const nv = skydiveSteer({ x: p.vel.x, z: p.vel.z }, dir, dt, { maxHoriz: T.skydiveSteer, accel: T.skydiveSteerAccel });
    p.vel.x = nv.x; p.vel.z = nv.z;

    const ground = this.supportHeight(p.pos.x, p.pos.z, p.pos.y);
    const altitude = Math.max(0, p.pos.y - ground);
    p.vel.y = skydiveDescent(p.vel.y, altitude, dt, {
      gravity: T.gravity, terminal: T.skydiveTerminal,
      decelAlt: T.skydiveDecelAlt, landSpeed: T.skydiveLandSpeed,
    });
    if (altitude < T.skydiveDecelAlt) {
      // flare out of the dive: bleed the drift so the hero lands on the mark
      p.vel.x = damp(p.vel.x, 0, 2.2, dt);
      p.vel.z = damp(p.vel.z, 0, 2.2, dt);
    }

    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    p.pos.y += p.vel.y * dt;
    this.collide(p);

    const ground2 = this.supportHeight(p.pos.x, p.pos.z, p.pos.y);
    if (p.pos.y <= ground2 + 0.05) {
      const impact = Math.max(6, Math.abs(p.vel.y));
      p.pos.y = ground2;
      p.vel.set(0, 0, 0);
      p.grounded = true;
      this.wasGrounded = true;
      this.skydive = null;
      st.phase = 'play';
      this.dist = 5.5;
      this.pitch = 0.12;
      const r = this.rig; if (r && r.setAnim) r.setAnim('land', { hero: true });
      bus.emit('land', { pos: p.pos.clone(), impact, hero: true, crater: true });
      bus.emit('phase', { phase: 'play' });
      return;
    }

    if (Math.hypot(p.vel.x, p.vel.z) > 0.6) p.yaw = yawFromDir(p.vel.x, p.vel.z);
  }

  /* ------------------------------------------------------------- teleport */

  teleport(x, z) {
    const p = this.state.player;
    const y = this.supportHeight(x, z, 1e6);
    p.pos.set(x, y, z);
    p.vel.set(0, 0, 0);
    p.grounded = true;
    this.wasGrounded = true;
    this.mantle = null;
    this.hovering = false;
    this.camTarget.set(x, y + this.tuning.eyeHeight, z);
    this.syncRig();
    return this;
  }

  /* ------------------------------------------------------------------- rig */

  syncRig() {
    const st = this.state, p = st.player, r = this.rig;
    if (!r) return;
    if (r.group) {
      r.group.position.copy(p.pos);
      r.group.rotation.y = p.yaw;
      r.group.visible = true;
    }
    if (typeof r.setAnim === 'function') {
      const anim = this.pickAnim();
      if (anim) r.setAnim(anim.name, anim.params);
    }
    if (typeof r.update === 'function') {
      const ts = (typeof st.timeScale === 'number' && st.timeScale > 0) ? st.timeScale : 1;
      r.update((st.dt || 0) * (p.character === 'quicksilver' ? 1 : ts));
    }
  }

  pickAnim() {
    const st = this.state, p = st.player;
    if (st.phase === 'skydive') return { name: 'skydive', params: null };
    if (p.hp <= 0) return { name: 'dead', params: null };
    if (this.attackTimer > 0) return null;   // attack anim already set by doAttack()
    if (this.mantle) return { name: 'jump', params: { mantle: true } };
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const def = this.activeDef;
    const base = def.speed || 7;
    if (!p.grounded) {
      if (this.hovering) return { name: 'fall', params: { hover: true, rate: 0.4 } };
      return p.vel.y > 0.4 ? { name: 'jump', params: null } : { name: 'fall', params: null };
    }
    if (speed < 0.35) return { name: 'idle', params: null };
    if (speed < base * 0.55) return { name: 'walk', params: { rate: speed / Math.max(1e-3, base * 0.55) } };
    if (speed < base * 1.02) return { name: 'run', params: { rate: speed / base } };
    // sprint — Quicksilver's legs churn faster than anyone else's
    const rate = p.character === 'quicksilver' ? clamp(speed / base, 1, 2.2) : clamp(speed / base, 1, 1.6);
    return { name: 'sprint', params: { rate } };
  }

  /* ---------------------------------------------------------------- camera */

  updateCamera(dt) {
    const cam = this.camera;
    if (!cam) return;
    const st = this.state, p = st.player, T = this.tuning;

    // spring-damped pivot just above the shoulders
    this._v1.set(p.pos.x, p.pos.y + T.eyeHeight, p.pos.z);
    this.camTarget.x = damp(this.camTarget.x, this._v1.x, T.camFollow, dt);
    this.camTarget.y = damp(this.camTarget.y, this._v1.y, T.camFollow * 0.75, dt);
    this.camTarget.z = damp(this.camTarget.z, this._v1.z, T.camFollow, dt);

    const skydiving = st.phase === 'skydive';
    const dist = skydiving ? T.skydiveCamDist : clampCamDistance(this.dist);
    const off = orbitOffset(this.yaw, this.pitch, dist);
    this._v2.set(this.camTarget.x + off.x, this.camTarget.y + off.y, this.camTarget.z + off.z);

    // pull in if the camera would sit inside a building
    this.pullInCamera(this._v2, this.camTarget);

    // never dip below the ground
    const gy = this.supportHeight(this._v2.x, this._v2.z, this._v2.y) + 0.45;
    if (this._v2.y < gy) this._v2.y = gy;

    const lambda = skydiving ? T.camLambda * 0.55 : T.camLambda;
    cam.position.x = damp(cam.position.x, this._v2.x, lambda, dt);
    cam.position.y = damp(cam.position.y, this._v2.y, lambda, dt);
    cam.position.z = damp(cam.position.z, this._v2.z, lambda, dt);

    // wind buffet during the dive
    if (skydiving) {
      const sh = windShake(st.time ?? this.skydive?.t ?? 0, 1);
      cam.position.x += sh.x; cam.position.y += sh.y;
      this._v3.set(p.pos.x, p.pos.y - 2.5, p.pos.z);
      cam.lookAt(this._v3);
    } else {
      cam.lookAt(this.camTarget);
    }

    // FOV kick
    if (typeof cam.fov === 'number') {
      const speed = Math.hypot(p.vel.x, p.vel.z);
      const ref = (this.activeDef.speed || 7) * (p.character === 'quicksilver' ? T.quicksilverSprintMul : T.sprintMul);
      const want = skydiving ? T.baseFov + T.fovKick * 1.4 : fovForSpeed(T.baseFov, speed, ref, T.fovKick);
      const next = damp(this.fov, want, 5, dt);
      if (Math.abs(next - this.fov) > 0.01) {
        this.fov = next;
        cam.fov = next;
        if (typeof cam.updateProjectionMatrix === 'function') cam.updateProjectionMatrix();
      }
    }
  }

  /**
   * City.collideCapsule on a small capsule at the camera position; if it is inside
   * geometry, walk the camera back toward the pivot until it is clear.
   */
  pullInCamera(camPos, target) {
    const city = this.city;
    if (!city || typeof city.collideCapsule !== 'function') return camPos;
    const r = this.tuning.camRadius;
    const out = this._out;
    out.copy(camPos);
    if (!city.collideCapsule(camPos, r, r * 2, out)) return camPos;
    const dx = camPos.x - target.x, dy = camPos.y - target.y, dz = camPos.z - target.z;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return camPos;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    for (let i = 0; i < 5; i++) {
      d *= 0.65;
      camPos.set(target.x + nx * d, target.y + ny * d, target.z + nz * d);
      out.copy(camPos);
      if (!city.collideCapsule(camPos, r, r * 2, out) || d < 0.8) break;
    }
    return camPos;
  }
}

export default PlayerController;
