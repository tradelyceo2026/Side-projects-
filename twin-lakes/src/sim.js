// Simulation state independent of rendering: the aircraft, weather and wind, scenarios, the demo pilot,
// assists for keyboard pilots, checkpoints and landing grading.

import { Aircraft, defaultControls } from './fdm/aircraft.js';
import { Autopilot, bearing } from './fdm/autopilot.js';
import { DemoPilot } from './fdm/pilot.js';
import { runwayEnd, runwayFrame } from './world/terrain.js';
import { clamp, wrapPi, DEG, KT, FT } from './fdm/math.js';

export const WEATHER_PRESETS = {
  clear: { label: 'Clear and calm', windDir: 200, windKt: 4, gustKt: 0, turb: 0.1, cloud: 0.0, cloudBaseFt: 5000, visSm: 30, tempC: 22, qnhHpa: 1016 },
  fair: { label: 'Fair weather cumulus', windDir: 210, windKt: 8, gustKt: 4, turb: 0.35, cloud: 0.32, cloudBaseFt: 4500, visSm: 22, tempC: 26, qnhHpa: 1015 },
  broken: { label: 'Broken clouds', windDir: 250, windKt: 12, gustKt: 6, turb: 0.5, cloud: 0.62, cloudBaseFt: 3200, visSm: 8, tempC: 18, qnhHpa: 1008 },
  gusty: { label: 'Gusty crosswind', windDir: 310, windKt: 16, gustKt: 10, turb: 0.8, cloud: 0.2, cloudBaseFt: 5500, visSm: 20, tempC: 14, qnhHpa: 1020 },
};

export const SCENARIOS = [
  { id: 'takeoff', title: 'Runway 23, cleared for takeoff', blurb: 'On the numbers at Baxter County Regional (KBPK), engine running. The Twin Lakes are yours.' },
  { id: 'final', title: 'Short final, runway 23', blurb: '3 miles out on a 3° glide path, flaps 20. Follow the PAPI, flare, and grease it.' },
  { id: 'dams', title: 'The dam run', blurb: 'Bull Shoals Dam, down the White River past Cotter, Norfork Dam, then home. Fly through each gate.' },
  { id: 'engine', title: 'Engine failure over Norfork Lake', blurb: '3,500 feet over the water, and the engine quits. Best glide is 68 knots. Can you make KBPK?' },
  { id: 'gastons', title: "Lunch at Gaston's", blurb: "Gaston's grass strip sits on the bank of the White River below Bull Shoals Dam. 3,000 feet of turf." },
  { id: 'demo', title: 'Watch it fly', blurb: 'The autopilot flies the whole circuit from takeoff to landing while the cameras follow.' },
  { id: 'golden', title: 'Golden hour over Bull Shoals', blurb: 'Free flight at 3,500 feet over Bull Shoals Lake, twenty minutes before sunset.' },
];

export class Sim {
  constructor(terrain) {
    this.T = terrain;
    this.a = new Aircraft();
    this.c = defaultControls();
    this.ap = new Autopilot();
    this.pilot = null;
    this.weather = { ...WEATHER_PRESETS.fair };
    this.turbState = [0, 0, 0];
    this.time = 0;
    this.gates = [];
    this.gateIdx = 0;
    this.events = [];
    this.landing = null;
    this.messages = [];
    this.assists = { coordination: true, attitudeHold: true };
    this.scenario = null;
    this.kbpk = runwayEnd(terrain.runway('KBPK'), 'a');
    const env = {
      ground: (x, z) => terrain.ground(x, z),
      wind: (p, t) => this.wind(p, t),
      wx: { dT: 0, qnh: 101500 },
    };
    this.env = env;
    this.setWeather(this.weather);
  }

  setWeather(w) {
    this.weather = { ...this.weather, ...w };
    const wx = this.weather;
    this.env.wx.qnh = wx.qnhHpa * 100;
    const isaAtField = 15 - 0.0065 * 280;
    this.env.wx.dT = wx.tempC - isaAtField;
    const r = wx.windDir * DEG;
    this.windVec = [-Math.sin(r) * wx.windKt * KT, 0, Math.cos(r) * wx.windKt * KT];
  }

