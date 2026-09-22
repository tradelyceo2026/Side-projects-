// International Standard Atmosphere (troposphere), with a temperature offset and a sea-level pressure (QNH).

export const G0 = 9.80665;
const R = 287.053;
const L = 0.0065;
const T0 = 288.15;
const P0 = 101325;
export const RHO0 = 1.225;

/**
 * @param {number} h geometric altitude MSL, m
 * @param {{dT?: number, qnh?: number}} wx temperature offset from ISA (K) and sea-level pressure (Pa)
 */
export function atmosphere(h, wx = {}) {
  const dT = wx.dT || 0;
  const qnh = wx.qnh || P0;
  const Tstd = T0 - L * h;
  const p = qnh * Math.pow(Tstd / T0, G0 / (R * L));
  const T = Tstd + dT;
  const rho = p / (R * T);
  const a = Math.sqrt(1.4 * R * T);
  return { T, p, rho, a, sigma: rho / RHO0 };
}

/** Pressure altitude an altimeter set to `setting` Pa shows at static pressure p. */
export function indicatedAltitude(p, setting = P0) {
  return (T0 / L) * (1 - Math.pow(p / setting, (R * L) / G0));
}
