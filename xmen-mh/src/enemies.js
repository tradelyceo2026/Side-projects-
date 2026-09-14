// src/enemies.js — Agent F
// Enemy types, AI, spawning and waves.
//
// Design note on the rig dependency: `EnemyManager`'s constructor takes a
// `rigFactory` function (matching the SPEC signature
// `EnemyManager(scene, city, rigFactory)`), so this module never imports
// `../entities/characters.js` itself — the caller (main.js) passes
// `createNpcRig` (and, optionally, `NPC_PRESETS.thug` via `opts.thugPreset`).
// That keeps this file import-safe under plain `node --test` even while
// other agents' modules are still being written.
//
// Pure helpers (steering, sensing, state transitions, damage math) are
// exported standalone so they can be unit tested with fake city/rig objects
// with no DOM and no THREE dependency beyond plain {x,z} vector-likes.

import * as THREE from '../vendor/three.module.js';
import { bus } from './core/bus.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const ENEMY_KINDS = {
  thug: {
    hp: 60, speed: 4.5, radius: 0.45, height: 1.8,
    senseRadius: 30, attackRange: 1.8,
    meleeDamage: 8, windup: 0.5, attackCooldown: 0.7,
  },
  drone: {
    hp: 40, speed: 5, radius: 0.6, height: 0.5,
    senseRadius: 30, attackRange: 18,
    fireDamage: 6, fireInterval: 2, hoverMin: 3, hoverMax: 6,
  },
  sentinel: {
    hp: 900, speed: 3, radius: 2.4, height: 12,
    senseRadius: 45, attackRange: 40,
    beamDamage: 25, beamTelegraph: 1.5, beamDuration: 2, beamWidth: 3,
    stompDamage: 30, stompRadius: 6, stompRange: 7,
  },
};

export const DEFAULT_THUG_SPEC = { gender: 'm', outfit: 'dark', skin: 'tan', hair: 'buzz', hat: null };

const CHASE_MEMORY = 5;        // seconds player is "remembered" after losing sense
const STAGGER_DURATION = 0.4;  // seconds
const DEAD_FADE_TIME = 4;      // seconds before a dead enemy is fully removed
const ACTIVE_RADIUS = 70;      // beyond this, AI ticks are throttled
const FAR_UPDATE_INTERVAL = 4; // update far enemies 1 frame in N
const KNOCKBACK_FORCE = { thug: 6, drone: 4, sentinel: 1.5 };

// ---------------------------------------------------------------------------
// Pure math / AI helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function distance2D(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function normalize2D(v) {
  const len = Math.hypot(v.x, v.z);
  return len < 1e-8 ? { x: 0, z: 0 } : { x: v.x / len, z: v.z / len };
}

export function seekVelocity(pos, target, speed) {
  return { ...normalize2D({ x: target.x - pos.x, z: target.z - pos.z }), speed };
}

export function canSensePlayer(enemyPos, playerPos, senseRadius) {
  return distance2D(enemyPos, playerPos) <= senseRadius;
}

/**
 * Pure state-machine transition. `cur` is the current state name, `input`
 * carries every fact the decision needs. Returns the next state name.
 */
export function nextEnemyState(cur, input) {
  const {
    time = 0, hp = 1, distToPlayer = Infinity, senseRadius = 0, attackRange = 0,
    lastSeenAt = null, rememberDuration = CHASE_MEMORY,
    staggerUntil = 0, controlledUntil = 0,
  } = input;

  if (hp <= 0) return 'dead';
  if (cur === 'dead') return 'dead';

  if (controlledUntil > time) return 'controlled';
  if (cur === 'controlled') cur = distToPlayer <= senseRadius ? 'chase' : 'idle';

  if (staggerUntil > time) return 'stagger';
  if (cur === 'stagger') cur = distToPlayer <= senseRadius ? 'chase' : 'idle';

  const canSee = distToPlayer <= senseRadius;
  const remembers = lastSeenAt != null && (time - lastSeenAt) <= rememberDuration;

  switch (cur) {
    case 'idle':
    case 'patrol':
      return canSee ? 'chase' : cur;
    case 'chase':
      if (distToPlayer <= attackRange) return 'attack';
      if (!canSee && !remembers) return 'patrol';
      return 'chase';
    case 'attack':
      if (distToPlayer > attackRange * 1.25) return canSee || remembers ? 'chase' : 'patrol';
      return 'attack';
    default:
      return canSee ? 'chase' : 'idle';
  }
}

