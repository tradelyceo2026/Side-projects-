// Pooled, low-draw-call visual effects: claw slashes, speed trails, an optic
// beam, TK / diamond auras, explosions, hit sparks, landing dust and collect
// sparkles. Subscribes to the bus itself; also exposes direct methods for
// modules that prefer calling them.
import * as THREE from '../vendor/three.module.js';
import { bus } from './core/bus.js';
import { state } from './core/state.js';

// ---------------------------------------------------------------------------
// Pure, DOM/GPU-free particle pool — allocation is round-robin so it always
// succeeds (oldest particle is recycled once the pool is full). Kept free of
// THREE/DOM so it can be unit tested directly under node --test.
// ---------------------------------------------------------------------------
export class ParticlePool {
  constructor(capacity) {
    this.capacity = capacity | 0;
    this.cursor = 0;
    this.active = new Uint8Array(this.capacity);
    this.life = new Float32Array(this.capacity);
    this.maxLife = new Float32Array(this.capacity);
  }
  /** Allocate the next slot (round robin) and (re)arm its lifetime. Returns the slot index. */
  alloc(life) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.active[i] = 1;
    this.life[i] = life;
    this.maxLife[i] = life > 0 ? life : 0.0001;
    return i;
  }
  /** Advance all active slots by dt; returns the list of slot indices still alive. */
  step(dt) {
    const alive = [];
    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.active[i] = 0; continue; }
      alive.push(i);
    }
    return alive;
  }
  /** 0 at birth, 1 at death. */
  progress(i) { return 1 - Math.max(0, this.life[i]) / this.maxLife[i]; }
  isActive(i) { return this.active[i] === 1; }
  killAll() { this.active.fill(0); }
}

