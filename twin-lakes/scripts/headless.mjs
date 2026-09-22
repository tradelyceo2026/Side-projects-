// Fly the demo circuit in Node against the real terrain and print a flight log.
//   node scripts/headless.mjs [route] [--wind=dir/kt]
// route: dams (default: KBPK 23 -> Bull Shoals Dam -> Norfork Dam -> KBPK 23) or pattern.

import { Aircraft, defaultControls } from '../src/fdm/aircraft.js';
import { DemoPilot } from '../src/fdm/pilot.js';
import { loadTerrain } from '../src/world/load-node.js';
import { runwayEnd, runwayFrame } from '../src/world/terrain.js';
import { KT, FT, DEG } from '../src/fdm/math.js';

export function flyCircuit({ route = 'dams', windDir = 0, windKt = 0, verbose = true, terrain = null } = {}) {
  const T = terrain || loadTerrain();
  const rw = T.runway('KBPK');
  const dep = runwayEnd(rw, 'a');       // runway 23 (the 'a' end is the north-east threshold)
  const arr = runwayEnd(rw, 'a');
  const dam = (n) => T.world.dams.find((d) => d.name === n);
  const routes = {
    dams: [
      { name: 'Bull Shoals Dam', ...dam('Bull Shoals Dam') },
      { name: 'Cotter bridge', x: -6000, z: 11500 },
      { name: 'Norfork Dam', ...dam('Norfork Dam') },
      { name: 'Mountain Home', x: 8000, z: 3600 },
    ],
    pattern: [
      { name: 'crosswind', x: dep.far[0] + Math.cos(dep.course) * 1500 - Math.sin(dep.course) * -1500, z: dep.far[1] + Math.sin(dep.course) * 1500 + Math.cos(dep.course) * -1500 },
    ],
  };
  const a = new Aircraft();
  const sx = dep.x + Math.sin(dep.course) * 20, sz = dep.z - Math.cos(dep.course) * 20;
  a.placeOnGround(sx, sz, dep.course, T.height(sx, sz));
  const pilot = new DemoPilot({ depart: dep, arrive: arr, route: routes[route], cruiseAlt: 3000 * FT });
  // wind blowing FROM windDir (deg true)
  const wr = windDir * DEG;
  const wv = [-Math.sin(wr) * windKt * KT, 0, Math.cos(wr) * windKt * KT];
  const env = {
    ground: (x, z) => T.ground(x, z),
    wind: (p) => { const agl = Math.max(1, p[1] - T.height(p[0], p[2])); const f = Math.min(1, Math.log(agl / 0.1) / Math.log(300 / 0.1)); return [wv[0] * f, 0, wv[2] * f]; },
    wx: {},
  };
  const c = defaultControls();
  const dt = 1 / 30;
  let t = 0;
  let maxAlt = 0;
  let touchdown = null;
  const timeline = [];
  let lastPhase = null;
  while (t < 3 * 3600 && !a.crashed && pilot.phase !== 'stopped') {
    pilot.update(dt, a, c, T);
    a.step(dt, c, env);
    if (!Number.isFinite(a.pos[1])) { a.crashed = 'numerical failure (NaN)'; break; }
    t += dt;
    maxAlt = Math.max(maxAlt, a.pos[1]);
    if (!touchdown) touchdown = a.events.find((e) => e.type === 'touchdown' && pilot.phase !== 'climb');
    if (pilot.phase !== lastPhase) { lastPhase = pilot.phase; }
    if (process.env.TRACE && Math.round(t / dt) % Math.round(20 / dt) === 0) {
      const o = a.out;
      console.log(`t ${t.toFixed(0)} ${pilot.phase} wp ${pilot.wp} pos ${a.pos.map((v) => v.toFixed(0))} ias ${(o.ias / KT).toFixed(0)} hdg ${(o.heading / DEG).toFixed(0)} vs ${o.vs.toFixed(1)} thr ${c.throttle.toFixed(2)} fl ${c.flaps} ap ${pilot.ap.lateral}/${pilot.ap.vertical}`);
    }
  }
  for (const l of pilot.log) timeline.push(l);
  const f = runwayFrame(arr, a.pos[0], a.pos[2]);
  const tdFrame = touchdown ? runwayFrame(arr, touchdown.pos[0], touchdown.pos[2]) : null;
  const res = {
    ok: !a.crashed && pilot.phase === 'stopped', crashed: a.crashed, phase: pilot.phase, time: t,
    maxAltFt: maxAlt / FT, fuelUsedGal: (0.75 * 144 - a.fuel) / 0.72 / 3.785,
    touchdown: touchdown && { vsFpm: touchdown.vs / 0.00508, iasKt: touchdown.ias / KT, pitchDeg: touchdown.pitch / DEG,
      alongM: tdFrame.along, crossM: tdFrame.cross },
    stop: { alongM: f.along, crossM: f.cross }, timeline, events: a.events,
  };
  if (verbose) {
    const mmss = (s) => { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
    console.log(`\nKBPK runway ${dep.ident} -> ${routes[route].map((w) => w.name).join(' -> ')} -> runway ${arr.ident}` +
      (windKt ? `, wind ${windDir}° at ${windKt} kt` : ', calm'));
    console.log('\n| Time | Event | Alt ft | KIAS |\n|---|---|---|---|');
    const liftoff = a.events.find((e) => e.type === 'liftoff');
    if (liftoff) console.log(`| ${mmss(liftoff.time)} | Liftoff, ${Math.round(runwayFrame(dep, liftoff.pos[0], liftoff.pos[2]).along / FT)} ft down the runway | ${Math.round(liftoff.pos[1] / FT)} | ${Math.round(liftoff.ias / KT)} |`);
    for (const l of timeline) console.log(`| ${mmss(l.t)} | ${l.note || l.phase} | ${Math.round(l.alt / FT)} | ${Math.round(l.ias / KT)} |`);
    if (res.touchdown) console.log(`\nTouchdown ${res.touchdown.vsFpm.toFixed(0)} fpm at ${res.touchdown.iasKt.toFixed(0)} KIAS, ${res.touchdown.alongM.toFixed(0)} m past the threshold, ${res.touchdown.crossM.toFixed(1)} m off centreline`);
    console.log(`Stopped ${res.stop.alongM.toFixed(0)} m down runway ${arr.ident}, ${res.stop.crossM.toFixed(1)} m off centreline. Flight time ${mmss(t)}, fuel used ${res.fuelUsedGal.toFixed(1)} gal.`);
    console.log(res.ok ? 'RESULT: complete' : `RESULT: FAILED (${a.crashed || pilot.phase})`);
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const route = process.argv.find((s) => ['dams', 'pattern'].includes(s)) || 'dams';
  const w = process.argv.find((s) => s.startsWith('--wind='));
  const [wd, wk] = w ? w.slice(7).split('/').map(Number) : [0, 0];
  const r = flyCircuit({ route, windDir: wd, windKt: wk });
  process.exit(r.ok ? 0 : 1);
}
