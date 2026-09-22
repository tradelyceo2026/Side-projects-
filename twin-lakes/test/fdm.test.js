// Flight model checks against the Cessna 172S POH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft, defaultControls, liftCurve } from '../src/fdm/aircraft.js';
import { atmosphere } from '../src/fdm/atmosphere.js';
import { qFromEuler, eulerFromQ, qRot, DEG, KT, FT } from '../src/fdm/math.js';
import { flat, flyAp } from './helpers.js';

test('ISA: sea level and 10,000 ft', () => {
  const sl = atmosphere(0);
  assert.ok(Math.abs(sl.rho - 1.225) < 1e-3);
  const a = atmosphere(3048);
  assert.ok(Math.abs(a.rho - 0.9046) < 0.002, `rho ${a.rho}`);
  assert.ok(Math.abs(a.T - 268.34) < 0.1);
});

test('Euler round trip through quaternions', () => {
  for (const [h, p, r] of [[0.3, 0.1, -0.4], [4, -0.2, 0.7], [2, 0.5, 0]]) {
    const e = eulerFromQ(qFromEuler(h, p, r));
    assert.ok(Math.abs(e.heading - h) < 1e-9 && Math.abs(e.pitch - p) < 1e-9 && Math.abs(e.roll - r) < 1e-9);
  }
  // heading 90° points the nose east (+x)
  const f = qRot(qFromEuler(Math.PI / 2, 0, 0), [0, 0, -1]);
  assert.ok(Math.abs(f[0] - 1) < 1e-9);
});

test('lift curve is linear, peaks, then breaks', () => {
  const cl = (a) => liftCurve(a * DEG, 0.307, 1.48, -0.95, 4.41);
  assert.ok(Math.abs(cl(4) - (0.307 + 4.41 * 4 * DEG)) < 1e-9);
  let peak = 0, peakA = 0;
  for (let a = 0; a < 30; a += 0.1) if (cl(a) > peak) { peak = cl(a); peakA = a; }
  assert.ok(Math.abs(peak - 1.48) < 0.01, `CLmax ${peak}`);
  assert.ok(peakA > 14 && peakA < 19, `stall angle ${peakA}`);
  assert.ok(cl(peakA + 6) < peak * 0.8);
});

test('static RPM at full throttle is 2300-2420 (POH static range)', () => {
  const a = new Aircraft();
  a.placeOnGround(0, 0, 0, 0);
  const c = defaultControls(); c.throttle = 1; c.parkingBrake = true;
  a.step(12, c, flat());
  assert.equal(a.crashed, null);
  assert.ok(a.out.rpm > 2300 && a.out.rpm < 2420, `rpm ${a.out.rpm}`);
});

test('cruise at 8,000 ft full throttle: about 122 KTAS and 2,500+ RPM (POH 122 KTAS)', () => {
  const { a } = flyAp({ alt: 8000 * FT, seconds: 200 });
  const tas = a.out.tas / KT;
  assert.ok(tas > 117 && tas < 127, `TAS ${tas}`);
  assert.ok(a.out.rpm > 2450 && a.out.rpm < 2650, `rpm ${a.out.rpm}`);
  assert.ok(Math.abs(a.pos[1] - 8000 * FT) < 10, 'altitude hold');
  const gph = a.out.fuelFlow * 3600 / 0.72 / 3.785;
  assert.ok(gph > 8.5 && gph < 11.5, `fuel flow ${gph} gph`);
});

test('climb at Vy near sea level: 650-850 fpm (POH 730 fpm at max gross)', () => {
  const { a } = flyAp({ alt: 300, tas: 74 * KT, vertical: 'IAS', ias: 74 * KT, seconds: 90 });
  const fpm = a.out.vs / 0.00508;
  assert.ok(fpm > 650 && fpm < 850, `climb ${fpm} fpm`);
  assert.ok(Math.abs(a.out.ias / KT - 74) < 2);
});

test('power-off stall at max gross: clean ~53 KCAS, flaps 30 ~48 KCAS (POH)', () => {
  for (const [flaps, lo, hi] of [[0, 49, 56], [3, 43, 51]]) {
    const { trace } = flyAp({ alt: 1500, tas: 70 * KT, throttle: 0, flaps, seconds: 120, mass: 1111 });
    const first = trace.find((o) => o.stalled);
    assert.ok(first, 'stalled');
    const kias = first.ias / KT;
    assert.ok(kias > lo && kias < hi, `flaps ${flaps * 10}: stall ${kias} KIAS`);
  }
});

test('controls act in the right sense', () => {
  const run = (set) => {
    const a = new Aircraft(); a.placeInFlight([0, 1500, 0], 0, 50, 0);
    const c = defaultControls(); c.throttle = 0.6; set(c);
    a.step(1.5, c, flat());
    return a.out;
  };
  assert.ok(run((c) => { c.pitch = 0.3; }).pitch > run(() => {}).pitch + 3 * DEG, 'pull raises the nose');
  assert.ok(run((c) => { c.roll = 0.5; }).roll > 5 * DEG, 'right aileron rolls right');
  const yawed = run((c) => { c.yaw = 0.5; });
  assert.ok(yawed.heading > 1 * DEG && yawed.heading < Math.PI, 'right rudder yaws right');
});

test('stable hands-off: no divergence in 60 s with neutral controls', () => {
  const a = new Aircraft(); a.placeInFlight([0, 1500, 0], 0, 40, 0);
  const c = defaultControls(); c.throttle = 0.65;
  a.step(60, c, flat());
  assert.equal(a.crashed, null);
  assert.ok(Math.abs(a.out.roll) < 30 * DEG, `roll ${a.out.roll / DEG}`);
});

test('hard landing breaks the gear, gentle one does not', () => {
  for (const [vs, shouldCrash] of [[-0.8, false], [-5, true]]) {
    const a = new Aircraft();
    a.placeInFlight([0, 1.3, 0], 0, 30, 0, 4 * DEG);   // wheels 0.2 m above the ground
    a.vel[1] = vs;
    const c = defaultControls();
    a.step(3, c, flat());
    assert.equal(Boolean(a.crashed), shouldCrash, `${vs} m/s: ${a.crashed}`);
  }
});

test('ground roll tracks straight and lifts off under 1,500 ft', () => {
  const a = new Aircraft(); a.placeOnGround(0, 0, 0, 0);
  const c = defaultControls(); c.throttle = 1;
  let lift = null;
  for (let i = 0; i < 60 * 40 && !lift; i++) {
    const o = a.out;
    if (o.ias !== undefined) {
      c.pitch = o.ias > 55 * KT ? Math.max(-1, Math.min(1, (10 * DEG - o.pitch) * 5 - o.q * 0.8)) : 0;
      c.yaw = Math.max(-1, Math.min(1, -Math.sin(o.heading) * 6 - o.r * 1.5));
    }
    a.step(1 / 60, c, flat());
    lift = a.events.find((e) => e.type === 'liftoff');
  }
  assert.ok(lift, 'lifted off');
  const ft = Math.hypot(lift.pos[0], lift.pos[2]) / FT;
  assert.ok(ft < 1500, `roll ${ft} ft`);
  assert.ok(Math.abs(lift.pos[0]) < 5, `drift ${lift.pos[0]} m`);
});
