// src/combat.js — melee combat, the damage model and throwable physics props (Agent E).
// No DOM or WebGL at import time: every canvas/texture call is lazy and guarded so this
// module can be imported by `node --test`.
import * as THREE from '../vendor/three.module.js';
import { bus } from './core/bus.js';

/* ------------------------------------------------------------------ tunables */

export const MELEE = {
  range: 2.4,            // metres, arc radius in front of the player
  arcDeg: 110,           // total cone angle (half-angle = 55 deg)
  damage: [18, 22, 30],  // by combo index (0-based)
  clawMultiplier: 1.6,
  bleedDps: 5,
  bleedTime: 3,
  knockbackForce: 9,     // third hit only
  knockbackLift: 3.5,
  verticalReach: 2.5,
};

export const PROP_KINDS = {
  crate:   { size: [0.9, 0.9, 0.9], mass: 35,  color: 0xa9773f, tint: '#a9773f' },
  bench:   { size: [1.8, 0.5, 0.62], mass: 60, color: 0x6b4a2a, tint: '#6b4a2a' },
  mailbox: { size: [0.42, 1.2, 0.5], mass: 18, color: 0x2f4f6f, tint: '#2f4f6f' },
  car:     { size: [4.4, 1.5, 1.9], mass: 900, color: 0xb8352f, tint: '#b8352f' },
};

// The live game state, so a prop updated as `prop.update(dt, city)` (no state argument,
// which is how src/main.js drives them) can still find the enemies it slams into.
let _world = null;
/** Lets abilities.js/main.js tell the prop system which state object is live. */
export function setWorld(state) {
  if (!state) return;
  _world = state;
  // time running backwards means a new game (or a new test state): forget who drove props
  if (state.time !== undefined && state.time < _lastPropTick) _lastPropTick = -Infinity;
}
// Game time at which someone OTHER than updateProps() last stepped a prop (src/main.js
// walks state.props itself). abilities.js only takes the props over when this goes stale,
// so they are never integrated twice in one frame.
let _lastPropTick = -Infinity;
let _inUpdateProps = false;
export function propsLastSteppedAt() { return _lastPropTick; }

const GRAVITY = -19.6;          // a touch heavier than real g; reads better for thrown junk
const PROP_DAMAGE_SPEED = 8;    // m/s above which a moving prop hurts
const PROP_DAMAGE_RADIUS = 1.5;
const TAU = Math.PI * 2;

/* --------------------------------------------------------- scratch (no per-frame allocs) */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _out = new THREE.Vector3();

/* ------------------------------------------------------------------ small helpers */

export function isAlive(e) {
  return !!e && e.state !== 'dead' && (e.hp === undefined || e.hp > 0);
}

export function enemyList(state, ctx) {
  const src = (ctx && ctx.enemies) || (state && state.enemies);
  if (!src) return EMPTY;
  if (Array.isArray(src)) return src;
  if (typeof src.all === 'function') return src.all();
  return EMPTY;
}
const EMPTY = [];

/** True while Wolverine's claws are out (abilities.js owns `player.clawsTimer`). */
export function hasClaws(state) {
  const p = state && state.player;
  return !!p && p.clawsTimer > 0;
}

/** Diamond form (or any other module setting `player.invulnerable`). */
export function isInvulnerable(state) {
  const p = state && state.player;
  if (!p) return false;
  return p.invulnerable === true || p.diamondTimer > 0;
}

function isPlayerTarget(state, target) {
  if (!target) return false;
  return target === (state && state.player) || target.isPlayer === true;
}

function posOf(t) {
  return t && (t.pos || (t.mesh && t.mesh.position)) || null;
}

/**
 * Body-centre height for an entity whose `pos` sits at its feet (enemies and the player).
 * Used by the optic beam and prop impacts so horizontal shots do not sail under everyone.
 */
export function centerY(e) {
  const p = posOf(e);
  if (!p) return 0;
  if (e.centerOffset !== undefined) return p.y + e.centerOffset;
  if (e.height) return p.y + e.height * 0.5;
  return p.y + 0.9;
}

