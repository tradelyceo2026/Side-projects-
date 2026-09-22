// Small vector and quaternion helpers on plain arrays. Quaternions are [x, y, z, w].

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

export const qIdentity = () => [0, 0, 0, 1];

export function qMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];

export function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function qAxisAngle(axis, ang) {
  const s = Math.sin(ang / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)];
}

/** Rotate vector v by unit quaternion q. */
export function qRot(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

export const qRotInv = (q, v) => qRot(qConj(q), v);

/** Integrate orientation by angular velocity w (model frame, rad/s) over dt. */
export function qIntegrate(q, w, dt) {
  const a = len(w) * dt;
  if (a < 1e-12) return q;
  return qNorm(qMul(q, qAxisAngle(scale(w, 1 / len(w)), a)));
}

/**
 * Aircraft model frame: +x right wing, +y up, -z nose (Three.js convention).
 * Heading is clockwise from north (-z world), pitch nose-up positive, roll right-wing-down positive.
 */
export function qFromEuler(heading, pitch, roll) {
  const qh = qAxisAngle([0, 1, 0], -heading);
  const qp = qAxisAngle([1, 0, 0], pitch);
  const qr = qAxisAngle([0, 0, 1], -roll);
  return qNorm(qMul(qMul(qh, qp), qr));
}

export function eulerFromQ(q) {
  const fwd = qRot(q, [0, 0, -1]);
  const right = qRot(q, [1, 0, 0]);
  const up = qRot(q, [0, 1, 0]);
  const heading = Math.atan2(fwd[0], -fwd[2]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd[1])));
  // roll: angle of the right wing below the horizon, measured in the plane normal to fwd
  const hRight = norm(cross(fwd, [0, 1, 0]));
  const hUp = cross(hRight, fwd);
  const roll = Math.atan2(-dot(right, hUp), dot(right, hRight));
  return { heading: (heading + 2 * Math.PI) % (2 * Math.PI), pitch, roll, fwd, right, up };
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const DEG = Math.PI / 180;
export const KT = 0.514444;      // m/s per knot
export const FT = 0.3048;        // m per foot
export const FPM = 0.00508;      // m/s per ft/min
