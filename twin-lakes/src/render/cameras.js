// Cameras: chase, cockpit, tower (a spotter with a long lens), flyby, and a cinematic director that cuts
// between them for the title screen and the demo flight.

import * as THREE from '../../vendor/three.module.js';

export const CAMERA_MODES = ['chase', 'cockpit', 'tower', 'flyby', 'orbit'];
const LABELS = { chase: 'Chase', cockpit: 'Cockpit', tower: 'Tower', flyby: 'Flyby', orbit: 'Orbit', cine: 'Cinematic' };

export class CameraRig {
  constructor(camera, dom, terrain) {
    this.cam = camera;
    this.T = terrain;
    this.mode = 'chase';
    this.look = { yaw: 0, pitch: 0 };        // mouse offsets
    this.zoom = 1;
    this.smoothPos = new THREE.Vector3();
    this.smoothYaw = 0;
    this.flybyPos = null;
    this.cineT = 0;
    this.cineMode = 'flyby';
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this.baseFov = 60;
    let drag = null;
    dom.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.button === 2) drag = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('pointerup', () => { drag = null; });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.look.yaw -= (e.clientX - drag.x) * 0.005;
      this.look.pitch = THREE.MathUtils.clamp(this.look.pitch - (e.clientY - drag.y) * 0.004, -1.3, 1.3);
      drag = { x: e.clientX, y: e.clientY };
      this._lookIdle = 0;
    });
    dom.addEventListener('wheel', (e) => {
      this.zoom = THREE.MathUtils.clamp(this.zoom * (e.deltaY > 0 ? 1.1 : 0.9), 0.35, 6);
      e.preventDefault();
    }, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    this._lookIdle = 0;
  }

  get label() { return LABELS[this.mode] || this.mode; }

  set(mode) {
    this.mode = mode;
    this.look = { yaw: 0, pitch: 0 };
    this.zoom = 1;
    this.flybyPos = null;
    this.snap = true;
  }

  next() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.set(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
  }

  /** @returns {boolean} whether the view is inside the cockpit */
  update(dt, a, model) {
    const cam = this.cam;
    const pos = new THREE.Vector3(...a.pos);
    const q = new THREE.Quaternion(...a.q);
    const vel = new THREE.Vector3(...a.vel);
    let mode = this.mode;
    // mouse look relaxes back to centre when left alone (outside views)
    this._lookIdle += dt;
    if (mode !== 'cockpit' && this._lookIdle > 3) {
      this.look.yaw *= Math.exp(-dt * 0.8);
      this.look.pitch *= Math.exp(-dt * 0.8);
    }
    if (mode === 'cine') {
      this.cineT += dt;
      if (this.cineT > 9 || !this.cineInit) {
        this.cineT = 0; this.cineInit = true;
        const opts = ['flyby', 'chase', 'orbit', 'flyby', 'tower'];
        this.cineMode = opts[Math.floor(Math.random() * opts.length)];
        this.flybyPos = null; this.snap = true;
        this.look = { yaw: (Math.random() - 0.5) * 2.5, pitch: Math.random() * 0.3 - 0.05 };
        this.zoom = 0.8 + Math.random() * 0.8;
      }
      mode = this.cineMode;
      if (mode === 'orbit') this.look.yaw += dt * 0.12;
    }
    let inside = false;
    cam.near = 0.5;
    let fov = this.baseFov;
    const heading = Math.atan2(-(new THREE.Vector3(0, 0, -1).applyQuaternion(q).x), -(new THREE.Vector3(0, 0, -1).applyQuaternion(q).z));
    if (mode === 'cockpit') {
      inside = true;
      cam.near = 0.05;
      const eye = model.eye.clone().applyQuaternion(q).add(pos);
      cam.position.copy(eye);
      const lookQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.look.pitch - 0.08, this.look.yaw, 0, 'YXZ'));
      cam.quaternion.copy(q).multiply(lookQ);
      fov = 68 / this.zoom ** 0.5;
    } else if (mode === 'chase' || mode === 'orbit') {
      // follow the heading smoothly, not the roll and pitch
      let dy = heading - this.smoothYaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      this.smoothYaw += dy * Math.min(1, dt * (this.snap ? 100 : 2.5));
      const dist = (mode === 'orbit' ? 22 : 15) * this.zoom;
      const yaw = this.smoothYaw + this.look.yaw;
      const pitch = 0.16 + this.look.pitch;
      const off = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist);
      const target = pos.clone().add(new THREE.Vector3(0, 1.2, 0));
      const want = target.clone().add(off);
      // aim a little below the aircraft so it sits above the instruments at the bottom of the screen
      const aim = target.clone().add(new THREE.Vector3(0, -2.2 * this.zoom, 0));
      const gh = this.T.surface(want.x, want.z) + 1.5;
      if (want.y < gh) want.y = gh;
      if (this.snap) this.smoothPos.copy(want); else this.smoothPos.lerp(want, Math.min(1, dt * 8));
      cam.position.copy(this.smoothPos);
      cam.lookAt(aim);
    } else if (mode === 'tower') {
      // KBPK's ramp when close, otherwise a spot on the ground beside the flight path
      const ramp = new THREE.Vector3(320, 0, -110);
      ramp.y = this.T.height(ramp.x, ramp.z) + 14;
      if (!this.towerPos || this.snap || this.towerPos.distanceTo(pos) > 4000) {
        if (pos.distanceTo(ramp) < 4000) this.towerPos = ramp;
        else {
          const side = new THREE.Vector3(vel.z, 0, -vel.x).normalize().multiplyScalar(350);
          const p = pos.clone().add(vel.clone().multiplyScalar(8)).add(side);
          p.y = this.T.surface(p.x, p.z) + 3;
          this.towerPos = p;
        }
      }
      cam.position.copy(this.towerPos);
      cam.lookAt(pos);
      const d = cam.position.distanceTo(pos);
      fov = THREE.MathUtils.clamp(2 * Math.atan(26 / d) * 180 / Math.PI, 1.5, 60) / this.zoom;
    } else if (mode === 'flyby') {
      const d = this.flybyPos ? this.flybyPos.distanceTo(pos) : 1e9;
      const behind = this.flybyPos ? this._v.copy(this.flybyPos).sub(pos).dot(vel) < 0 : true;
      if (!this.flybyPos || (behind && d > 250) || d > 1500) {
        const sp = Math.max(20, vel.length());
        const side = new THREE.Vector3(vel.z, 0, -vel.x).normalize().multiplyScalar((Math.random() > 0.5 ? 1 : -1) * (18 + Math.random() * 25));
        const p = pos.clone().add(vel.clone().normalize().multiplyScalar(sp * 5)).add(side);
        p.y += (Math.random() - 0.3) * 12;
        const gh = this.T.surface(p.x, p.z) + 2;
        if (p.y < gh) p.y = gh;
        this.flybyPos = p;
      }
      cam.position.copy(this.flybyPos);
      cam.lookAt(pos);
      fov = 45 / this.zoom;
    }
    this.snap = false;
    cam.fov = fov;
    cam.updateProjectionMatrix();
    return inside;
  }
}