/** Forward vector for the attack: explicit dir > camera > player yaw. */
export function aimDirection(state, ctx, out = _out, flat = true) {
  const d = ctx && ctx.dir;
  if (d && typeof d.x === 'number' && (d.x * d.x + d.y * d.y + d.z * d.z) > 1e-8) {
    out.set(d.x, d.y, d.z);
  } else {
    const cam = (ctx && ctx.camera) || (state && state.camera);
    if (cam && typeof cam.getWorldDirection === 'function') cam.getWorldDirection(out);
    else {
      const yaw = (ctx && ctx.player && ctx.player.yaw) || (state && state.player && state.player.yaw) || 0;
      out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    }
  }
  if (flat) out.y = 0;
  if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
  return out.normalize();
}

/** Generic knockback: works with `vel` Vector3, a `knockback()` method, or bare position. */
export function applyKnockback(target, dir, force = 8, lift = 3) {
  if (!target) return false;
  if (typeof target.knockback === 'function') {
    target.knockback(dir.x * force, lift, dir.z * force);
  } else if (target.vel && typeof target.vel.x === 'number') {
    target.vel.x += dir.x * force;
    target.vel.y += lift;
    target.vel.z += dir.z * force;
  } else {
    const p = posOf(target);
    if (p) { p.x += dir.x * 0.6; p.z += dir.z * 0.6; }
  }
  if (target.state && target.state !== 'dead' && target.state !== 'controlled') target.state = 'stagger';
  if (target.staggerTime !== undefined) target.staggerTime = Math.max(target.staggerTime, 0.6);
  return true;
}

/* ------------------------------------------------------------------ damage */

/**
 * Apply damage to an enemy or to the player.
 * Returns the damage actually dealt (0 when blocked by diamond form).
 */
export function damageEntity(state, target, amount, source = 'unknown') {
  if (!target || !(amount > 0)) return 0;

  if (isPlayerTarget(state, target)) {
    if (isInvulnerable(state)) {
      bus.emit('sfx', { name: 'diamond_deflect', pos: target.pos, gain: 0.6 });
      bus.emit('hit', { targetId: 'player', damage: 0, source, pos: target.pos, blocked: true });
      return 0;
    }
    const before = target.hp === undefined ? 100 : target.hp;
    const dealt = Math.min(before, amount);
    target.hp = Math.max(0, before - amount);
    bus.emit('hit', { targetId: 'player', damage: dealt, source, pos: target.pos });
    bus.emit('sfx', { name: 'player_hurt', pos: target.pos, gain: 0.8 });
    if (target.hp <= 0 && state && state.phase !== 'gameover') {
      state.phase = 'gameover';
      bus.emit('phase', { phase: 'gameover' });
    }
    return dealt;
  }

  const p = posOf(target);
  const before = target.hp === undefined ? Infinity : target.hp;
  if (typeof target.takeDamage === 'function') target.takeDamage(amount, source);
  else if (target.hp !== undefined) target.hp = Math.max(0, target.hp - amount);
  const after = target.hp === undefined ? Infinity : target.hp;
  const dealt = Number.isFinite(before) ? Math.max(0, before - after) : amount;

  bus.emit('hit', { targetId: target.id, damage: dealt, source, pos: p });
  return dealt;
}

/**
 * Damage enemies deal to the player, routed through the damage model so diamond form,
 * the hp floor and the game-over phase all apply. enemies.js emits its own `hit` event
 * for this path, so this handler deliberately stays quiet.
 */
export function playerDamageHook(amount, info = {}) {
  const st = info.state || _world;
  const p = st && st.player;
  if (!p || !(amount > 0)) return 0;
  if (isInvulnerable(st)) {
    bus.emit('sfx', { name: 'diamond_deflect', pos: p.pos, gain: 0.6 });
    return 0;
  }
  const before = p.hp === undefined ? 100 : p.hp;
  const dealt = Math.min(before, amount);
  p.hp = Math.max(0, before - amount);
  if (p.hp <= 0 && st.phase !== 'gameover') {
    st.phase = 'gameover';
    bus.emit('phase', { phase: 'gameover' });
  }
  return dealt;
}

/** Registers playerDamageHook with an enemies module. Safe to call repeatedly. */
export function installPlayerDamageHook(mod) {
  if (mod && typeof mod.onPlayerDamage === 'function') { mod.onPlayerDamage(playerDamageHook); return true; }
  return false;
}
// Best effort: wire ourselves up when enemies.js is present, so goon hits respect diamond form.
import { onPlayerDamage as _onPlayerDamage } from './enemies.js';
try { installPlayerDamageHook({ onPlayerDamage: _onPlayerDamage }); } catch (e) { /* optional */ }

