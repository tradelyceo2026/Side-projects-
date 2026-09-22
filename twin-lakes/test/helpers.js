import { Aircraft, defaultControls } from '../src/fdm/aircraft.js';
import { Autopilot } from '../src/fdm/autopilot.js';

export const flat = (h = 0) => ({ ground: () => ({ h, n: [0, 1, 0], water: false, waterH: -1e9 }), wx: {} });

/** Fly with the autopilot for `seconds`; returns the aircraft. */
export function flyAp({ alt, tas = 55, throttle = 1, lateral = 'HDG', vertical = 'ALT', ias, flaps = 0, seconds = 120, mass, env = flat() }) {
  const a = new Aircraft();
  a.placeInFlight([0, alt, 0], 0, tas, 0);
  if (mass) a.payload = mass - a.d.emptyMass - a.fuel;
  const c = defaultControls();
  c.throttle = throttle; c.flaps = flaps;
  const ap = new Autopilot();
  ap.lateral = lateral;
  a.step(0.01, c, env);
  ap.engage({ ...a.out, alt });
  ap.setVertical(vertical, a.out);
  if (ias) ap.target.ias = ias;
  const trace = [];
  for (let i = 0; i < seconds * 30; i++) {
    ap.update(1 / 30, a.out, a.pos, c);
    a.step(1 / 30, c, env);
    trace.push({ ...a.out, y: a.pos[1] });
  }
  return { a, ap, trace };
}
