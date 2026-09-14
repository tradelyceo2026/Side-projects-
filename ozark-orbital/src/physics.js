// Ozark Orbital — physics core.
// Pure functions, no DOM. Units: metres, seconds, kilograms, radians.
// 2D equatorial-plane simulation with patched-conic sphere-of-influence handoff.

export const G0 = 9.80665;

export const EARTH = {
  name: 'Earth',
  mu: 3.986004418e14,
  radius: 6371000,
  rotation: 7.2921159e-5,      // rad/s
  atmosphere: { rho0: 1.225, scaleHeight: 8500, top: 140000, p0: 101325 },
  color: '#2f6fd6',
};

export const MOON = {
  name: 'Moon',
  mu: 4.9048695e12,
  radius: 1737400,
  rotation: 2.6617e-6,
  atmosphere: null,
  color: '#b8b8b0',
  orbitRadius: 384400000,
  soi: 66100000,
};
// Moon mean motion around Earth (circular orbit assumed)
MOON.meanMotion = Math.sqrt(EARTH.mu / Math.pow(MOON.orbitRadius, 3));
MOON.period = 2 * Math.PI / MOON.meanMotion;
MOON.orbitSpeed = MOON.meanMotion * MOON.orbitRadius;

export function moonState(t, phase0 = 0) {
  const th = phase0 + MOON.meanMotion * t;
  const c = Math.cos(th), s = Math.sin(th);
  return {
    x: MOON.orbitRadius * c,
    y: MOON.orbitRadius * s,
    vx: -MOON.orbitSpeed * s,
    vy: MOON.orbitSpeed * c,
    angle: th,
  };
}

export function atmDensity(body, alt) {
  const a = body.atmosphere;
  if (!a || alt > a.top || alt < -1000) return 0;
  return a.rho0 * Math.exp(-Math.max(alt, 0) / a.scaleHeight);
}
export function atmPressure(body, alt) {
  const a = body.atmosphere;
  if (!a || alt > a.top) return 0;
  return a.p0 * Math.exp(-Math.max(alt, 0) / a.scaleHeight);
}

// ---------- Stumpff functions & universal-variable Kepler propagation ----------
export function stumpffC(z) {
  if (z > 1e-8) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; }
  if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / (-z); }
  return 0.5 - z / 24;
}
export function stumpffS(z) {
  if (z > 1e-8) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  return 1 / 6 - z / 120;
}

/**
 * Propagate a two-body state by dt seconds using universal variables (all conics).
 * state: {x,y,vx,vy}; returns new {x,y,vx,vy}.
 */
export function propagateKepler(state, dt, mu) {
  if (dt === 0) return { ...state };
  const r0 = Math.hypot(state.x, state.y);
  const v0sq = state.vx * state.vx + state.vy * state.vy;
  const rdotv = state.x * state.vx + state.y * state.vy;
  const vr0 = rdotv / r0;
  const alpha = 2 / r0 - v0sq / mu; // 1/a
  const sqmu = Math.sqrt(mu);

  // For bound orbits reduce dt modulo the period for accuracy
  if (alpha > 1e-16) {
    const T = 2 * Math.PI / (sqmu * Math.pow(alpha, 1.5));
    if (Math.abs(dt) > T) dt = dt % T;
    if (dt === 0) return { ...state };
  }

  let chi;
  if (alpha > 1e-16) {
    chi = sqmu * alpha * dt;
  } else if (alpha < -1e-16) {
    const a = 1 / alpha;
    const sgn = Math.sign(dt);
    const num = -2 * mu * alpha * dt;
    const den = rdotv + sgn * Math.sqrt(-mu * a) * (1 - r0 * alpha);
    chi = sgn * Math.sqrt(-a) * Math.log(Math.abs(num / den));
    if (!isFinite(chi)) chi = sgn * Math.sqrt(-a);
  } else {
    // parabolic: use a rough guess, Newton will fix
    chi = sqmu * dt / r0;
  }

  for (let i = 0; i < 60; i++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z), S = stumpffS(z);
    const F = (r0 * vr0 / sqmu) * chi * chi * C + (1 - alpha * r0) * chi * chi * chi * S + r0 * chi - sqmu * dt;
    const dF = (r0 * vr0 / sqmu) * chi * (1 - alpha * chi * chi * S) + (1 - alpha * r0) * chi * chi * C + r0;
    const ratio = F / dF;
    chi -= ratio;
    if (Math.abs(ratio) < 1e-10 * Math.max(1, Math.abs(chi))) break;
  }
  const z = alpha * chi * chi;
  const C = stumpffC(z), S = stumpffS(z);
  const f = 1 - (chi * chi / r0) * C;
  const g = dt - (chi * chi * chi / sqmu) * S;
  const x = f * state.x + g * state.vx;
  const y = f * state.y + g * state.vy;
  const r = Math.hypot(x, y);
  const fdot = (sqmu / (r * r0)) * chi * (z * S - 1);
  const gdot = 1 - (chi * chi / r) * C;
  return { x, y, vx: fdot * state.x + gdot * state.vx, vy: fdot * state.y + gdot * state.vy };
}

export function propagate(state, dt, mu) {
  const s = propagateKepler(state, dt, mu);
  return s;
}