/* ------------------------------------------------------------------ bleed (claws) */

export function applyBleed(target, dps = MELEE.bleedDps, seconds = MELEE.bleedTime, source = 'claws') {
  if (!target) return false;
  if (target.bleed) {
    target.bleed.dps = Math.max(target.bleed.dps, dps);
    target.bleed.t = Math.max(target.bleed.t, seconds);
    target.bleed.source = source;
  } else {
    target.bleed = { dps, t: seconds, source };
  }
  return true;
}

/** Ticks bleed damage-over-time on every enemy. Called from updateAbilities(). */
export function tickBleeds(state, dt) {
  if (!(dt > 0)) return;
  const list = enemyList(state);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const b = e && e.bleed;
    if (!b || b.t <= 0) continue;
    if (!isAlive(e)) { e.bleed = null; continue; }
    const step = Math.min(dt, b.t);
    b.t -= dt;
    damageEntity(state, e, b.dps * step, b.source || 'bleed');
    if (b.t <= 0) e.bleed = null;
  }
}

/* ------------------------------------------------------------------ regen (Wolverine) */

/**
 * Heals the player from `state.player.regen = { t, rate }` (set by abilities.js).
 * Returns hp healed this frame.
 */
export function applyRegen(state, dt) {
  const p = state && state.player;
  const r = p && p.regen;
  if (!r || !(r.t > 0) || !(dt > 0)) return 0;
  const step = Math.min(dt, r.t);
  r.t -= dt;
  const maxHp = p.maxHp === undefined ? Infinity : p.maxHp;
  const before = p.hp === undefined ? 0 : p.hp;
  const healed = Math.max(0, Math.min(r.rate * step, maxHp - before));
  p.hp = before + healed;
  if (r.t <= 0) { p.regen = null; }
  return healed;
}

/* ------------------------------------------------------------------ melee */

/**
 * 3-hit melee combo. Hit-tests enemies inside a 2.4 m / 110-degree arc in front of the player.
 * comboIndex is 0-based (0,1,2); values out of range are clamped.
 * Returns the array of enemies hit.
 */
export function meleeAttack(state, ctx = {}, comboIndex = 0) {
  const player = (ctx && ctx.player) || (state && state.player);
  const origin = posOf(player);
  if (!origin) return EMPTY;

  const idx = Math.max(0, Math.min(MELEE.damage.length - 1, comboIndex | 0));
  const claws = hasClaws(state);
  const damage = MELEE.damage[idx] * (claws ? MELEE.clawMultiplier : 1);
  const dir = aimDirection(state, ctx, _a, true);
  const cosHalf = Math.cos((MELEE.arcDeg * 0.5) * Math.PI / 180);
  const range2 = MELEE.range * MELEE.range;

  bus.emit('sfx', { name: claws ? 'claw_swing' : 'swing', pos: origin, gain: 0.7 });
  bus.emit('ability', {
    character: characterId(state), name: claws ? 'claw_strike' : 'melee',
    pos: origin, dir, combo: idx,
  });

  const list = enemyList(state, ctx);
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isAlive(e)) continue;
    const ep = posOf(e);
    if (!ep) continue;
    _b.set(ep.x - origin.x, 0, ep.z - origin.z);
    const d2 = _b.lengthSq();
    const reach = MELEE.range + (e.radius || 0.5);
    if (d2 > Math.max(range2, reach * reach)) continue;
    if (Math.abs(ep.y - origin.y) > MELEE.verticalReach) continue;
    if (d2 > 1e-6) {
      _b.multiplyScalar(1 / Math.sqrt(d2));
      if (_b.dot(dir) < cosHalf) continue;
    }
    damageEntity(state, e, damage, claws ? 'claws' : 'melee');
    if (claws) applyBleed(e, MELEE.bleedDps, MELEE.bleedTime, 'claws');
    if (idx === MELEE.damage.length - 1) applyKnockback(e, dir, MELEE.knockbackForce, MELEE.knockbackLift);
    bus.emit('sfx', { name: claws ? 'claw_hit' : 'melee_hit', pos: ep, gain: 0.9 });
    hits.push(e);
  }
  return hits;
}

