// Ozark Orbital — flight computer. Runs the same code in the browser and in headless tests.
import { EARTH, MOON, hohmann, orbitalElements, propagateKepler, moonState, angleDiff, wrapAngle } from './physics.js';
import { body, altitude, elements, radialDir, surfaceVelocity, verticalSpeed, launch, doStage, moonRel, logEvent, progradeAngle } from './sim.js';
import { stage, totalMass, thrustAt, stagesLeft } from './vehicle.js';

export const PROGRAMS = {
  ASCENT: 'ascent',      // pad -> circular parking orbit
  TLI: 'tli',            // parking orbit -> trans-lunar injection -> Moon SOI
  LOI: 'loi',            // Moon SOI -> lunar orbit insertion
};

export function createAutopilot() {
  return { program: null, phase: 'idle', targetAlt: 200000, info: '', burnStart: 0, lastPhaseChange: 0, lunarTargetAlt: 300000 };
}

export function startProgram(ap, sim, program) {
  ap.program = program;
  ap.phase = 'start';
  ap.info = '';
  logEvent(sim, `Autopilot: ${program.toUpperCase()} program engaged`);
}
export function stopAutopilot(ap, sim) {
  if (ap.program) logEvent(sim, 'Autopilot disengaged');
  ap.program = null; ap.phase = 'idle'; ap.info = '';
  sim.warp = Math.min(sim.warp, 1);
}

function setPhase(ap, sim, phase, note) {
  ap.phase = phase; ap.lastPhaseChange = sim.met;
  if (note) logEvent(sim, `Autopilot: ${note}`);
}

/** Choose a warp so that `secondsAway` is reached in a handful of frames without overshooting. */
function warpFor(secondsAway, frameDt, maxWarp) {
  if (secondsAway <= 0) return 1;
  const w = secondsAway / (8 * frameDt);
  const steps = [1, 2, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000];
  let best = 1;
  for (const s of steps) if (s <= w && s <= maxWarp) best = s;
  return best;
}

/** True when the current stage is dry; stages automatically if another stage remains. */
function dry(sim) {
  const v = sim.vehicle;
  if (v.prop[v.stageIndex] > 0) return false;
  if (stagesLeft(v) > 1) { doStage(sim); return false; }
  return true;
}

function burnTimeFor(sim, dv) {
  const s = stage(sim.vehicle);
  if (!s) return 0;
  const m = totalMass(sim.vehicle);
  const T = thrustAt(s, body(sim), altitude(sim));
  const a = T / m;
  return dv / a;
}

function setHeadingFromPitch(sim, pitchFromVertical) {
  // pitch toward the direction of orbital motion (east / counter-clockwise)
  const u = radialDir(sim);
  const up = Math.atan2(u.y, u.x);
  sim.sas = 'manual';
  sim.headingCmd = up - pitchFromVertical; // negative? east = up rotated by -90deg in CCW frame? compute:
  // tangential (east / prograde) direction for CCW motion is up + 90deg.
  sim.headingCmd = up + pitchFromVertical;
}

