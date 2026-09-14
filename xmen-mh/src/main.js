// X-Men: Mountain Home — integration: boot, game loop, phases (title → intro on the helicarrier → skydive → play).
import * as THREE from '../vendor/three.module.js';
import { state } from './core/state.js';
import { bus } from './core/bus.js';
import cityData from './data/city.js';
import { City } from './world/city.js';
import { CHARACTERS, createCharacterRig, createNpcRig } from './entities/characters.js';
import { PlayerController, attachInput } from './player/controller.js';
import { updateAbilities, spawnProps } from './abilities.js';
import { EnemyManager } from './enemies.js';
import { MissionManager, STORY, placeCollectibles } from './missions.js';
import { HUD } from './ui/hud.js';
import { createHelicarrier } from './world/helicarrier.js';
import { createSky } from './world/sky.js';
import { VFX } from './vfx.js';
import { Audio } from './audio.js';

const QUALITY = { high: { pixelRatio: 1.5, shadows: true, shadowSize: 2048 }, medium: { pixelRatio: 1, shadows: true, shadowSize: 1024 }, low: { pixelRatio: 0.75, shadows: false, shadowSize: 512 } };

/** Ground/collision proxy: while the player is on the helicarrier deck the deck is the floor. */
function makeWorld(city, carrier) {
  const inDeck = (x, z) => x >= carrier.deckBounds.minX && x <= carrier.deckBounds.maxX && z >= carrier.deckBounds.minZ && z <= carrier.deckBounds.maxZ;
  const proxy = Object.create(city);
  proxy.onDeck = false;
  proxy.getGroundHeight = (x, z) => (proxy.onDeck && inDeck(x, z)) ? carrier.deckY : city.getGroundHeight(x, z);
  proxy.raycastDown = (x, y, z) => (proxy.onDeck && inDeck(x, z) && y >= carrier.deckY - 1) ? carrier.deckY : city.raycastDown(x, y, z);
  proxy.collideCapsule = (pos, r, h, out) => { if (proxy.onDeck) { out.copy(pos); return false; } return city.collideCapsule(pos, r, h, out); };
  proxy.inDeck = inDeck;
  return proxy;
}