function characterId(state) {
  if (!state) return 'wolverine';
  if (state.player && state.player.character) return state.player.character;
  const r = state.roster;
  return (r && r[state.activeIndex || 0]) || 'wolverine';
}

/* ------------------------------------------------------------------ physics props */

let _propId = 0;

/**
 * A throwable prop: crate, bench, mailbox, car.
 * Ballistic motion with a ground bounce (city.getGroundHeight) and building stop
 * (city.collideCapsule). While `held` is true (telekinesis) physics is suspended.
 */
export class PhysicsProp {
  constructor(mesh, mass = 30, opts = {}) {
    this.id = 'prop' + (++_propId);
    this.mesh = mesh;
    this.mass = mass;
    this.kind = opts.kind || 'crate';
    this.pos = mesh && mesh.position ? mesh.position : new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.held = false;
    this.alive = true;
    this.asleep = true;
    this.grounded = true;
    this.size = opts.size || [1, 1, 1];
    this.halfH = this.size[1] * 0.5;
    this.radius = opts.radius || Math.max(0.3, Math.max(this.size[0], this.size[2]) * 0.5);
    this.restitution = opts.restitution === undefined ? 0.32 : opts.restitution;
    this.friction = opts.friction === undefined ? 0.72 : opts.friction;
    this.thrownBy = null;
    this._hitIds = null; // lazily allocated per throw
  }

  /** Launch it. `vel` is a Vector3-like in m/s. */
  throwWith(vel, source = 'telekinesis') {
    this.held = false;
    this.asleep = false;
    this.grounded = false;
    if (vel) this.vel.set(vel.x || 0, vel.y || 0, vel.z || 0);
    this.thrownBy = source;
    this.spin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    if (this._hitIds) this._hitIds.clear(); else this._hitIds = new Set();
    bus.emit('sfx', { name: 'prop_throw', pos: this.pos, gain: 0.7 });
    return this;
  }

  /** Telekinesis grab/park helper — abilities.js sets `held` directly too. */
  grab() { this.held = true; this.asleep = false; this.vel.set(0, 0, 0); return this; }

  update(dt, city, state) {
    if (!this.alive || !(dt > 0)) return;
    const st = state || _world;
    if (!_inUpdateProps && st && st.time !== undefined) _lastPropTick = st.time;
    if (this.held) { this.asleep = false; if (this.mesh) this.mesh.position.copy(this.pos); return; }
    if (this.asleep) return;

    this.vel.y += GRAVITY * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    // buildings: push the prop back out and kill most of its horizontal energy
    if (city && typeof city.collideCapsule === 'function') {
      _c.copy(this.pos);
      if (city.collideCapsule(_c, this.radius, this.size[1], _out)) {
        this.pos.copy(_out);
        this.vel.x *= -0.25;
        this.vel.z *= -0.25;
        bus.emit('sfx', { name: 'prop_impact', pos: this.pos, gain: 0.5 });
      }
    }

    // ground
    const ground = city && typeof city.getGroundHeight === 'function'
      ? city.getGroundHeight(this.pos.x, this.pos.z) : 0;
    const rest = ground + this.halfH;
    if (this.pos.y <= rest) {
      this.pos.y = rest;
      if (this.vel.y < -1.2) {
        this.vel.y = -this.vel.y * this.restitution;
        this.vel.x *= this.friction;
        this.vel.z *= this.friction;
        bus.emit('sfx', { name: 'prop_land', pos: this.pos, gain: 0.5 });
      } else {
        this.vel.y = 0;
        const damp = Math.exp(-5 * dt);   // frame-rate independent ground friction
        this.vel.x *= damp;
        this.vel.z *= damp;
        this.grounded = true;
        this.spin.set(0, 0, 0);
        if (this.vel.lengthSq() < 0.04) { this.vel.set(0, 0, 0); this.asleep = true; }
      }
    } else {
      this.grounded = false;
    }

    // damage things it slams into while it is really moving
    const speed2 = this.vel.lengthSq();
    if (speed2 > PROP_DAMAGE_SPEED * PROP_DAMAGE_SPEED) this._smash(st, Math.sqrt(speed2));

    if (this.mesh) {
      this.mesh.position.copy(this.pos);
      if (!this.grounded && this.mesh.rotation) {
        this.mesh.rotation.x = (this.mesh.rotation.x + this.spin.x * dt) % TAU;
        this.mesh.rotation.y = (this.mesh.rotation.y + this.spin.y * dt) % TAU;
        this.mesh.rotation.z = (this.mesh.rotation.z + this.spin.z * dt) % TAU;
      }
    }
  }

