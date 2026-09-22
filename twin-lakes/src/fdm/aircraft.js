// Six-degree-of-freedom rigid-body flight model for a light single.
//
// Frames. World: +x east, +y up, +z south (metres from KBPK). Model: +x right wing, +y up, -z nose.
// Aerodynamics are evaluated in conventional body axes (x forward, y right, z down), which map to the
// model frame as xb = -z, yb = x, zb = -y. Integration is semi-implicit Euler at a fixed 240 Hz.

import { C172 } from './c172.js';
import { atmosphere, indicatedAltitude, G0, RHO0 } from './atmosphere.js';
import {
  add, sub, scale, dot, cross, len, norm, madd, qRot, qRotInv, qIntegrate, qFromEuler, eulerFromQ,
  clamp, smoothstep, DEG, KT, FT,
} from './math.js';

export const DT = 1 / 240;

export function defaultControls() {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brake: 0, brakeL: 0, brakeR: 0, parkingBrake: false, trim: 0 };
}

/** Lift coefficient versus angle of attack with a rounded peak and a post-stall break toward a flat plate. */
export function liftCurve(a, cl0, clmax, clmin, CLa) {
  const lin = cl0 + CLa * a;
  const round = 0.06;
  const a1 = (clmax - cl0) / CLa - round;          // rounding starts here
  const a2 = a1 + 2 * round;                       // peak (stall) angle
  const n1 = (clmin - cl0) / CLa + round;
  const n2 = n1 - 2 * round;
  const flat = 1.05 * Math.sin(2 * a);
  if (a <= a1 && a >= n1) return lin;
  if (a > a1 && a <= a2) {
    const x = a - a1;
    return cl0 + CLa * a1 + CLa * x - (CLa / (4 * round)) * x * x;
  }
  if (a > a2) {
    const x = a - a2;
    const post = clmax * (1 - 0.3 * smoothstep(0, 0.1, x));
    return post + (flat - post) * smoothstep(0.1, 0.6, x);
  }
  if (a < n1 && a >= n2) {
    const x = a - n1;
    return cl0 + CLa * n1 + CLa * x + (CLa / (4 * round)) * x * x;
  }
  const x = n2 - a;
  const post = clmin * (1 - 0.3 * smoothstep(0, 0.1, x));
  return post + (flat - post) * smoothstep(0.1, 0.6, x);
}

export function stallAngle(cl0, clmax, CLa) {
  return (clmax - cl0) / CLa + 0.06;
}

export class Aircraft {
  constructor(data = C172) {
    this.d = data;
    this.reset();
  }

  reset() {
    const d = this.d;
    this.pos = [0, 1000, 0];
    this.vel = [0, 0, 0];
    this.q = qFromEuler(0, 0, 0);
    this.w = [0, 0, 0];
    this.fuel = d.fuelMax * 0.75;
    this.payload = d.pilotMass + 80;
    this.flapDeg = 0;
    this.engineOn = true;
    this.omegaE = 2 * Math.PI * 2300 / 60;
    this.crashed = null;
    this.onGround = false;
    this.mainsOnGround = false;
    this.alphaPrev = 0;
    this.alphaDot = 0;
    this.time = 0;
    this.events = [];
    this.gearState = this.d.gear.map(() => ({ comp: 0, load: 0, contact: false }));
    this.airborneSince = null;
    this.lastAirVs = 0;
    this.accel = [0, 0, 0];
    this.fuelFlow = 0;
    this.thrust = 0;
    this.out = {};
    this.stallRoll = 0;
  }

  get mass() { return this.d.emptyMass + this.payload + this.fuel; }

  /** Place the aircraft on the ground at (x, z) facing heading (rad), gear compressed to static load. */
  placeOnGround(x, z, heading, groundH) {
    this.reset();
    const pitch = 0.5 * DEG;
    this.q = qFromEuler(heading, pitch, 0);
    const lowest = Math.min(...this.d.gear.map((g) => qRot(this.q, g.pos)[1]));
    this.pos = [x, groundH - lowest - 0.05, z];
    this.vel = [0, 0, 0];
    this.omegaE = 2 * Math.PI * 700 / 60;
    this.onGround = true;
    this.mainsOnGround = true;
  }

