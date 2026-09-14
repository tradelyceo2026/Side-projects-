// Ozark Orbital — game shell: loop, input, HUD, missions.
import { EARTH, MOON } from './physics.js';
import { createSim, step, summary, launch, doStage, logEvent, body, altitude } from './sim.js';
import { createAutopilot, startProgram, stopAutopilot, autopilotTick, PROGRAMS, moonPhaseAngle, requiredLeadAngle, predictMoonApproach } from './autopilot.js';
import { createCamera, updateCamera, render, fitZoom } from './render.js';
import { MISSIONS, loadProgress, saveProgress, checkMissions } from './missions.js';
import { stagesLeft } from './vehicle.js';

const WARPS = [1, 2, 5, 10, 50, 100, 1000, 10000, 100000];

function fmtTime(s) {
  if (!isFinite(s)) return '—';
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function fmtKm(m) { if (!isFinite(m)) return '∞'; const k = m / 1000; return k >= 10000 ? `${(k / 1000).toFixed(1)}k km` : `${k.toFixed(k < 100 ? 1 : 0)} km`; }

export function init() {
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const state = {
    sim: createSim(),
    ap: createAutopilot(),
    cam: createCamera(),
    ui: { trail: [], approach: null, toast: [], paused: false },
    keys: {},
    mission: MISSIONS[0],
    done: loadProgress(),
    completedThisFlight: {},
    lastHud: 0,
    lastApproach: 0,
  };
  window.ozark = state; // for curious people in the console

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  }
  window.addEventListener('resize', resize); resize();

  function toast(text, ms = 3500) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
  }

  function newFlight() {
    state.sim = createSim();
    state.ap = createAutopilot();
    state.cam = createCamera();
    state.ui.trail = []; state.ui.approach = null;
    state.completedThisFlight = {};
    $('overlay').hidden = true;
    state.ui.paused = false;
  }

  // ---------- controls ----------
  function setWarp(dir) {
    const s = state.sim;
    let i = WARPS.indexOf(s.warp); if (i < 0) i = 0;
    i = Math.max(0, Math.min(WARPS.length - 1, i + dir));
    s.warp = WARPS[i];
    toast(`Time warp ${s.warp}×`, 1200);
  }
  function setThrottle(v) { state.sim.throttle = Math.max(0, Math.min(1, v)); }
  function setSas(mode) { state.sim.sas = mode; if (mode === 'manual') state.sim.headingCmd = state.sim.heading; updateSasButtons(); }
  function updateSasButtons() { for (const b of document.querySelectorAll('[data-sas]')) b.classList.toggle('on', b.dataset.sas === state.sim.sas); }
  function stageOrLaunch() {
    const s = state.sim;
    if (s.status === 'pad') { launch(s); toast('Liftoff!'); }
    else if (s.status === 'flying') { if (doStage(s)) toast('Stage separation'); else toast('No stages left', 1500); }
  }
  function autopilot(program) {
    const s = state.sim, ap = state.ap;
    if (!program) { stopAutopilot(ap, s); toast('Autopilot off', 1500); return; }
    if (program === PROGRAMS.TLI && s.bodyName !== 'Earth') { toast('TLI only works from Earth orbit', 2500); return; }
    if (program === PROGRAMS.LOI && s.bodyName !== 'Moon') { toast("LOI needs to be inside the Moon's sphere of influence", 2500); return; }
    if (program === PROGRAMS.ASCENT && s.status !== 'pad' && altitude(s) > 150000) { toast('ASCENT is for launch; you are already up here', 2500); return; }
    startProgram(ap, s, program);
    toast(`Autopilot: ${program.toUpperCase()}`);
  }
  function setCamMode(mode) { state.cam.mode = mode; for (const b of document.querySelectorAll('[data-cam]')) b.classList.toggle('on', b.dataset.cam === mode); }

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    state.keys[e.code] = true;
    const s = state.sim;
    switch (e.code) {
      case 'Space': e.preventDefault(); stageOrLaunch(); break;
      case 'KeyZ': setThrottle(1); break;
      case 'KeyX': setThrottle(0); break;
      case 'Digit1': setSas('manual'); break;
      case 'Digit2': setSas('up'); break;
      case 'Digit3': setSas('prograde'); break;
      case 'Digit4': setSas('retrograde'); break;
      case 'Comma': setWarp(-1); break;
      case 'Period': setWarp(1); break;
      case 'KeyM': setCamMode(state.cam.mode === 'map' ? 'auto' : 'map'); break;
      case 'KeyF': setCamMode('auto'); break;
      case 'KeyP': state.ui.paused = !state.ui.paused; toast(state.ui.paused ? 'Paused' : 'Resumed', 1000); break;
      case 'KeyA': case 'KeyT': autopilot(s.status === 'pad' || altitude(s) < 150000 ? PROGRAMS.ASCENT : (s.bodyName === 'Moon' ? PROGRAMS.LOI : PROGRAMS.TLI)); break;
      case 'Escape': stopAutopilot(state.ap, s); break;
      case 'Equal': case 'NumpadAdd': setCamMode('manual'); state.cam.targetZoom *= 1.6; break;
      case 'Minus': case 'NumpadSubtract': setCamMode('manual'); state.cam.targetZoom /= 1.6; break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': e.preventDefault(); break;
    }
  });
  window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setCamMode('manual');
    state.cam.targetZoom *= Math.pow(1.15, -Math.sign(e.deltaY));
    state.cam.targetZoom = Math.max(1e-7, Math.min(20, state.cam.targetZoom));
  }, { passive: false });

  // on-screen buttons
  document.querySelectorAll('[data-action]').forEach((btn) => {
    const act = btn.dataset.action;
    const hold = (code) => {
      const down = (e) => { e.preventDefault(); state.keys[code] = true; btn.classList.add('on'); };
      const up = () => { state.keys[code] = false; btn.classList.remove('on'); };
      btn.addEventListener('pointerdown', down); btn.addEventListener('pointerup', up); btn.addEventListener('pointerleave', up); btn.addEventListener('pointercancel', up);
    };
    if (act === 'left') return hold('ArrowLeft');
    if (act === 'right') return hold('ArrowRight');
    if (act === 'thr-up') return hold('ShiftLeft');
    if (act === 'thr-down') return hold('ControlLeft');
    btn.addEventListener('click', () => {
      switch (act) {
        case 'stage': stageOrLaunch(); break;
        case 'full': setThrottle(1); break;
        case 'cut': setThrottle(0); break;
        case 'warp-': setWarp(-1); break;
        case 'warp+': setWarp(1); break;
        case 'ap-ascent': autopilot(PROGRAMS.ASCENT); break;
        case 'ap-tli': autopilot(PROGRAMS.TLI); break;
        case 'ap-loi': autopilot(PROGRAMS.LOI); break;
        case 'ap-off': autopilot(null); break;
        case 'new': showMissionSelect(); break;
        case 'zoom-in': setCamMode('manual'); state.cam.targetZoom *= 1.6; break;
        case 'zoom-out': setCamMode('manual'); state.cam.targetZoom /= 1.6; break;
        case 'help': $('help').hidden = !$('help').hidden; break;
      }
    });
  });
  document.querySelectorAll('[data-sas]').forEach((b) => b.addEventListener('click', () => setSas(b.dataset.sas)));
  document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => setCamMode(b.dataset.cam)));
  updateSasButtons(); setCamMode('auto');

  // ---------- mission select ----------
  function showMissionSelect() {
    const ov = $('overlay');
    ov.hidden = false;
    state.ui.paused = true;
    const list = MISSIONS.map((m) => `
      <button class="mission ${state.done[m.id] ? 'done' : ''}" data-mission="${m.id}">
        <div class="mt">${m.title} ${state.done[m.id] ? '<span class="badge">✓ ' + fmtTime(state.done[m.id].met) + '</span>' : ''}</div>
        <div class="mg">${m.goal}</div>
      </button>`).join('');
    ov.innerHTML = `
      <div class="card">
        <h1>Ozark Orbital</h1>
        <p class="sub">A real-physics rocket and orbital mechanics game. Launch a Falcon-class rocket from the Ozarks, reach orbit, and fly to the Moon. Real gravity, real drag, real rocket equation. Every number on the HUD is honest.</p>
        <div class="missions">${list}</div>
        <p class="tiny">Progress is saved in this browser. Press <b>?</b> in flight for controls.</p>
      </div>`;
    ov.querySelectorAll('[data-mission]').forEach((b) => b.addEventListener('click', () => {
      state.mission = MISSIONS.find((m) => m.id === b.dataset.mission);
      newFlight();
      toast(`${state.mission.title}: ${state.mission.goal}`, 5000);
    }));
  }

  function showComplete(m) {
    const ov = $('overlay');
    ov.hidden = false;
    const next = MISSIONS[MISSIONS.indexOf(m) + 1];
    const s = summary(state.sim);
    ov.innerHTML = `
      <div class="card">
        <h1>Mission complete</h1>
        <h2>${m.title}</h2>
        <p class="sub">${m.goal}</p>
        <div class="stats">
          <div><span>MET</span><b>${fmtTime(s.met)}</b></div>
          <div><span>Orbit</span><b>${fmtKm(s.periAlt)} × ${fmtKm(s.apoAlt)}</b></div>
          <div><span>Δv left</span><b>${s.dv.toFixed(0)} m/s</b></div>
          <div><span>Max-Q</span><b>${(state.sim.maxQ / 1000).toFixed(1)} kPa</b></div>
        </div>
        <div class="row">
          <button data-continue>Keep flying</button>
          ${next ? `<button data-next class="primary">Next: ${next.title}</button>` : '<button data-menu class="primary">Mission list</button>'}
        </div>
      </div>`;
    ov.querySelector('[data-continue]').addEventListener('click', () => { ov.hidden = true; state.ui.paused = false; });
    const n = ov.querySelector('[data-next]'); if (n) n.addEventListener('click', () => { state.mission = next; ov.hidden = true; state.ui.paused = false; toast(`${next.title}: ${next.goal}`, 5000); });
    const mm = ov.querySelector('[data-menu]'); if (mm) mm.addEventListener('click', showMissionSelect);
  }

  function showEnd(title, text) {
    const ov = $('overlay');
    ov.hidden = false;
    ov.innerHTML = `<div class="card"><h1>${title}</h1><p class="sub">${text}</p><div class="row"><button data-menu class="primary">Back to the pad</button></div></div>`;
    ov.querySelector('[data-menu]').addEventListener('click', showMissionSelect);
  }

  // ---------- HUD ----------
  function hud() {
    const s = state.sim, ap = state.ap;
    const sum = summary(s);
    const b = body(s);
    $('t-met').textContent = fmtTime(sum.met);
    $('t-body').textContent = sum.body;
    const onPad = s.status === 'pad' || (sum.alt < 2000 && sum.apoAlt < 5000);
    $('t-alt').textContent = fmtKm(Math.max(0, sum.alt));
    $('t-speed').textContent = `${sum.speed.toFixed(0)} m/s`;
    $('t-vspeed').textContent = `${sum.vertSpeed.toFixed(0)} m/s`;
    $('t-apo').textContent = onPad ? '—' : fmtKm(sum.apoAlt);
    $('t-peri').textContent = onPad ? '—' : fmtKm(sum.periAlt);
    $('t-tapo').textContent = onPad ? '—' : fmtTime(sum.tApo);
    $('t-tperi').textContent = onPad ? '—' : fmtTime(sum.tPeri);
    $('t-dv').textContent = `${sum.dv.toFixed(0)} m/s`;
    $('t-warp').textContent = `${sum.warp}× ${sum.onRails ? '(rails)' : ''}`;
    $('t-stage').textContent = sum.stage ? `${sum.stage.name} · ${stagesLeft(s.vehicle)} left` : '—';
    $('t-prop').style.width = `${sum.stage ? (100 * sum.prop / sum.stage.prop) : 0}%`;
    $('t-thr').style.width = `${s.throttle * 100}%`;
    $('t-thrv').textContent = `${(s.throttle * 100).toFixed(0)}%`;
    $('t-e').textContent = onPad ? '—' : sum.e.toFixed(3);
    $('t-q').textContent = `${(s.maxQ / 1000).toFixed(1)} kPa`;
    let extra = '';
    if (s.bodyName === 'Earth' && sum.periAlt > 100000 && sum.e < 0.2) {
      extra = `Moon phase angle ${(moonPhaseAngle(s) * 180 / Math.PI).toFixed(1)}° · ideal TLI lead ${(requiredLeadAngle(s) * 180 / Math.PI).toFixed(1)}°`;
    } else if (s.bodyName === 'Earth' && sum.apoAlt > MOON.orbitRadius * 0.5 && state.ui.approach) {
      extra = `Closest lunar approach ${fmtKm(state.ui.approach.dist)} in ${fmtTime(state.ui.approach.t)}`;
    }
    $('t-extra').textContent = extra;
    $('ap-status').textContent = ap.program ? `AUTOPILOT ${ap.program.toUpperCase()} · ${ap.info || ap.phase}` : (ap.info || 'Autopilot off');
    $('ap-status').classList.toggle('active', !!ap.program);
    $('m-title').textContent = state.mission.title;
    $('m-goal').textContent = state.mission.goal;
    $('m-hint').textContent = state.mission.hint;
    $('m-done').textContent = state.done[state.mission.id] ? '✓ completed' : '';
    const log = s.log.slice(-6).map((e) => `<div><span>T+${fmtTime(e.t)}</span>${e.text}</div>`).join('');
    $('log').innerHTML = log;
    $('b-stage').textContent = s.status === 'pad' ? 'LAUNCH' : 'STAGE';
  }

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    let dt = Math.min(0.05, (now - last) / 1000); last = now;
    const s = state.sim, ap = state.ap, k = state.keys;
    if (!state.ui.paused) {
      // manual inputs
      if (k.ArrowLeft || k.ArrowRight) {
        if (s.sas !== 'manual') { s.sas = 'manual'; s.headingCmd = s.heading; updateSasButtons(); }
        if (ap.program) stopAutopilot(ap, s);
        s.headingCmd += (k.ArrowLeft ? 1 : -1) * 1.2 * dt;
      }
      if (k.ShiftLeft || k.ShiftRight) s.throttle = Math.min(1, s.throttle + 0.8 * dt);
      if (k.ControlLeft || k.ControlRight) s.throttle = Math.max(0, s.throttle - 0.8 * dt);
      autopilotTick(ap, s, dt);
      step(s, dt);
      // trail
      const tr = state.ui.trail;
      const lastP = tr[tr.length - 1];
      if (s.status === 'flying' && (!lastP || lastP.body !== s.bodyName || Math.hypot(lastP.x - s.ship.x, lastP.y - s.ship.y) * state.cam.zoom > 3)) {
        tr.push({ x: s.ship.x, y: s.ship.y, body: s.bodyName });
        if (tr.length > 1500) tr.shift();
      }
      // lunar approach prediction (cheap enough at 2 Hz)
      if (s.bodyName === 'Earth' && now - state.lastApproach > 500) {
        state.lastApproach = now;
        const sum = summary(s);
        state.ui.approach = sum.apoAlt > MOON.orbitRadius * 0.5 && s.throttle === 0 ? predictMoonApproach(s) : null;
      }
      // missions
      const newly = checkMissions(s, state.completedThisFlight);
      for (const id of newly) {
        const m = MISSIONS.find((x) => x.id === id);
        if (!state.done[id]) { state.done[id] = { met: s.met }; saveProgress(state.done); }
        if (m === state.mission) { showComplete(m); state.ui.paused = true; }
        else toast(`Bonus: ${m.title} achieved`, 3000);
      }
      if (s.status === 'crashed' && !state.ui.ended) { state.ui.ended = true; showEnd('Rapid unscheduled disassembly', s.log[s.log.length - 1].text + '. Every failure is data. Try again.'); }
      if (s.status === 'landed' && !state.ui.ended) { state.ui.ended = true; showEnd('Touchdown', 'The vehicle came back down in one piece. Nice.'); }
      if (s.status === 'flying') state.ui.ended = false;
    }
    updateCamera(state.cam, s, canvas, dt);
    render(ctx, canvas, s, state.cam, state.ui);
    if (now - state.lastHud > 100) { state.lastHud = now; hud(); }
    requestAnimationFrame(frame);
  }
  showMissionSelect();
  requestAnimationFrame(frame);
}

init();
