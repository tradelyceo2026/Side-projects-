// Twin Lakes: a real-terrain Cessna 172 simulator over the Twin Lakes of north Arkansas.

import * as THREE from '../vendor/three.module.js';
import { loadWorld } from './render/assets.js';
import { TerrainRenderer } from './render/terrain-mesh.js';
import { Sky, makeSharedUniforms } from './render/sky.js';
import { sunPosition } from './render/atmosphere.js';
import { AircraftModel } from './render/aircraft-model.js';
import { buildBuildings, makeLightsTexture, buildRunways, buildLights, buildForest, buildWindsock } from './render/scenery.js';
import { CameraRig } from './render/cameras.js';
import { PFD } from './ui/pfd.js';
import { MovingMap } from './ui/map.js';
import { Sound } from './audio/sound.js';
import { Input, KEYS } from './input.js';
import { Sim, SCENARIOS, WEATHER_PRESETS } from './sim.js';
import { DEG, KT, FT } from './fdm/math.js';
import { bearing } from './fdm/autopilot.js';

const $ = (s) => document.querySelector(s);
const TZ = 'America/Chicago';

// ------------------------------------------------------------------ time of day
function chicagoOffsetHours(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - d.getTime()) / 3600000);
}
function localToday(hours) {
  const now = new Date();
  const off = chicagoOffsetHours(now);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, 0, 0, 0) + (hours - off) * 3600000);
}
function sunsetToday(lat, lon) {
  const start = localToday(12);
  let prev = sunPosition(start, lat, lon).elevation;
  for (let m = 1; m < 12 * 60; m++) {
    const d = new Date(start.getTime() + m * 60000);
    const e = sunPosition(d, lat, lon).elevation;
    if (prev > 0 && e <= 0) return d;
    prev = e;
  }
  return localToday(19.5);
}
function timeFor(choice, lat, lon) {
  const ss = sunsetToday(lat, lon);
  switch (choice) {
    case 'morning': return localToday(9.25);
    case 'noon': return localToday(13);
    case 'golden': return new Date(ss.getTime() - 24 * 60000);
    case 'dusk': return new Date(ss.getTime() + 18 * 60000);
    case 'night': return new Date(ss.getTime() + 90 * 60000);
    case 'now': default: {
      const now = new Date();
      return sunPosition(now, lat, lon).elevation > 4 * DEG ? now : localToday(10);
    }
  }
}
const fmtTime = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);

// ------------------------------------------------------------------ live weather
async function liveWeather() {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=36.3691&longitude=-92.4694'
    + '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,cloud_cover_low,pressure_msl,visibility&wind_speed_unit=kn';
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const j = await r.json();
    const c = j.current;
    return {
      label: `Live at KBPK: wind ${Math.round(c.wind_direction_10m)}° ${Math.round(c.wind_speed_10m)} kt, ${Math.round(c.temperature_2m)}°C`,
      windDir: c.wind_direction_10m, windKt: c.wind_speed_10m, gustKt: Math.max(0, (c.wind_gusts_10m || 0) - c.wind_speed_10m),
      turb: Math.min(1, 0.2 + c.wind_speed_10m / 25), cloud: Math.min(0.85, (c.cloud_cover_low ?? c.cloud_cover) / 100 * 0.9),
      cloudBaseFt: 3500, visSm: Math.min(30, (c.visibility || 16000) / 1609), tempC: c.temperature_2m, qnhHpa: c.pressure_msl, live: true,
    };
  } catch {
    return null;
  } finally { clearTimeout(to); }
}

