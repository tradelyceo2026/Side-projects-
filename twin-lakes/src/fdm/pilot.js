// The demo pilot: flies a whole circuit (takeoff, route, approach, flare, rollout) through the same
// control struct a person uses, with the autopilot for the en-route legs. The headless test flies it in
// Node against the real terrain; in the browser it is the "Watch it fly" mode.

import { Autopilot, bearing } from './autopilot.js';
import { runwayEnd, runwayFrame } from '../world/terrain.js';
import { clamp, wrapPi, DEG, KT, FT } from './math.js';

export class DemoPilot {
  /**
   * @param {object} opts
   *   depart: runway end object (from runwayEnd) to take off from
   *   arrive: runway end object to land on
   *   route:  [{name, x, z, alt}] waypoints between them (alt in metres MSL)
   *   cruiseAlt: metres MSL
   */
  constructor(opts) {
    Object.assign(this, { cruiseAlt: 3500 * FT }, opts);
    this.ap = new Autopilot();
    this.phase = 'takeoff';
    this.wp = 0;
    this.log = [];
    this.t = 0;
    this.flare = { started: false };
    this.onPhase = null;
  }

  _set(phase, a, note = '') {
    if (this.phase === phase) return;
    this.phase = phase;
    this.log.push({ t: this.t, phase, note, pos: [...a.pos], ias: a.out.ias, alt: a.pos[1] });
    if (this.onPhase) this.onPhase(phase, note);
  }

  /** Build the approach: a fix on the extended centreline, then the glide path. */
  _approachFixes() {
    const e = this.arrive;
    const back = (d) => [e.x - Math.sin(e.course) * d, e.z + Math.cos(e.course) * d];
    const faf = back(5.5 * 1852);
    const iaf = back(9.5 * 1852);
    return { faf, iaf };
  }

