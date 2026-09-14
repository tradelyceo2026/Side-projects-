// Ozark Orbital — world simulation: powered flight (RK4), coasting (Kepler on rails),
// patched-conic SOI transitions, ground contact, events.
import { EARTH, MOON, moonState, atmDensity, propagateKepler, orbitalElements, rk4Step, wrapAngle } from './physics.js';
import { createVehicle, stage, totalMass, massFlow, thrustAt, separate, deltaVRemaining } from './vehicle.js';

export const MAX_PHYSICS_WARP = 10;
export const MAX_RAILS_WARP = 100000;
export const TURN_RATE = 0.6; // rad/s attitude slew

export function createSim(opts = {}) {
  const t0 = 0;
  const sim = {
    t: t0,
    met: 0,
    launched: false,
    status: 'pad',            // pad | flying | landed | crashed
    bodyName: 'Earth',
    ship: { x: EARTH.radius, y: 0, vx: 0, vy: EARTH.rotation * EARTH.radius },
    vehicle: createVehicle(opts.vehicle),
    heading: 0,               // absolute inertial angle the nose points at
    headingCmd: 0,
    throttle: 0,
    sas: 'up',                // manual | up | prograde | retrograde
    warp: 1,
    onRails: false,
    moonPhase0: opts.moonPhase0 ?? Math.PI * 0.75,
    maxQ: 0,
    log: [],
    lastAccel: 0,
    autoStage: true,
    padAngle: 0,
  };
  sim.heading = 0; sim.headingCmd = 0;
  return sim;
}

export function body(sim) { return sim.bodyName === 'Moon' ? MOON : EARTH; }

export function logEvent(sim, text) {
  sim.log.push({ t: sim.met, text });
  if (sim.log.length > 200) sim.log.shift();
}

export function altitude(sim) {
  return Math.hypot(sim.ship.x, sim.ship.y) - body(sim).radius;
}
export function radialDir(sim) {
  const r = Math.hypot(sim.ship.x, sim.ship.y);
  return { x: sim.ship.x / r, y: sim.ship.y / r };
}
/** Velocity relative to the rotating surface / atmosphere. */
export function surfaceVelocity(sim) {
  const b = body(sim);
  const w = b.rotation;
  return { x: sim.ship.vx + w * sim.ship.y, y: sim.ship.vy - w * sim.ship.x };
}
export function verticalSpeed(sim) {
  const u = radialDir(sim);
  return sim.ship.vx * u.x + sim.ship.vy * u.y;
}
export function elements(sim) { return orbitalElements(sim.ship, body(sim).mu); }
export function moonRel(sim) { return moonState(sim.t, sim.moonPhase0); }

/** Position of ship in Earth-centred frame regardless of current SOI. */
export function earthFrame(sim) {
  if (sim.bodyName === 'Earth') return { ...sim.ship };
  const m = moonRel(sim);
  return { x: sim.ship.x + m.x, y: sim.ship.y + m.y, vx: sim.ship.vx + m.vx, vy: sim.ship.vy + m.vy };
}

export function progradeAngle(sim, surface) {
  const v = surface ? surfaceVelocity(sim) : sim.ship;
  const speed = Math.hypot(v.vx ?? v.x, v.vy ?? v.y);
  if (speed < 1) { const u = radialDir(sim); return Math.atan2(u.y, u.x); }
  return Math.atan2(v.vy ?? v.y, v.vx ?? v.x);
}

export function launch(sim) {
  if (sim.status !== 'pad') return;
  sim.launched = true;
  sim.status = 'flying';
  sim.throttle = 1;
  logEvent(sim, 'Liftoff from Ozark Spaceport');
}

export function doStage(sim) {
  const s = stage(sim.vehicle);
  const name = s ? s.name : '';
  if (separate(sim.vehicle)) {
    logEvent(sim, `Separation: ${name}`);
    return true;
  }
  return false;
}