// ---------------- ASCENT ----------------
function ascent(ap, sim, frameDt) {
  const b = body(sim);
  const alt = altitude(sim);
  const el = elements(sim);
  const target = ap.targetAlt;
  switch (ap.phase) {
    case 'start':
      sim.warp = 1; sim.sas = 'up'; sim.throttle = 1;
      if (sim.status === 'pad') launch(sim);
      setPhase(ap, sim, 'liftoff');
      break;
    case 'liftoff': {
      sim.sas = 'up'; sim.throttle = 1;
      const sv = surfaceVelocity(sim);
      if (Math.hypot(sv.x, sv.y) > 70) setPhase(ap, sim, 'gravityturn', 'beginning gravity turn');
      break;
    }
    case 'gravityturn': {
      sim.throttle = 1;
      // pitch program: pitch from vertical grows with altitude; stage-2 guard keeps climb rate sane
      let pitch = (Math.PI / 2) * (1 - Math.exp(-alt / 32000));
      if (sim.vehicle.stageIndex >= 1) {
        const vv = verticalSpeed(sim);
        const vvDes = Math.max(0, Math.min(500, (target - alt) / 150));
        const corr = (vvDes - vv) * 0.0025; // rad per m/s
        pitch -= Math.max(-0.35, Math.min(0.15, corr));
      }
      pitch = Math.max(0, Math.min(Math.PI / 2 + 0.1, pitch));
      setHeadingFromPitch(sim, pitch);
      ap.info = `Gravity turn · pitch ${(pitch * 180 / Math.PI).toFixed(0)}°`;
      if (el.ra - b.radius >= target && alt > 100000) {
        sim.throttle = 0;
        setPhase(ap, sim, 'coast', 'MECO — coasting to apoapsis');
      }
      break;
    }
    case 'coast': {
      sim.throttle = 0; sim.sas = 'prograde';
      const r = el.ra;
      const vApo = Math.sqrt(b.mu * (2 / r - 1 / el.a));
      const dv = Math.sqrt(b.mu / r) - vApo;
      const tb = burnTimeFor(sim, dv);
      const lead = el.tApo - tb / 2;
      ap.info = `Coast · circularization Δv ${dv.toFixed(0)} m/s · burn ${tb.toFixed(0)} s · in ${Math.max(0, lead).toFixed(0)} s`;
      if (alt < (b.atmosphere ? b.atmosphere.top : 0)) { sim.warp = 1; break; }
      if (lead <= 0.5) { setPhase(ap, sim, 'circ', 'circularization burn'); sim.warp = 1; }
      else sim.warp = warpFor(lead, frameDt, 1000);
      break;
    }
    case 'circ': {
      sim.sas = 'prograde'; sim.throttle = 1; sim.warp = 1;
      ap.info = `Circularizing · periapsis ${((el.rp - b.radius) / 1000).toFixed(0)} km`;
      if (dry(sim)) { sim.throttle = 0; ap.program = null; ap.info = 'Out of propellant during circularization'; break; }
      if (el.rp - b.radius >= target - 5000) {
        sim.throttle = 0;
        setPhase(ap, sim, 'done', `orbit achieved: ${((el.rp - b.radius) / 1000).toFixed(0)} × ${((el.ra - b.radius) / 1000).toFixed(0)} km`);
        ap.program = null; ap.info = 'Parking orbit achieved';
      }
      break;
    }
  }
}

// ---------------- TLI ----------------
/** Phase angle of the Moon ahead of the ship (radians, 0..2pi). */
export function moonPhaseAngle(sim) {
  const m = moonRel(sim);
  const shipAng = Math.atan2(sim.ship.y, sim.ship.x);
  return wrapAngle(m.angle - shipAng);
}
/** Required lead angle for a Hohmann-type transfer from current radius. */
export function requiredLeadAngle(sim) {
  const r = Math.hypot(sim.ship.x, sim.ship.y);
  const h = hohmann(EARTH.mu, r, MOON.orbitRadius);
  return Math.PI - MOON.meanMotion * h.time;
}

/** Predict closest approach to the Moon (Earth frame) over the next `horizon` seconds for a coasting ship. */
export function predictMoonApproach(sim, horizon = 6 * 86400, samples = 240) {
  let best = { dist: Infinity, t: 0 };
  const s0 = sim.ship;
  for (let i = 1; i <= samples; i++) {
    const dt = (i / samples) * horizon;
    const s = propagateKepler(s0, dt, EARTH.mu);
    if (Math.hypot(s.x, s.y) < EARTH.radius) break;
    const m = moonState(sim.t + dt, sim.moonPhase0);
    const d = Math.hypot(s.x - m.x, s.y - m.y);
    if (d < best.dist) best = { dist: d, t: dt };
  }
  return best;
}

