// src/abilities.js — the mutant abilities (Agent E).
// Pure logic + THREE math only: safe to import under `node --test`.
//
// Contract for the player controller:
//   useAbility(state, name, ctx)  -> true if it fired
//   releaseAbility(state, name)   -> ends a held ability (blast; also throws a TK hold)
//   updateAbilities(state, dt)    -> call once per frame, after the player moves
//   abilityCooldown(name)         -> 0..1 remaining fraction, for the HUD sweep
//   abilityState(name)            -> { active, remaining, cooldown }
// ctx = { player, rig, camera, city, enemies, props, dir } and is captured at fire time.
import * as THREE from '../vendor/three.module.js';
import { bus } from './core/bus.js';
import {
  damageEntity, applyRegen, tickBleeds, updateProps, applyKnockback,
  isAlive, enemyList, aimDirection, centerY, setWorld, propsLastSteppedAt,
} from './combat.js';

// Convenience re-exports so a caller can pull the whole combat surface off this module
// (src/main.js imports `spawnProps` from here).
export {
  meleeAttack, damageEntity, applyRegen, applyBleed, applyKnockback,
  PhysicsProp, spawnProps, clearProps, updateProps, MELEE, PROP_KINDS,
} from './combat.js';

/* ------------------------------------------------------------------ the table */

export const ABILITIES = {
  claws: {
    name: 'Adamantium Claws', cooldown: 10, icon: '⚔', hold: false, duration: 8,
    describe: 'Snikt — claws out for 8 s: melee ×1.6 and 5 dps bleed for 3 s.',
  },
  regen: {
    name: 'Healing Factor', cooldown: 12, icon: '✚', hold: false, duration: 4,
    describe: 'Knit yourself back together: 40 hp over 4 s.',
  },
  dash: {
    name: 'Speed Dash', cooldown: 2, icon: '»', hold: false, duration: 0.25,
    describe: '25 m burst that blows straight through anyone in the way.',
  },
  slowmo: {
    name: 'Slow Motion', cooldown: 15, icon: '◷', hold: false, duration: 3,
    describe: 'The world crawls at quarter speed for 3 s.',
  },
  telekinesis: {
    name: 'Telekinesis', cooldown: 1, icon: '✺', hold: false, duration: 0,
    describe: 'Lift the nearest prop or goon within 12 m; press again to hurl it.',
  },
  hover: {
    name: 'Hover', cooldown: 0, icon: '⇧', hold: true, duration: 0,
    describe: 'Hang in the air on a telekinetic cushion.',
  },
  blast: {
    name: 'Optic Blast', cooldown: 0.8, icon: '⦿', hold: true, duration: 5,
    describe: 'Hold to pour a 60 m optic beam out of the visor — 45 dps.',
  },
  sweep: {
    name: 'Optic Sweep', cooldown: 6, icon: '◗', hold: false, duration: 0.5,
    describe: 'Wide 90° burst: 60 damage and heavy knockback.',
  },
  diamond: {
    name: 'Diamond Form', cooldown: 14, icon: '◆', hold: false, duration: 6,
    describe: 'Organic diamond: untouchable for 6 s, but 30% slower.',
  },
  psychic: {
    name: 'Psychic Domination', cooldown: 12, icon: '☯', hold: false, duration: 5,
    describe: 'Enemies within 12 m turn on each other for 5 s.',
  },
};

/* ------------------------------------------------------------------ tunables */

const CLAWS_TIME = 8;
const REGEN_HP = 40, REGEN_TIME = 4;
const DASH_DIST = 25, DASH_TIME = 0.25, DASH_KNOCK_R = 2.2;
const SLOW_SCALE = 0.25, SLOW_TIME = 3, SLOW_EASE = 0.6;
const TK_RANGE = 12, TK_CONE_DEG = 60, TK_HOLD_DIST = 2.5, TK_HOLD_HEIGHT = 1.5;
const TK_THROW_SPEED = 28, TK_DPS = 10, TK_FOLLOW = 9, TK_MIN_HOLD = 0.3;
const BEAM_RANGE = 60, BEAM_DPS = 45, BEAM_RADIUS = 1, BEAM_MAX_TIME = 5;
const SWEEP_RANGE = 10, SWEEP_CONE_DEG = 90, SWEEP_DAMAGE = 60, SWEEP_TIME = 0.5;
const DIAMOND_TIME = 6, DIAMOND_SPEED = 0.7;
const PSY_RANGE = 12, PSY_TIME = 5;