/**
 * Steers `dir` (a normalized {x,z}) around obstacles by probing a point
 * ahead of `pos` with `probeFn(pos,radius,height,out)` — the same signature
 * as `city.collideCapsule`. Returns a new normalized {x,z} direction.
 */
export function steerAroundObstacles(pos, dir, radius, height, probeFn, aheadDist = 2.5) {
  if (typeof probeFn !== 'function') return dir;
  const ahead = { x: pos.x + dir.x * aheadDist, y: pos.y ?? 0, z: pos.z + dir.z * aheadDist };
  const out = { x: ahead.x, y: ahead.y, z: ahead.z };
  const collided = probeFn(ahead, radius, height, out);
  if (!collided) return dir;
  const pushX = out.x - ahead.x, pushZ = out.z - ahead.z;
  const pushLen = Math.hypot(pushX, pushZ);
  if (pushLen < 1e-5) return normalize2D({ x: -dir.z, z: dir.x }); // fall back: turn 90deg
  return normalize2D({ x: dir.x + pushX / pushLen, z: dir.z + pushZ / pushLen });
}

/** Picks a wander point within `radius` of `pos`, optionally snapped to a road via roadPointFn(x,z). */
export function pickWanderTarget(pos, radius, roadPointFn, rng = Math.random) {
  const angle = rng() * Math.PI * 2;
  const dist = radius * (0.4 + rng() * 0.6);
  const raw = { x: pos.x + Math.cos(angle) * dist, z: pos.z + Math.sin(angle) * dist };
  if (typeof roadPointFn === 'function') {
    const rp = roadPointFn(raw.x, raw.z);
    if (rp) return { x: rp.x, z: rp.z };
  }
  return raw;
}

/** Pure hp/dead calculation, no side effects. */
export function applyDamage(hp, amount) {
  const nextHp = Math.max(0, hp - Math.max(0, amount));
  return { hp: nextHp, dead: nextHp <= 0 };
}

/** Fall damage from an impact speed (m/s), used for TK-thrown/dropped enemies. */
export function fallDamage(impactSpeed, opts = {}) {
  const safe = opts.safeSpeed ?? 8;
  const factor = opts.factor ?? 4;
  if (impactSpeed <= safe) return 0;
  return Math.round((impactSpeed - safe) * factor);
}

/** Nearest other living enemy from `others`, used by the `controlled` (psychic) state. */
export function pickControlledTarget(enemy, others) {
  let best = null, bestDist = Infinity;
  for (const o of others) {
    if (o === enemy || o.isDead) continue;
    const d = distance2D(enemy.pos, o.pos);
    if (d < bestDist) { bestDist = d; best = o; }
  }
  return best;
}

/** Knockback direction*force away from a damage source ({pos} or {dir}), or a default. */
export function knockbackFrom(pos, source, force) {
  if (source && source.pos) {
    const dx = pos.x - source.pos.x, dz = pos.z - source.pos.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) return { x: (dx / len) * force, z: (dz / len) * force };
  }
  if (source && source.dir) {
    const len = Math.hypot(source.dir.x, source.dir.z) || 1;
    return { x: (source.dir.x / len) * force, z: (source.dir.z / len) * force };
  }
  return { x: 0, z: force };
}

/** True if `point` lies within `width` of the ray from `origin` along normalized `dir`, within `maxDist`. */
export function pointNearLine(origin, dir, point, width, maxDist) {
  const dx = point.x - origin.x, dz = point.z - origin.z;
  const forward = dx * dir.x + dz * dir.z;
  if (forward < 0 || forward > maxDist) return false;
  const perp = Math.abs(dx * dir.z - dz * dir.x);
  return perp <= width;
}

function sourceLabel(source) {
  if (!source) return 'unknown';
  if (typeof source === 'string') return source;
  if (source.id) return source.id;
  if (source.kind) return source.kind;
  return 'unknown';
}