  /** Damage to deal on impact — heavier and faster hurts more. */
  impactDamage(speed) {
    return Math.min(90, 8 + Math.min(this.mass, 400) * 0.08 + speed * 1.4);
  }

  _smash(state, speed) {
    const list = enemyList(state);
    if (!list.length) return;
    if (!this._hitIds) this._hitIds = new Set();
    const r = PROP_DAMAGE_RADIUS + this.radius;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!isAlive(e)) continue;
      const ep = posOf(e);
      if (!ep) continue;
      const dx = ep.x - this.pos.x, dy = centerY(e) - this.pos.y, dz = ep.z - this.pos.z;
      if (dx * dx + dy * dy + dz * dz > r * r) continue;
      const key = e.id === undefined ? e : e.id;
      if (this._hitIds.has(key)) continue;
      this._hitIds.add(key);
      damageEntity(state, e, this.impactDamage(speed), this.thrownBy ? 'thrown_prop' : 'prop');
      _a.set(dx, 0, dz);
      if (_a.lengthSq() > 1e-6) _a.normalize(); else _a.copy(this.vel).setY(0).normalize();
      applyKnockback(e, _a, 7, 3);
      bus.emit('sfx', { name: 'prop_smash', pos: this.pos, gain: 1 });
      this.vel.multiplyScalar(0.45);
    }
  }

  dispose() {
    this.alive = false;
    const m = this.mesh;
    if (m) {
      if (m.parent) m.parent.remove(m);
      if (m.geometry && m.geometry.dispose) m.geometry.dispose();
    }
  }
}

/**
 * Advances every prop in `state.props`. Guarded so calling it twice in one frame
 * (main loop + updateAbilities) does not double-integrate.
 */
export function updateProps(state, dt, city) {
  if (!state || !Array.isArray(state.props) || !(dt > 0)) return;
  _world = state;
  const stamp = state.time === undefined ? null : state.time;
  if (stamp !== null && state.__propsStamp === stamp) return;
  state.__propsStamp = stamp;
  const c = city || state.city;
  const props = state.props;
  _inUpdateProps = true;
  try {
    for (let i = 0; i < props.length; i++) props[i].update(dt, c, state);
  } finally {
    _inUpdateProps = false;
  }
}

/* ------------------------------------------------------------------ prop spawning */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _geoCache = new Map();
const _matCache = new Map();

function propGeometry(kind) {
  let g = _geoCache.get(kind);
  if (!g) {
    const s = PROP_KINDS[kind].size;
    g = new THREE.BoxGeometry(s[0], s[1], s[2]);
    _geoCache.set(kind, g);
  }
  return g;
}

/** Small procedural canvas texture per kind; falls back to flat colour without a DOM. */
function propMaterial(kind) {
  let m = _matCache.get(kind);
  if (m) return m;
  const def = PROP_KINDS[kind];
  const params = { color: def.color, roughness: 0.82, metalness: kind === 'mailbox' || kind === 'car' ? 0.45 : 0.05 };
  if (typeof document !== 'undefined' && document.createElement) {
    const tex = propTexture(kind);
    if (tex) { params.map = tex; params.color = 0xffffff; }
  }
  m = new THREE.MeshStandardMaterial(params);
  _matCache.set(kind, m);
  return m;
}