function slewHeading(sim, dt) {
  const b = body(sim);
  let target = sim.headingCmd;
  if (sim.sas === 'up') { const u = radialDir(sim); target = Math.atan2(u.y, u.x); }
  else if (sim.sas === 'prograde') target = progradeAngle(sim, altitude(sim) < (b.atmosphere ? b.atmosphere.top : 0));
  else if (sim.sas === 'retrograde') target = progradeAngle(sim, altitude(sim) < (b.atmosphere ? b.atmosphere.top : 0)) + Math.PI;
  let d = target - sim.heading;
  d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const maxStep = TURN_RATE * dt;
  if (Math.abs(d) <= maxStep) sim.heading = target; else sim.heading += Math.sign(d) * maxStep;
  sim.heading = wrapAngle(sim.heading);
}

function makeAccel(sim) {
  const b = body(sim);
  const v = sim.vehicle;
  const s = stage(v);
  const cdA = v.def.dragArea;
  const w = b.rotation;
  const engineOn = sim.throttle > 0 && s && v.prop[v.stageIndex] > 0;
  const hx = Math.cos(sim.heading), hy = Math.sin(sim.heading);
  return (x, y, vx, vy, m) => {
    const r2 = x * x + y * y, r = Math.sqrt(r2);
    const g = -b.mu / (r2 * r);
    let ax = g * x, ay = g * y;
    const alt = r - b.radius;
    // drag (relative to rotating atmosphere)
    const rho = atmDensity(b, alt);
    let mdot = 0;
    if (rho > 0) {
      const rvx = vx + w * y, rvy = vy - w * x;
      const rv = Math.hypot(rvx, rvy);
      if (rv > 0) {
        const fd = 0.5 * rho * rv * rv * cdA;
        ax -= fd * rvx / (rv * m); ay -= fd * rvy / (rv * m);
      }
    }
    if (engineOn) {
      const T = thrustAt(s, b, alt) * sim.throttle;
      ax += T * hx / m; ay += T * hy / m;
      mdot = -massFlow(s) * sim.throttle;
    }
    return { ax, ay, mdot };
  };
}

function checkSoi(sim) {
  if (sim.bodyName === 'Earth') {
    const m = moonRel(sim);
    const dx = sim.ship.x - m.x, dy = sim.ship.y - m.y;
    if (Math.hypot(dx, dy) < MOON.soi) {
      sim.ship = { x: dx, y: dy, vx: sim.ship.vx - m.vx, vy: sim.ship.vy - m.vy };
      sim.bodyName = 'Moon';
      logEvent(sim, 'Entered the Moon\'s sphere of influence');
      return true;
    }
  } else {
    if (Math.hypot(sim.ship.x, sim.ship.y) > MOON.soi) {
      const m = moonRel(sim);
      sim.ship = { x: sim.ship.x + m.x, y: sim.ship.y + m.y, vx: sim.ship.vx + m.vx, vy: sim.ship.vy + m.vy };
      sim.bodyName = 'Earth';
      logEvent(sim, 'Left the Moon\'s sphere of influence');
      return true;
    }
  }
  return false;
}

function checkGround(sim) {
  const b = body(sim);
  const r = Math.hypot(sim.ship.x, sim.ship.y);
  if (r <= b.radius) {
    const sv = surfaceVelocity(sim);
    const speed = Math.hypot(sv.x, sv.y);
    // pin to surface
    const u = { x: sim.ship.x / r, y: sim.ship.y / r };
    sim.ship.x = u.x * b.radius; sim.ship.y = u.y * b.radius;
    sim.ship.vx = -b.rotation * sim.ship.y; sim.ship.vy = b.rotation * sim.ship.x;
    sim.throttle = 0;
    sim.warp = 1;
    if (speed > 12) { sim.status = 'crashed'; logEvent(sim, `Impact at ${speed.toFixed(0)} m/s on the ${b.name}`); }
    else { sim.status = 'landed'; logEvent(sim, `Touchdown on the ${b.name}`); }
    return true;
  }
  return false;
}

/** Whether the ship can coast on rails right now. */
export function canRails(sim) {
  const b = body(sim);
  const v = sim.vehicle;
  const s = stage(v);
  const engineOn = sim.throttle > 0 && s && v.prop[v.stageIndex] > 0;
  if (engineOn) return false;
  const alt = altitude(sim);
  if (b.atmosphere && alt < b.atmosphere.top) return false;
  return true;
}