/* ------------------------------------------------------------------ runtime */

const cool = Object.create(null);   // name -> seconds of cooldown left
const act = Object.create(null);    // name -> seconds of active effect left
const ctxOf = Object.create(null);  // name -> ctx captured at fire time

const rt = { dash: null, slow: null, blast: null, tk: null, invulnByUs: false };

/** Live optic-beam description; VFX may read it via getBeam(). Also mirrored on state.beam. */
const beam = { active: false, from: new THREE.Vector3(), to: new THREE.Vector3(), length: 0, target: null };
export function getBeam() { return beam; }

/** The current telekinesis hold (null when nothing is held). */
export function getHeld() { return rt.tk ? rt.tk.target : null; }

/** Clears every cooldown/effect — new game, respawn, or tests. */
export function resetAbilities(state) {
  setWorld(state);
  for (const k in cool) delete cool[k];
  for (const k in act) delete act[k];
  for (const k in ctxOf) delete ctxOf[k];
  rt.dash = null; rt.slow = null; rt.blast = null; rt.tk = null; rt.invulnByUs = false;
  beam.active = false; beam.length = 0; beam.target = null;
  if (state && state.player) {
    state.player.clawsTimer = 0;
    state.player.diamondTimer = 0;
    state.player.dashing = false;
    state.player.regen = null;
    state.player.speedMul = 1;
    state.player.speedScale = 1;
  }
  if (state) state.timeScale = 1;
}

/* ------------------------------------------------------------------ scratch vectors */

const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _head = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

/* ------------------------------------------------------------------ helpers */

function playerOf(state, ctx) { return (ctx && ctx.player) || (state && state.player) || null; }
function posOf(t) { return t && (t.pos || (t.mesh && t.mesh.position)) || null; }
function cityOf(state, ctx) { return (ctx && ctx.city) || (state && state.city) || null; }
function propsOf(state, ctx) {
  const p = (ctx && ctx.props) || (state && state.props);
  return Array.isArray(p) ? p : EMPTY;
}
const EMPTY = [];

function characterId(state) {
  if (!state) return '';
  if (state.player && state.player.character) return state.player.character;
  const r = state.roster;
  return (r && r[state.activeIndex || 0]) || '';
}

/** Look direction, refreshed every frame from the live camera (falls back to ctx.dir / yaw). */
function lookDir(state, ctx, out, flat) {
  return aimDirection(state, ctx, out, !!flat);
}

/** Visor / eye height for beams. */
function headPos(state, ctx, out) {
  const rig = ctx && ctx.rig;
  const head = rig && (rig.head || (rig.parts && rig.parts.head));
  if (head && typeof head.getWorldPosition === 'function') { head.getWorldPosition(out); return out; }
  const p = posOf(playerOf(state, ctx));
  if (p) out.set(p.x, p.y + 1.62, p.z); else out.set(0, 1.62, 0);
  return out;
}

function emitAbility(state, name, pos, dir, extra) {
  const payload = { character: characterId(state), name, pos, dir };
  if (extra) for (const k in extra) payload[k] = extra[k];
  bus.emit('ability', payload);
}

/** Enemies inside a cone: returns them via the callback to avoid allocating. */
function forEachInCone(state, ctx, origin, dir, range, coneDeg, fn) {
  const list = enemyList(state, ctx);
  const cosHalf = Math.cos(coneDeg * 0.5 * Math.PI / 180);
  const r2 = range * range;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isAlive(e)) continue;
    const ep = posOf(e);
    if (!ep) continue;
    _tmp.set(ep.x - origin.x, 0, ep.z - origin.z);
    const d2 = _tmp.lengthSq();
    if (d2 > r2) continue;
    if (d2 > 1e-6) {
      _tmp.multiplyScalar(1 / Math.sqrt(d2));
      if (_tmp.dot(dir) < cosHalf) continue;
    }
    fn(e, ep, Math.sqrt(d2));
  }
}

/* ------------------------------------------------------------------ public API */