function tli(ap, sim, frameDt) {
  const b = body(sim);
  if (sim.bodyName === 'Moon') { setPhase(ap, sim, 'done'); ap.program = null; ap.info = 'In lunar SOI'; sim.warp = 1; return; }
  const el = elements(sim);
  switch (ap.phase) {
    case 'start': {
      if (el.e > 0.05 || el.rp < b.radius + 120000) { ap.info = 'TLI needs a low circular parking orbit first'; stopAutopilot(ap, sim); return; }
      setPhase(ap, sim, 'wait', 'waiting for lunar transfer window');
      break;
    }
    case 'wait': {
      sim.throttle = 0; sim.sas = 'prograde';
      const r = Math.hypot(sim.ship.x, sim.ship.y);
      const h = hohmann(EARTH.mu, r, MOON.orbitRadius);
      const tb = burnTimeFor(sim, h.dv1);
      const shipRate = Math.sqrt(b.mu / (r * r * r));
      // Start the burn early by half its arc so the impulse is centred on the ideal point
      const lead = requiredLeadAngle(sim) + shipRate * tb / 2 - MOON.meanMotion * tb / 2;
      const phase = moonPhaseAngle(sim);
      let d = angleDiff(phase, lead); // >0 : moon still too far ahead; it closes at (shipRate - moonRate)
      if (d < 0) d += 2 * Math.PI;
      const tWindow = d / (shipRate - MOON.meanMotion);
      ap.info = `Transfer window in ${(tWindow / 60).toFixed(1)} min · phase ${(phase * 180 / Math.PI).toFixed(1)}° → ${(lead * 180 / Math.PI).toFixed(1)}° · Δv ${h.dv1.toFixed(0)} m/s`;
      if (tWindow <= 0.5 * frameDt * sim.warp || tWindow < 0.5) { sim.warp = 1; setPhase(ap, sim, 'burn', `TLI burn, Δv ${h.dv1.toFixed(0)} m/s`); }
      else sim.warp = warpFor(tWindow, frameDt, 1000);
      break;
    }
    case 'burn': {
      sim.sas = 'prograde'; sim.throttle = 1; sim.warp = 1;
      const targetApo = MOON.orbitRadius + 20000000;
      ap.info = `TLI burn · apoapsis ${((el.ra - b.radius) / 1000).toFixed(0)} km`;
      if (dry(sim)) { sim.throttle = 0; ap.program = null; ap.info = 'Out of propellant during TLI'; break; }
      if (el.ra >= targetApo || el.e >= 1) {
        sim.throttle = 0;
        const p = predictMoonApproach(sim);
        setPhase(ap, sim, 'coast', `TLI complete — predicted lunar approach ${(p.dist / 1000).toFixed(0)} km in ${(p.t / 3600).toFixed(1)} h`);
      }
      break;
    }
    case 'coast': {
      sim.throttle = 0; sim.sas = 'prograde';
      const p = predictMoonApproach(sim);
      ap.info = `Coasting to the Moon · closest approach ${(p.dist / 1000).toFixed(0)} km in ${(p.t / 3600).toFixed(1)} h`;
      if (p.dist > MOON.soi && p.t < 60) { ap.info = 'Missed the Moon — no encounter'; ap.program = null; sim.warp = 1; break; }
      sim.warp = warpFor(Math.max(p.t - 3600, 60), frameDt, 10000);
      if (altitude(sim) < 500000) sim.warp = Math.min(sim.warp, 50);
      break;
    }
  }
}

// ---------------- LOI ----------------
function elementsAfterImpulse(sim, dvx, dvy) {
  return orbitalElements({ x: sim.ship.x, y: sim.ship.y, vx: sim.ship.vx + dvx, vy: sim.ship.vy + dvy }, body(sim).mu);
}

