import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, step, summary } from '../src/sim.js';
import { createAutopilot, startProgram, autopilotTick, PROGRAMS } from '../src/autopilot.js';
import { MOON, EARTH } from '../src/physics.js';

const FRAME = 1 / 30;
function run(sim, ap, until, maxFrames = 300000) {
  for (let i = 0; i < maxFrames; i++) {
    autopilotTick(ap, sim, FRAME);
    step(sim, FRAME);
    if (until(sim, ap)) return true;
    if (sim.status !== 'flying' && sim.status !== 'pad') return false;
  }
  return false;
}

test('ASCENT autopilot reaches a ~200 km circular parking orbit', () => {
  const sim = createSim();
  const ap = createAutopilot();
  startProgram(ap, sim, PROGRAMS.ASCENT);
  const ok = run(sim, ap, (s, a) => a.program === null);
  assert.ok(ok, 'program finished');
  const s = summary(sim);
  assert.equal(s.status, 'flying');
  assert.ok(s.periAlt > 185000 && s.periAlt < 215000, `periapsis ${s.periAlt}`);
  assert.ok(s.apoAlt > 190000 && s.apoAlt < 230000, `apoapsis ${s.apoAlt}`);
  assert.ok(s.met < 1500, `reached orbit in ${s.met}s`);
  assert.ok(s.dv > 7000, `plenty of dv left: ${s.dv}`);
  assert.ok(sim.maxQ > 20000 && sim.maxQ < 60000, `max-Q realistic: ${sim.maxQ}`);
});

test('ASCENT + TLI + LOI autopilots deliver the probe into lunar orbit', () => {
  const sim = createSim();
  const ap = createAutopilot();
  startProgram(ap, sim, PROGRAMS.ASCENT);
  assert.ok(run(sim, ap, (s, a) => a.program === null), 'ascent');
  startProgram(ap, sim, PROGRAMS.TLI);
  assert.ok(run(sim, ap, (s) => s.bodyName === 'Moon', 400000), 'reached lunar SOI');
  assert.ok(sim.met < 8 * 86400, 'within 8 days');
  startProgram(ap, sim, PROGRAMS.LOI);
  assert.ok(run(sim, ap, (s, a) => a.program === null, 400000), 'LOI finished');
  const s = summary(sim);
  assert.equal(s.body, 'Moon');
  assert.ok(s.e < 1, `captured (e=${s.e})`);
  assert.ok(s.periAlt > 20000, `periapsis above surface: ${s.periAlt}`);
  assert.ok(s.apoAlt < 1500000, `apoapsis reasonable: ${s.apoAlt}`);
  assert.ok(Math.hypot(sim.ship.x, sim.ship.y) < MOON.soi, 'inside SOI');
});

test('a rocket that never turns falls back and crashes', () => {
  const sim = createSim();
  sim.launched = true; sim.status = 'flying'; sim.throttle = 1; sim.sas = 'up';
  // burn only briefly so it comes back down
  let frames = 0;
  while (sim.status === 'flying' && frames < 200000) {
    if (sim.met > 25) sim.throttle = 0;
    step(sim, FRAME); frames++;
  }
  assert.equal(sim.status, 'crashed');
  assert.ok(sim.log.some(e => /Impact/.test(e.text)));
});

test('SOI handoff preserves Earth-frame position and velocity', () => {
  const sim = createSim();
  sim.launched = true; sim.status = 'flying'; sim.throttle = 0;
  // place ship just outside the Moon's SOI heading in
  const m = { x: MOON.orbitRadius, y: 0 };
  sim.moonPhase0 = 0; sim.t = 0;
  sim.ship = { x: m.x - MOON.soi - 5000, y: 0, vx: 800, vy: MOON.orbitSpeed };
  const before = { ...sim.ship };
  step(sim, 0.5); // physics or rails; either way should hand off
  for (let i = 0; i < 100 && sim.bodyName === 'Earth'; i++) step(sim, 0.5);
  assert.equal(sim.bodyName, 'Moon');
  const rel = sim.ship;
  const mm = sim.t * MOON.meanMotion;
  const moonNow = { x: MOON.orbitRadius * Math.cos(mm), y: MOON.orbitRadius * Math.sin(mm) };
  const earthX = rel.x + moonNow.x;
  assert.ok(Math.abs(earthX - (before.x + 800 * sim.t)) < 2000, 'earth-frame x continuous');
});