/** Fires an ability. Returns true if it actually fired. */
export function useAbility(state, name, ctx) {
  const def = ABILITIES[name];
  if (!def || !state || !state.player) return false;
  ctx = ctx || {};

  // toggles: a second press ends a hold instead of failing on cooldown
  if (name === 'telekinesis' && rt.tk) { throwHeld(state); return true; }
  if (name === 'blast' && rt.blast) { stopBlast(state); return true; }

  if (cool[name] > 0) return false;
  if (!FIRE[name]) return false;
  ctxOf[name] = ctx;
  if (!FIRE[name](state, ctx, def)) { ctxOf[name] = null; return false; }

  // hold-style abilities start their cooldown when they end, everything else right now
  if (name !== 'blast' && name !== 'telekinesis' && def.cooldown > 0) cool[name] = def.cooldown;
  return true;
}

/** Ends a held ability (button released). Safe to call for anything. */
export function releaseAbility(state, name) {
  if (name === 'blast') { if (rt.blast) { stopBlast(state); return true; } return false; }
  if (name === 'telekinesis') {
    // a tap is a toggle, a real hold throws on release
    if (rt.tk && rt.tk.t >= TK_MIN_HOLD) { throwHeld(state); return true; }
    return false;
  }
  return false;
}

/** 0..1 fraction of cooldown still to run (1 = just used, 0 = ready). */
export function abilityCooldown(name) {
  const def = ABILITIES[name];
  if (!def || !def.cooldown) return 0;
  const left = cool[name] || 0;
  if (left <= 0) return 0;
  return Math.min(1, left / def.cooldown);
}

/** { active, remaining (seconds of effect left), cooldown (0..1) } */
export function abilityState(name) {
  const def = ABILITIES[name];
  if (!def) return { active: false, remaining: 0, cooldown: 0 };
  let remaining = act[name] || 0;
  let active = remaining > 0;
  if (name === 'blast' && rt.blast) { active = true; remaining = Math.max(0, BEAM_MAX_TIME - rt.blast.t); }
  if (name === 'telekinesis' && rt.tk) { active = true; remaining = rt.tk.t; }
  return { active, remaining, cooldown: abilityCooldown(name) };
}

/** Per-frame: cooldowns, durations, dash, slow-mo, beam, TK hold, bleeds, regen, props. */
export function updateAbilities(state, dt) {
  if (!state || !(dt > 0)) return;

  for (const k in cool) {
    if (cool[k] > 0) { cool[k] -= dt; if (cool[k] <= 0) cool[k] = 0; }
  }
  for (const k in act) {
    if (act[k] > 0) { act[k] -= dt; if (act[k] <= 0) { act[k] = 0; endEffect(state, k); } }
  }

  const p = state.player;
  if (p) {
    p.clawsTimer = act.claws || 0;
    p.diamondTimer = act.diamond || 0;
  }

  updateDash(state, dt);
  updateSlow(state, dt);
  updateBlast(state, dt);
  updateTK(state, dt);

  applyRegen(state, dt);
  tickBleeds(state, dt);

  // Props: the main loop usually steps them itself (with the slow-mo scaled dt). Only take
  // over when nobody has stepped them for a frame, so they are never integrated twice.
  setWorld(state);
  const t = state.time === undefined ? 0 : state.time;
  if (!(t - propsLastSteppedAt() <= dt * 2.5)) updateProps(state, dt * (state.timeScale || 1), state.city);
}

/* ------------------------------------------------------------------ fire handlers */