  update(dt, a, c, terrain) {
    this.t += dt;
    const o = a.out;
    const ap = this.ap;
    const dep = this.depart, arr = this.arrive;
    c.yawManual = 0;
    if (o.ias === undefined) return c;          // no outputs until the first flight-model step

    if (this.phase === 'takeoff') {
      // full power, rudder and nosewheel on the centreline, rotate at 55 KIAS
      c.throttle = 1; c.flaps = 0; c.brake = 0; c.parkingBrake = false;
      const f = runwayFrame(dep, a.pos[0], a.pos[2]);
      const hdgErr = wrapPi(dep.course - o.heading);
      c.yaw = clamp(hdgErr * 6 - f.cross * 0.06 - o.r * 1.5, -1, 1);
      c.roll = clamp(-o.roll * 2 - o.p * 0.3, -1, 1);
      if (o.ias > 55 * KT) {
        c.pitch = clamp((10 * DEG - o.pitch) * 5 - o.q * 0.8, -1, 1);
      } else {
        c.pitch = clamp(0.1 - o.pitch * 2, -1, 1);   // light back pressure keeps the nosewheel light
      }
      if (!o.onGround && o.agl > 15) {
        ap.lateral = 'TRK'; ap.target.heading = dep.course;
        ap.engage(o); ap.setVertical('IAS', o); ap.target.ias = 74 * KT;
        this._set('climb', a, 'positive rate, Vy climb');
      }
      return c;
    }

    if (['climb', 'cruise', 'descent'].includes(this.phase)) {
      const wp = this.route[this.wp];
      if (wp) {
        const prev = this.wp === 0 ? [dep.far[0], dep.far[1]] : [this.route[this.wp - 1].x, this.route[this.wp - 1].z];
        ap.lateral = 'NAV';
        ap.nav = { from: prev, to: [wp.x, wp.z] };
        const d = Math.hypot(wp.x - a.pos[0], wp.z - a.pos[2]);
        if (d < 900) {
          this.log.push({ t: this.t, phase: this.phase, note: `passed ${wp.name}`, pos: [...a.pos], ias: o.ias, alt: a.pos[1] });
          this.wp++;
        }
      }
      if (this.phase === 'climb') {
        c.throttle = 1;
        if (a.pos[1] > this.cruiseAlt - 30) {
          ap.target.alt = this.cruiseAlt; ap.setVertical('ALT', o);
          this._set('cruise', a, `level at ${Math.round(this.cruiseAlt / FT)} ft`);
        }
      }
      if (this.phase === 'cruise') {
        c.throttle = 0.78;
        if (this.wp >= this.route.length) this._set('descent', a, 'route complete, descending for the approach');
      }
      if (this.phase === 'descent') {
        const { faf, iaf } = this._approachFixes();
        const patternAlt = arr.elev + 1500 * FT;
        ap.target.alt = patternAlt; ap.setVertical('ALT', o);
        c.throttle = a.pos[1] > patternAlt + 60 ? 0.45 : 0.62;
        // fly to the initial fix, then down the extended centreline
        const dIaf = Math.hypot(iaf[0] - a.pos[0], iaf[1] - a.pos[2]);
        if (!this._iafDone) {
          if (!this._navFrom) this._navFrom = [a.pos[0], a.pos[2]];
          ap.lateral = 'NAV';
          ap.nav = { from: this._navFrom, to: iaf };
          if (dIaf < 1200) { this._iafDone = true; this.log.push({ t: this.t, phase: 'descent', note: 'initial approach fix', pos: [...a.pos], ias: o.ias, alt: a.pos[1] }); }
        } else {
          ap.nav = { from: iaf, to: [arr.x, arr.z] };
          const f = runwayFrame(arr, a.pos[0], a.pos[2]);
          if (-f.along < 6.2 * 1852) {
            c.flaps = 1;
            ap.autothrottle = true; ap.target.speed = 75 * KT;
          }
          if (-f.along < 5.0 * 1852 && Math.abs(f.cross) < 400) {
            ap.glide = { x: arr.x, z: arr.z, elev: arr.elev, aim: 15, course: arr.course, angle: 3 * DEG };
            ap.setVertical('GS', o);
            this._set('approach', a, 'glide path captured, flaps 10');
          }
        }
      }
      return ap.update(dt, o, a.pos, c);
    }

    if (this.phase === 'approach') {
      const f = runwayFrame(arr, a.pos[0], a.pos[2]);
      const agl = a.pos[1] - 1.12 - terrain.height(a.pos[0], a.pos[2]);
      ap.nav = { from: [arr.x - Math.sin(arr.course) * 20000, arr.z + Math.cos(arr.course) * 20000], to: [arr.x, arr.z] };
      ap.lateral = 'NAV';
      if (-f.along < 3.5 * 1852) { c.flaps = 2; ap.target.speed = 70 * KT; }
      if (-f.along < 2.0 * 1852) { c.flaps = 3; ap.target.speed = 65 * KT; }
      if (-f.along < 0.6 * 1852) ap.target.speed = 62 * KT;
      if (agl < 12) {
        ap.autothrottle = false;
        this._set('flare', a, 'flare, power idle');
      }
      return ap.update(dt, o, a.pos, c);
    }

    if (this.phase === 'flare') {
      // hold the centreline, align the nose with the runway, ease the sink rate toward zero
      const f = runwayFrame(arr, a.pos[0], a.pos[2]);
      const agl = a.pos[1] - 1.12 - terrain.height(a.pos[0], a.pos[2]);
      c.throttle = Math.max(0, (c.throttle ?? 0) - dt * 0.8);
      const vsT = -Math.max(0.25, Math.min(3.5, agl * 0.4));
      this._fp = (this._fp ?? o.pitch) + clamp((vsT - o.vs) * 0.9 * dt, -0.2 * dt, 0.5 * dt);
      this._fp = clamp(this._fp, -2 * DEG, 11 * DEG);
      c.pitch = clamp((this._fp - o.pitch) * 3 - o.q * 0.6 + 0.05, -1, 1);
      const trkErr = wrapPi(arr.course - o.track);
      const wantBank = clamp((-f.cross * 0.004 + trkErr * 0.8), -6 * DEG, 6 * DEG);
      c.roll = clamp((wantBank - o.roll) * 2 - o.p * 0.3, -1, 1);
      c.yaw = clamp(wrapPi(arr.course - o.heading) * 4 - o.r, -1, 1);
      if (o.mains) this._set('rollout', a, 'touchdown');
      return c;
    }

    if (this.phase === 'rollout') {
      const f = runwayFrame(arr, a.pos[0], a.pos[2]);
      c.throttle = 0;
      c.pitch = clamp(0.25 - o.ias / (40 * KT) * 0.1, -1, 1) * (o.ias > 35 * KT ? 1 : 0.3);
      c.roll = clamp(-o.roll * 2, -1, 1);
      c.yaw = clamp(wrapPi(arr.course - o.heading) * 5 - f.cross * 0.08 - o.r * 1.5, -1, 1);
      const noseDown = a.gearState[0].contact;
      c.brake = noseDown && o.gs > 2 ? 0.7 : 0;
      c.flaps = o.ias < 45 * KT ? 0 : c.flaps;
      if (o.gs < 0.5 && noseDown) {
        c.parkingBrake = true; c.brake = 0;
        this._set('stopped', a, 'stopped on the runway');
      }
      return c;
    }
    return c;
  }
}

export { runwayEnd };