// ---------- Orbital elements (2D) ----------
export function orbitalElements(state, mu) {
  const { x, y, vx, vy } = state;
  const r = Math.hypot(x, y);
  const v2 = vx * vx + vy * vy;
  const h = x * vy - y * vx;                 // signed specific angular momentum (z)
  const rdotv = x * vx + y * vy;
  const ex = ((v2 - mu / r) * x - rdotv * vx) / mu;
  const ey = ((v2 - mu / r) * y - rdotv * vy) / mu;
  const e = Math.hypot(ex, ey);
  const energy = v2 / 2 - mu / r;
  const a = -mu / (2 * energy);              // negative for hyperbolic
  const p = h * h / mu;
  const rp = p / (1 + e);
  const ra = e < 1 ? p / (1 - e) : Infinity;
  const argPe = e > 1e-12 ? Math.atan2(ey, ex) : Math.atan2(y, x);
  // true anomaly, signed so it is negative when approaching periapsis
  let nu;
  if (e > 1e-12) {
    let c = (ex * x + ey * y) / (e * r);
    c = Math.max(-1, Math.min(1, c));
    nu = Math.acos(c);
    if (rdotv < 0) nu = -nu;
  } else {
    nu = 0;
  }
  const period = e < 1 ? 2 * Math.PI * Math.sqrt(a * a * a / mu) : Infinity;
  let tPeri, tApo;
  if (e < 1) {
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
    const M = E - e * Math.sin(E);
    const n = Math.sqrt(mu / (a * a * a));
    tPeri = (-M / n);
    if (tPeri < 0) tPeri += period;
    tApo = tPeri - period / 2;
    if (tApo < 0) tApo += period;
  } else {
    const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    const M = e * Math.sinh(F) - F;
    const n = Math.sqrt(mu / Math.pow(-a, 3));
    tPeri = -M / n;
    tApo = Infinity;
  }
  return { a, e, h, p, rp, ra, argPe, nu, period, energy, tPeri, tApo, direction: h >= 0 ? 1 : -1 };
}

/** Sample points along the conic for drawing. Returns array of [x,y]. */
export function orbitPath(el, mu, opts = {}) {
  const n = opts.samples || 256;
  const maxR = opts.maxRadius || Infinity;
  const pts = [];
  const dir = el.direction;
  if (el.e < 1) {
    for (let i = 0; i <= n; i++) {
      const nu = (i / n) * 2 * Math.PI;
      const r = el.p / (1 + el.e * Math.cos(nu));
      const th = el.argPe + dir * nu;
      pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
  } else {
    let nuInf = Math.acos(-1 / el.e);
    if (isFinite(maxR)) {
      // limit to where r <= maxR
      const c = (el.p / maxR - 1) / el.e;
      if (c > -1 && c < 1) nuInf = Math.min(nuInf, Math.acos(c));
    }
    nuInf *= 0.999;
    for (let i = 0; i <= n; i++) {
      const nu = -nuInf + (i / n) * 2 * nuInf;
      const r = el.p / (1 + el.e * Math.cos(nu));
      const th = el.argPe + dir * nu;
      pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
  }
  return pts;
}

// ---------- Rocket equation ----------
export function deltaV(isp, m0, m1) {
  return isp * G0 * Math.log(m0 / m1);
}
export function circularSpeed(mu, r) { return Math.sqrt(mu / r); }
export function escapeSpeed(mu, r) { return Math.sqrt(2 * mu / r); }

/** Hohmann transfer from circular r1 to r2: returns {dv1, dv2, time}. */
export function hohmann(mu, r1, r2) {
  const at = (r1 + r2) / 2;
  const v1 = Math.sqrt(mu / r1), v2 = Math.sqrt(mu / r2);
  const vt1 = Math.sqrt(mu * (2 / r1 - 1 / at));
  const vt2 = Math.sqrt(mu * (2 / r2 - 1 / at));
  return { dv1: vt1 - v1, dv2: v2 - vt2, time: Math.PI * Math.sqrt(at * at * at / mu) };
}

// ---------- Integration for powered / atmospheric flight ----------
/**
 * RK4 step for state {x,y,vx,vy,m} with an acceleration function
 * accel(x,y,vx,vy,m,t) -> {ax, ay, mdot}.
 */
export function rk4Step(s, dt, t, accel) {
  const k1 = accel(s.x, s.y, s.vx, s.vy, s.m, t);
  const s2 = { x: s.x + 0.5 * dt * s.vx, y: s.y + 0.5 * dt * s.vy, vx: s.vx + 0.5 * dt * k1.ax, vy: s.vy + 0.5 * dt * k1.ay, m: s.m + 0.5 * dt * k1.mdot };
  const k2 = accel(s2.x, s2.y, s2.vx, s2.vy, s2.m, t + dt / 2);
  const s3 = { x: s.x + 0.5 * dt * s2.vx, y: s.y + 0.5 * dt * s2.vy, vx: s.vx + 0.5 * dt * k2.ax, vy: s.vy + 0.5 * dt * k2.ay, m: s.m + 0.5 * dt * k2.mdot };
  const k3 = accel(s3.x, s3.y, s3.vx, s3.vy, s3.m, t + dt / 2);
  const s4 = { x: s.x + dt * s3.vx, y: s.y + dt * s3.vy, vx: s.vx + dt * k3.ax, vy: s.vy + dt * k3.ay, m: s.m + dt * k3.mdot };
  const k4 = accel(s4.x, s4.y, s4.vx, s4.vy, s4.m, t + dt);
  return {
    x: s.x + (dt / 6) * (s.vx + 2 * s2.vx + 2 * s3.vx + s4.vx),
    y: s.y + (dt / 6) * (s.vy + 2 * s2.vy + 2 * s3.vy + s4.vy),
    vx: s.vx + (dt / 6) * (k1.ax + 2 * k2.ax + 2 * k3.ax + k4.ax),
    vy: s.vy + (dt / 6) * (k1.ay + 2 * k2.ay + 2 * k3.ay + k4.ay),
    m: s.m + (dt / 6) * (k1.mdot + 2 * k2.mdot + 2 * k3.mdot + k4.mdot),
  };
}

export function wrapAngle(a) {
  a = a % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a;
}
export function angleDiff(a, b) { // shortest signed difference a-b
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
