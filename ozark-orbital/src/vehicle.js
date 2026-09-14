// Ozark Orbital — launch vehicle definitions and staging.
import { G0, atmPressure } from './physics.js';

// A Falcon-9-class two-stage booster plus a storable-propellant kick stage
// carrying the "Ozark-1" lunar probe. Numbers are public-domain approximations.
export const OZARK_1 = {
  name: 'Ozark-1',
  dragArea: 4.2,            // Cd * A (m^2)
  stages: [
    { name: 'Booster (S1)',   dry: 25600, prop: 395700, thrustSl: 7607000, thrustVac: 8227000, ispVac: 311, length: 42, width: 3.7 },
    { name: 'Upper stage (S2)', dry: 3900, prop: 92670, thrustSl: 500000, thrustVac: 934000, ispVac: 348, length: 14, width: 3.7 },
    { name: 'Kick stage + probe', dry: 1200, prop: 3800, thrustSl: 30000, thrustVac: 60000, ispVac: 320, length: 6, width: 2.4 },
  ],
};

export function createVehicle(def = OZARK_1) {
  return {
    def,
    stageIndex: 0,
    prop: def.stages.map(s => s.prop),
    events: [],
  };
}

export function stage(v) { return v.def.stages[v.stageIndex] || null; }
export function stagesLeft(v) { return v.def.stages.length - v.stageIndex; }
export function totalMass(v) {
  let m = 0;
  for (let i = v.stageIndex; i < v.def.stages.length; i++) m += v.def.stages[i].dry + v.prop[i];
  return m;
}
export function propFraction(v) {
  const s = stage(v);
  return s ? v.prop[v.stageIndex] / s.prop : 0;
}
export function massFlow(s) { return s.thrustVac / (s.ispVac * G0); }
export function thrustAt(s, body, alt) {
  const p = atmPressure(body, alt);
  const p0 = body.atmosphere ? body.atmosphere.p0 : 1;
  return s.thrustVac - (s.thrustVac - s.thrustSl) * (p / p0);
}
export function vehicleLength(v) {
  let L = 0;
  for (let i = v.stageIndex; i < v.def.stages.length; i++) L += v.def.stages[i].length;
  return L;
}
/** Sum of ideal vacuum delta-v across remaining stages. */
export function deltaVRemaining(v) {
  let dv = 0;
  let mAbove = 0;
  for (let i = v.def.stages.length - 1; i >= v.stageIndex; i--) {
    const s = v.def.stages[i];
    const m1 = mAbove + s.dry;
    const m0 = m1 + v.prop[i];
    dv += s.ispVac * G0 * Math.log(m0 / m1);
    mAbove = m0;
  }
  return dv;
}
/** Jettison current stage. Returns true if staged. */
export function separate(v) {
  if (v.stageIndex >= v.def.stages.length - 1) return false;
  v.stageIndex++;
  return true;
}