// ---------------------------------------------------------------------------
// GPU-facing helpers (only touched once the class below is constructed with a
// real THREE.Scene — never at module import time).
// ---------------------------------------------------------------------------
function radialTexture(inner, outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.4, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// One InstancedMesh + pool per effect "kind". Particles fade by shrinking
// (mode 'shrink'), growing (mode 'grow', used for expanding rings) and, for
// additive materials, by darkening their instance colour toward black (which
// reads as a true opacity fade under additive blending without needing a
// per-instance alpha channel).
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

class InstancedFX {
  constructor(geometry, material, capacity, mode = 'shrink') {
    this.pool = new ParticlePool(capacity);
    this.mode = mode;
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    if (material.vertexColors) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.mesh = mesh;
    this.pos = Array.from({ length: capacity }, () => new THREE.Vector3());
    this.quat = Array.from({ length: capacity }, () => new THREE.Quaternion());
    this.vel = Array.from({ length: capacity }, () => new THREE.Vector3());
    this.baseScale = new Float32Array(capacity);
    this.aspect = Array.from({ length: capacity }, () => new THREE.Vector3(1, 1, 1));
    this.color = Array.from({ length: capacity }, () => new THREE.Color(0xffffff));
    this.gravity = 0;
  }
  spawn({ position, quaternion, scale = 1, aspect, velocity, color, life = 0.5 }) {
    const i = this.pool.alloc(life);
    this.pos[i].copy(position);
    if (quaternion) this.quat[i].copy(quaternion); else this.quat[i].identity();
    this.baseScale[i] = scale;
    if (aspect) this.aspect[i].copy(aspect); else this.aspect[i].set(1, 1, 1);
    if (velocity) this.vel[i].copy(velocity); else this.vel[i].set(0, 0, 0);
    if (color) this.color[i].copy(color); else this.color[i].set(0xffffff);
    return i;
  }
  update(dt) {
    const alive = this.pool.step(dt);
    let n = 0;
    for (const i of alive) {
      this.pos[i].addScaledVector(this.vel[i], dt);
      if (this.gravity) this.vel[i].y -= this.gravity * dt;
      const t = this.pool.progress(i);
      let s = this.baseScale[i];
      if (this.mode === 'shrink') s *= Math.max(0, 1 - t);
      else if (this.mode === 'grow') s *= 0.35 + t * 1.4;
      _s.copy(this.aspect[i]).multiplyScalar(s);
      _m4.compose(this.pos[i], this.quat[i], _s);
      this.mesh.setMatrixAt(n, _m4);
      if (this.mesh.instanceColor) {
        _c.copy(this.color[i]).multiplyScalar(Math.max(0, 1 - t));
        this.mesh.setColorAt(n, _c);
      }
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
export class VFX {
  constructor(scene) {
    this.scene = scene;
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();

    // --- claw slashes / sweeps: partial rings, additive white ---
    const arcGeo = new THREE.RingGeometry(0.55, 1, 5, 1, -0.9, 1.8);
    const arcMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.arcs = new InstancedFX(arcGeo, arcMat, 18, 'shrink');
    scene.add(this.arcs.mesh);

    // --- hit sparks: tiny streaking shards, additive ---
    const sparkGeo = new THREE.BoxGeometry(0.06, 0.06, 0.5);
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    this.sparks = new InstancedFX(sparkGeo, sparkMat, 48, 'shrink');
    scene.add(this.sparks.mesh);

    // --- debris: tumbling cubes for landing impacts ---
    const debrisGeo = new THREE.BoxGeometry(0.18, 0.18, 0.18);
    const debrisMat = new THREE.MeshStandardMaterial({ color: 0x8a7a63, roughness: 1 });
    this.debris = new InstancedFX(debrisGeo, debrisMat, 40, 'shrink');
    this.debris.gravity = 14;
    scene.add(this.debris.mesh);

    // --- expanding rings: reused for landing dust, explosion shockwave, psychic pulse ---
    const ringGeo = new THREE.RingGeometry(0.7, 1, 28).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.rings = new InstancedFX(ringGeo, ringMat, 14, 'grow');
    scene.add(this.rings.mesh);

    // --- smoke puffs (explosions) ---
    const smokeGeo = new THREE.IcosahedronGeometry(0.6, 0);
    const smokeMat = new THREE.MeshBasicMaterial({ color: 0x777066, transparent: true, opacity: 0.55, depthWrite: false });
    this.smoke = new InstancedFX(smokeGeo, smokeMat, 24, 'shrink');
    scene.add(this.smoke.mesh);

    // --- sparkle: collect pickups, diamond shimmer ---
    const sparkleGeo = new THREE.OctahedronGeometry(0.14, 0);
    const sparkleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    this.sparkle = new InstancedFX(sparkleGeo, sparkleMat, 60, 'shrink');
    scene.add(this.sparkle.mesh);

    // --- speed trail: fading capsule afterimages ---
    const trailGeo = new THREE.CapsuleGeometry(0.35, 1.1, 2, 6);
    const trailMat = new THREE.MeshBasicMaterial({ color: 0x66b3ff, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.trails = new InstancedFX(trailGeo, trailMat, 16, 'shrink');
    scene.add(this.trails.mesh);

    // --- fireball bursts (billboarded quads, additive) ---
    const fireGeo = new THREE.PlaneGeometry(1, 1);
    const fireMat = new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,220,150,1)', 'rgba(255,80,0,0)'), color: 0xffffff, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.fireballs = new InstancedFX(fireGeo, fireMat, 8, 'shrink');
    scene.add(this.fireballs.mesh);

    // --- optic beam: persistent cylinder + glow sprite, toggled active/inactive ---
    const beamGeo = new THREE.CylinderGeometry(0.12, 0.12, 1, 8, 1, true);
    beamGeo.translate(0, 0.5, 0);
    beamGeo.rotateX(Math.PI / 2);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    scene.add(this.beam);
    const glowMat = new THREE.SpriteMaterial({ map: radialTexture('rgba(255,120,90,1)'), color: 0xff5533, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.beamGlow = new THREE.Sprite(glowMat);
    this.beamGlow.visible = false;
    this.beamGlow.scale.set(2.4, 2.4, 2.4);
    scene.add(this.beamGlow);
    this._beamFrom = new THREE.Vector3();
    this._beamTo = new THREE.Vector3();

    // --- TK glow: pulsing purple ring following an Object3D ---
    const tkGeo = new THREE.TorusGeometry(1, 0.08, 8, 24);
    const tkMat = new THREE.MeshBasicMaterial({ color: 0xaa55ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    this.tkRing = new THREE.Mesh(tkGeo, tkMat);
    this.tkRing.visible = false;
    this.tkRing.rotation.x = Math.PI / 2;
    scene.add(this.tkRing);
    this._tkTarget = null;
    this._tkAnchor = new THREE.Object3D();
    this._tkTime = 0;

    // --- diamond shimmer state ---
    this._diamondRig = null;
    this._diamondActive = false;
    this._diamondAnchor = new THREE.Object3D();
    this._diamondTimer = 0;

    // --- slow-mo: full-screen tint quad held just in front of the camera ---
    const tintGeo = new THREE.PlaneGeometry(1, 1);
    const tintMat = new THREE.MeshBasicMaterial({ color: 0x2255ff, transparent: true, opacity: 0.12, depthWrite: false, depthTest: false });
    this.slowmoQuad = new THREE.Mesh(tintGeo, tintMat);
    this.slowmoQuad.visible = false;
    this.slowmoQuad.renderOrder = 999;
    this.slowmoQuad.frustumCulled = false;
    scene.add(this.slowmoQuad);

    this._psychicColor = new THREE.Color(0x8a5cff);
    this._landColor = new THREE.Color(0xb9a67e);
    this._explosionRingColor = new THREE.Color(0xffaa55);

    this._unsubs = [
      bus.on('ability', (p) => this._onAbility(p)),
      bus.on('hit', (p) => this.hitSpark(p.pos)),
      bus.on('land', (p) => this.dust(p.pos, p.impact)),
      bus.on('enemy_dead', (p) => this.explosion(p.enemy && p.enemy.pos ? p.enemy.pos : p.pos, p.enemy && p.enemy.scale)),
      bus.on('collect', (p) => this.collectSparkle(p.pos)),
      bus.on('footstep', (p) => this._footstepPuff(p.pos)),
      bus.on('jump', (p) => this.dust(p.pos, 0.4)),
    ];
  }

  dispose() { this._unsubs.forEach((off) => off && off()); }

  // -------------------------------------------------------------- dispatch
  _onAbility({ character, name, pos, dir, active }) {
    const p = pos || (state.player && state.player.pos);
    if (!p) return;
    switch (name) {
      case 'claws': this.clawSlash(p, dir); break;
      case 'sweep': this.clawSlash(p, dir, 1.6); break;
      case 'dash': this.speedTrail(p); break;
      case 'diamond': this._onDiamond(p, active !== false); break;
      case 'telekinesis': this._onTelekinesis(p, active !== false); break;
      case 'blast': {
        this._tmpV.set(p.x, p.y, p.z);
        const d = dir || { x: 0, y: 0, z: -1 };
        this._beamFrom.copy(p);
        this._beamTo.set(p.x + d.x * 60, p.y + d.y * 60, p.z + d.z * 60);
        this.opticBeam(this._beamFrom, this._beamTo, active !== false);
        break;
      }
      case 'slowmo': this._flashSlowmo(); break;
      case 'psychic': this.spawnRing(p, this._psychicColor, 1.1, 3.5); break;
      default: break;
    }
  }

  _onDiamond(pos, active) {
    this._diamondAnchor.position.set(pos.x, pos.y, pos.z);
    this.diamondShimmer(this._diamondAnchor, active);
  }
  _onTelekinesis(pos, active) {
    this._tkAnchor.position.set(pos.x, pos.y, pos.z);
    this.tkGlow(this._tkAnchor, active);
  }
  _footstepPuff(pos) {
    this.spawnRing(pos, this._landColor, 0.4, 0.35, 0.55);
    this._spawnDebris(pos, 2, 1.2);
  }

  // -------------------------------------------------------------- effects
  clawSlash(pos, dir = { x: 0, y: 0, z: -1 }, scale = 1) {
    this._tmpV.set(dir.x || 0, dir.y || 0, dir.z || -1).normalize();
    this._tmpQ.setFromUnitVectors(this._up, this._tmpV.lengthSq() > 0 ? this._tmpV : this._up);
    for (let i = 0; i < 3; i++) {
      const q = new THREE.Quaternion().setFromAxisAngle(this._tmpV.lengthSq() > 0.001 ? this._tmpV : this._up, i * 0.5 - 0.5);
      q.multiply(this._faceDirQuat(dir));
      this.arcs.spawn({
        position: new THREE.Vector3(pos.x, pos.y + 1 + i * 0.15, pos.z),
        quaternion: q,
        scale: (0.9 + i * 0.15) * scale,
        color: new THREE.Color(0xffffff),
        life: 0.22,
      });
    }
  }

  _faceDirQuat(dir) {
    const d = this._tmpV.set(dir?.x || 0, dir?.y || 0, dir?.z || -1);
    if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
    d.normalize();
    const yaw = Math.atan2(d.x, d.z);
    return new THREE.Quaternion().setFromAxisAngle(this._up, yaw);
  }

  speedTrail(pos, facing) {
    const q = facing ? this._faceDirQuat(facing) : new THREE.Quaternion();
    this.trails.spawn({
      position: new THREE.Vector3(pos.x, pos.y + 0.9, pos.z),
      quaternion: q,
      scale: 1,
      color: new THREE.Color(0x66b3ff),
      life: 0.35,
    });
  }

  opticBeam(from, to, active = true) {
    if (!active) {
      this.beam.visible = false;
      this.beamGlow.visible = false;
      return;
    }
    this.beam.visible = true;
    this.beamGlow.visible = true;
    this.beam.position.set(from.x, from.y, from.z);
    this._tmpV.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const len = Math.max(0.001, this._tmpV.length());
    this.beam.scale.set(1, 1, len);
    this._tmpQ.setFromUnitVectors(this._up, this._tmpV.normalize());
    // beam geometry's long axis is local Z after construction; align +Z with dir.
    const dir = this._tmpV;
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    this.beamGlow.position.set(to.x, to.y, to.z);
  }

  tkGlow(target, active = true) {
    this._tkTarget = active ? target : null;
    this.tkRing.visible = !!active;
  }

  diamondShimmer(rig, active = true) {
    this._diamondRig = active ? rig : null;
    this._diamondActive = !!active;
  }

  explosion(pos, size = 1) {
    if (!pos) return;
    const p = pos;
    this.fireballs.spawn({
      position: new THREE.Vector3(p.x, p.y + size * 1.2, p.z),
      quaternion: new THREE.Quaternion(),
      scale: 3 * size,
      color: new THREE.Color(0xffffff),
      life: 0.4,
    });
    this.spawnRing(p, this._explosionRingColor, 3.5 * size, 0.6);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.smoke.spawn({
        position: new THREE.Vector3(p.x, p.y + 0.4, p.z),
        quaternion: new THREE.Quaternion(),
        scale: (0.8 + Math.random() * 0.6) * size,
        velocity: new THREE.Vector3(Math.cos(a) * 1.5, 2 + Math.random() * 1.5, Math.sin(a) * 1.5),
        color: new THREE.Color(0x999288),
        life: 1.1 + Math.random() * 0.5,
      });
    }
    this._spawnDebris(p, 10, 6 * size);
  }

  hitSpark(pos) {
    if (!pos) return;
    for (let i = 0; i < 10; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(this._up, dir);
      this.sparks.spawn({
        position: new THREE.Vector3(pos.x, pos.y + 0.9, pos.z),
        quaternion: q,
        scale: 1,
        velocity: dir.clone().multiplyScalar(3 + Math.random() * 2),
        color: new THREE.Color(0xfff2c0),
        life: 0.22,
      });
    }
  }

  dust(pos, impact = 1) {
    if (!pos) return;
    const s = 0.6 + Math.min(2.5, impact || 1);
    this.spawnRing(pos, this._landColor, s, 0.45);
    this._spawnDebris(pos, 8, s * 3);
  }

  collectSparkle(pos) {
    if (!pos) return;
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.3 + Math.random() * 0.5;
      this.sparkle.spawn({
        position: new THREE.Vector3(pos.x + Math.cos(a) * r, pos.y + Math.random() * 0.8, pos.z + Math.sin(a) * r),
        quaternion: new THREE.Quaternion().random(),
        scale: 1,
        velocity: new THREE.Vector3(0, 1.5 + Math.random(), 0),
        color: new THREE.Color(0xbfe6ff),
        life: 0.5,
      });
    }
  }

  spawnRing(pos, color, scale, life, height = 0.05) {
    this.rings.spawn({
      position: new THREE.Vector3(pos.x, pos.y + height, pos.z),
      quaternion: new THREE.Quaternion(),
      scale,
      color,
      life,
    });
  }

  _spawnDebris(pos, count, force) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = force * (0.3 + Math.random() * 0.5);
      this.debris.spawn({
        position: new THREE.Vector3(pos.x, pos.y + 0.2, pos.z),
        quaternion: new THREE.Quaternion().random(),
        scale: 0.6 + Math.random() * 0.8,
        velocity: new THREE.Vector3(Math.cos(a) * speed, speed * (0.6 + Math.random() * 0.6), Math.sin(a) * speed),
        color: new THREE.Color(0x8a7a63),
        life: 0.6 + Math.random() * 0.4,
      });
    }
  }

  _flashSlowmo() {
    this.slowmoQuad.visible = true;
    this._slowmoTimer = 0.5;
    this._updateSlowmoQuad();
  }

  _updateSlowmoQuad() {
    const cam = state.camera;
    if (!cam) return;
    cam.getWorldPosition(this.slowmoQuad.position);
    cam.getWorldQuaternion(this.slowmoQuad.quaternion);
    this._tmpV.set(0, 0, -1).applyQuaternion(this.slowmoQuad.quaternion);
    this.slowmoQuad.position.addScaledVector(this._tmpV, 0.5);
    const fov = (cam.fov || 60) * Math.PI / 180;
    const h = 2 * Math.tan(fov / 2) * 0.5;
    const w = h * (cam.aspect || 1.6);
    this.slowmoQuad.scale.set(w * 1.05, h * 1.05, 1);
  }

  // -------------------------------------------------------------- frame tick
  update(dt) {
    this.arcs.update(dt);
    this.sparks.update(dt);
    this.debris.update(dt);
    this.rings.update(dt);
    this.smoke.update(dt);
    this.sparkle.update(dt);
    this.trails.update(dt);
    this.fireballs.update(dt);

    if (this._tkTarget) {
      this._tkTarget.getWorldPosition(this.tkRing.position);
      this._tkTime += dt;
      const pulse = 0.7 + 0.25 * Math.sin(this._tkTime * 6);
      this.tkRing.scale.setScalar(pulse);
      this.tkRing.rotation.z += dt * 1.5;
    }

    if (this._diamondActive && this._diamondRig) {
      this._diamondTimer -= dt;
      if (this._diamondTimer <= 0) {
        this._diamondTimer = 0.06;
        const p = new THREE.Vector3();
        this._diamondRig.getWorldPosition(p);
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = 0.4 + Math.random() * 0.6;
          this.sparkle.spawn({
            position: new THREE.Vector3(p.x + Math.cos(a) * r, p.y + Math.random() * 1.7, p.z + Math.sin(a) * r),
            quaternion: new THREE.Quaternion().random(),
            scale: 0.7,
            velocity: new THREE.Vector3(0, 0.4, 0),
            color: new THREE.Color(0xeaf6ff),
            life: 0.4,
          });
        }
      }
    }

    if (this.slowmoQuad.visible) {
      this._updateSlowmoQuad();
      this._slowmoTimer -= dt;
      this.slowmoQuad.material.opacity = 0.16 * Math.max(0, this._slowmoTimer / 0.5);
      if (this._slowmoTimer <= 0) this.slowmoQuad.visible = false;
    }
  }
}