/** Advance the world by real seconds `realDt` (warp applied inside). */
export function step(sim, realDt) {
  if (sim.status === 'pad') {
    sim.t += realDt * sim.warp;
    sim.padAngle = wrapAngle(EARTH.rotation * sim.t);
    sim.ship = { x: EARTH.radius * Math.cos(sim.padAngle), y: EARTH.radius * Math.sin(sim.padAngle), vx: -EARTH.rotation * EARTH.radius * Math.sin(sim.padAngle), vy: EARTH.rotation * EARTH.radius * Math.cos(sim.padAngle) };
    sim.heading = sim.padAngle; sim.headingCmd = sim.padAngle;
    if (sim.launched) sim.status = 'flying';
    return;
  }
  if (sim.status !== 'flying') { sim.t += realDt; return; }

  const rails = canRails(sim);
  sim.onRails = rails;
  if (rails) {
    if (sim.warp > MAX_RAILS_WARP) sim.warp = MAX_RAILS_WARP;
    let dt = realDt * sim.warp;
    const b = body(sim);
    // sub-step so SOI checks stay accurate; keep each sub-step below ~1/50 of period or 200s
    const el = elements(sim);
    const maxSub = isFinite(el.period) ? Math.max(1, Math.min(el.period / 50, 600)) : 120;
    let n = Math.max(1, Math.ceil(dt / maxSub));
    if (n > 400) n = 400;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      sim.ship = propagateKepler(sim.ship, h, b.mu);
      sim.t += h; sim.met += h;
      slewHeading(sim, h);
      if (checkSoi(sim)) break;
      if (Math.hypot(sim.ship.x, sim.ship.y) <= body(sim).radius) { checkGround(sim); break; }
    }
    return;
  }

  if (sim.warp > MAX_PHYSICS_WARP) sim.warp = MAX_PHYSICS_WARP;
  let dt = realDt * sim.warp;
  const alt = altitude(sim);
  const maxSub = alt < 150000 ? 0.05 : 0.5;
  const n = Math.max(1, Math.ceil(dt / maxSub));
  const h = dt / n;
  const v = sim.vehicle;
  for (let i = 0; i < n; i++) {
    slewHeading(sim, h);
    const s = stage(v);
    if (sim.throttle > 0 && s && v.prop[v.stageIndex] <= 0) {
      if (sim.autoStage && v.stageIndex < v.def.stages.length - 1) doStage(sim);
    }
    const accel = makeAccel(sim);
    const m0 = totalMass(v);
    const st = rk4Step({ ...sim.ship, m: m0 }, h, sim.t, accel);
    const burned = m0 - st.m;
    if (burned > 0) {
      v.prop[v.stageIndex] = Math.max(0, v.prop[v.stageIndex] - burned);
      if (v.prop[v.stageIndex] === 0) logEvent(sim, `${stage(v).name}: propellant depleted`);
    }
    sim.lastAccel = Math.hypot(st.vx - sim.ship.vx, st.vy - sim.ship.vy) / h;
    sim.ship = { x: st.x, y: st.y, vx: st.vx, vy: st.vy };
    sim.t += h; sim.met += h;
    // max-Q tracking
    const b = body(sim);
    const rho = atmDensity(b, altitude(sim));
    if (rho > 0) { const sv = surfaceVelocity(sim); const q = 0.5 * rho * (sv.x * sv.x + sv.y * sv.y); if (q > sim.maxQ) sim.maxQ = q; }
    if (checkGround(sim)) break;
    if (checkSoi(sim)) break;
  }
}

export function summary(sim) {
  const b = body(sim);
  const el = elements(sim);
  const sv = surfaceVelocity(sim);
  return {
    body: b.name,
    alt: altitude(sim),
    speed: Math.hypot(sim.ship.vx, sim.ship.vy),
    surfaceSpeed: Math.hypot(sv.x, sv.y),
    vertSpeed: verticalSpeed(sim),
    apoAlt: el.ra - b.radius,
    periAlt: el.rp - b.radius,
    e: el.e,
    period: el.period,
    tApo: el.tApo,
    tPeri: el.tPeri,
    dv: deltaVRemaining(sim.vehicle),
    mass: totalMass(sim.vehicle),
    stage: stage(sim.vehicle),
    stageIndex: sim.vehicle.stageIndex,
    prop: sim.vehicle.prop[sim.vehicle.stageIndex],
    met: sim.met,
    status: sim.status,
    onRails: sim.onRails,
    warp: sim.warp,
  };
}