// ------------------------------------------------------------------ app
class App {
  async boot() {
    const bar = $('#loadBar'), msg = $('#loadMsg');
    let assets;
    try {
      assets = await loadWorld((m, f) => { bar.style.width = `${Math.round(f * 100)}%`; msg.textContent = `Loading ${m}…`; });
    } catch (e) {
      msg.textContent = `Could not load the world data: ${e.message}`;
      throw e;
    }
    this.assets = assets;
    this.T = assets.terrain;
    msg.textContent = 'Building the scene…';
    await new Promise((r) => setTimeout(r, 20));
    this._setupRenderer();
    this._setupScene();
    this.sim = new Sim(this.T);
    this.input = new Input(this.canvas);
    this.input.onKey = (k, e) => this._key(k, e);
    this.sound = new Sound();
    if (matchMedia('(pointer: coarse)').matches) this.input.mountTouch(document.body);
    this.settings = { scenario: 'takeoff', time: 'now', weather: 'live', coordination: true, attitudeHold: true, quality: 'high' };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem('twinlakes.settings') || '{}')); } catch { /* private mode */ }
    this.paused = false;
    this.inMenu = true;
    this.liveWx = null;
    liveWeather().then((w) => { this.liveWx = w; this._renderMenu(); });
    // title screen: the demo flight in the background with cinematic cameras
    this._applyEnvironment('golden', 'fair');
    this.sim.load('demo');
    this.rig.set('cine');
    $('#loading').classList.add('hidden');
    this._renderMenu();
    $('#menu').classList.remove('hidden');
    this.last = performance.now();
    this.fpsAvg = 60;
    requestAnimationFrame((t) => this._frame(t));
    window.__twinlakes = this;   // for the browser test harness
  }

  _setupRenderer() {
    const canvas = $('#view');
    this.canvas = canvas;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.low = new URLSearchParams(location.search).get('q') === 'low';
    r.setPixelRatio(this.low ? 0.5 : Math.min(window.devicePixelRatio || 1, 1.5));
    r.setSize(innerWidth, innerHeight, false);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 400000);
    addEventListener('resize', () => {
      r.setSize(innerWidth, innerHeight, false);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  _setupScene() {
    const scene = new THREE.Scene();
    this.scene = scene;
    const shared = makeSharedUniforms();
    this.shared = shared;
    this.sky = new Sky(this.renderer, shared);
    scene.add(this.sky.dome);
    this.terrainR = new TerrainRenderer(this.assets, this.renderer, shared);
    scene.add(this.terrainR.group);
    const b = buildBuildings(this.assets);
    scene.add(b.mesh);
    const lights = makeLightsTexture(this.assets, b.list);
    shared.tLights.value = lights.texture;
    shared.uLightsRect.value.copy(lights.rect);
    scene.add(buildRunways(this.assets, shared));
    this.lightPoints = buildLights(this.assets, shared);
    scene.add(this.lightPoints);
    this.forest = buildForest(this.terrainR.worldUniforms, shared);
    if (!this.low) scene.add(this.forest);
    this.windsock = buildWindsock(this.assets);
    scene.add(this.windsock);
    scene.add(this.sky.clouds);
    // lights for the standard materials (aircraft, buildings)
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.hemi = new THREE.HemisphereLight(0x9fc3ff, 0x4a4a3a, 0.8);
    scene.add(this.sunLight, this.sunLight.target, this.hemi);
    // aircraft
    this.pfd = new PFD(1280, 400);
    this.map = new MovingMap(this.assets, 480, 400);
    this.model = new AircraftModel(this.pfd.canvas);
    scene.add(this.model.root);
    // gates for the dam run
    this.gateGroup = new THREE.Group();
    scene.add(this.gateGroup);
    // aircraft shadow map
    this.shadowRT = new THREE.WebGLRenderTarget(1024, 1024, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.shadowCam = new THREE.OrthographicCamera(-7, 7, 7, -7, 1, 120);
    this.shadowScene = new THREE.Scene();
    this.shadowScene.overrideMaterial = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'void main(){ gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }',
      side: THREE.DoubleSide,
    });
    shared.tShadow.value = this.shadowRT.texture;
    this.rig = new CameraRig(this.camera, this.canvas, this.T);
    this.date = new Date();
  }

  _applyEnvironment(timeChoice, weatherChoice) {
    const o = this.assets.world.origin;
    this.date = timeFor(timeChoice, o.lat, o.lon);
    let w = WEATHER_PRESETS[weatherChoice];
    if (weatherChoice === 'live') w = this.liveWx || WEATHER_PRESETS.fair;
    this.weather = w;
    this.sim?.setWeather(w);
    const s = this.shared;
    s.uCloudCover.value = w.cloud;
    s.uCloudBase.value = 280 + w.cloudBaseFt * FT;
    s.uFogDensity.value = 3.0 / (w.visSm * 1609) * 0.42;
    this.haze = 0.8 + (1 - Math.min(1, w.visSm / 20)) * 1.5;
  }

  _gates() {
    this.gateGroup.clear();
    const mat = new THREE.MeshBasicMaterial({ color: 0xf2b544, transparent: true, opacity: 0.85 });
    for (const [i, g] of this.sim.gates.entries()) {
      const next = this.sim.gates[i + 1] || { x: this.sim.kbpk.x, z: this.sim.kbpk.z };
      const ring = new THREE.Mesh(new THREE.TorusGeometry(60, 2.2, 8, 48), mat.clone());
      ring.position.set(g.x, g.y, g.z);
      const prev = i ? this.sim.gates[i - 1] : { x: this.sim.a.pos[0], z: this.sim.a.pos[2] };
      ring.rotation.y = -bearing(prev.x, prev.z, g.x, g.z);
      void next;
      ring.userData.index = i;
      this.gateGroup.add(ring);
    }
  }

  start(scenario) {
    const st = this.settings;
    st.scenario = scenario || st.scenario;
    try { localStorage.setItem('twinlakes.settings', JSON.stringify(st)); } catch { /* ignore */ }
    const time = st.scenario === 'golden' ? 'golden' : st.time;
    this._applyEnvironment(time, st.weather);
    this.sim.assists.coordination = st.coordination;
    this.sim.assists.attitudeHold = st.attitudeHold;
    this.sim.messages.length = 0;
    $('#msgs').innerHTML = '';
    this.sim.load(st.scenario);
    this._gates();
    this.rig.set(st.scenario === 'demo' ? 'cine' : 'chase');
    this.inMenu = false;
    this.paused = false;
    this.cardShown = false;
    $('#menu').classList.add('hidden');
    $('#card').classList.add('hidden');
    $('#hud').classList.remove('hidden');
    this.sound.start();
    this.map.route = this.sim.route || [];
    this._renderApBar();
  }

  _key(k, e) {
    if (k === 'Escape') { this.inMenu ? (this.sim.scenario && !this.firstMenu ? this._closeMenu() : null) : this._openMenu(); return; }
    if (this.inMenu) return;
    if (k === 'p') { this.paused = !this.paused; $('#paused').classList.toggle('hidden', !this.paused); }
    if (k === 'c') this.rig.next();
    if (k === 'v') this.rig.set(this.rig.mode === 'cockpit' ? 'chase' : 'cockpit');
    if (k === 'z') { this.sim.takeControl(); this.sim.toggleAutopilot(); this._renderApBar(); }
    if (k === 'm') { const r = [2, 4, 8, 16, 32]; this.map.setRange(r[(r.indexOf(this.map.rangeNm) + 1) % r.length] || 8); }
    if (k === 'i') $('#pfdWrap').classList.toggle('hidden');
    if (k === 'Enter' && this.sim.outcome) this.start(this.settings.scenario);
    void e;
  }

  _openMenu() { this.inMenu = true; this._renderMenu(); $('#menu').classList.remove('hidden'); }
  _closeMenu() { this.inMenu = false; $('#menu').classList.add('hidden'); }

  _renderMenu() {
    const st = this.settings;
    const p = $('#menu .panel');
    const wxOpts = [['live', this.liveWx ? this.liveWx.label : 'Live at KBPK (Open-Meteo)'], ...Object.entries(WEATHER_PRESETS).map(([k, v]) => [k, v.label])];
    p.innerHTML = `
      <div class="sub">Mountain Home, Arkansas · KBPK</div>
      <h1>TWIN LAKES</h1>
      <p class="lede">Fly a Cessna 172 over Norfork and Bull Shoals lakes. The hills are USGS elevation, the ground is USGS aerial photography, the lakes, rivers and runways are OpenStreetMap, and the airplane is a six-degree-of-freedom model built from published Cessna 172 aerodynamics.</p>
      <div class="scen">${SCENARIOS.map((s) => `<button data-s="${s.id}" class="${s.id === st.scenario ? 'sel' : ''}"><b>${s.title}</b><span>${s.blurb}</span></button>`).join('')}</div>
      <div class="opts">
        <label>Time of day<select id="optTime">${[['now', 'Now in Mountain Home'], ['morning', 'Morning'], ['noon', 'Midday'], ['golden', 'Golden hour'], ['dusk', 'Dusk'], ['night', 'Night']]
          .map(([v, l]) => `<option value="${v}" ${st.time === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Weather<select id="optWx">${wxOpts.map(([v, l]) => `<option value="${v}" ${st.weather === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="checks">
        <label><input type="checkbox" id="optHold" ${st.attitudeHold ? 'checked' : ''}> Attitude hold when hands off</label>
        <label><input type="checkbox" id="optCoord" ${st.coordination ? 'checked' : ''}> Auto-rudder</label>
      </div>
      <button class="go" id="goBtn">FLY</button>
      <details style="margin-top:16px"><summary>Controls</summary><div class="keys">${KEYS.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div>
        <p class="fine">Gamepad: left stick flies, right stick X is rudder, right stick Y and the triggers are throttle, bumpers are flaps, A brakes, X autopilot, Y camera. On a phone: on-screen stick, throttle and flap buttons.</p></details>
      <p class="fine">Elevation: USGS 3DEP via AWS Terrain Tiles. Imagery: USGS National Map (public domain). Map data © OpenStreetMap contributors (ODbL). Weather: Open-Meteo. Not for real-world navigation.</p>`;
    p.querySelectorAll('.scen button').forEach((b) => b.addEventListener('click', () => {
      st.scenario = b.dataset.s;
      p.querySelectorAll('.scen button').forEach((x) => x.classList.toggle('sel', x === b));
    }));
    p.querySelector('#optTime').addEventListener('change', (e) => { st.time = e.target.value; });
    p.querySelector('#optWx').addEventListener('change', (e) => { st.weather = e.target.value; });
    p.querySelector('#optHold').addEventListener('change', (e) => { st.attitudeHold = e.target.checked; });
    p.querySelector('#optCoord').addEventListener('change', (e) => { st.coordination = e.target.checked; });
    p.querySelector('#goBtn').addEventListener('click', () => this.start());
  }

  _renderApBar() {
    const ap = this.sim.ap;
    const on = ap.engaged;
    const bar = $('#apbar');
    const btn = (id, label, active) => `<button data-a="${id}" class="${active ? 'on' : ''}">${label}</button>`;
    bar.innerHTML = btn('ap', 'AP', on) + btn('hdg', 'HDG', on && ap.lateral === 'HDG') + btn('hl', '◀', false) + btn('hr', '▶', false)
      + btn('nav', 'NAV', on && ap.lateral === 'NAV') + btn('alt', 'ALT', on && ap.vertical === 'ALT') + btn('au', '▲', false) + btn('ad', '▼', false)
      + btn('vs', 'VS', on && ap.vertical === 'VS') + btn('apr', 'APR', on && ap.vertical === 'GS') + btn('cam', 'CAM', false);
    bar.onclick = (e) => {
      const a = e.target.dataset?.a;
      if (!a) return;
      const sim = this.sim, o = sim.a.out;
      if (a === 'cam') { this.rig.next(); return; }
      if (a === 'ap') { sim.takeControl(); sim.toggleAutopilot(); }
      if (!ap.engaged && a !== 'ap') { sim.takeControl(); sim.toggleAutopilot(); }
      if (a === 'hdg') { ap.lateral = 'HDG'; ap.target.heading = o.heading; }
      if (a === 'hl') { ap.lateral = 'HDG'; ap.target.heading = ((ap.target.heading - 10 * DEG) + 2 * Math.PI) % (2 * Math.PI); }
      if (a === 'hr') { ap.lateral = 'HDG'; ap.target.heading = (ap.target.heading + 10 * DEG) % (2 * Math.PI); }
      if (a === 'nav') {
        const w = sim.activeWaypoint();
        if (w) { ap.lateral = 'NAV'; ap.nav = { from: [sim.a.pos[0], sim.a.pos[2]], to: [w.x, w.z] }; sim.say(`NAV direct ${w.name}`); }
      }
      if (a === 'alt') { ap.target.alt = Math.round(sim.a.pos[1] / 30.48) * 30.48; ap.setVertical('ALT', o); }
      if (a === 'au') { ap.target.alt += 100 * FT; ap.setVertical('ALT', o); }
      if (a === 'ad') { ap.target.alt -= 100 * FT; ap.setVertical('ALT', o); }
      if (a === 'vs') { ap.target.vs = Math.round(o.vs / 0.00508 / 100) * 100 * 0.00508; ap.setVertical('VS', o); }
      if (a === 'apr') {
        const k = sim.kbpk;
        ap.lateral = 'NAV'; ap.nav = { from: [k.x - Math.sin(k.course) * 20000, k.z + Math.cos(k.course) * 20000], to: [k.x, k.z] };
        ap.glide = { x: k.x, z: k.z, elev: k.elev, aim: 15, course: k.course, angle: 3 * DEG };
        ap.setVertical('GS', o);
        sim.say('Approach armed: KBPK runway 23, 3° glide path. Manage power yourself; disconnect before the flare.');
      }
      this._renderApBar();
    };
  }

  _showOutcome() {
    const o = this.sim.outcome;
    if (!o || this.cardShown) return;
    this.cardShown = true;
    const card = $('#card');
    if (o.type === 'crash') {
      this.sound.bang('crash');
      card.innerHTML = `<h2>Crashed</h2><p style="color:#ffb3b3">${o.reason[0].toUpperCase() + o.reason.slice(1)}.</p>
        <div class="row"><button class="primary" data-a="retry">Try again</button><button data-a="menu">Menu</button></div>`;
    } else {
      const r = o.report;
      const col = { 'A+': '#3ecf6e', A: '#3ecf6e', B: '#9ad84a', C: '#f2b544', D: '#ff9040', F: '#ff4d4d' }[r.grade];
      const tdz = r.along == null ? 'off the runway' : r.along < 60 ? `${Math.round(r.along)} m past the threshold (short!)` : `${Math.round(r.along / FT)} ft past the threshold`;
      card.innerHTML = `<div class="grade" style="color:${col}">${r.grade}</div><h2>Landed</h2>
        <div style="color:#9aa6b2">${r.runway || 'Off-airport'}</div>
        <table>
          <tr><td>Sink rate at touchdown</td><td>${Math.round(r.fpm)} fpm</td></tr>
          <tr><td>Touchdown point</td><td>${tdz}</td></tr>
          <tr><td>Off the centreline</td><td>${r.cross == null ? '-' : `${Math.abs(r.cross).toFixed(1)} m ${r.cross > 0 ? 'right' : 'left'}`}</td></tr>
          <tr><td>Crab / bank</td><td>${r.crab == null ? '-' : `${Math.abs(r.crab).toFixed(1)}°`} / ${Math.abs(r.roll).toFixed(1)}°</td></tr>
          <tr><td>Airspeed</td><td>${Math.round(r.ias)} KIAS</td></tr>
          <tr><td>Bounces</td><td>${r.bounces}</td></tr>
          <tr><td>Score</td><td>${r.score} / 100</td></tr>
        </table>
        <div class="row"><button class="primary" data-a="retry">Fly it again</button><button data-a="cont">Keep flying</button><button data-a="menu">Menu</button></div>`;
    }
    card.classList.remove('hidden');
    card.onclick = (e) => {
      const a = e.target.dataset?.a;
      if (a === 'retry') this.start(this.settings.scenario);
      if (a === 'menu') { card.classList.add('hidden'); this._openMenu(); }
      if (a === 'cont') { card.classList.add('hidden'); this.sim.outcome = null; this.sim.landing = null; this.cardShown = false; }
    };
  }

  _updateHud(inside) {
    const sim = this.sim, a = sim.a, o = a.out;
    $('#status .t').textContent = sim.scenario?.title || '';
    const agl = Math.max(0, a.pos[1] - this.T.surface(a.pos[0], a.pos[2]) - 1.1);
    $('#status .o').textContent = `${fmtTime(this.date)} · ${Math.round(o.ias / KT)} KIAS · ${Math.round(a.pos[1] / FT)} ft MSL · ${Math.round(agl / FT)} ft AGL`
      + (sim.pilot ? ' · demo pilot flying' : '');
    $('#camLabel').textContent = `${this.rig.mode === 'cine' ? 'Cinematic' : this.rig.label} view · C to change`;
    const gh = $('#gateHint');
    const w = sim.activeWaypoint();
    if (sim.gates.length && sim.gateIdx < sim.gates.length) {
      const g = sim.gates[sim.gateIdx];
      const d = Math.hypot(g.x - a.pos[0], g.z - a.pos[2]);
      gh.textContent = `Gate ${sim.gateIdx + 1}/${sim.gates.length}: ${g.name} · ${(d / 1852).toFixed(1)} nm · ${String(Math.round(bearing(a.pos[0], a.pos[2], g.x, g.z) / DEG)).padStart(3, '0')}° · ${Math.round(g.y / FT)} ft`;
      gh.classList.remove('hidden');
    } else gh.classList.add('hidden');
    // messages
    const box = $('#msgs');
    while (sim.messages.length) {
      const m = sim.messages.shift();
      const div = document.createElement('div');
      div.className = `msg ${m.kind}`;
      div.textContent = m.text;
      box.appendChild(div);
      setTimeout(() => div.remove(), 6500);
      while (box.children.length > 3) box.firstChild.remove();
    }
    // instruments (30 Hz)
    this._pfdT = (this._pfdT || 0) + 1;
    if (this._pfdT % 2 === 0) {
      this.map.draw(a.pos, o.heading, o.track, { activeWp: w?.idx });
      const ap = sim.pilot ? sim.pilot.ap : sim.ap;
      this.pfd.draw(o, {
        ap: ap.engaged, apLateral: ap.lateral, apVertical: ap.vertical, target: ap.target,
        baroHpa: sim.weather.qnhHpa, localTime: fmtTime(this.date), trim: sim.c.trim, throttle: sim.c.throttle,
        wpName: w?.name, wpDist: w ? Math.hypot(w.x - a.pos[0], w.z - a.pos[2]) : null,
        dtk: w ? bearing(a.pos[0], a.pos[2], w.x, w.z) : null, map: this.map.canvas,
      });
      const wrap = $('#pfdWrap');
      if (!wrap.firstChild) wrap.appendChild(this.pfd.canvas);
    }
    $('#pfdWrap').style.display = inside ? 'none' : '';
    const bar = $('#apbar');
    bar.style.bottom = inside ? '12px' : `${$('#pfdWrap').getBoundingClientRect().height + 18}px`;
    if (this.input.touchThrottleFill) this.input.touchThrottleFill.style.height = `${sim.c.throttle * 100}%`;
  }

  _frame(now) {
    requestAnimationFrame((t) => this._frame(t));
    let dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.fpsAvg += (1 / Math.max(dt, 1e-3) - this.fpsAvg) * 0.05;
    const sim = this.sim;
    const input = this.input.read(dt);
    if (!this.paused) {
      if (this.inMenu && sim.a.crashed) sim.load('demo');
      if (this.inMenu && sim.pilot?.phase === 'stopped') sim.load('demo');
      sim.update(dt, this.inMenu ? { ...input, active: {}, throttleDelta: 0, throttleSet: null, flapsDelta: 0, brake: 0, trimDelta: 0 } : input);
      this.date = new Date(this.date.getTime() + dt * 1000);
      if (!this.inMenu && sim.outcome) this._showOutcome();
    }
    const a = sim.a;
    // aircraft pose
    this.model.root.position.set(...a.pos);
    this.model.root.quaternion.set(...a.q);
    const inside = this.rig.update(dt, a, this.model);
    this.model.update(this.paused ? 0 : dt, a, sim.c, now / 1000, inside, this.shared.uNight.value);
    this.model.root.visible = true;
    this.model.body.material.side = inside ? THREE.DoubleSide : THREE.FrontSide;
    // environment
    const o = this.assets.world.origin;
    const sun = sunPosition(this.date, o.lat, o.lon);
    const s = this.shared;
    s.uCam.value.copy(this.camera.position);
    s.uTime.value = now / 1000;
    const wv = sim.windVec || [0, 0, 0];
    s.uCloudOffset.value.x -= wv[0] * dt * 1.3;
    s.uCloudOffset.value.y -= wv[2] * dt * 1.3;
    this.sky.update(sun.dir, this.camera.position, this.haze || 1);
    const sc = s.uSunColor.value;
    const mag = Math.max(1e-3, Math.max(sc.x, sc.y, sc.z));
    this.sunLight.color.setRGB(sc.x / mag, sc.y / mag, sc.z / mag);
    this.sunLight.intensity = mag * 1.1;
    this.sunLight.position.set(a.pos[0] + sun.dir[0] * 100, a.pos[1] + sun.dir[1] * 100, a.pos[2] + sun.dir[2] * 100);
    this.sunLight.target.position.set(...a.pos);
    const am = s.uAmbient.value;
    this.hemi.color.setRGB(am.x * 1.6, am.y * 1.6, am.z * 1.6);
    this.hemi.groundColor.setRGB(am.x * 0.7, am.y * 0.7, am.z * 0.55);
    this.hemi.intensity = 1.6;
    // eye adaptation: open up after sunset
    this.renderer.toneMappingExposure = 1.0 + 2.2 * s.uNight.value + 0.6 * (1 - THREE.MathUtils.smoothstep(sun.dir[1], -0.05, 0.12)) * (1 - s.uNight.value);
    this.lightPoints.material.uniforms.uPx.value = this.renderer.getPixelRatio();
    // windsock
    const piv = this.windsock.userData.pivot;
    const wk = Math.hypot(wv[0], wv[2]) / KT;
    piv.rotation.y = Math.atan2(wv[0], wv[2]) + Math.sin(now / 700) * 0.05 * Math.min(1, wk / 5);
    piv.rotation.x = (1 - Math.min(1, wk / 15)) * 1.1;
    // gates
    for (const g of this.gateGroup.children) {
      const i = g.userData.index;
      g.visible = i >= sim.gateIdx;
      g.material.color.set(i === sim.gateIdx ? 0xf2b544 : 0x7fd0ff);
      g.material.opacity = i === sim.gateIdx ? 0.9 : 0.35;
    }
    // terrain patches
    this.camera.updateMatrixWorld();
    this.terrainR.update(this.camera);
    // aircraft shadow
    const sunUp = sun.dir[1] > 0.03;
    s.uShadowOn.value = sunUp ? 1 : 0;
    if (sunUp) {
      const sc2 = this.shadowCam;
      sc2.position.set(a.pos[0] + sun.dir[0] * 60, a.pos[1] + sun.dir[1] * 60, a.pos[2] + sun.dir[2] * 60);
      sc2.lookAt(a.pos[0], a.pos[1], a.pos[2]);
      sc2.updateMatrixWorld();
      s.uShadowMatrix.value.multiplyMatrices(sc2.projectionMatrix, sc2.matrixWorldInverse);
      const parent = this.model.root.parent;
      this.model.cockpit.visible = false;
      this.shadowScene.add(this.model.root);
      this.renderer.setRenderTarget(this.shadowRT);
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.clear();
      this.renderer.render(this.shadowScene, sc2);
      this.renderer.setRenderTarget(null);
      parent.add(this.model.root);
      this.model.cockpit.visible = inside;
    }
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.render(this.scene, this.camera);
    if (!this.inMenu) this._updateHud(inside);
    this.sound.update(a.out, a, inside, this.paused || this.inMenu);
    const td = sim.events.at(-1);
    if (td && td !== this._lastEv) {
      this._lastEv = td;
      if (td.type === 'touchdown') this.sound.bang('chirp', Math.min(1.5, Math.abs(td.vs) / 1.5 + 0.3));
    }
  }
}

new App().boot().catch((e) => { console.error(e); });