const FIRE = {
  claws(state, ctx) {
    const p = playerOf(state, ctx);
    act.claws = CLAWS_TIME;
    if (p) p.clawsTimer = CLAWS_TIME;
    if (ctx.rig && ctx.rig.setClaws) ctx.rig.setClaws(true);
    const pos = posOf(p);
    emitAbility(state, 'claws', pos, lookDir(state, ctx, _dir, true));
    bus.emit('sfx', { name: 'snikt', pos, gain: 1 });
    bus.emit('toast', { text: 'Claws out.' });
    return true;
  },

  regen(state, ctx) {
    const p = playerOf(state, ctx);
    if (!p) return false;
    p.regen = { t: REGEN_TIME, rate: REGEN_HP / REGEN_TIME, source: 'regen' };
    act.regen = REGEN_TIME;
    if (ctx.rig && ctx.rig.setAnim) ctx.rig.setAnim('ability');
    emitAbility(state, 'regen', posOf(p), lookDir(state, ctx, _dir, true));
    bus.emit('sfx', { name: 'regen', pos: posOf(p), gain: 0.8 });
    return true;
  },

  dash(state, ctx) {
    const p = playerOf(state, ctx);
    if (!p || !p.pos) return false;
    const dir = lookDir(state, ctx, _dir, true);
    const pv = p.vel;
    rt.dash = {
      t: DASH_TIME, dir: dir.clone(), speed: DASH_DIST / DASH_TIME, hit: new Set(),
      preSpeed: pv ? Math.hypot(pv.x || 0, pv.z || 0) : 0,
    };
    act.dash = DASH_TIME;
    p.dashing = true;
    if (ctx.rig && ctx.rig.setAnim) ctx.rig.setAnim('sprint');
    emitAbility(state, 'dash', p.pos, dir, { distance: DASH_DIST });
    bus.emit('sfx', { name: 'dash', pos: p.pos, gain: 0.9 });
    return true;
  },

  slowmo(state, ctx) {
    rt.slow = { t: SLOW_TIME, ease: 0 };
    act.slowmo = SLOW_TIME + SLOW_EASE;
    state.timeScale = SLOW_SCALE;
    emitAbility(state, 'slowmo', posOf(playerOf(state, ctx)), lookDir(state, ctx, _dir, true), { timeScale: SLOW_SCALE });
    bus.emit('sfx', { name: 'slowmo_in', gain: 0.9 });
    return true;
  },

  telekinesis(state, ctx) {
    const p = playerOf(state, ctx);
    const origin = posOf(p);
    if (!origin) return false;
    const dir = lookDir(state, ctx, _dir, false);
    const grabbed = pickTKTarget(state, ctx, origin, dir);
    if (!grabbed) {
      bus.emit('sfx', { name: 'tk_miss', pos: origin, gain: 0.4 });
      return false;
    }
    const isEnemy = grabbed.kind === 'enemy';
    const t = grabbed.target;
    t.held = true;
    if (!isEnemy && typeof t.grab === 'function') t.grab();
    if (isEnemy) {
      t.state = 'controlled';
      t.controlledBy = 'jean';
      t.controlledUntil = (state.time || 0) + 999;
      if (t.vel && t.vel.set) t.vel.set(0, 0, 0);
    }
    rt.tk = { target: t, kind: grabbed.kind, t: 0 };
    ctxOf.telekinesis = ctx;
    if (ctx.rig && ctx.rig.setAnim) ctx.rig.setAnim('ability');
    emitAbility(state, 'telekinesis', origin, dir, { phase: 'grab', target: t, targetKind: grabbed.kind });
    bus.emit('sfx', { name: 'tk_grab', pos: posOf(t) || origin, gain: 0.8 });
    return true;
  },

  // Hover is driven by the player controller; we only advertise it and announce the event.
  hover(state, ctx) {
    emitAbility(state, 'hover', posOf(playerOf(state, ctx)), lookDir(state, ctx, _dir, true));
    bus.emit('sfx', { name: 'hover', gain: 0.5 });
    return true;
  },

  blast(state, ctx) {
    rt.blast = { t: 0 };
    beam.active = true;
    beam.target = null;
    if (ctx.rig && ctx.rig.setVisorGlow) ctx.rig.setVisorGlow(1);
    if (ctx.rig && ctx.rig.setAnim) ctx.rig.setAnim('ability');
    state.beam = beam;
    const from = headPos(state, ctx, _head);
    const dir = lookDir(state, ctx, _dir, false);
    beam.from.copy(from);
    beam.to.copy(from).addScaledVector(dir, BEAM_RANGE);
    beam.length = BEAM_RANGE;
    emitAbility(state, 'blast', from, dir, { phase: 'start', active: true, range: BEAM_RANGE });
    bus.emit('sfx', { name: 'beam_start', pos: from, gain: 1 });
    return true;
  },

  sweep(state, ctx) {
    const p = playerOf(state, ctx);
    const origin = posOf(p);
    if (!origin) return false;
    const dir = lookDir(state, ctx, _dir, true);
    act.sweep = SWEEP_TIME;
    if (ctx.rig && ctx.rig.setVisorGlow) ctx.rig.setVisorGlow(1);
    if (ctx.rig && ctx.rig.setAnim) ctx.rig.setAnim('ability');
    emitAbility(state, 'sweep', origin, dir, { range: SWEEP_RANGE, cone: SWEEP_CONE_DEG });
    bus.emit('sfx', { name: 'optic_sweep', pos: origin, gain: 1 });
    forEachInCone(state, ctx, origin, dir, SWEEP_RANGE, SWEEP_CONE_DEG, (e, ep) => {
      damageEntity(state, e, SWEEP_DAMAGE, 'sweep');
      _tmp2.set(ep.x - origin.x, 0, ep.z - origin.z);
      if (_tmp2.lengthSq() < 1e-6) _tmp2.copy(dir); else _tmp2.normalize();
      applyKnockback(e, _tmp2, 14, 5);
    });
    return true;
  },

  diamond(state, ctx) {
    const p = playerOf(state, ctx);
    if (!p) return false;
    act.diamond = DIAMOND_TIME;
    p.diamondTimer = DIAMOND_TIME;
    p.invulnerable = true;
    rt.invulnByUs = true;
    p.speedMul = DIAMOND_SPEED;
    p.speedScale = DIAMOND_SPEED;
    if (ctx.rig && ctx.rig.setDiamond) ctx.rig.setDiamond(true);
    emitAbility(state, 'diamond', p.pos, lookDir(state, ctx, _dir, true), { duration: DIAMOND_TIME });
    bus.emit('sfx', { name: 'diamond_on', pos: p.pos, gain: 0.9 });
    return true;
  },

  psychic(state, ctx) {
    const p = playerOf(state, ctx);
    const origin = posOf(p);
    if (!origin) return false;
    const until = (state.time || 0) + PSY_TIME;
    act.psychic = PSY_TIME;
    const list = enemyList(state, ctx);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!isAlive(e)) continue;
      const ep = posOf(e);
      if (!ep) continue;
      const dx = ep.x - origin.x, dy = ep.y - origin.y, dz = ep.z - origin.z;
      if (dx * dx + dy * dy + dz * dz > PSY_RANGE * PSY_RANGE) continue;
      e.state = 'controlled';
      e.controlledUntil = until;
      e.controlledBy = 'emma';
      n++;
    }
    if (ctx.rig && ctx.rig.setAnim) ctx.rig.setAnim('ability');
    emitAbility(state, 'psychic', origin, lookDir(state, ctx, _dir, true), { radius: PSY_RANGE, count: n });
    bus.emit('sfx', { name: 'psychic', pos: origin, gain: 0.9 });
    bus.emit('toast', { text: n ? `${n} mind${n === 1 ? '' : 's'} turned.` : 'No minds in range.' });
    return true;
  },
};

