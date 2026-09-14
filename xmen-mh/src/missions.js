// src/missions.js — Agent G
// Mission system: sequencing, objective evaluation, side-character quests and
// Cerebro-core collectible placement. Pure logic — no THREE, no DOM — so it
// duck-types the city/enemies/state contracts described in docs/SPEC.md and
// imports cleanly under plain `node --test`.

import { STORY, MISSIONS, SIDE_CHARACTERS } from './story.js';

export { STORY };

const POI_IDS = ['courthouse', 'asumh', 'hospital', 'walmart', 'high_school', 'lake', 'airport', 'downtown', 'park', 'landing_zone'];
const POI_AT_POI = ['courthouse', 'asumh', 'hospital', 'walmart', 'lake'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function safePoi(city, id) {
  try { return city && typeof city.poi === 'function' ? city.poi(id) : null; } catch { return null; }
}
function safeGround(city, x, z) {
  try { return city && typeof city.getGroundHeight === 'function' ? city.getGroundHeight(x, z) : 0; } catch { return 0; }
}
function safeRaycast(city, x, z) {
  try {
    if (city && typeof city.raycastDown === 'function') return city.raycastDown(x, 250, z);
  } catch { /* fall through */ }
  return safeGround(city, x, z);
}
function safeRoad(city, x, z) {
  try { return city && typeof city.nearestRoadPoint === 'function' ? city.nearestRoadPoint(x, z) : null; } catch { return null; }
}

function dist2D(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

function wordsDuration(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length || 1;
  return words * 0.35 + 1.2;
}

function pickLine(sideChar) {
  const lines = sideChar.lines || [];
  if (!lines.length) return '...';
  return lines[Math.floor(Math.random() * lines.length)];
}

// ---------------------------------------------------------------------------
// Collectible placement — 25 Cerebro cores total:
//   5 dropped right at POIs, 10 perched on rooftops near POIs
//   (via raycastDown), 10 snapped onto the road network.
// ---------------------------------------------------------------------------
export function placeCollectibles(city) {
  const out = [];

  for (const id of POI_AT_POI) {
    const p = safePoi(city, id);
    if (!p) continue;
    const y = safeGround(city, p.x, p.z) + 1.1;
    out.push({ x: p.x, y, z: p.z, id: `poi_${id}`, atPoi: id });
  }

  for (let i = 0; i < 10; i++) {
    const id = POI_IDS[i % POI_IDS.length];
    const p = safePoi(city, id);
    const cx = p ? p.x : 0, cz = p ? p.z : 0, r = p && p.radius ? p.radius : 30;
    const angle = (i / 10) * Math.PI * 2 + 0.37;
    const dist = Math.max(6, r * 0.6);
    const x = cx + Math.cos(angle) * dist;
    const z = cz + Math.sin(angle) * dist;
    const roofY = safeRaycast(city, x, z);
    out.push({ x, y: roofY + 0.6, z, id: `roof_${id}_${i}`, atPoi: id });
  }

  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const dist = 180 + (i % 4) * 220;
    const gx = Math.cos(angle) * dist;
    const gz = Math.sin(angle) * dist;
    const rp = safeRoad(city, gx, gz);
    const x = rp ? rp.x : gx;
    const z = rp ? rp.z : gz;
    const y = safeGround(city, x, z) + 1.0;
    out.push({ x, y, z, id: `road_${i}` });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Per-active-quest bookkeeping shared by main missions and side missions.
// ---------------------------------------------------------------------------
class Runner {
  constructor(objectives) {
    this.objectives = objectives;
    this.index = 0;
    this._resetLocal();
  }
  _resetLocal() {
    this.elapsed = 0;
    this.killCount = {};
    this.killUnsub = null;
    this.collectBaseline = 0;
    this.talkOk = false;
    this.escort = null;
    this.waveTimes = null;
    this.wavesSpawned = 0;
  }
  get objective() { return this.objectives[this.index]; }
  done() { return this.index >= this.objectives.length; }
  teardown() { if (this.killUnsub) { this.killUnsub(); this.killUnsub = null; } }
  advance() { this.teardown(); this.index++; this._resetLocal(); }
}

function resolveAround(city, missionLike, objective) {
  if (objective.around) return objective.around;
  const poiId = objective.poi || (missionLike && missionLike.at);
  const p = safePoi(city, poiId);
  return p ? { x: p.x, z: p.z, radius: p.radius } : { x: 0, z: 0 };
}

function targetsFor(objective) {
  if (objective.type === 'defeat') return [{ kind: objective.kind, count: objective.count || 1 }];
  if (objective.type === 'destroy') return objective.targets || [];
  if (objective.type === 'boss') return [{ kind: objective.kind, count: 1 }];
  return [];
}

function activateObjective(mgr, missionLike, runner) {
  const objective = runner.objective;
  if (!objective) return;
  switch (objective.type) {
    case 'defeat':
    case 'destroy':
    case 'boss': {
      const targets = targetsFor(objective);
      const around = resolveAround(mgr.city, missionLike, objective);
      for (const t of targets) {
        runner.killCount[t.kind] = 0;
        try { mgr.enemies.spawnWave({ kind: t.kind, count: t.count, around, radius: objective.radius || around.radius || 35 }); } catch { /* enemies module not ready */ }
      }
      runner.killUnsub = mgr.bus.on('enemy_dead', (payload) => {
        const enemy = payload && payload.enemy;
        if (enemy && Object.prototype.hasOwnProperty.call(runner.killCount, enemy.kind)) runner.killCount[enemy.kind]++;
      });
      break;
    }
    case 'protect': {
      const around = resolveAround(mgr.city, missionLike, objective);
      const waves = Math.max(1, objective.waves || 1);
      const duration = objective.duration || 60;
      runner.waveTimes = [];
      for (let i = 0; i < waves; i++) runner.waveTimes.push((duration / waves) * i);
      try { mgr.enemies.spawnWave({ kind: 'thug', count: 4, around, radius: objective.radius || around.radius || 40 }); } catch { /* n/a */ }
      runner.wavesSpawned = 1;
      break;
    }
    case 'collect':
      runner.collectBaseline = mgr._collectCounts[objective.kind] || 0;
      break;
    case 'escort': {
      const startPos = mgr.state.player && mgr.state.player.pos ? mgr.state.player.pos : { x: 0, z: 0 };
      const target = objective.to && objective.to.poi ? safePoi(mgr.city, objective.to.poi) : objective.to;
      runner.escort = {
        pos: { x: startPos.x, z: startPos.z },
        target: target ? { x: target.x, z: target.z } : { x: 0, z: 0 },
        speed: objective.speed || 9,
      };
      break;
    }
    default:
      break; // goto / talk need no setup
  }
}

function checkObjective(mgr, missionLike, runner, dt) {
  const objective = runner.objective;
  if (!objective) return false;
  const player = mgr.state.player;
  const ppos = player && player.pos ? player.pos : { x: 0, z: 0 };

  switch (objective.type) {
    case 'goto': {
      const target = objective.poi ? safePoi(mgr.city, objective.poi) : null;
      const tx = target ? target.x : (objective.x || 0);
      const tz = target ? target.z : (objective.z || 0);
      const r = objective.radius || (target && target.radius) || 10;
      return dist2D(ppos.x, ppos.z, tx, tz) <= r;
    }
    case 'talk':
      return runner.talkOk;
    case 'collect': {
      const have = (mgr._collectCounts[objective.kind] || 0) - runner.collectBaseline;
      return have >= (objective.count || 1);
    }
    case 'defeat':
    case 'destroy':
    case 'boss': {
      const targets = targetsFor(objective);
      if (!targets.length) return false;
      return targets.every((t) => (runner.killCount[t.kind] || 0) >= t.count);
    }
    case 'protect': {
      runner.elapsed += dt;
      const duration = objective.duration || 60;
      const waves = Math.max(1, objective.waves || 1);
      while (runner.wavesSpawned < waves && runner.elapsed >= runner.waveTimes[runner.wavesSpawned]) {
        const around = resolveAround(mgr.city, missionLike, objective);
        try { mgr.enemies.spawnWave({ kind: 'thug', count: 4, around, radius: objective.radius || around.radius || 40 }); } catch { /* n/a */ }
        runner.wavesSpawned++;
      }
      return runner.elapsed >= duration;
    }
    case 'escort': {
      const esc = runner.escort;
      if (!esc) return false;
      const dx = esc.target.x - esc.pos.x, dz = esc.target.z - esc.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const step = Math.min(d, esc.speed * dt);
        esc.pos.x += (dx / d) * step;
        esc.pos.z += (dz / d) * step;
      }
      return Math.hypot(esc.target.x - esc.pos.x, esc.target.z - esc.pos.z) <= (objective.radius || 10);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// MissionManager
// ---------------------------------------------------------------------------
export class MissionManager {
  constructor(state, city, enemies, bus) {
    this.state = state;
    this.city = city;
    this.enemies = enemies;
    this.bus = bus;

    this.missions = MISSIONS;
    this.sideCharacters = SIDE_CHARACTERS;

    this.collectibles = placeCollectibles(city).map((c) => ({ ...c, collected: false }));
    this._collectCounts = {};

    this.completed = new Set();
    this.sideCompleted = new Set();
    this.sideActive = new Map(); // sideCharacterId -> { def, runner }

    this.active = null; // { mission, runner, started, awaitingRequirement }
    this._toastTimer = 0;
    this._prevPhase = 'play';
    this.dialogState = null; // { lines, i, timer, onDone }
  }

  // -- lifecycle -------------------------------------------------------------

  start(id) {
    const mission = this.missions.find((m) => m.id === id);
    if (!mission) return;
    const runner = new Runner(mission.objectives);
    this.active = { mission, runner, started: false, awaitingRequirement: false };
    this.bus.emit('mission_start', { id: mission.id });
    if (mission.requires && this.state.player && this.state.player.character !== mission.requires) {
      this.active.awaitingRequirement = true;
      this._toastTimer = 0;
      this.bus.emit('toast', { text: mission.requiresToast || `Switch to ${mission.requires}` });
    } else {
      this._beginActive();
    }
  }

  _beginActive() {
    const { mission } = this.active;
    this.active.started = true;
    this._queueDialog(mission.intro || [], () => this._activateCurrentObjective());
  }

  _activateCurrentObjective() {
    if (!this.active) return;
    const { mission, runner } = this.active;
    if (runner.done()) { this._finishMission(); return; }
    activateObjective(this, mission, runner);
    const objective = runner.objective;
    this.bus.emit('objective_update', { missionId: mission.id, objectiveIndex: runner.index, text: objective.text || '', done: false });
  }

  _finishMission() {
    const { mission } = this.active;
    this.completed.add(mission.id);
    this.bus.emit('mission_complete', { id: mission.id });
    const finishedId = mission.id;
    this.active = null;
    this._queueDialog(mission.outro || [], () => {
      const idx = this.missions.findIndex((m) => m.id === finishedId);
      const next = this.missions[idx + 1];
      if (next && !this.completed.has(next.id)) this.start(next.id);
    });
  }

  // -- dialog sequencer --------------------------------------------------------
  // Lines play one at a time; each is on screen for words*0.35s + 1.2s before
  // the next is shown. state.phase is 'dialog' for the duration.

  _queueDialog(lines, onDone) {
    if (!lines || lines.length === 0) { onDone && onDone(); return; }
    this._prevPhase = this.state.phase === 'dialog' ? 'play' : this.state.phase;
    this._setPhase('dialog');
    this.dialogState = { lines, i: -1, timer: 0, onDone };
    this._advanceDialogLine();
  }

  _advanceDialogLine() {
    const ds = this.dialogState;
    ds.i++;
    if (ds.i >= ds.lines.length) {
      const onDone = ds.onDone;
      this.dialogState = null;
      this._setPhase(this._prevPhase || 'play');
      onDone && onDone();
      return;
    }
    const line = ds.lines[ds.i];
    const duration = line.duration || wordsDuration(line.text);
    ds.timer = duration;
    this.bus.emit('dialog', { speaker: line.speaker, text: line.text, portrait: line.portrait, duration });
  }

  _setPhase(phase) {
    this.state.phase = phase;
    this.bus.emit('phase', { phase });
  }

  // -- main loop --------------------------------------------------------------

  update(dt) {
    if (this.dialogState) {
      this.dialogState.timer -= dt;
      while (this.dialogState && this.dialogState.timer <= 0) this._advanceDialogLine();
      return; // hold gameplay logic while a line is up
    }

    if (this.active) {
      if (this.active.awaitingRequirement) {
        this._toastTimer -= dt;
        const need = this.active.mission.requires;
        if (this.state.player && this.state.player.character === need) {
          this.active.awaitingRequirement = false;
          this._beginActive();
        } else if (this._toastTimer <= 0) {
          this._toastTimer = 4;
          this.bus.emit('toast', { text: this.active.mission.requiresToast || `Switch to ${need}` });
        }
      } else if (this.active.started) {
        const { mission, runner } = this.active;
        if (checkObjective(this, mission, runner, dt)) {
          this.bus.emit('objective_update', { missionId: mission.id, objectiveIndex: runner.index, text: runner.objective.text || '', done: true });
          runner.advance();
          if (runner.done()) this._finishMission();
          else this._activateCurrentObjective();
        }
      }
    }

    this._updateSideMissions(dt);
  }

  _updateSideMissions(dt) {
    for (const [id, entry] of this.sideActive) {
      const { def, runner } = entry;
      const missionLike = { at: def.at };
      if (checkObjective(this, missionLike, runner, dt)) {
        this.bus.emit('objective_update', { missionId: def.mission.id, objectiveIndex: runner.index, text: runner.objective.text || '', done: true });
        runner.advance();
        if (runner.done()) {
          runner.teardown();
          this.sideActive.delete(id);
          this.sideCompleted.add(def.mission.id);
          this.bus.emit('mission_complete', { id: def.mission.id });
          this._queueDialog(def.mission.outro || [], () => {});
        } else {
          activateObjective(this, missionLike, runner);
          this.bus.emit('objective_update', { missionId: def.mission.id, objectiveIndex: runner.index, text: runner.objective.text || '', done: false });
        }
      }
    }
  }

  // -- interaction --------------------------------------------------------------

  nearInteractable() {
    const player = this.state.player;
    if (!player || !player.pos) return null;
    const px = player.pos.x, pz = player.pos.z;
    let best = null, bestD = 3;

    for (const c of this.collectibles) {
      if (c.collected) continue;
      const d = dist2D(px, pz, c.x, c.z);
      if (d < bestD) { bestD = d; best = { kind: 'collect', id: c.id, x: c.x, z: c.z, prompt: 'Pick up Cerebro core' }; }
    }

    for (const sc of this.sideCharacters) {
      const p = safePoi(this.city, sc.at);
      const x = p ? p.x : 0, z = p ? p.z : 0;
      const d = dist2D(px, pz, x, z);
      if (d < bestD) { bestD = d; best = { kind: 'side', id: sc.id, x, z, prompt: `Talk to ${sc.name}` }; }
    }

    if (this.active && this.active.started && !this.active.awaitingRequirement) {
      const objective = this.active.runner.objective;
      if (objective && objective.type === 'talk') {
        const sc = this.sideCharacters.find((s) => s.id === objective.characterId);
        const p = sc ? safePoi(this.city, sc.at) : null;
        if (sc && p) {
          const d = dist2D(px, pz, p.x, p.z);
          if (d < bestD) { bestD = d; best = { kind: 'talk', id: objective.characterId, x: p.x, z: p.z, prompt: `Talk to ${sc.name}` }; }
        }
      }
    }

    return best;
  }

  interact() {
    const target = this.nearInteractable();
    if (!target) return false;

    if (target.kind === 'collect') {
      const c = this.collectibles.find((x) => x.id === target.id);
      if (!c || c.collected) return false;
      c.collected = true;
      this._collectCounts.cerebro = (this._collectCounts.cerebro || 0) + 1;
      const total = this.collectibles.length;
      this.bus.emit('collect', { kind: 'cerebro', pos: { x: c.x, y: c.y, z: c.z }, count: this._collectCounts.cerebro, total });
      this.bus.emit('toast', { text: `Cerebro core recovered (${this._collectCounts.cerebro}/${total})` });
      return true;
    }

    if (target.kind === 'talk') {
      if (this.active && this.active.runner) this.active.runner.talkOk = true;
      const sc = this.sideCharacters.find((s) => s.id === target.id);
      if (sc) this.bus.emit('dialog', { speaker: sc.name, text: pickLine(sc), duration: 2 });
      return true;
    }

    if (target.kind === 'side') {
      const sc = this.sideCharacters.find((s) => s.id === target.id);
      if (!sc) return false;
      if (this.sideCompleted.has(sc.mission.id) || this.sideActive.has(sc.id)) {
        this.bus.emit('dialog', { speaker: sc.name, text: pickLine(sc), duration: 2.4 });
        return true;
      }
      const runner = new Runner(sc.mission.objectives);
      this.sideActive.set(sc.id, { def: sc, runner });
      this.bus.emit('mission_start', { id: sc.mission.id });
      this._queueDialog(sc.mission.intro || [], () => {
        activateObjective(this, { at: sc.at }, runner);
        this.bus.emit('objective_update', { missionId: sc.mission.id, objectiveIndex: runner.index, text: runner.objective.text || '', done: false });
      });
      return true;
    }

    return false;
  }

  // -- queries -------------------------------------------------------------------

  current() {
    if (!this.active) return { mission: null, objectiveIndex: -1, objective: null };
    if (this.active.awaitingRequirement) {
      const need = this.active.mission.requires;
      return { mission: this.active.mission, objectiveIndex: -1, objective: { type: 'requires', text: this.active.mission.requiresToast || `Switch to ${need}` } };
    }
    return { mission: this.active.mission, objectiveIndex: this.active.runner.index, objective: this.active.runner.objective || null };
  }

  markers() {
    const out = [];
    if (this.active && this.active.started && !this.active.awaitingRequirement) {
      const objective = this.active.runner.objective;
      if (objective) {
        const around = resolveAround(this.city, this.active.mission, objective);
        if (around) out.push({ x: around.x, z: around.z, label: objective.text || this.active.mission.title, kind: 'objective' });
      }
    }
    for (const sc of this.sideCharacters) {
      if (this.sideCompleted.has(sc.mission.id)) continue;
      const p = safePoi(this.city, sc.at);
      if (p) out.push({ x: p.x, z: p.z, label: sc.name, kind: 'side' });
    }
    for (const c of this.collectibles) {
      if (c.collected) continue;
      out.push({ x: c.x, z: c.z, label: 'Cerebro core', kind: 'collect' });
    }
    return out;
  }

  completedIds() {
    return [...this.completed, ...this.sideCompleted];
  }
}
