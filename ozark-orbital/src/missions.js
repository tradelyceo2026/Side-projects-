// Ozark Orbital — mission definitions and completion checks.
import { MOON, EARTH } from './physics.js';
import { summary } from './sim.js';

export const MISSIONS = [
  {
    id: 'karman', title: '1 · Kármán Line', goal: 'Climb above 100 km altitude.',
    hint: 'Full throttle (Z), keep SAS on UP (2). Stage with SPACE when the booster runs dry. Or press the ASCENT autopilot and watch how it is done.',
    check: (s) => s.body === 'Earth' && s.alt > 100000,
  },
  {
    id: 'orbit', title: '2 · Ozark Orbit', goal: 'Reach Earth orbit: periapsis above 150 km.',
    hint: 'Pitch east gradually as you climb (right arrow). Cut the engine when apoapsis reads ~200 km, coast to Ap, then burn PROGRADE (3) until periapsis rises above 150 km.',
    check: (s) => s.body === 'Earth' && s.periAlt > 150000 && s.status === 'flying',
  },
  {
    id: 'circular', title: '3 · Perfect Circle', goal: 'Circular Earth orbit: periapsis above 180 km, eccentricity below 0.01.',
    hint: 'Fine-tune at apoapsis with short prograde/retrograde pulses. The ASCENT autopilot targets a 200 km circular orbit.',
    check: (s) => s.body === 'Earth' && s.periAlt > 180000 && s.e < 0.01 && s.status === 'flying',
  },
  {
    id: 'moonshot', title: '4 · Moonshot', goal: "Enter the Moon's sphere of influence.",
    hint: 'From a low circular orbit, wait until the Moon is ~115° ahead of you, then burn prograde until apoapsis reaches ~400,000 km. Warp and watch the encounter marker. The TLI autopilot computes the window for you.',
    check: (s) => s.body === 'Moon',
  },
  {
    id: 'lunarorbit', title: '5 · Lunar Orbit', goal: 'Capture into orbit around the Moon (periapsis above 20 km, apoapsis below 1,500 km).',
    hint: 'Inside the Moon SOI, warp to periapsis, then burn RETROGRADE (4) until the orbit closes and apoapsis drops. The LOI autopilot also corrects a bad periapsis first.',
    check: (s) => s.body === 'Moon' && s.e < 1 && s.periAlt > 20000 && s.apoAlt < 1500000 && s.status === 'flying',
  },
];

export function loadProgress() {
  try { return JSON.parse(localStorage.getItem('ozark-orbital-progress') || '{}'); } catch { return {}; }
}
export function saveProgress(p) {
  try { localStorage.setItem('ozark-orbital-progress', JSON.stringify(p)); } catch { /* ignore */ }
}

/** Returns the list of newly completed mission ids this tick. */
export function checkMissions(sim, done) {
  const s = summary(sim);
  const newly = [];
  for (const m of MISSIONS) {
    if (done[m.id]) continue;
    if (m.check(s)) { done[m.id] = { met: s.met }; newly.push(m.id); }
  }
  return newly;
}