function disposeObject3D(obj) {
  if (!obj || typeof obj.traverse !== 'function') return;
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) m && m.dispose && m.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Player damage hook — combat.js wraps this to route enemy damage into its
// own pipeline (armor, diamond form, etc.); default just subtracts hp.
// ---------------------------------------------------------------------------

let playerDamageHandler = null;
/** Register a hook `fn(amount, {state, source, pos})` for damage enemies deal to the player. Pass a falsy value to restore the default (state.player.hp -= amount). */
export function onPlayerDamage(fn) {
  playerDamageHandler = typeof fn === 'function' ? fn : null;
}
function dealPlayerDamage(state, amount, info = {}) {
  const amt = Math.max(0, amount);
  if (amt <= 0) return;
  if (playerDamageHandler) playerDamageHandler(amt, { state, ...info });
  else if (state && state.player) state.player.hp -= amt;
  bus.emit('hit', { targetId: 'player', damage: amt, source: sourceLabel(info.source), pos: info.pos });
}

// ---------------------------------------------------------------------------
// Procedural meshes (drone / sentinel) — Three.js primitives only, no
// textures, so this stays Node-safe.
// ---------------------------------------------------------------------------

function buildDroneMesh() {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x7a6f8a, metalness: 0.6, roughness: 0.4 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.55, 0.22, 12), bodyMat);
  g.add(body);
  const domeMat = new THREE.MeshStandardMaterial({ color: 0x5a3f6e, metalness: 0.3, roughness: 0.5 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
  dome.position.y = 0.1;
  g.add(dome);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 1.5 });
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), eyeMat);
  eye.position.set(0, 0.15, 0.5);
  g.add(eye);
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const rotorGeo = new THREE.BoxGeometry(0.9, 0.03, 0.08);
  const rotorL = new THREE.Mesh(rotorGeo, rotorMat); rotorL.position.set(-0.55, 0.13, 0);
  const rotorR = new THREE.Mesh(rotorGeo, rotorMat); rotorR.position.set(0.55, 0.13, 0);
  g.add(rotorL, rotorR);
  g.userData.rotors = [rotorL, rotorR];
  g.userData.eye = eye;
  return g;
}

function buildSentinelMesh() {
  const g = new THREE.Group();
  const limbMat = new THREE.MeshStandardMaterial({ color: 0x6a2f8a, metalness: 0.5, roughness: 0.4 });
  const armorMat = new THREE.MeshStandardMaterial({ color: 0x8a3fae, metalness: 0.6, roughness: 0.35 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xd63fd6, metalness: 0.4, roughness: 0.3, emissive: 0x440044, emissiveIntensity: 0.3 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffee55, emissive: 0xffee00, emissiveIntensity: 2 });

  const legGeo = new THREE.BoxGeometry(1.1, 5, 1.1);
  const legL = new THREE.Mesh(legGeo, limbMat); legL.position.set(-1.2, 2.5, 0);
  const legR = new THREE.Mesh(legGeo, limbMat); legR.position.set(1.2, 2.5, 0);
  g.add(legL, legR);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(3.2, 4, 2.2), armorMat);
  torso.position.set(0, 7.5, 0);
  g.add(torso);

  const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 1.2, 10), trimMat);
  cannon.rotation.x = Math.PI / 2;
  cannon.position.set(0, 7.3, 1.3);
  g.add(cannon);

  const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 1.4), armorMat);
  head.position.set(0, 10.2, 0);
  g.add(head);

  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), eyeMat); eyeL.position.set(-0.35, 10.25, 0.65);
  const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), eyeMat); eyeR.position.set(0.35, 10.25, 0.65);
  g.add(eyeL, eyeR);

  const armGeo = new THREE.BoxGeometry(0.9, 3.4, 0.9);
  const armL = new THREE.Mesh(armGeo, limbMat); armL.position.set(-2.1, 7, 0);
  const armR = new THREE.Mesh(armGeo, limbMat); armR.position.set(2.1, 7, 0);
  g.add(armL, armR);

  g.userData.cannon = cannon;
  g.userData.legs = [legL, legR];
  return g;
}