function loi(ap, sim, frameDt) {
  const b = body(sim);
  if (sim.bodyName !== 'Moon') { ap.info = 'LOI program needs to be inside the Moon\'s sphere of influence'; stopAutopilot(ap, sim); return; }
  const el = elements(sim);
  const targetPeri = 100000;
  switch (ap.phase) {
    case 'start':
      setPhase(ap, sim, 'check', 'assessing approach');
      break;
    case 'check': {
      sim.throttle = 0;
      if (el.rp - b.radius < 30000 || el.rp - b.radius > 2000000) {
        // choose a normal-to-velocity direction that moves periapsis toward the target
        const v = Math.hypot(sim.ship.vx, sim.ship.vy);
        const nx = -sim.ship.vy / v, ny = sim.ship.vx / v;
        const plus = elementsAfterImpulse(sim, nx * 5, ny * 5).rp;
        const minus = elementsAfterImpulse(sim, -nx * 5, -ny * 5).rp;
        const want = targetPeri + b.radius;
        const better = Math.abs(plus - want) < Math.abs(minus - want) ? 1 : -1;
        ap.corrDir = Math.atan2(better * ny, better * nx);
        setPhase(ap, sim, 'correct', `correcting periapsis (${((el.rp - b.radius) / 1000).toFixed(0)} km)`);
      } else setPhase(ap, sim, 'coastperi', 'coasting to lunar periapsis');
      break;
    }
    case 'correct': {
      sim.sas = 'manual'; sim.headingCmd = ap.corrDir; sim.warp = 1;
      const aligned = Math.abs(angleDiff(sim.heading, ap.corrDir)) < 0.05;
      const periAlt = el.rp - b.radius;
      sim.throttle = aligned ? (Math.abs(periAlt - targetPeri) > 3000000 ? 0.3 : 0.05) : 0;
      ap.info = `Trajectory correction · periapsis ${(periAlt / 1000).toFixed(0)} km`;
      if (periAlt > targetPeri - 20000 && periAlt < targetPeri + 150000) { sim.throttle = 0; setPhase(ap, sim, 'coastperi', 'coasting to lunar periapsis'); }
      if (dry(sim)) { sim.throttle = 0; ap.program = null; ap.info = 'Out of propellant'; }
      break;
    }
    case 'coastperi': {
      sim.throttle = 0; sim.sas = 'retrograde';
      const vPeri = Math.sqrt(b.mu * (2 / el.rp - 1 / el.a));
      const dv = vPeri - Math.sqrt(b.mu / el.rp);
      const tb = burnTimeFor(sim, dv);
      const lead = el.tPeri - tb / 2;
      ap.info = `Coast to periapsis · capture Δv ${dv.toFixed(0)} m/s · in ${Math.max(0, lead).toFixed(0)} s`;
      if (lead <= 0.5) { sim.warp = 1; setPhase(ap, sim, 'burn', `lunar orbit insertion burn, Δv ${dv.toFixed(0)} m/s`); }
      else sim.warp = warpFor(lead, frameDt, 1000);
      break;
    }
    case 'burn': {
      sim.sas = 'retrograde'; sim.throttle = 1; sim.warp = 1;
      const apoAlt = el.e < 1 ? el.ra - b.radius : Infinity;
      ap.info = `LOI burn · ${el.e < 1 ? 'captured, apoapsis ' + (apoAlt / 1000).toFixed(0) + ' km' : 'e = ' + el.e.toFixed(2)}`;
      if (el.e < 1 && (apoAlt <= ap.lunarTargetAlt || el.e < 0.02)) {
        sim.throttle = 0; ap.program = null;
        setPhase(ap, sim, 'done', `lunar orbit: ${((el.rp - b.radius) / 1000).toFixed(0)} × ${(apoAlt / 1000).toFixed(0)} km`);
        ap.info = 'Lunar orbit achieved';
      }
      if (dry(sim)) { sim.throttle = 0; ap.program = null; ap.info = el.e < 1 ? 'Captured with dry tanks' : 'Out of propellant before capture'; }
      break;
    }
  }
}

export function autopilotTick(ap, sim, frameDt) {
  if (!ap.program) return;
  if (sim.status === 'crashed' || sim.status === 'landed') { ap.program = null; return; }
  if (ap.program === PROGRAMS.ASCENT) ascent(ap, sim, frameDt);
  else if (ap.program === PROGRAMS.TLI) tli(ap, sim, frameDt);
  else if (ap.program === PROGRAMS.LOI) loi(ap, sim, frameDt);
}
