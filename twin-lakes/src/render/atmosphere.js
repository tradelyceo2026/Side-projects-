// Sun position (NOAA solar calculator) and a single-scattering atmosphere (Rayleigh + Mie), in JS for the
// light colours and in GLSL for the sky look-up table the sky dome and the aerial perspective share.

const RAD = Math.PI / 180;

/** Sun direction in the local frame (+x east, +y up, +z south) and its elevation/azimuth, for a UTC Date. */
export function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan(eps * RAD / 2) ** 2;
  const eqTime = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) - 0.5 * y * y * Math.sin(4 * L0 * RAD)
    - 1.25 * e * e * Math.sin(2 * M * RAD));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (minutes + eqTime + 4 * lon + 1440) % 1440;
  const ha = (tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180) * RAD;
  const latR = lat * RAD;
  const cosZ = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const elev = Math.PI / 2 - zen;
  let az = Math.acos(Math.max(-1, Math.min(1, (Math.sin(latR) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(latR) * Math.sin(zen)))));
  az = ha > 0 ? (az + Math.PI) % (2 * Math.PI) : (3 * Math.PI - az) % (2 * Math.PI);
  // az is clockwise from north
  const dir = [Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev)];
  return { dir, elevation: elev, azimuth: az };
}

// ---- scattering constants (metres)
const RE = 6360e3, RA = 6420e3;
const BR = [5.8e-6, 13.5e-6, 33.1e-6];
const BM = 21e-6;
const HR = 7994, HM = 1200;

function raySphere(o, d, r) {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

/** Transmittance of sunlight reaching altitude h (m) from a sun at direction dir (unit, y up). */
export function sunTransmittance(h, dir) {
  const o = [0, RE + h, 0];
  if (dir[1] < -0.2) return [0, 0, 0];
  const len = raySphere(o, dir, RA);
  const n = 16;
  const ds = len / n;
  let odR = 0, odM = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * ds;
    const p = [o[0] + dir[0] * t, o[1] + dir[1] * t, o[2] + dir[2] * t];
    const hh = Math.hypot(p[0], p[1], p[2]) - RE;
    if (hh < 0) return [0, 0, 0];
    odR += Math.exp(-hh / HR) * ds;
    odM += Math.exp(-hh / HM) * ds;
  }
  return BR.map((b) => Math.exp(-(b * odR + BM * 1.1 * odM)));
}

export const ATMOSPHERE_GLSL = /* glsl */`
const float RE = 6360e3;
const float RA = 6420e3;
const vec3 BR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float BM = 21e-6;
const float HR = 7994.0;
const float HM = 1200.0;

float raySphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  return -b + sqrt(disc);
}

// single-scattered sky radiance along dir, seen from altitude h, for a sun of unit intensity
vec3 scatterSky(float h, vec3 dir, vec3 sunDir, float haze) {
  vec3 o = vec3(0.0, RE + h, 0.0);
  float len = raySphere(o, dir, RA);
  // stop at the ground
  float b = dot(o, dir);
  float c = dot(o, o) - RE * RE;
  float disc = b * b - c;
  if (disc > 0.0) { float tg = -b - sqrt(disc); if (tg > 0.0) len = min(len, tg); }
  const int N = 16;
  const int NL = 6;
  float ds = len / float(N);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  float bm = BM * haze;
  for (int i = 0; i < N; i++) {
    vec3 p = o + dir * ds * (float(i) + 0.5);
    float hh = length(p) - RE;
    float dR = exp(-hh / HR) * ds;
    float dM = exp(-hh / HM) * ds;
    odR += dR; odM += dM;
    float ll = raySphere(p, sunDir, RA);
    float dls = ll / float(NL);
    float lR = 0.0, lM = 0.0;
    bool blocked = false;
    for (int j = 0; j < NL; j++) {
      vec3 q = p + sunDir * dls * (float(j) + 0.5);
      float hq = length(q) - RE;
      if (hq < 0.0) { blocked = true; break; }
      lR += exp(-hq / HR) * dls;
      lM += exp(-hq / HM) * dls;
    }
    if (!blocked) {
      vec3 tau = BR * (odR * 0.4 + lR) + bm * 1.1 * (odM * 0.4 + lM);
      vec3 att = exp(-tau);
      sumR += att * dR;
      sumM += att * dM;
    }
  }
  float mu = dot(dir, sunDir);
  float phaseR = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
  float g = 0.76;
  float phaseM = 3.0 / (8.0 * 3.14159265) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  return sumR * BR * phaseR + sumM * bm * phaseM;
}
`;

/** Sky look-up table parametrisation shared by the LUT writer and its readers. */
export const SKYLUT_GLSL = /* glsl */`
vec2 skyLutUv(vec3 d) {
  float az = atan(d.x, -d.z) / 6.2831853 + 0.5;
  float e = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(e) * sqrt(abs(e) / 1.5707963);
  return vec2(az, v);
}
vec3 skyLutDir(vec2 uv) {
  float az = (uv.x - 0.5) * 6.2831853;
  float s = uv.y * 2.0 - 1.0;
  float e = sign(s) * s * s * 1.5707963;
  return vec3(sin(az) * cos(e), sin(e), -cos(az) * cos(e));
}
`;