/* ------------------------------------------------------------------ effect ends */

function endEffect(state, name) {
  const ctx = ctxOf[name] || {};
  const p = state && state.player;
  if (name === 'claws') {
    if (ctx.rig && ctx.rig.setClaws) ctx.rig.setClaws(false);
    if (p) p.clawsTimer = 0;
    bus.emit('sfx', { name: 'claws_retract', pos: p && p.pos, gain: 0.6 });
  } else if (name === 'diamond') {
    if (ctx.rig && ctx.rig.setDiamond) ctx.rig.setDiamond(false);
    if (p) {
      p.diamondTimer = 0;
      if (rt.invulnByUs) p.invulnerable = false;
      p.speedMul = 1;
      p.speedScale = 1;
    }
    rt.invulnByUs = false;
    bus.emit('sfx', { name: 'diamond_off', pos: p && p.pos, gain: 0.7 });
  } else if (name === 'sweep') {
    if (ctx.rig && ctx.rig.setVisorGlow && !rt.blast) ctx.rig.setVisorGlow(0);
  } else if (name === 'dash') {
    if (p) p.dashing = false;
  }
}

/* ------------------------------------------------------------------ per-frame effects */

function updateDash(state, dt) {
  const d = rt.dash;
  if (!d) return;
  const ctx = ctxOf.dash || {};
  const p = playerOf(state, ctx);
  const pos = posOf(p);
  if (!pos) { rt.dash = null; return; }

  const step = Math.min(d.t, dt) * d.speed;
  pos.x += d.dir.x * step;
  pos.z += d.dir.z * step;

  const city = cityOf(state, ctx);
  if (city && typeof city.collideCapsule === 'function') {
    if (city.collideCapsule(pos, p.radius || 0.4, p.height || 1.8, _tmp)) pos.copy(_tmp);
  }
  if (city && typeof city.getGroundHeight === 'function' && p.grounded !== false) {
    pos.y = city.getGroundHeight(pos.x, pos.z);
  }
  // The controller integrates player.vel itself, so the dash moves the position directly and
  // parks the horizontal velocity — otherwise the burst would be applied twice per frame.
  if (p.vel && p.vel.set) { p.vel.x = 0; p.vel.z = 0; }

  // shoulder-check everyone we pass through
  const list = enemyList(state, ctx);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isAlive(e)) continue;
    const key = e.id === undefined ? e : e.id;
    if (d.hit.has(key)) continue;
    const ep = posOf(e);
    if (!ep) continue;
    const dx = ep.x - pos.x, dz = ep.z - pos.z;
    if (dx * dx + dz * dz > DASH_KNOCK_R * DASH_KNOCK_R) continue;
    if (Math.abs(ep.y - pos.y) > 3) continue;
    d.hit.add(key);
    _tmp2.copy(d.dir);
    applyKnockback(e, _tmp2, 12, 4.5);
    e.knockedDown = true;
    e.knockdownTime = 1.6;
    bus.emit('sfx', { name: 'dash_impact', pos: ep, gain: 0.8 });
    bus.emit('hit', { targetId: e.id, damage: 0, source: 'dash', pos: ep, knockdown: true });
  }

  d.t -= dt;
  if (d.t <= 0) {
    rt.dash = null;
    if (p) {
      p.dashing = false;
      if (p.vel && p.vel.set) {          // hand a sane run speed back to the controller
        const carry = Math.min(d.preSpeed || 0, 14);
        p.vel.x = d.dir.x * carry;
        p.vel.z = d.dir.z * carry;
      }
    }
  }
}

