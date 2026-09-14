import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EARTH, MOON, propagateKepler, orbitalElements, orbitPath, hohmann, deltaV, circularSpeed, rk4Step, stumpffC, stumpffS, moonState } from '../src/physics.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

test('Stumpff functions are continuous through zero', () => {
  close(stumpffC(1e-9), 0.5, 1e-6, 'C(0+)');
  close(stumpffC(-1e-9), 0.5, 1e-6, 'C(0-)');
  close(stumpffS(1e-9), 1 / 6, 1e-6, 'S(0+)');
  close(stumpffS(-1e-9), 1 / 6, 1e-6, 'S(0-)');
});

test('circular orbit propagates exactly one period back to start', () => {
  const r = EARTH.radius + 400000;
  const v = circularSpeed(EARTH.mu, r);
  const s0 = { x: r, y: 0, vx: 0, vy: v };
  const T = 2 * Math.PI * Math.sqrt(r ** 3 / EARTH.mu);
  const s1 = propagateKepler(s0, T * 0.9999999, EARTH.mu);
  close(s1.x, s0.x, 5, 'x after one period');
  close(s1.y, s0.y, 50, 'y after one period');
  const q = propagateKepler(s0, T / 4, EARTH.mu);
  close(q.x, 0, 1, 'quarter orbit x');
  close(q.y, r, 1, 'quarter orbit y');
});

test('Kepler propagation matches RK4 integration on an eccentric orbit', () => {
  const rp = EARTH.radius + 200000;
  const vp = Math.sqrt(EARTH.mu * (2 / rp - 1 / ((rp + EARTH.radius + 20000000) / 2)));
  let s = { x: rp, y: 0, vx: 0, vy: vp, m: 1 };
  const accel = (x, y) => { const r = Math.hypot(x, y); const g = -EARTH.mu / (r * r * r); return { ax: g * x, ay: g * y, mdot: 0 }; };
  const dt = 2, total = 4000;
  for (let t = 0; t < total; t += dt) s = rk4Step(s, dt, t, accel);
  const k = propagateKepler({ x: rp, y: 0, vx: 0, vy: vp }, total, EARTH.mu);
  close(k.x, s.x, 50, 'x');
  close(k.y, s.y, 50, 'y');
  close(k.vx, s.vx, 0.05, 'vx');
  close(k.vy, s.vy, 0.05, 'vy');
});

test('hyperbolic propagation conserves energy and angular momentum', () => {
  const r = MOON.radius + 500000;
  const v = Math.sqrt(2 * MOON.mu / r) * 1.3;
  const s0 = { x: r, y: 0, vx: -v * 0.3, vy: v * 0.95 };
  const e0 = orbitalElements(s0, MOON.mu);
  assert.ok(e0.e > 1, 'is hyperbolic');
  const s1 = propagateKepler(s0, 50000, MOON.mu);
  const e1 = orbitalElements(s1, MOON.mu);
  close(e1.energy, e0.energy, Math.abs(e0.energy) * 1e-9, 'energy');
  close(e1.h, e0.h, Math.abs(e0.h) * 1e-9, 'angular momentum');
  // and propagating backwards returns home
  const back = propagateKepler(s1, -50000, MOON.mu);
  close(back.x, s0.x, 1, 'back x');
  close(back.y, s0.y, 1, 'back y');
});

test('orbital elements of a known ellipse', () => {
  const rp = EARTH.radius + 200000, ra = EARTH.radius + 35786000; // GTO
  const a = (rp + ra) / 2;
  const vp = Math.sqrt(EARTH.mu * (2 / rp - 1 / a));
  const el = orbitalElements({ x: rp, y: 0, vx: 0, vy: vp }, EARTH.mu);
  close(el.rp, rp, 1, 'rp');
  close(el.ra, ra, 10, 'ra');
  close(el.e, (ra - rp) / (ra + rp), 1e-9, 'e');
  close(el.period, 2 * Math.PI * Math.sqrt(a ** 3 / EARTH.mu), 1e-3, 'period');
  assert.ok(Math.abs(el.tPeri) < 1e-3 || Math.abs(el.tPeri - el.period) < 1e-3, 'at periapsis: tPeri is 0 or one period');
  close(el.tApo, el.period / 2, 1e-3, 'apoapsis half a period away');
  // one quarter period later we are heading away from periapsis
  const later = propagateKepler({ x: rp, y: 0, vx: 0, vy: vp }, 1000, EARTH.mu);
  const el2 = orbitalElements(later, EARTH.mu);
  close(el2.tPeri, el.period - 1000, 1e-2, 'tPeri counts down');
});

test('orbit path samples lie on the conic', () => {
  const r = EARTH.radius + 300000;
  const el = orbitalElements({ x: r, y: 0, vx: 0, vy: circularSpeed(EARTH.mu, r) * 1.1 }, EARTH.mu);
  const pts = orbitPath(el, EARTH.mu, { samples: 64 });
  assert.equal(pts.length, 65);
  const radii = pts.map(p => Math.hypot(p[0], p[1]));
  close(Math.min(...radii), el.rp, 1, 'min radius = rp');
  close(Math.max(...radii), el.ra, 1, 'max radius = ra');
});

test('rocket equation and Hohmann numbers match textbook values', () => {
  close(deltaV(311, 100, 50), 311 * 9.80665 * Math.log(2), 1e-9, 'dv');
  const h = hohmann(EARTH.mu, EARTH.radius + 200000, MOON.orbitRadius);
  close(h.dv1, 3130, 20, 'TLI dv ~3.13 km/s');
  close(h.time / 86400, 4.98, 0.05, 'transfer ~5 days');
});

test('Moon ephemeris is circular with the right period', () => {
  close(MOON.period / 86400, 27.4, 0.2, 'sidereal month');
  const m = moonState(MOON.period / 2);
  close(m.x, -MOON.orbitRadius, 1e3, 'half period opposite');
  close(Math.hypot(m.vx, m.vy), MOON.orbitSpeed, 1e-6, 'speed');
});
