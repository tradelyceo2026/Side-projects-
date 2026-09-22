// Automatic flight control. Two layers:
//   Autopilot   GFC-700-style modes a pilot engages (HDG, NAV, ALT, VS, IAS) with inner attitude loops,
//               a yaw damper that centres the ball, and optional autothrottle.
//   It writes into the same control struct the pilot uses, so the flight model cannot tell who is flying.

import { clamp, wrapPi, DEG, KT, FPM } from './math.js';

export class PID {
  constructor(kp, ki, kd, iMin = -1, iMax = 1) {
    Object.assign(this, { kp, ki, kd, iMin, iMax });
    this.i = 0;
  }
  reset(i = 0) { this.i = i; }
  update(err, dt, dMeas = 0) {
    this.i = clamp(this.i + err * this.ki * dt, this.iMin, this.iMax);
    return this.kp * err + this.i - this.kd * dMeas;
  }
}

/** Bearing (rad, clockwise from north) from a to b in world x/z. */
export function bearing(ax, az, bx, bz) {
  return (Math.atan2(bx - ax, -(bz - az)) + 2 * Math.PI) % (2 * Math.PI);
}

export class Autopilot {
  constructor() {
    this.lateral = 'ROL';       // ROL | HDG | NAV | TRK
    this.vertical = 'PIT';      // PIT | ALT | VS | IAS | GS
    this.engaged = false;
    this.autothrottle = false;
    this.yawDamper = true;
    this.target = { heading: 0, alt: 1000, vs: 0, ias: 90 * KT, pitch: 0, roll: 0, speed: 90 * KT };
    this.nav = null;           // { from:[x,z], to:[x,z] } course line
    this.glide = null;         // { x, z, elev, course, angle } glidepath origin at the touchdown point
    this.maxBank = 25 * DEG;
    this.pitchPid = new PID(2.2, 1.4, 0.0, -0.6, 0.6);
    this.rollPid = new PID(1.6, 0.25, 0.0, -0.3, 0.3);
    this.vsPid = new PID(0.03, 0.012, 0, -0.25, 0.3);
    this.iasPid = new PID(0.02, 0.006, 0, -0.25, 0.3);
    this.spdPid = new PID(0.18, 0.05, 0, -0.5, 0.8);
    this.yawPid = new PID(2.5, 2.0, 0, -0.5, 0.5);
    this.pitchTarget = 0;
    this.trimOut = 0;
  }

  engage(o) {
    this.engaged = true;
    this.pitchTarget = o.pitch;
    this.target.heading = o.heading;
    this.target.alt = Math.round(o.alt / 30.48) * 30.48;
    this.pitchPid.reset(0);
    this.rollPid.reset(0);
    this.syncVertical(o);
  }

  /** Seed the outer-loop integrators with the current pitch so a mode change is bumpless. */
  syncVertical(o) {
    this.vsPid.reset(o.pitch);
    this.iasPid.reset(o.pitch);
    this.pitchTarget = o.pitch;
  }

  setVertical(mode, o) {
    if (mode !== this.vertical) { this.vertical = mode; this.syncVertical(o); }
  }

  disengage() { this.engaged = false; }

  /** Desired bank for the lateral mode. */
  _bankCommand(o, pos) {
    const t = this.target;
    switch (this.lateral) {
      case 'HDG': {
        const err = wrapPi(t.heading - o.heading);
        return clamp(err * 1.6, -this.maxBank, this.maxBank);
      }
      case 'TRK': {
        const err = wrapPi(t.heading - o.track);
        return clamp(err * 1.8, -this.maxBank, this.maxBank);
      }
      case 'NAV': {
        if (!this.nav) return 0;
        const [fx, fz] = this.nav.from, [tx, tz] = this.nav.to;
        const crs = bearing(fx, fz, tx, tz);
        // cross-track error: positive when right of course
        const dx = pos[0] - fx, dz = pos[2] - fz;
        const xtk = dx * Math.cos(crs) + dz * Math.sin(crs);
        const intercept = clamp(-xtk / 600, -1, 1) * 40 * DEG;
        const desired = crs + intercept;
        const err = wrapPi(desired - o.track);
        return clamp(err * 1.8, -this.maxBank, this.maxBank);
      }
      case 'ROL':
      default:
        return t.roll;
    }
  }

  /** Desired pitch for the vertical mode. */
  _pitchCommand(o, pos, dt) {
    const t = this.target;
    switch (this.vertical) {
      case 'ALT': {
        const err = t.alt - pos[1];
        const vsT = clamp(err * 0.15, -4, 4);
        this.pitchTarget = this.vsPid.update(vsT - o.vs, dt);
        break;
      }
      case 'VS': {
        this.pitchTarget = this.vsPid.update(t.vs - o.vs, dt);
        break;
      }
      case 'IAS': {
        // climb or descend on the elevator at a target airspeed (flight level change)
        this.pitchTarget = this.iasPid.update(o.ias - t.ias, dt);
        break;
      }
      case 'GS': {
        const g = this.glide;
        const dist = Math.hypot(pos[0] - g.x, pos[2] - g.z);
        const along = -((pos[0] - g.x) * Math.sin(g.course) - (pos[2] - g.z) * Math.cos(g.course));
        const d = Math.max(0, along > 0 ? along : dist);
        const pathH = g.elev + g.aim + Math.tan(g.angle) * d;
        const err = pathH - pos[1];
        const vsT = -o.gs * Math.tan(g.angle) + clamp(err * 0.18, -2.5, 2.5);
        this.pitchTarget = this.vsPid.update(vsT - o.vs, dt);
        break;
      }
      case 'PIT':
      default:
        this.pitchTarget = t.pitch;
    }
    this.pitchTarget = clamp(this.pitchTarget, -12 * DEG, 16 * DEG);
    return this.pitchTarget;
  }

  /** Write elevator, aileron, rudder (and throttle with autothrottle) for this step. */
  update(dt, o, pos, c) {
    if (this.engaged) {
      const bank = this._bankCommand(o, pos);
      const pitch = this._pitchCommand(o, pos, dt);
      c.roll = clamp(this.rollPid.update(bank - o.roll, dt) - 0.25 * o.p, -1, 1);
      // turns need extra back pressure: 1/cos(bank) - 1 of lift, fed forward
      const turnComp = (1 / Math.max(0.5, Math.cos(o.roll)) - 1) * 0.6;
      c.pitch = clamp(this.pitchPid.update(pitch - o.pitch, dt) - 0.6 * o.q + turnComp, -1, 1);
      if (this.autothrottle) {
        c.throttle = clamp(0.55 + this.spdPid.update(this.target.speed - o.ias, dt), 0, 1);
      }
    }
    if (this.yawDamper && !o.onGround) {
      // turn coordinator: drive sideslip to zero (feeds the rudder, damped by yaw rate)
      c.yaw = clamp(this.yawPid.update(o.beta, dt) - 0.3 * (o.r - 9.81 * Math.tan(o.roll) / Math.max(o.tas, 20)) + (c.yawManual || 0), -1, 1);
    }
    return c;
  }
}