// ---------------------------------------------------------------------------
// Enemy
// ---------------------------------------------------------------------------

let nextId = 1;

export class Enemy {
  constructor(kind, opts = {}) {
    const def = ENEMY_KINDS[kind];
    if (!def) throw new Error(`unknown enemy kind: ${kind}`);
    this.id = opts.id ?? `e${nextId++}`;
    this.kind = kind;
    this.maxHp = opts.hp ?? def.hp;
    this.hp = this.maxHp;
    this.pos = new THREE.Vector3(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
    this.vel = new THREE.Vector3();
    this.radius = def.radius;
    this.height = def.height;
    this.yaw = opts.yaw ?? 0;

    this.mesh = null;
    this.rig = null;
    this.state = 'idle';
    this.stateTime = 0;

    this.held = false;
    this._wasHeld = false;
    this.airborne = false;
    this.controlledUntil = 0;
    this.controlledBy = null;
    this.isDead = false;
    this.deadAt = null;

    this.wanderTarget = null;
    this.lastSeenPlayerAt = null;
    this.attackPhase = null;
    this.attackTimer = 0;
    this.staggerUntil = 0;
    this.fireTimer = def.fireInterval ? def.fireInterval * Math.random() : 0;
    this.hoverSeed = Math.random() * Math.PI * 2;
    this.phase = 1;

    this._t = 0;
    this._sdt = 0;
    this._idleTimer = 0;
    this._stompFxTimer = 0;
    this._fallDir = Math.random() < 0.5 ? -1 : 1;
    this._city = null;
    this._manager = null;
    this._skipOffset = Math.floor(Math.random() * FAR_UPDATE_INTERVAL);
  }

  _groundHeight() {
    if (this._city && typeof this._city.getGroundHeight === 'function') {
      return this._city.getGroundHeight(this.pos.x, this.pos.z);
    }
    return this.pos.y;
  }

  _probe(pos, r, h, out) {
    if (!this._city || typeof this._city.collideCapsule !== 'function') return false;
    return this._city.collideCapsule(pos, r, h, out);
  }

  _attackRange() {
    return ENEMY_KINDS[this.kind].attackRange;
  }

  _controlledDamage() {
    const def = ENEMY_KINDS[this.kind];
    return def.meleeDamage ?? def.fireDamage ?? Math.round(def.stompDamage / 4) ?? 8;
  }

  /** Accelerate `this.vel` toward `desired` at `accel` m/s^2, clamped for the tick. */
  _applySteering(desired, sdt, accel = 20) {
    const dx = desired.x - this.vel.x, dz = desired.z - this.vel.z;
    const maxDelta = accel * sdt;
    const d = Math.hypot(dx, dz);
    if (d <= maxDelta || d === 0) { this.vel.x = desired.x; this.vel.z = desired.z; }
    else { this.vel.x += (dx / d) * maxDelta; this.vel.z += (dz / d) * maxDelta; }
  }

  takeDamage(amount, source) {
    if (this.isDead) return;
    const dmg = Math.max(0, Math.round(amount));
    const res = applyDamage(this.hp, dmg);
    this.hp = res.hp;
    bus.emit('hit', { targetId: this.id, damage: dmg, source: sourceLabel(source), pos: this.pos.clone() });
    if (res.dead) { this._die(); return; }

    this.state = 'stagger';
    this.stateTime = 0;
    this.staggerUntil = this._t + STAGGER_DURATION;
    this.attackPhase = null;
    this.attackTimer = 0;
    const kb = knockbackFrom(this.pos, source, KNOCKBACK_FORCE[this.kind] ?? 5);
    this.vel.x += kb.x;
    this.vel.z += kb.z;

    if (this.kind === 'sentinel') this._checkPhaseChange();
  }

  _die() {
    this.isDead = true;
    this.state = 'dead';
    this.deadAt = this._t;
    this.vel.set(0, 0, 0);
    bus.emit('enemy_dead', { enemy: this });
    bus.emit('sfx', { name: `${this.kind}_death`, pos: this.pos.clone(), gain: 1 });
  }

  _checkPhaseChange() {
    const ratio = this.hp / this.maxHp;
    if (this.phase === 1 && ratio <= 0.66) { this.phase = 2; this._spawnPhaseDrones(); }
    else if (this.phase === 2 && ratio <= 0.33) { this.phase = 3; this._spawnPhaseDrones(); }
  }

  _spawnPhaseDrones() {
    if (this._manager) this._manager.spawnWave({ kind: 'drone', count: 3, around: { x: this.pos.x, z: this.pos.z }, radius: 10 });
    bus.emit('sfx', { name: 'sentinel_phase', pos: this.pos.clone(), gain: 1 });
  }

  update(dt, state) {
    this._t = state?.time ?? (this._t + dt);
    const sdt = dt * (state?.timeScale ?? 1);
    this._sdt = sdt;

    if (this.isDead) { this._updateDeadFade(state); return; }

    if (this._wasHeld && !this.held) this.airborne = true; // just released by telekinesis
    this._wasHeld = this.held;
    if (this.held) { this._syncMesh(); return; } // frozen: do not move it

    if (this.airborne) { this._integrateBallistic(sdt); this._syncMesh(); return; }

    const player = state?.player;
    const playerPos = player?.pos ?? this.pos;
    const dist = distance2D(this.pos, playerPos);

    // Only throttle idle/patrol wandering — anything actively engaged
    // (chasing, attacking, staggered, controlled) always ticks fully so
    // combat stays responsive regardless of the player's distance.
    const idling = this.state === 'idle' || this.state === 'patrol';
    const frame = this._manager?._frame ?? 0;
    const throttled = idling && dist > ACTIVE_RADIUS && ((frame + this._skipOffset) % FAR_UPDATE_INTERVAL !== 0);
    if (!throttled) this._think(sdt, state, dist, playerPos);

    this._move(sdt);
    this._syncMesh();
  }

  _think(sdt, state, dist, playerPos) {
    const def = ENEMY_KINDS[this.kind];
    this.stateTime += sdt;
    if (dist <= def.senseRadius) this.lastSeenPlayerAt = this._t;

    const next = nextEnemyState(this.state, {
      time: this._t,
      hp: this.hp,
      distToPlayer: dist,
      senseRadius: def.senseRadius,
      attackRange: this._attackRange(),
      lastSeenAt: this.lastSeenPlayerAt,
      rememberDuration: CHASE_MEMORY,
      staggerUntil: this.staggerUntil,
      controlledUntil: this.controlledUntil,
    });
    if (next !== this.state) {
      this.state = next;
      this.stateTime = 0;
      this.attackPhase = null;
      this.attackTimer = 0;
    }

    switch (this.state) {
      case 'idle': this._doIdle(sdt); break;
      case 'patrol': this._doPatrol(sdt); break;
      case 'chase': this._doChase(sdt, playerPos); break;
      case 'attack': this._doAttack(sdt, state, playerPos, dist); break;
      case 'stagger': this._applySteering({ x: 0, z: 0 }, sdt, 12); break;
      case 'controlled': this._doControlled(sdt); break;
      default: break;
    }
  }

  _doIdle(sdt) {
    this._applySteering({ x: 0, z: 0 }, sdt, 10);
    this._idleTimer += sdt;
    if (this._idleTimer > 1.5 + Math.random()) {
      this.state = 'patrol'; this.stateTime = 0; this._idleTimer = 0; this.wanderTarget = null;
    }
  }

  _doPatrol(sdt) {
    const def = ENEMY_KINDS[this.kind];
    if (!this.wanderTarget || distance2D(this.pos, this.wanderTarget) < 1.5) {
      const roadFn = this._city?.nearestRoadPoint ? (x, z) => this._city.nearestRoadPoint(x, z) : null;
      this.wanderTarget = pickWanderTarget(this.pos, 15, roadFn);
    }
    const dir = normalize2D({ x: this.wanderTarget.x - this.pos.x, z: this.wanderTarget.z - this.pos.z });
    const avoided = steerAroundObstacles(this.pos, dir, this.radius, this.height, (p, r, h, o) => this._probe(p, r, h, o));
    this._applySteering({ x: avoided.x * def.speed * 0.4, z: avoided.z * def.speed * 0.4 }, sdt, def.speed * 3);
    if (avoided.x || avoided.z) this.yaw = Math.atan2(avoided.x, avoided.z);
  }

  _doChase(sdt, playerPos) {
    const def = ENEMY_KINDS[this.kind];
    const dir = normalize2D({ x: playerPos.x - this.pos.x, z: playerPos.z - this.pos.z });
    const avoided = steerAroundObstacles(this.pos, dir, this.radius, this.height, (p, r, h, o) => this._probe(p, r, h, o));
    this._applySteering({ x: avoided.x * def.speed, z: avoided.z * def.speed }, sdt, def.speed * 5);
    if (avoided.x || avoided.z) this.yaw = Math.atan2(avoided.x, avoided.z);

    if (this.kind === 'sentinel') {
      this._stompFxTimer += sdt;
      if (this._stompFxTimer > 0.8) {
        this._stompFxTimer = 0;
        bus.emit('sfx', { name: 'sentinel_footstep', pos: this.pos.clone(), gain: 1 });
      }
    }
  }

  _doAttack(sdt, state, playerPos, dist) {
    if (this.kind === 'thug') this._doThugAttack(sdt, state, dist);
    else if (this.kind === 'drone') this._doDroneAttack(sdt, state, playerPos, dist);
    else if (this.kind === 'sentinel') this._doSentinelAttack(sdt, state, playerPos, dist);
  }

  _doThugAttack(sdt, state, dist) {
    this._applySteering({ x: 0, z: 0 }, sdt, 30);
    const def = ENEMY_KINDS.thug;
    if (!this.attackPhase) { this.attackPhase = 'windup'; this.attackTimer = 0; }
    this.attackTimer += sdt;
    if (this.attackPhase === 'windup' && this.attackTimer >= def.windup) {
      if (dist <= def.attackRange) {
        dealPlayerDamage(state, def.meleeDamage, { source: this, pos: this.pos.clone() });
        bus.emit('sfx', { name: 'thug_punch', pos: this.pos.clone(), gain: 1 });
      }
      this.attackPhase = 'cooldown'; this.attackTimer = 0;
    } else if (this.attackPhase === 'cooldown' && this.attackTimer >= def.attackCooldown) {
      this.attackPhase = null;
    }
  }

  _doDroneAttack(sdt, state, playerPos, dist) {
    const def = ENEMY_KINDS.drone;
    const toPlayer = normalize2D({ x: playerPos.x - this.pos.x, z: playerPos.z - this.pos.z });
    const tangent = { x: -toPlayer.z, z: toPlayer.x };
    this._applySteering({ x: tangent.x * def.speed * 0.6, z: tangent.z * def.speed * 0.6 }, sdt, 15);
    this.fireTimer -= sdt;
    if (this.fireTimer <= 0 && dist <= def.attackRange) {
      dealPlayerDamage(state, def.fireDamage, { source: this, pos: this.pos.clone() });
      bus.emit('sfx', { name: 'drone_bolt', pos: this.pos.clone(), gain: 1 });
      this.fireTimer = def.fireInterval;
    }
  }

  _doSentinelAttack(sdt, state, playerPos, dist) {
    const def = ENEMY_KINDS.sentinel;
    this._applySteering({ x: 0, z: 0 }, sdt, 20);
    this.attackTimer += sdt;
    if (!this.attackPhase) {
      this.attackPhase = dist <= def.stompRange ? 'stomp_windup' : 'beam_telegraph';
      this.attackTimer = 0;
      if (this.attackPhase === 'beam_telegraph') {
        this.yaw = Math.atan2(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
        this._beamDir = { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
        bus.emit('sfx', { name: 'sentinel_beam_charge', pos: this.pos.clone(), gain: 1 });
      }
    }
    switch (this.attackPhase) {
      case 'beam_telegraph':
        if (this.attackTimer >= def.beamTelegraph) { this.attackPhase = 'beam'; this.attackTimer = 0; }
        break;
      case 'beam': {
        if (this.attackTimer === 0) bus.emit('sfx', { name: 'sentinel_beam_fire', pos: this.pos.clone(), gain: 1.5 });
        const origin = { x: this.pos.x, z: this.pos.z };
        if (pointNearLine(origin, this._beamDir, playerPos, def.beamWidth, def.attackRange)) {
          dealPlayerDamage(state, def.beamDamage * sdt, { source: this, pos: this.pos.clone() });
        }
        if (this.attackTimer >= def.beamDuration) { this.attackPhase = 'cooldown'; this.attackTimer = 0; }
        break;
      }
      case 'stomp_windup':
        if (this.attackTimer >= 0.6) {
          bus.emit('sfx', { name: 'sentinel_stomp', pos: this.pos.clone(), gain: 1.5 });
          if (dist <= def.stompRadius) dealPlayerDamage(state, def.stompDamage, { source: this, pos: this.pos.clone() });
          this.attackPhase = 'cooldown'; this.attackTimer = 0;
        }
        break;
      case 'cooldown':
        if (this.attackTimer >= 1.2) this.attackPhase = null;
        break;
      default:
        break;
    }
  }

  _doControlled(sdt) {
    const target = this._manager ? pickControlledTarget(this, this._manager.all()) : null;
    if (!target) { this._applySteering({ x: 0, z: 0 }, sdt, 15); return; }
    const dist = distance2D(this.pos, target.pos);
    const range = this._attackRange();
    if (dist > range) {
      const dir = normalize2D({ x: target.pos.x - this.pos.x, z: target.pos.z - this.pos.z });
      const avoided = steerAroundObstacles(this.pos, dir, this.radius, this.height, (p, r, h, o) => this._probe(p, r, h, o));
      const def = ENEMY_KINDS[this.kind];
      this._applySteering({ x: avoided.x * def.speed, z: avoided.z * def.speed }, sdt, def.speed * 5);
      if (avoided.x || avoided.z) this.yaw = Math.atan2(avoided.x, avoided.z);
    } else {
      this._applySteering({ x: 0, z: 0 }, sdt, 20);
      this.attackTimer += sdt;
      const windup = ENEMY_KINDS[this.kind].windup ?? 0.5;
      if (this.attackTimer >= windup) {
        target.takeDamage(this._controlledDamage(), this);
        bus.emit('sfx', { name: 'psychic_hit', pos: this.pos.clone(), gain: 0.8 });
        this.attackTimer = 0;
      }
    }
  }

  _integrateBallistic(sdt) {
    const g = -28;
    this.vel.y += g * sdt;
    this.pos.x += this.vel.x * sdt;
    this.pos.y += this.vel.y * sdt;
    this.pos.z += this.vel.z * sdt;
    const groundY = this._groundHeight();
    if (this.pos.y <= groundY) {
      const impact = Math.abs(this.vel.y);
      this.pos.y = groundY;
      this.vel.set(0, 0, 0);
      this.airborne = false;
      const dmg = fallDamage(impact);
      if (dmg > 0) this.takeDamage(dmg, 'fall');
      else { this.state = 'stagger'; this.stateTime = 0; this.staggerUntil = this._t + STAGGER_DURATION; }
    }
  }

  _move(sdt) {
    this.pos.x += this.vel.x * sdt;
    this.pos.z += this.vel.z * sdt;
    if (this.kind === 'drone') {
      const groundY = this._groundHeight();
      const def = ENEMY_KINDS.drone;
      const hover = def.hoverMin + (def.hoverMax - def.hoverMin) * (0.5 + 0.5 * Math.sin(this._t * 0.6 + this.hoverSeed));
      this.pos.y = groundY + hover;
    } else {
      this.pos.y = this._groundHeight();
    }
    this.vel.y = 0;
  }

  _updateDeadFade(state) {
    const now = state?.time ?? this._t;
    const t = now - (this.deadAt ?? now);
    if (!this.mesh) return;
    const fallProgress = Math.min(1, t / 0.6);
    this.mesh.rotation.x = fallProgress * (Math.PI / 2) * this._fallDir;
    this.mesh.position.copy(this.pos);
    if (t > DEAD_FADE_TIME - 1) {
      const sinkT = Math.min(1, (t - (DEAD_FADE_TIME - 1)) / 1);
      this.mesh.position.y = this.pos.y - sinkT * 1.5;
      if (sinkT >= 1) this.mesh.visible = false;
    }
  }

  _syncMesh() {
    if (!this.mesh) return;
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
    if (this.kind === 'thug' && this.rig) {
      const animMap = { idle: 'idle', patrol: 'walk', chase: 'run', attack: 'attack1', stagger: 'hurt', controlled: 'run', dead: 'dead' };
      if (this.rig.setAnim) this.rig.setAnim(animMap[this.state] || 'idle');
      if (this.rig.update) this.rig.update(this._sdt);
    } else if (this.kind === 'drone' && this.mesh.userData.rotors) {
      const spin = this._t * 30;
      this.mesh.userData.rotors[0].rotation.y = spin;
      this.mesh.userData.rotors[1].rotation.y = -spin;
    }
  }

  dispose() {
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
    if (this.kind === 'thug') { if (this.rig && this.rig.dispose) this.rig.dispose(); }
    else disposeObject3D(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// EnemyManager
// ---------------------------------------------------------------------------

export class EnemyManager {
  /**
   * @param scene THREE.Scene-like (needs .add/.remove on meshes)
   * @param city  City instance (getGroundHeight, collideCapsule, nearestRoadPoint, poi)
   * @param rigFactory createNpcRig-like function: (spec) => Rig
   * @param opts.thugPreset spec object passed to rigFactory for thugs (e.g. NPC_PRESETS.thug)
   */
  constructor(scene, city, rigFactory, opts = {}) {
    this.scene = scene;
    this.city = city;
    this.rigFactory = rigFactory;
    this.thugSpec = opts.thugPreset || DEFAULT_THUG_SPEC;
    this._enemies = [];
    this._frame = 0;
  }

  spawn(kind, x, z, opts = {}) {
    if (!ENEMY_KINDS[kind]) throw new Error(`unknown enemy kind: ${kind}`);
    const groundY = this.city && typeof this.city.getGroundHeight === 'function'
      ? this.city.getGroundHeight(x, z) : 0;
    const enemy = new Enemy(kind, { ...opts, x, y: groundY, z });
    enemy._city = this.city;
    enemy._manager = this;

    let mesh;
    if (kind === 'thug') {
      const rig = typeof this.rigFactory === 'function' ? this.rigFactory(opts.rigSpec || this.thugSpec) : null;
      enemy.rig = rig;
      mesh = rig ? rig.group : new THREE.Group();
    } else if (kind === 'drone') {
      mesh = buildDroneMesh();
    } else {
      mesh = buildSentinelMesh();
    }
    mesh.position.copy(enemy.pos);
    enemy.mesh = mesh;
    if (this.scene && typeof this.scene.add === 'function') this.scene.add(mesh);

    this._enemies.push(enemy);
    bus.emit('enemy_spawn', { enemy });
    return enemy;
  }

  spawnWave({ kind, count, around = { x: 0, z: 0 }, radius = 10 } = {}) {
    const spawned = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const r = radius * (0.4 + Math.random() * 0.6);
      const x = around.x + Math.cos(angle) * r;
      const z = around.z + Math.sin(angle) * r;
      spawned.push(this.spawn(kind, x, z));
    }
    return spawned;
  }

  update(dt, state) {
    this._frame++;
    for (const e of this._enemies) e.update(dt, state);
    const now = state?.time ?? 0;
    for (let i = this._enemies.length - 1; i >= 0; i--) {
      const e = this._enemies[i];
      if (e.isDead && e.deadAt != null && (now - e.deadAt) >= DEAD_FADE_TIME) {
        e.dispose();
        this._enemies.splice(i, 1);
      }
    }
  }

  nearest(pos, maxDist = Infinity) {
    let best = null, bestDist = maxDist;
    for (const e of this._enemies) {
      if (e.isDead) continue;
      const d = distance2D(e.pos, pos);
      if (d <= bestDist) { bestDist = d; best = e; }
    }
    return best;
  }

  all() {
    return this._enemies.filter((e) => !e.isDead);
  }

  clear() {
    for (const e of this._enemies) e.dispose();
    this._enemies.length = 0;
  }
}