function updateSlow(state, dt) {
  const s = rt.slow;
  if (!s) return;
  if (s.t > 0) {
    s.t -= dt;
    state.timeScale = SLOW_SCALE;
    if (s.t <= 0) { s.ease = SLOW_EASE; bus.emit('sfx', { name: 'slowmo_out', gain: 0.8 }); }
    return;
  }
  s.ease -= dt;
  if (s.ease <= 0) {
    state.timeScale = 1;
    rt.slow = null;
  } else {
    const k = 1 - s.ease / SLOW_EASE;           // 0 -> 1
    state.timeScale = SLOW_SCALE + (1 - SLOW_SCALE) * k;
  }
}

function updateBlast(state, dt) {
  const b = rt.blast;
  if (!b) return;
  const ctx = ctxOf.blast || {};
  b.t += dt;
  if (ctx.rig && ctx.rig.setVisorGlow) ctx.rig.setVisorGlow(1);

  const from = headPos(state, ctx, _head);
  const dir = lookDir(state, ctx, _dir, false);
  beam.from.copy(from);

  // sphere test against the enemy body centre (radius 1), nearest wins;
  // the city is not raycast horizontally — the beam is simply capped at 60 m.
  const list = enemyList(state, ctx);
  let best = null, bestT = BEAM_RANGE;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isAlive(e)) continue;
    const ep = posOf(e);
    if (!ep) continue;
    _tmp.set(ep.x - from.x, centerY(e) - from.y, ep.z - from.z);
    const t = _tmp.dot(dir);
    if (t < 0 || t > bestT) continue;
    const r = BEAM_RADIUS + (e.radius || 0);
    if (_tmp.lengthSq() - t * t > r * r) continue;
    best = e; bestT = t;
  }

  beam.length = bestT;
  beam.to.copy(from).addScaledVector(dir, bestT);
  beam.target = best;
  state.beam = beam;
  if (best) {
    damageEntity(state, best, BEAM_DPS * dt, 'blast');
    if (Math.random() < dt * 8) bus.emit('sfx', { name: 'beam_hit', pos: posOf(best), gain: 0.5 });
  }
  if (b.t >= BEAM_MAX_TIME) stopBlast(state);
}

function stopBlast(state) {
  if (!rt.blast) return;
  const ctx = ctxOf.blast || {};
  rt.blast = null;
  beam.active = false;
  beam.target = null;
  beam.length = 0;
  if (ctx.rig && ctx.rig.setVisorGlow) ctx.rig.setVisorGlow(0);
  cool.blast = ABILITIES.blast.cooldown;
  emitAbility(state, 'blast', beam.from, beam.to, { phase: 'end', active: false });
  bus.emit('sfx', { name: 'beam_stop', pos: beam.from, gain: 0.7 });
}