  /** Start in flight: position, heading (rad), true airspeed (m/s), flight-path angle (rad). */
  placeInFlight(pos, heading, tas, gamma = 0, pitch = null) {
    this.reset();
    const p = pitch ?? gamma + 3 * DEG;
    this.q = qFromEuler(heading, p, 0);
    this.pos = [...pos];
    const fwd = [Math.sin(heading) * Math.cos(gamma), Math.sin(gamma), -Math.cos(heading) * Math.cos(gamma)];
    this.vel = scale(fwd, tas);
    this.omegaE = 2 * Math.PI * 2300 / 60;
    this.airborneSince = 0;
  }

  /**
   * Advance by dt (seconds) in fixed sub-steps.
   * env: { ground(x, z) -> {h, n:[3], water: bool, waterH}, wind(pos, t) -> [3], wx: {dT, qnh}, gust: number }
   */
  step(dt, c, env) {
    let t = dt;
    while (t > 1e-9 && !this.crashed) {
      const h = Math.min(DT, t);
      this._substep(h, c, env);
      t -= h;
    }
  }

  _substep(dt, c, env) {
    const d = this.d;
    const m = this.mass;
    const atm = atmosphere(this.pos[1], env.wx);
    const wind = env.wind ? env.wind(this.pos, this.time) : [0, 0, 0];
    const vAir = sub(this.vel, wind);
    const vm = qRotInv(this.q, vAir);
    const u = -vm[2], v = vm[0], w = -vm[1];
    const V = Math.hypot(u, v, w);
    const p = -this.w[2], q = this.w[0], r = -this.w[1];
    const alpha = Math.atan2(w, Math.max(Math.abs(u), 1e-3) * Math.sign(u || 1));
    const beta = V > 0.5 ? Math.asin(clamp(v / V, -1, 1)) : 0;
    const qbar = 0.5 * atm.rho * V * V;

    // flaps move toward the selected detent
    const flapTarget = d.flapDetents[clamp(Math.round(c.flaps), 0, 3)];
    const fd = flapTarget - this.flapDeg;
    this.flapDeg += clamp(fd, -d.flapRate * dt, d.flapRate * dt);
    const fi = this.flapDeg / 10;                    // 0..3 continuous
    const fInterp = (arr) => { const i = Math.min(2, Math.floor(fi)); const f = fi - i; return arr[i] + (arr[i + 1] - arr[i]) * f; };
    const dCL = fInterp(d.flapCL), dCLmax = fInterp(d.flapCLmax), dCD = fInterp(d.flapCD), dCm = fInterp(d.flapCm);

    // control surfaces
    const pull = clamp(c.pitch, -1, 1);
    let de = pull > 0 ? -pull * d.elevUp : -pull * d.elevDown;
    const trim = clamp(c.trim, -1, 1);
    de += trim > 0 ? trim * d.trimRange[0] : -trim * d.trimRange[1];
    const da = clamp(c.roll, -1, 1) * d.aileronMax;
    const dr = clamp(c.yaw, -1, 1) * d.rudderMax;

    // ---- engine and propeller
    const n = this.omegaE / (2 * Math.PI);              // rev/s
    const D = d.propD;
    let thrust = 0, Qprop = 0;
    if (n > 1) {
      const J = u / (n * D);
      thrust = d.Ct(J) * atm.rho * n * n * D ** 4;
      Qprop = d.Cp(J) * atm.rho * n * n * D ** 5 / (2 * Math.PI);
    } else {
      thrust = -0.5 * atm.rho * u * Math.abs(u) * 0.12 * 0.6;   // stopped prop drag
      Qprop = -0.02 * atm.rho * u * Math.abs(u);                // airflow tries to turn it
    }
    const rpm = n * 60;
    let Qeng = 0;
    const altFactor = Math.max(0, 1.132 * atm.sigma - 0.132);
    const th = clamp(c.throttle, 0, 1);
    if (this.engineOn && this.fuel > 0) {
      const Qmax = d.ratedPower / (2 * Math.PI * d.ratedRpm / 60) + d.frictionTorque(d.ratedRpm) * 0.5;
      Qeng = Qmax * altFactor * (d.idleFraction + (1 - d.idleFraction) * th);
      if (rpm < 350) Qeng *= rpm / 350;                    // below firing speed the engine quits
      if (rpm < 150) this.engineOn = false;
      const P = Qeng * this.omegaE;
      this.fuelFlow = P * d.bsfc;
      this.fuel = Math.max(0, this.fuel - this.fuelFlow * dt);
    } else {
      this.fuelFlow = 0;
    }
    const Qfric = n > 0.05 ? d.frictionTorque(rpm) : 0;
    this.omegaE = Math.max(0, this.omegaE + (Qeng - Qprop - Qfric) / d.engineInertia * dt);
    this.thrust = thrust;

    // ---- aerodynamics
    const Vn = Math.max(V, 8);
    const ph = p * d.b / (2 * Vn), qh = q * d.c / (2 * Vn), rh = r * d.b / (2 * Vn);
    const aDotRaw = (alpha - this.alphaPrev) / dt;
    this.alphaDot += (clamp(aDotRaw, -2, 2) - this.alphaDot) * Math.min(1, dt * 20);
    this.alphaPrev = alpha;
    const adh = this.alphaDot * d.c / (2 * Vn);

    const cl0 = d.CL0 + dCL;
    const clmax = d.CLmax + dCLmax;
    const aStall = stallAngle(cl0, clmax, d.CLa);
    const sf = smoothstep(aStall - 0.02, aStall + 0.1, alpha);
    const Aprop = Math.PI * D * D / 4;
    const qTail = qbar + 0.25 * Math.max(0, thrust) / Aprop;
    const tailRatio = qbar > 1 ? qTail / qbar : 0;

    // ground effect on induced drag
    const agl = this.lastAgl ?? 100;
    const hw = Math.max(0.3, agl + 0.9);
    const ge = (16 * hw / d.b) ** 2 / (1 + (16 * hw / d.b) ** 2);

    const CLs = liftCurve(alpha, cl0, clmax, d.CLmin, d.CLa);
    let CL = CLs + d.CLq * qh + d.CLadot * adh + d.CLde * de * tailRatio;
    const K = 1 / (Math.PI * d.AR * d.e);
    let CD = d.CD0 + dCD + K * ge * Math.min(CL * CL, 2.4) + 1.2 * sf * Math.sin(alpha) ** 2 + 0.2 * beta * beta;
    const CY = d.CYb * beta + d.CYp * ph + d.CYr * rh - d.CYdr * dr * tailRatio;
    // stall: roll damping collapses (autorotation) and the wing drops toward the sideslip
    this.stallRoll += ((this._rand() - 0.5) * 0.02 - this.stallRoll) * Math.min(1, dt * 2);
    const Cl = d.Clb * beta + d.Clp * (1 - 1.3 * sf) * ph + d.Clr * rh + d.Clda * da - d.Cldr * dr * tailRatio
      + sf * (this.stallRoll + 0.02 * Math.sign(beta || 0.001) * Math.min(1, Math.abs(beta) * 20));
    const Cm = d.Cm0 + dCm + d.Cma * alpha + d.Cmq * qh + d.Cmadot * adh + d.Cmde * de * tailRatio
      - 0.5 * sf * (alpha - aStall);
    // Roskam defines +δr as trailing edge left; here +dr is right pedal (trailing edge right), hence the signs
    const Cn = d.Cnb * beta + d.Cnp * ph + d.Cnr * rh + d.Cnda * da - d.Cndr * dr * tailRatio;

    // forces in body axes (x fwd, y right, z down)
    let Fb = [0, 0, 0];
    if (V > 0.1) {
      const uh = [u / V, v / V, w / V];
      const liftDir = norm(cross([0, 1, 0], uh));
      Fb = scale(add(add(scale(uh, -CD), scale(liftDir, CL)), [0, CY, 0]), qbar * d.S);
    }
    Fb[0] += thrust;
    const S = d.S;
    let Lm = qbar * S * d.b * Cl;
    let Mm = qbar * S * d.c * Cm;
    let Nm = qbar * S * d.b * Cn;
    // propeller reactions: engine torque rolls the airframe left, slipstream and P-factor yaw it left
    // (the airframe is rigged to cancel both at cruise power, so only the difference is felt)
    Lm -= (Qeng - Qfric - 330) * 0.25;
    Nm -= 0.1 * (thrust * (1 + 2 * Math.max(0, alpha)) - 1000) * Math.min(1, V / 20);
    // aerodynamic damping when nearly stationary (keeps ground handling sane)
    if (V < 8) { Lm -= 400 * p; Mm -= 400 * q; Nm -= 200 * r; }

    // body -> model frame
    const Fm = [Fb[1], -Fb[2], -Fb[0]];
    let F = qRot(this.q, Fm);
    F[1] -= m * G0;
    let tau = [Mm, -Nm, -Lm];

    // ---- ground contact
    let onGround = false, mains = 0;
    const g0 = env.ground(this.pos[0], this.pos[2]);
    this.lastAgl = this.pos[1] - 1.12 - g0.h;
    const fwdW = qRot(this.q, [0, 0, -1]);
    const nearGround = this.lastAgl < 12 || (g0.water && this.pos[1] - g0.waterH < 12);
    for (let i = 0; nearGround && i < d.gear.length; i++) {
      const gd = d.gear[i];
      const st = this.gearState[i];
      const rW = qRot(this.q, gd.pos);
      const P = add(this.pos, rW);
      const gnd = env.ground(P[0], P[2]);
      if (gnd.water && P[1] < gnd.waterH && gnd.waterH > gnd.h) {
        this._crash('ditched in the water'); return;
      }
      const nrm = gnd.n;
      const pen = (gnd.h - P[1]) * nrm[1];
      st.contact = pen > 0;
      if (pen <= 0) { st.comp = 0; st.load = 0; continue; }
      onGround = true;
      if (gd.name !== 'nose') mains++;
      const vP = add(this.vel, cross(qRot(this.q, this.w), rW));
      const vn = dot(vP, nrm);
      if (pen > gd.stroke) {
        if (-vn > 3.2 || pen > gd.stroke * 1.6) { this._crash(gd.name === 'nose' ? 'nose gear collapsed' : 'hard landing, main gear failed'); return; }
      }
      let N = gd.k * pen - gd.c * vn;
      // spring-steel mains fail near 30 kN (about 3 g of the whole aircraft on one leg); the nose strut sooner
      if (N > (gd.name === 'nose' ? 16000 : 30000)) {
        this._crash(gd.name === 'nose' ? 'nose gear collapsed' : 'hard landing, main gear failed'); return;
      }
      if (pen > gd.stroke) N += gd.k * 12 * (pen - gd.stroke);
      N = Math.max(0, N);
      st.comp = pen; st.load = N;
      // wheel axes on the ground plane
      let roll = norm(sub(fwdW, scale(nrm, dot(fwdW, nrm))));
      if (gd.steer) {
        // spring-link steering: full throw at taxi speed, the rudder takes over as speed builds
        const gs = Math.hypot(this.vel[0], this.vel[2]);
        const steer = clamp(c.yaw, -1, 1) * d.noseSteer / (1 + (gs / 9) ** 2);
        const side0 = norm(cross(roll, nrm));
        roll = norm(add(scale(roll, Math.cos(steer)), scale(side0, Math.sin(steer))));
      }
      const side = norm(cross(roll, nrm));
      const vRoll = dot(vP, roll), vSide = dot(vP, side);
      let brake = 0;
      if (gd.brake) {
        const b = c.parkingBrake ? 1 : clamp(Math.max(c.brake, gd.name === 'left' ? c.brakeL : c.brakeR), 0, 1);
        brake = b;
      }
      const mu = d.mu.roll + (d.mu.brake - d.mu.roll) * brake;
      const fRoll = -mu * N * Math.tanh(vRoll / (brake > 0.9 ? 0.05 : 0.3));
      // lateral force from the tyre slip angle (saturates near 8°), velocity-based below walking pace
      const slipAng = Math.atan2(vSide, Math.max(Math.abs(vRoll), 1.5));
      const fSide = -d.mu.side * N * Math.tanh(slipAng / 0.08);
      const Fc = add(add(scale(nrm, N), scale(roll, fRoll)), scale(side, fSide));
      F = add(F, Fc);
      tau = add(tau, qRotInv(this.q, cross(rW, Fc)));
    }
    if (!nearGround) for (const st of this.gearState) { st.contact = false; st.comp = 0; st.load = 0; }
    for (const hp of nearGround ? d.hardPoints : []) {
      const rW = qRot(this.q, hp.pos);
      const P = add(this.pos, rW);
      const gnd = env.ground(P[0], P[2]);
      if (P[1] < gnd.h) {
        const vP = add(this.vel, cross(qRot(this.q, this.w), rW));
        if (hp.name === 'tail' && -vP[1] < 1.5 && len(this.vel) < 45) {
          // tail skid scrape: a stiff spring, not a crash
          const pen = gnd.h - P[1];
          const Fc = [0, 60000 * pen - 3000 * vP[1], 0];
          F = add(F, Fc);
          tau = add(tau, qRotInv(this.q, cross(rW, Fc)));
          if (!this._tailStrikeLogged) { this.events.push({ type: 'tailstrike', time: this.time }); this._tailStrikeLogged = true; }
          continue;
        }
        this._crash(`${hp.name} struck the ground`); return;
      }
    }

    // touchdown / liftoff events
    const wasMains = this.mainsOnGround;
    this.onGround = onGround;
    this.mainsOnGround = mains > 0;
    if (!this.mainsOnGround) this.lastAirVs = this.vel[1];
    if (this.mainsOnGround && !wasMains && this.airborneSince !== null && this.time - this.airborneSince > 1.0) {
      const e = eulerFromQ(this.q);
      this.events.push({
        type: 'touchdown', time: this.time, vs: this.lastAirVs, ias: this.out.ias ?? 0, pitch: e.pitch, roll: e.roll,
        heading: e.heading, pos: [...this.pos], airborne: this.time - this.airborneSince,
      });
    }
    if (!onGround && wasMains) {
      this.airborneSince = this.time;
      this.events.push({ type: 'liftoff', time: this.time, ias: this.out.ias ?? 0, pos: [...this.pos] });
    }

    // ---- integrate
    const acc = scale(F, 1 / m);
    this.accel = acc;
    this.vel = madd(this.vel, acc, dt);
    this.pos = madd(this.pos, this.vel, dt);
    const I = [d.Iyy, d.Izz, d.Ixx];               // model-frame principal inertias
    const Iw = [I[0] * this.w[0], I[1] * this.w[1], I[2] * this.w[2]];
    const gyro = cross(this.w, Iw);
    const wd = [(tau[0] - gyro[0]) / I[0], (tau[1] - gyro[1]) / I[1], (tau[2] - gyro[2]) / I[2]];
    this.w = madd(this.w, wd, dt);
    this.q = qIntegrate(this.q, this.w, dt);
    this.time += dt;

    // structural limits
    const sfm = qRotInv(this.q, add(acc, [0, G0, 0]));
    const nz = sfm[1] / G0;
    if (!onGround && (nz > 5.7 || nz < -3.0)) this._crash(`structural failure at ${nz.toFixed(1)} g`);
    if (V > d.V.ne * KT * 1.25) this._crash('structural failure (flutter above Vne)');

    // ---- outputs
    const e = eulerFromQ(this.q);
    const ias = Math.sqrt(2 * qbar / RHO0);
    const setting = env.wx?.qnh || 101325;
    this.out = {
      ias, tas: V, gs: Math.hypot(this.vel[0], this.vel[2]), vs: this.vel[1],
      alt: this.pos[1], indAlt: indicatedAltitude(atm.p, setting), agl: this.lastAgl,
      alpha, beta, aStall, stallWarn: alpha > aStall - 5 * DEG && !this.mainsOnGround && ias > 5,
      stalled: sf > 0.5, heading: e.heading, pitch: e.pitch, roll: e.roll,
      track: Math.atan2(this.vel[0], -this.vel[2]),
      rpm, thrust, fuel: this.fuel, fuelFlow: this.fuelFlow, flaps: this.flapDeg,
      nz, slip: sfm[0] / G0, p, q, r, onGround: this.onGround, mains: this.mainsOnGround,
      rho: atm.rho, oat: atm.T - 273.15, wind,
    };
  }

  _rand() {
    this._seed = (Math.imul(this._seed ?? 12345, 1664525) + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }

  _crash(reason) {
    if (this.crashed) return;
    this.crashed = reason;
    this.events.push({ type: 'crash', reason, time: this.time, pos: [...this.pos] });
    this.vel = [0, 0, 0];
    this.w = [0, 0, 0];
  }
}

export { KT, FT, DEG };
