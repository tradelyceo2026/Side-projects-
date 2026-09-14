// Headless mission runner: node scripts/headless.mjs [ascent|moon]
import { createSim, step, summary, logEvent } from '../src/sim.js';
import { createAutopilot, startProgram, autopilotTick, PROGRAMS, predictMoonApproach } from '../src/autopilot.js';

const mode = process.argv[2] || 'ascent';
const sim = createSim();
const ap = createAutopilot();
const FRAME = 1 / 30;
startProgram(ap, sim, PROGRAMS.ASCENT);
let frames = 0;
let lastPrint = -1;
const maxFrames = 400000;
let stageQueue = ['ascent'];
let nextProgram = null;
while (frames < maxFrames) {
  autopilotTick(ap, sim, FRAME);
  step(sim, FRAME);
  frames++;
  if (!ap.program && sim.status === 'flying') {
    if (mode === 'moon' && ap.phase === 'done' && sim.bodyName === 'Earth' && !nextProgram) { nextProgram = 'tli'; startProgram(ap, sim, PROGRAMS.TLI); }
    else if (mode === 'moon' && sim.bodyName === 'Moon' && nextProgram === 'tli') { nextProgram = 'loi'; startProgram(ap, sim, PROGRAMS.LOI); }
    else break;
  }
  if (sim.status !== 'flying') break;
  const s = summary(sim);
  const mark = Math.floor(sim.met / 20);
  if (mark !== lastPrint) {
    lastPrint = mark;
    console.log(`MET ${s.met.toFixed(0).padStart(7)}s ${s.body.padEnd(5)} alt ${(s.alt/1000).toFixed(1).padStart(9)} km  v ${s.speed.toFixed(0).padStart(5)}  vv ${s.vertSpeed.toFixed(0).padStart(5)}  apo ${(s.apoAlt/1000).toFixed(0).padStart(8)}  peri ${(s.periAlt/1000).toFixed(0).padStart(8)}  stg ${s.stageIndex} prop ${(s.prop/1000).toFixed(1).padStart(6)}t thr ${sim.throttle.toFixed(1)} warp ${s.warp.toString().padStart(6)} rails ${s.onRails?1:0} | ${ap.phase} ${ap.info}`);
  }
}
console.log('--- LOG ---');
for (const e of sim.log) console.log(`T+${e.t.toFixed(0)}s ${e.text}`);
console.log(JSON.stringify(summary(sim), (k, v) => typeof v === 'number' ? +v.toFixed(2) : v));