  /** Wind at a point: log-law profile over the terrain, slow gusts and filtered turbulence. */
  wind(p, t) {
    const wx = this.weather;
    const agl = Math.max(1, p[1] - this.T.height(p[0], p[2]));
    const prof = Math.min(1.15, Math.log(agl / 0.15) / Math.log(300 / 0.15));
    const gust = wx.gustKt * KT * (0.5 + 0.5 * Math.sin(t * 0.37) * Math.sin(t * 0.13 + 1.7)) / Math.max(1, wx.windKt * KT) ;
    const f = prof * (1 + gust);
    const tb = this.turbState;
    return [this.windVec[0] * f + tb[0], tb[1] * Math.min(1, agl / 30), this.windVec[2] * f + tb[2]];
  }

  _stepTurbulence(dt) {
    const wx = this.weather;
    const agl = Math.max(5, this.a.pos[1] - this.T.height(this.a.pos[0], this.a.pos[2]));
    const sigma = wx.turb * (0.6 + 0.08 * wx.windKt) * Math.min(1.4, 0.4 + agl / 400) * (agl > 1800 ? 0.5 : 1);
    const L = 200, V = Math.max(20, this.a.out.tas || 40);
    const k = Math.min(1, dt * V / L);
    for (let i = 0; i < 3; i++) {
      const n = (Math.random() * 2 - 1) * Math.sqrt(3);
      this.turbState[i] += (sigma * n * Math.sqrt(2 / Math.max(k, 1e-3)) * k - this.turbState[i] * k);
    }
  }