export async function boot() {
  const canvas = document.getElementById('game');
  const q = QUALITY[state.settings.quality] || QUALITY.high;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = q.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 6000);
  state.renderer = renderer; state.scene = scene; state.camera = camera;
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });

  const hud = new HUD(state, bus, cityData);
  const setStatus = (t) => { const el = document.getElementById('loading'); if (el) el.textContent = t; };
  setStatus('Painting the sky…');
  const sky = createSky(scene, renderer);
  await frame();
  setStatus('Building Mountain Home from OpenStreetMap…');
  const city = new City(scene, cityData, { quality: state.settings.quality }).build();
  state.city = city;
  await frame();
  setStatus('Helicarrier inbound…');
  const carrier = createHelicarrier(scene);
  const world = makeWorld(city, carrier);
  await frame();
  setStatus('Assembling the team…');
  const rigs = {};
  for (const id of state.roster) { rigs[id] = createCharacterRig(id); rigs[id].group.visible = false; scene.add(rigs[id].group); }
  const charDefs = Object.fromEntries(state.roster.map(id => [id, CHARACTERS[id]]));
  attachInput(state, canvas);
  const player = new PlayerController(state, world, rigs, camera, canvas, { charDefs });
  const enemies = new EnemyManager(scene, city, createNpcRig);
  state.enemyManager = enemies;
  const vfx = new VFX(scene);
  const audio = new Audio(state, bus);
  const missions = new MissionManager(state, city, enemies, bus);
  state.missions = missions;
  spawnProps(state, city, 40);
  // side characters standing at their places
  const npcs = [];
  for (const sc of STORY.sideCharacters || []) {
    try {
      const rig = createNpcRig(sc.rigSpec || { seed: sc.id });
      const p = city.poi(sc.at) || { x: 0, z: 0 };
      const ox = (Math.random() - 0.5) * 6, oz = (Math.random() - 0.5) * 6;
      rig.group.position.set(p.x + ox, city.getGroundHeight(p.x + ox, p.z + oz), p.z + oz);
      rig.setAnim('idle'); scene.add(rig.group); npcs.push(rig); sc.rig = rig;
    } catch (e) { console.warn('npc failed', sc.id, e); }
  }
  // collectibles
  const cores = (placeCollectibles(city) || []).map(p => ({ ...p, taken: false }));
  const coreGeo = new THREE.OctahedronGeometry(0.45, 0);
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x66e0ff, emissive: 0x2299cc, emissiveIntensity: 1.2, metalness: 0.6, roughness: 0.2 });
  const coreMesh = new THREE.InstancedMesh(coreGeo, coreMat, Math.max(1, cores.length));
  const m4 = new THREE.Matrix4();
  cores.forEach((c, i) => { m4.makeTranslation(c.x, c.y + 1, c.z); coreMesh.setMatrixAt(i, m4); });
  coreMesh.instanceMatrix.needsUpdate = true; scene.add(coreMesh);
  hud.setCores?.(0, cores.length);
  let collected = 0;

  // ---------- phases ----------
  const jp = carrier.jumpPoint;
  const startOnDeck = () => {
    world.onDeck = true;
    player.teleport(jp.x - 40, jp.z);
    state.player.pos.y = carrier.deckY; state.player.vel.set(0, 0, 0);
    state.phase = 'deck'; bus.emit('phase', { phase: 'deck' });
    hud.toast?.('Walk to the bow and press E (or step off) to jump');
  };
  const playIntro = async () => {
    state.phase = 'dialog'; bus.emit('phase', { phase: 'dialog' });
    hud.letterbox?.(true);
    for (const line of STORY.intro || []) {
      const dur = (String(line.text).split(/\s+/).length * 0.35) + 1.2;
      bus.emit('dialog', { speaker: line.speaker, text: line.text, duration: dur });
      await waitDialog(dur);
      if (state.phase === 'title') return;
    }
    hud.letterbox?.(false);
    startOnDeck();
  };
  const waitDialog = (dur) => new Promise(res => { let done = false; const t = setTimeout(() => { if (!done) { done = true; res(); } }, dur * 1000); const off = bus.on('dialog_advance', () => { if (!done) { done = true; clearTimeout(t); off(); res(); } }); });
  const jump = () => {
    if (state.phase !== 'deck') return;
    world.onDeck = false;
    player.startSkydive(state.player.pos.clone());
    bus.emit('phase', { phase: 'skydive' });
    audio.setMusic?.('explore');
    bus.emit('toast', { text: 'Steer with WASD. Land on the courthouse square.' });
  };
  bus.on('phase', ({ phase }) => { if (phase === 'play' && !missions.current?.()) { missions.start('m1'); } });
  const startGame = () => {
    audio.resume?.(); audio.setMusic?.('title');
    startOnDeck();
    state.phase = 'dialog';
    playIntro();
  };
  hud.showTitle?.(startGame);
  document.getElementById('loading')?.remove();
  audio.setMusic?.('title');

  // interaction + pause keys
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE') {
      if (state.phase === 'dialog') bus.emit('dialog_advance');
      else if (state.phase === 'deck' && world.inDeck(state.player.pos.x, state.player.pos.z) && Math.hypot(state.player.pos.x - jp.x, state.player.pos.z - jp.z) < 12) jump();
      else if (state.phase === 'play') missions.interact?.();
    }
    if (e.code === 'Escape') {
      if (state.phase === 'play' || state.phase === 'deck') { state.prevPhase = state.phase; state.phase = 'paused'; hud.showPause?.(); bus.emit('phase', { phase: 'paused' }); }
      else if (state.phase === 'paused') { state.phase = state.prevPhase || 'play'; hud.hidePause?.(); bus.emit('phase', { phase: state.phase }); }
    }
  });
  bus.on('resume', () => { state.phase = state.prevPhase || 'play'; hud.hidePause?.(); });
  bus.on('restart', () => location.reload());

  // ---------- loop ----------
  const clock = new THREE.Clock();
  let combatTimer = 0;
  const tmp = new THREE.Vector3();
  function loop() {
    requestAnimationFrame(loop);
    const raw = Math.min(0.05, clock.getDelta());
    const dt = raw * (state.phase === 'paused' ? 0 : 1);
    state.dt = dt; state.time += dt;
    const worldDt = dt * state.timeScale;
    try {
      player.update(dt);
      if (state.phase === 'deck' && state.player && !world.inDeck(state.player.pos.x, state.player.pos.z)) jump();
      updateAbilities(state, dt);
      enemies.update(worldDt, state);
      state.enemies = enemies.all();
      for (const p of state.props) p.update(worldDt, city);
      missions.update(dt);
      // collectibles
      if (state.player && state.phase === 'play') {
        for (let i = 0; i < cores.length; i++) {
          const c = cores[i]; if (c.taken) continue;
          if (tmp.set(c.x - state.player.pos.x, c.y - state.player.pos.y, c.z - state.player.pos.z).lengthSq() < 4) {
            c.taken = true; collected++;
            m4.makeScale(0, 0, 0); coreMesh.setMatrixAt(i, m4); coreMesh.instanceMatrix.needsUpdate = true;
            bus.emit('collect', { kind: 'cerebro', pos: new THREE.Vector3(c.x, c.y + 1, c.z), count: collected, total: cores.length });
            hud.setCores?.(collected, cores.length);
          }
        }
        coreMat.emissiveIntensity = 1 + 0.5 * Math.sin(state.time * 4);
      }
      for (const n of npcs) n.update(dt);
      vfx.update(dt);
      sky.update(dt, state.player ? state.player.pos : tmp.set(0, 0, 0));
      carrier.update(dt);
      city.update?.(dt, state.player?.pos);
      // music mood
      const near = state.phase === 'play' ? enemies.nearest?.(state.player.pos, 40) : null;
      combatTimer = near ? 4 : Math.max(0, combatTimer - dt);
      const boss = state.enemies.some(e => e.kind === 'sentinel');
      audio.setMusic?.(state.phase === 'title' ? 'title' : boss ? 'boss' : combatTimer > 0 ? 'combat' : 'explore');
      audio.update?.(dt);
      // interaction prompt
      if (state.phase === 'play') { const it = missions.nearInteractable?.(); hud.setPrompt?.(it ? (it.prompt || `E — ${it.name || 'Interact'}`) : null); }
      else if (state.phase === 'deck') hud.setPrompt?.(Math.hypot(state.player.pos.x - jp.x, state.player.pos.z - jp.z) < 12 ? 'E — Jump' : null);
      hud.setMarkers?.(missions.markers?.() || []);
      hud.update(dt);
      if (state.player && state.player.hp <= 0 && state.phase === 'play') { state.phase = 'gameover'; bus.emit('phase', { phase: 'gameover' }); hud.showGameOver?.(() => location.reload()); }
    } catch (e) { if (!state._loopErr) { state._loopErr = true; console.error('loop error', e); } }
    renderer.render(scene, camera);
  }
  loop();
  window.xmen = { state, bus, city, player, enemies, missions, hud, vfx, audio, carrier, rigs, jump, startGame };
}
function frame() { return new Promise(r => requestAnimationFrame(() => r())); }
boot().catch(e => { console.error(e); const el = document.getElementById('loading'); if (el) el.textContent = 'Failed to start: ' + e.message; });