function propTexture(kind) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  if (!g) return null;
  const def = PROP_KINDS[kind];
  g.fillStyle = def.tint;
  g.fillRect(0, 0, 64, 64);
  if (kind === 'crate') {
    g.strokeStyle = 'rgba(60,36,14,0.85)'; g.lineWidth = 5;
    g.strokeRect(3, 3, 58, 58);
    g.beginPath(); g.moveTo(3, 3); g.lineTo(61, 61); g.moveTo(61, 3); g.lineTo(3, 61); g.stroke();
  } else if (kind === 'bench') {
    g.strokeStyle = 'rgba(40,24,10,0.7)'; g.lineWidth = 3;
    for (let y = 6; y < 64; y += 12) { g.beginPath(); g.moveTo(0, y); g.lineTo(64, y); g.stroke(); }
  } else if (kind === 'mailbox') {
    g.fillStyle = 'rgba(230,230,235,0.9)'; g.fillRect(10, 24, 44, 16);
    g.fillStyle = 'rgba(20,30,45,0.9)'; g.fillRect(10, 40, 44, 4);
  } else {
    const grd = g.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0.35)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.3)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(25,35,55,0.85)'; g.fillRect(6, 14, 52, 16); // window band
  }
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  return t;
}

function gatherPois(city) {
  const out = [];
  const push = (p) => { if (p && typeof p.x === 'number') out.push(p); };
  if (city && Array.isArray(city.pois)) city.pois.forEach(push);
  else if (city && city.json && Array.isArray(city.json.pois)) city.json.pois.forEach(push);
  else if (city && typeof city.poi === 'function') {
    const ids = ['downtown', 'courthouse', 'landing_zone', 'asumh', 'hospital', 'walmart', 'high_school', 'park', 'airport', 'lake'];
    for (let i = 0; i < ids.length; i++) { try { push(city.poi(ids[i])); } catch (e) { /* ignore */ } }
  }
  if (!out.length) out.push({ id: 'origin', x: 0, z: 0, radius: 250 });
  return out;
}

const SPAWN_MIX = ['crate', 'crate', 'crate', 'crate', 'bench', 'bench', 'mailbox', 'mailbox', 'crate', 'car'];

/**
 * Scatters throwable props (crates, benches, mailboxes, a few cars) near roads around the
 * POIs, adds them to `state.props` and to the scene. Returns the props created.
 */
export function spawnProps(state, city, count = 120, opts = {}) {
  _world = state;
  const rand = mulberry32(opts.seed === undefined ? 0x5eed1e : opts.seed);
  const pois = gatherPois(city);
  const scene = opts.scene || (state && state.scene);
  if (!state.props) state.props = [];
  const made = [];

  for (let i = 0; i < count; i++) {
    const kind = SPAWN_MIX[i % SPAWN_MIX.length];
    const def = PROP_KINDS[kind];
    const poi = pois[(i + (rand() * pois.length | 0)) % pois.length];
    const radius = Math.max(40, poi.radius || 150);
    const r = radius * Math.sqrt(rand());
    const a = rand() * TAU;
    let x = poi.x + Math.cos(a) * r;
    let z = poi.z + Math.sin(a) * r;

    // hug the nearest road, offset onto the verge so props are reachable but not in lanes
    if (city && typeof city.nearestRoadPoint === 'function') {
      const rp = city.nearestRoadPoint(x, z);
      if (rp && typeof rp.x === 'number') {
        let dx = x - rp.x, dz = z - rp.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-3) { const t = rand() * TAU; dx = Math.cos(t); dz = Math.sin(t); }
        else { dx /= len; dz /= len; }
        const off = (kind === 'car' ? 5.5 : 7) + rand() * 4;
        x = rp.x + dx * off;
        z = rp.z + dz * off;
      }
    }
    if (city && city.bounds) {
      const b = city.bounds;
      x = Math.min(b.maxX - 5, Math.max(b.minX + 5, x));
      z = Math.min(b.maxZ - 5, Math.max(b.minZ + 5, z));
    }
    const groundY = city && typeof city.getGroundHeight === 'function' ? city.getGroundHeight(x, z) : 0;

    const mesh = new THREE.Mesh(propGeometry(kind), propMaterial(kind));
    mesh.position.set(x, groundY + def.size[1] * 0.5, z);
    mesh.rotation.y = rand() * TAU;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = kind;

    const prop = new PhysicsProp(mesh, def.mass, { kind, size: def.size });
    mesh.userData.prop = prop;
    if (scene && typeof scene.add === 'function') scene.add(mesh);
    state.props.push(prop);
    made.push(prop);
  }
  return made;
}

/** Removes every prop from the scene and empties `state.props`. */
export function clearProps(state) {
  if (!state || !Array.isArray(state.props)) return;
  for (let i = 0; i < state.props.length; i++) state.props[i].dispose();
  state.props.length = 0;
}