  // ---------------------------------------------------------------- scenarios
  load(id, options = {}) {
    const T = this.T;
    this.scenario = SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
    this.a = new Aircraft();
    this.c = defaultControls();
    this.ap = new Autopilot();
    this.pilot = null;
    this.gates = [];
    this.gateIdx = 0;
    this.landing = null;
    this.touchdowns = [];
    this.time = 0;
    this.engineFailAt = null;
    this.target = null;
    this.outcome = null;
    const k = this.kbpk;
    const onRunway = (end, d = 25) => {
      const x = end.x + Math.sin(end.course) * d, z = end.z - Math.cos(end.course) * d;
      this.a.placeOnGround(x, z, end.course, T.height(x, z));
      this.c.throttle = 0; this.c.parkingBrake = false;
    };
    const onFinal = (end, nm, flaps, kt) => {
      const d = nm * 1852;
      const x = end.x - Math.sin(end.course) * d, z = end.z + Math.cos(end.course) * d;
      const y = end.elev + 15 + Math.tan(3 * DEG) * d;
      this.a.placeInFlight([x, y, z], end.course, kt * KT * 1.02, -3 * DEG, 0);
      this.a.flapDeg = [0, 10, 20, 30][flaps];
      this.c.flaps = flaps; this.c.throttle = 0.42; this.c.trim = 0.35;
    };
    const dam = (n) => T.world.dams.find((d) => d.name === n);
    switch (this.scenario.id) {
      case 'takeoff':
        onRunway(k);
        this.target = { type: 'free' };
        this.say('Cleared for takeoff, runway 23. Full throttle (hold R), rotate at 55 knots (hold S or ↓).');
        break;
      case 'final':
        onFinal(k, 3, 2, 70);
        this.target = { type: 'land', end: k };
        this.say('Three miles out. Two white, two red on the PAPI means on glide path.');
        break;
      case 'dams': {
        const bs = dam('Bull Shoals Dam'), nd = dam('Norfork Dam');
        const start = [k.x - 2500, 0, k.z + 800];
        this.a.placeInFlight([start[0], 2500 * FT, start[2]], bearing(start[0], start[2], bs.x, bs.z), 100 * KT, 0);
        this.c.throttle = 0.72; this.c.trim = 0.1;
        this.gates = [
          { name: 'Bull Shoals Dam', x: bs.x + 400, z: bs.z + 900, y: 900 * FT + 199 * 0 + 1100 * FT },
          { name: 'White River at Cotter', x: -6200, z: 11200, y: 1300 * FT },
          { name: 'Norfork Dam', x: nd.x - 500, z: nd.z - 300, y: 1300 * FT },
          { name: 'Norfork Lake, Hwy 62 bridge', x: 12200, z: -500, y: 1500 * FT },
        ];
        for (const g of this.gates) g.y = Math.max(g.y, T.height(g.x, g.z) + 150);
        this.target = { type: 'gates', then: 'land', end: k };
        this.say('Fly through each gate. First: Bull Shoals Dam, to the west.');
        break;
      }
      case 'engine': {
        const x = 9500, z = -5200;
        const hdg = bearing(x, z, k.x, k.z);
        this.a.placeInFlight([x, 3500 * FT, z], hdg + 0.6, 95 * KT, 0);
        this.c.throttle = 0.7; this.c.trim = 0.1;
        this.engineFailAt = 6;
        this.target = { type: 'land', end: null, anyRunway: true };
        this.say('Cruising over Norfork Lake at 3,500 feet...');
        break;
      }
      case 'gastons': {
        const r = T.world.runways.find((q) => /Gaston/.test(q.airport));
        const end = runwayEnd(r, 'a');
        const d = 4 * 1852;
        const x = end.x - Math.sin(end.course) * d, z = end.z + Math.cos(end.course) * d;
        this.a.placeInFlight([x, end.elev + 1200 * FT, z], end.course, 85 * KT, 0);
        this.c.throttle = 0.5; this.c.flaps = 1; this.a.flapDeg = 10; this.c.trim = 0.25;
        this.target = { type: 'land', end, grass: true };
        this.say("Gaston's is ahead on the river bank. It's grass and there are trees at both ends. Land and stop.");
        break;
      }
      case 'demo': {
        onRunway(k, 20);
        const dep = k, arr = k;
        this.pilot = new DemoPilot({
          depart: dep, arrive: arr, cruiseAlt: 3000 * FT,
          route: [
            { name: 'Bull Shoals Dam', ...dam('Bull Shoals Dam') },
            { name: 'Cotter', x: -6000, z: 11500 },
            { name: 'Norfork Dam', ...dam('Norfork Dam') },
            { name: 'Mountain Home', x: 8000, z: 3600 },
          ],
        });
        this.pilot.onPhase = (ph, note) => this.say(note);
        this.target = { type: 'demo' };
        this.say('Watching the demo flight. Press C to change camera, or take the controls at any time.');
        break;
      }
      case 'golden': {
        const x = -14500, z = -3000;
        this.a.placeInFlight([x, 3500 * FT, z], 70 * DEG, 100 * KT, 0);
        this.c.throttle = 0.7; this.c.trim = 0.1;
        this.target = { type: 'free' };
        this.say('Bull Shoals Lake below. Enjoy the light.');
        break;
      }
      default:
        onRunway(k);
    }
    this.a.step(1e-4, this.c, this.env);
    this.holdPitch = this.a.out.pitch;
    this.holdRoll = 0;
    this.route = this.pilot ? this.pilot.route : this.gates;
  }

  say(text, kind = 'info') {
    this.messages.push({ text, kind, t: performance.now() });
  }

  /** Take over from the demo pilot. */
  takeControl() {
    if (this.pilot) {
      this.pilot = null;
      this.ap.disengage();
      this.say('You have control.');
    }
  }

  toggleAutopilot() {
    const o = this.a.out;
    if (this.ap.engaged) { this.ap.disengage(); this.say('Autopilot off', 'warn'); return; }
    this.ap.lateral = 'HDG';
    this.ap.target.heading = o.heading;
    this.ap.engage({ ...o, alt: this.a.pos[1] });
    this.ap.setVertical('ALT', o);
    this.say(`Autopilot on: heading ${Math.round(((o.heading / DEG) + 360) % 360)}°, altitude ${Math.round(this.a.pos[1] / FT / 10) * 10} ft`);
  }