/** Nearest prop or enemy inside the 12 m / 60-degree cone in front. */
function pickTKTarget(state, ctx, origin, dir) {
  const cosHalf = Math.cos(TK_CONE_DEG * 0.5 * Math.PI / 180);
  let best = null, bestKind = null, bestD2 = TK_RANGE * TK_RANGE;

  const consider = (obj, kind) => {
    const op = posOf(obj);
    if (!op) return;
    _tmp.set(op.x - origin.x, op.y - origin.y, op.z - origin.z);
    const d2 = _tmp.lengthSq();
    if (d2 > bestD2) return;
    if (d2 > 1e-6) {
      _tmp.multiplyScalar(1 / Math.sqrt(d2));
      if (_tmp.dot(dir) < cosHalf) return;
    }
    best = obj; bestKind = kind; bestD2 = d2;
  };

  const props = propsOf(state, ctx);
  for (let i = 0; i < props.length; i++) {
    const pr = props[i];
    if (!pr || pr.held || pr.alive === false) continue;
    consider(pr, 'prop');
  }
  const list = enemyList(state, ctx);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isAlive(e) || e.held) continue;
    consider(e, 'enemy');
  }
  return best ? { target: best, kind: bestKind } : null;
}

function updateTK(state, dt) {
  const tk = rt.tk;
  if (!tk) return;
  const t = tk.target;
  const ctx = ctxOf.telekinesis || {};

  // gone, dead, or somebody cleared the held flag -> let it fly
  if (!t || t.alive === false || (tk.kind === 'enemy' && !isAlive(t))) {
    rt.tk = null;
    cool.telekinesis = ABILITIES.telekinesis.cooldown;
    return;
  }
  if (t.held === false) { throwHeld(state); return; }

  tk.t += dt;
  const p = playerOf(state, ctx);
  const base = posOf(p);
  if (!base) return;
  const dir = lookDir(state, ctx, _dir, false);

  _tgt.set(
    base.x + dir.x * TK_HOLD_DIST,
    base.y + TK_HOLD_HEIGHT,
    base.z + dir.z * TK_HOLD_DIST,
  );
  const k = 1 - Math.exp(-TK_FOLLOW * dt);         // frame-rate independent smoothing
  const tp = posOf(t);
  tp.x += (_tgt.x - tp.x) * k;
  tp.y += (_tgt.y - tp.y) * k;
  tp.z += (_tgt.z - tp.z) * k;
  if (t.mesh && t.mesh.position && t.mesh.position !== tp) t.mesh.position.copy(tp);
  if (t.vel && t.vel.set) t.vel.set(0, 0, 0);

  if (tk.kind === 'enemy') {
    t.state = 'controlled';
    t.controlledBy = 'jean';
    t.controlledUntil = (state.time || 0) + 1;
    damageEntity(state, t, TK_DPS * dt, 'telekinesis');
  }
}

/** Hurls whatever telekinesis is holding at 28 m/s along the look direction. */
export function throwHeld(state) {
  const tk = rt.tk;
  if (!tk) return false;
  const ctx = ctxOf.telekinesis || {};
  const t = tk.target;
  rt.tk = null;
  cool.telekinesis = ABILITIES.telekinesis.cooldown;
  const dir = lookDir(state, ctx, _dir, false);
  _tmp.copy(dir).multiplyScalar(TK_THROW_SPEED);

  if (t) {
    t.held = false;
    if (tk.kind === 'prop' && typeof t.throwWith === 'function') {
      t.throwWith(_tmp, 'telekinesis');
    } else {
      if (t.vel && t.vel.set) t.vel.set(_tmp.x, _tmp.y, _tmp.z);
      t.controlledUntil = 0;
      t.controlledBy = null;
      if (isAlive(t)) {
        t.state = 'stagger';
        t.knockedDown = true;
        damageEntity(state, t, 20, 'telekinesis');
      }
    }
  }
  emitAbility(state, 'telekinesis', posOf(t) || _pos, dir, { phase: 'throw', speed: TK_THROW_SPEED, target: t });
  bus.emit('sfx', { name: 'tk_throw', pos: posOf(t), gain: 0.9 });
  return true;
}

/** Convenience for the controller: does this character have the ability at all? */
export function hasAbility(name) { return !!ABILITIES[name]; }