  /**
   * Advance the simulation. `input` is the pilot's desired control positions from src/input.js:
   * { pitch, roll, yaw, throttleDelta, throttleSet, flapsDelta, brake, trimDelta, active: {pitch, roll} }
   */
  update(dt, input) {
    if (this.a.crashed) return;
    this.time += dt;
    const a = this.a, c = this.c, o = a.out;
    this._stepTurbulence(dt);
    if (this.engineFailAt !== null && this.time > this.engineFailAt && a.engineOn) {
      a.engineOn = false;
      this.say('ENGINE FAILURE. Pitch for 68 knots, pick a field, or stretch it to KBPK.', 'warn');
    }
    const pilotInput = input.active.pitch || input.active.roll || input.active.yaw || input.throttleDelta || input.throttleSet != null;
    if (this.pilot && pilotInput) this.takeControl();

    if (this.pilot) {
      this.pilot.update(dt, a, c, this.T);
    } else {
      // throttle, flaps, trim, brakes
      if (input.throttleSet != null) c.throttle = input.throttleSet;
      c.throttle = clamp(c.throttle + input.throttleDelta * dt, 0, 1);
      if (input.flapsDelta) c.flaps = clamp(c.flaps + input.flapsDelta, 0, 3);
      c.trim = clamp(c.trim + input.trimDelta * dt, -1, 1);
      c.brake = input.brake;
      c.brakeL = input.brakeL || 0; c.brakeR = input.brakeR || 0;
      if (input.parkingToggle) { c.parkingBrake = !c.parkingBrake; this.say(c.parkingBrake ? 'Parking brake set' : 'Parking brake released'); }
      if (input.brake > 0.1) c.parkingBrake = false;
      // primary controls, with optional assists for keyboard pilots
      const ap = this.ap;
      if (ap.engaged && (input.active.pitch || input.active.roll)) { ap.disengage(); this.say('Autopilot disconnected', 'warn'); }
      if (ap.engaged) {
        c.yawManual = input.yaw;
        ap.update(dt, o, a.pos, c);
      } else {
        c.roll = input.roll;
        c.pitch = input.pitch;
        const assist = this.assists.attitudeHold && !o.onGround && o.ias > 35 * KT;
        if (assist) {
          if (input.active.pitch) this.holdPitch = o.pitch;
          else c.pitch = clamp(input.pitch + (this.holdPitch - o.pitch) * 2.5 - o.q * 0.5, -1, 1);
          if (input.active.roll) this.holdRoll = Math.abs(o.roll) < 7 * DEG ? 0 : o.roll;
          else c.roll = clamp(input.roll + (this.holdRoll - o.roll) * 1.8 - o.p * 0.3, -1, 1);
          // hold bank needs a little back pressure
          if (!input.active.pitch) c.pitch = clamp(c.pitch + (1 / Math.max(0.5, Math.cos(o.roll)) - 1) * 0.5, -1, 1);
        } else {
          this.holdPitch = o.pitch; this.holdRoll = o.roll;
        }
        if (this.assists.coordination && !o.onGround) {
          c.yaw = clamp(input.yaw + ap.yawPid.update(o.beta, dt) - 0.3 * (o.r - 9.81 * Math.tan(o.roll) / Math.max(o.tas, 20)), -1, 1);
        } else {
          c.yaw = input.yaw;
        }
      }
    }
    a.step(dt, c, this.env);
    this._events();
    this._gates();
  }

  _events() {
    const a = this.a;
    while (a.events.length) {
      const e = a.events.shift();
      if (e.type === 'touchdown') this._touchdown(e);
      if (e.type === 'liftoff' && this.time > 2) this.say(`Liftoff at ${Math.round(e.ias / KT)} knots`);
      if (e.type === 'tailstrike') this.say('Tail strike!', 'warn');
      if (e.type === 'crash') {
        this.outcome = { type: 'crash', reason: e.reason };
      }
      this.events.push(e);
    }
    // landing complete: stopped on a runway
    if (this.landing && !this.landing.final && a.out.gs < 1 && a.out.mains) {
      this.landing.final = true;
      this.outcome = { type: 'landed', report: this.landing };
    }
  }

  _touchdown(e) {
    const T = this.T;
    // which runway, if any?
    let best = null;
    for (const r of T.world.runways) {
      for (const endName of ['a', 'b']) {
        const end = runwayEnd(r, endName);
        const f = runwayFrame(end, e.pos[0], e.pos[2]);
        if (f.along > -30 && f.along < r.length + 30 && Math.abs(f.cross) < r.width / 2 + 8) {
          const alignErr = Math.abs(wrapPi(e.heading - end.course));
          if (!best || alignErr < best.alignErr) best = { r, end, f, alignErr };
        }
      }
    }
    const fpm = e.vs / 0.00508;
    if (this.landing && !this.landing.final) {
      this.landing.bounces += 1;
      this.say('Bounced!', 'warn');
      return;
    }
    const rep = {
      fpm, ias: e.ias / KT, pitch: e.pitch / DEG, roll: e.roll / DEG,
      runway: best ? `${best.r.airport} runway ${best.end.ident}` : null,
      along: best ? best.f.along : null, cross: best ? best.f.cross : null,
      crab: best ? wrapPi(e.heading - best.end.course) / DEG : null,
      bounces: 0, final: false, t: this.time,
    };
    // grade
    let score = 100;
    const v = Math.abs(fpm);
    score -= v < 120 ? 0 : v < 250 ? (v - 120) * 0.12 : v < 450 ? 16 + (v - 250) * 0.15 : 46 + (v - 450) * 0.1;
    if (best) {
      if (best.f.along < 60) score -= 25;
      else if (best.f.along > 600) score -= Math.min(25, (best.f.along - 600) * 0.05);
      score -= Math.min(20, Math.abs(best.f.cross) * 2.5);
      score -= Math.min(15, Math.abs(rep.crab) * 2);
    } else score -= 60;
    score -= Math.min(20, Math.abs(rep.roll) * 2);
    rep.score = Math.max(0, Math.round(score));
    rep.grade = score >= 92 ? 'A+' : score >= 85 ? 'A' : score >= 75 ? 'B' : score >= 62 ? 'C' : score >= 45 ? 'D' : 'F';
    this.landing = rep;
    const words = v < 120 ? 'Butter.' : v < 250 ? 'Nice landing.' : v < 450 ? 'Firm.' : 'Ouch. That was a controlled crash.';
    this.say(`Touchdown ${Math.round(fpm)} fpm${best ? ` on ${best.end.ident}` : ' off the runway'}. ${words}`);
  }

  _gates() {
    if (!this.gates.length || this.gateIdx >= this.gates.length) return;
    const g = this.gates[this.gateIdx];
    const p = this.a.pos;
    const d = Math.hypot(p[0] - g.x, p[2] - g.z);
    if (d < 180 && Math.abs(p[1] - g.y) < 120) {
      this.gateIdx++;
      this.say(this.gateIdx < this.gates.length ? `Gate ${this.gateIdx}/${this.gates.length}: ${g.name}. Next: ${this.gates[this.gateIdx].name}` : `All gates. Now bring it home to KBPK runway 23.`);
    }
  }

  activeWaypoint() {
    if (this.pilot) {
      const w = this.pilot.route[this.pilot.wp];
      return w ? { ...w, idx: this.pilot.wp } : { name: 'KBPK 23', x: this.kbpk.x, z: this.kbpk.z, idx: -1 };
    }
    if (this.gates.length && this.gateIdx < this.gates.length) return { ...this.gates[this.gateIdx], idx: this.gateIdx };
    if (this.target?.type === 'land' || this.target?.then === 'land') {
      const e = this.target.end || this.kbpk;
      return { name: e === this.kbpk ? 'KBPK 23' : 'RWY', x: e.x, z: e.z, idx: -1 };
    }
    return null;
  }
}
