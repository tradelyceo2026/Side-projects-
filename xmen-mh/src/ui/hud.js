// src/ui/hud.js — Agent H: all 2D UI (HUD, minimap, dialog, title/pause/gameover screens, character wheel).
// Plain DOM + one injected <style> tag + one <canvas> for the minimap. No build step, no THREE import needed:
// all screen-space projection is done with plain matrix/vector math against the camera's own matrices so this
// file stays importable (and its math testable) in bare Node — DOM is only ever touched inside the HUD
// constructor / instance methods, never at module load time.

import { CHARACTERS } from '../entities/characters.js';
import { ABILITIES, abilityCooldown, abilityState } from '../abilities.js';

// ---------------------------------------------------------------------------
// Pure helpers — no DOM, no THREE. Exported for test/hud.test.js.
// ---------------------------------------------------------------------------

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function distance2D(x1, z1, x2, z2) {
  return Math.hypot(x2 - x1, z2 - z1);
}

// 4x4 column-major matrix multiply (THREE.Matrix4.elements layout): returns a*b (a applied after b).
function mat4Multiply(a, b) {
  const r = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[row + k * 4] * b[k + col * 4];
      r[row + col * 4] = sum;
    }
  }
  return r;
}

function mat4TransformVec4(m, x, y, z, w) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

// Projects a world point to screen pixel space given a camera's view (matrixWorldInverse) and
// projection matrices (both plain 16-number arrays, THREE.Matrix4.elements order). Pure — takes
// arrays, never a THREE object, so it needs no THREE import and runs the same in Node or a browser.
export function projectToScreen(viewEl, projEl, pos, width, height) {
  const vp = mat4Multiply(projEl, viewEl);
  const [cx, cy, cz, cw] = mat4TransformVec4(vp, pos.x, pos.y, pos.z, 1);
  const behind = cw <= 0;
  const w = behind ? -cw : cw; // avoid divide-by-zero flip artifacts, keep a usable magnitude
  const ndcX = w !== 0 ? cx / w : 0;
  const ndcY = w !== 0 ? cy / w : 0;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
    ndcX,
    ndcY,
    behind,
    visible: !behind && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1,
  };
}

// Given a (possibly off-screen or behind-camera) projected point, returns where an edge arrow
// should sit on the screen border, clamped inside `margin` px, plus the angle to rotate it.
export function edgeArrow(proj, width, height, margin = 28) {
  const cx = width / 2;
  const cy = height / 2;
  let dx = proj.x - cx;
  let dy = proj.y - cy;
  if (proj.behind) {
    // A point behind the camera projects with its direction flipped; un-flip it so the arrow
    // still points the short way around toward the real-world target.
    dx = -dx;
    dy = -dy;
  }
  if (dx === 0 && dy === 0) dx = 0.0001;
  const angle = Math.atan2(dy, dx);
  const halfW = Math.max(1, cx - margin);
  const halfH = Math.max(1, cy - margin);
  const scale = Math.min(
    dx !== 0 ? Math.abs(halfW / dx) : Infinity,
    dy !== 0 ? Math.abs(halfH / dy) : Infinity,
  );
  const onEdge = proj.behind || !proj.visible;
  return {
    x: onEdge ? cx + dx * scale : proj.x,
    y: onEdge ? cy + dy * scale : proj.y,
    angle,
    onEdge,
  };
}

// World (x,z) -> minimap pixel, player-centred, optionally rotated by camera yaw for a
// "rotating" minimap mode (yaw radians, 0 = north-up / no rotation).
export function worldToMinimap(worldX, worldZ, centerX, centerZ, metersPerPixel, mapSize, yaw = 0) {
  let dx = (worldX - centerX) / metersPerPixel;
  let dz = (worldZ - centerZ) / metersPerPixel;
  if (yaw) {
    const s = Math.sin(-yaw);
    const c = Math.cos(-yaw);
    const rx = dx * c - dz * s;
    const rz = dx * s + dz * c;
    dx = rx;
    dz = rz;
  }
  return { x: mapSize / 2 + dx, y: mapSize / 2 + dz };
}

export function withinMinimapRadius(px, py, mapSize, padding = 0) {
  const r = mapSize / 2 - padding;
  const dx = px - mapSize / 2;
  const dy = py - mapSize / 2;
  return dx * dx + dy * dy <= r * r;
}

// Radial cooldown sweep, 0 (ready) .. 1 (just used / fully on cooldown remaining).
export function cooldownDegrees(fraction) {
  return clamp(fraction, 0, 1) * 360;
}

export function cooldownGradient(fraction, sweepColor = 'rgba(0,0,0,0.72)', baseColor = 'transparent') {
  const deg = cooldownDegrees(fraction);
  if (deg <= 0) return baseColor;
  return `conic-gradient(${sweepColor} ${deg}deg, ${baseColor} ${deg}deg 360deg)`;
}

// Typewriter reveal: how many characters of `text` are visible after `elapsedMs` at `charsPerSec`.
export function typewriterSlice(text, elapsedMs, charsPerSec = 42) {
  if (!text) return '';
  const count = Math.floor((elapsedMs / 1000) * charsPerSec);
  return text.slice(0, clamp(count, 0, text.length));
}

export function typewriterDone(text, elapsedMs, charsPerSec = 42) {
  if (!text) return true;
  return (elapsedMs / 1000) * charsPerSec >= text.length;
}

// Up to 2 uppercase initials for a generated NPC portrait badge, e.g. "Deputy Hallie" -> "DH".
export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Simple deterministic colour from a string, used for NPC badge backgrounds.
export function colorFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 45%, 32%)`;
}

// ---------------------------------------------------------------------------
// CSS (single injected <style> tag, scoped under .xmh-root)
// ---------------------------------------------------------------------------

const CSS = `
.xmh-root {
  position: fixed; inset: 0; z-index: 9999; overflow: hidden;
  font-family: 'Bebas Neue', Oswald, 'Arial Narrow', Arial, sans-serif;
  color: #f1ede2; pointer-events: none; user-select: none;
  --gold: #d9b45c; --gold-dim: #8a7238; --glass: rgba(10,12,15,0.68);
  --glass-2: rgba(14,16,20,0.82); --danger: #e0433f; --panel-radius: 2px;
}
.xmh-root * { box-sizing: border-box; }
.xmh-hide { display: none !important; }
.xmh-panel {
  background: var(--glass); border: 1px solid var(--gold-dim);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.45);
  border-radius: var(--panel-radius); backdrop-filter: blur(3px);
}

/* ---- health / abilities (bottom-left) ---- */
.xmh-vitals { position: absolute; left: 22px; bottom: 22px; width: 300px; padding: 10px 12px; }
.xmh-hpRow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.xmh-hpName { font-size: 15px; letter-spacing: 1px; color: var(--gold); min-width: 78px; }
.xmh-hpBarWrap { flex: 1; height: 14px; background: rgba(0,0,0,0.55); border: 1px solid var(--gold-dim); position: relative; }
.xmh-hpBarFill { height: 100%; width: 100%; transition: width 120ms linear; }
.xmh-hpNum { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; text-shadow: 0 1px 2px #000; letter-spacing: 1px; }
.xmh-hoverWrap { height: 5px; margin-top: 3px; background: rgba(0,0,0,0.5); border: 1px solid var(--gold-dim); }
.xmh-hoverFill { height: 100%; background: linear-gradient(90deg, #7fd0ff, #cfeeff); width: 0%; }
.xmh-abilities { display: flex; gap: 10px; }
.xmh-slot { position: relative; width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--gold-dim);
  background: radial-gradient(circle at 35% 30%, #23262c, #101215); display: flex; align-items: center; justify-content: center; }
.xmh-slot.xmh-empty { opacity: 0.25; }
.xmh-slotIcon { font-size: 20px; z-index: 2; filter: drop-shadow(0 1px 1px #000); }
.xmh-slotSweep { position: absolute; inset: 0; border-radius: 50%; z-index: 1; }
.xmh-slotKey { position: absolute; bottom: -16px; left: 0; right: 0; text-align: center; font-size: 10px; color: #cfc9b8; letter-spacing: 1px; }
.xmh-slot.xmh-active { box-shadow: 0 0 8px 2px var(--gold), inset 0 0 6px rgba(217,180,92,0.6); border-color: var(--gold); }

/* ---- character portraits row (bottom-center) ---- */
.xmh-roster { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; gap: 10px; align-items: flex-end; }
.xmh-portrait { width: 46px; height: 46px; border-radius: 50%; border: 2px solid rgba(217,180,92,0.35); background-size: cover; background-position: center; position: relative; opacity: 0.6; transition: all 140ms ease; background-color: #1a1c20; }
.xmh-portrait .xmh-pKey { position: absolute; bottom: -15px; left: 0; right: 0; text-align: center; font-size: 10px; color: #cfc9b8; }
.xmh-portrait.xmh-activeChar { width: 62px; height: 62px; opacity: 1; border-color: var(--gold); box-shadow: 0 0 10px 2px rgba(217,180,92,0.55); }

/* ---- objective tracker (top-left) ---- */
.xmh-objective { position: absolute; left: 22px; top: 20px; width: 300px; padding: 10px 14px; }
.xmh-missionTitle { font-size: 17px; letter-spacing: 1.5px; color: var(--gold); text-transform: uppercase; }
.xmh-objText { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-top: 4px; color: #e8e3d6; letter-spacing: 0.5px; }
.xmh-check { display: inline-block; width: 14px; height: 14px; border: 1px solid var(--gold-dim); border-radius: 50%; flex: none; }
.xmh-check.xmh-done { background: var(--gold); animation: xmh-pop 420ms ease; }
@keyframes xmh-pop { 0% { transform: scale(0.4); } 60% { transform: scale(1.35); } 100% { transform: scale(1); } }
.xmh-cores { margin-top: 8px; font-size: 12px; color: #cfeeff; display: flex; align-items: center; gap: 6px; }
.xmh-coreDot { width: 8px; height: 8px; border-radius: 50%; background: #7fd0ff; box-shadow: 0 0 4px #7fd0ff; }

/* ---- minimap (top-right) ---- */
.xmh-minimapWrap { position: absolute; right: 22px; top: 20px; width: 200px; height: 200px; border-radius: 50%; border: 2px solid var(--gold); box-shadow: 0 0 0 3px rgba(0,0,0,0.55), 0 6px 18px rgba(0,0,0,0.5); overflow: hidden; background: #0c0d10; }
.xmh-minimapWrap canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.xmh-minimapToggle { position: absolute; right: 22px; top: 224px; font-size: 10px; padding: 2px 8px; pointer-events: auto; cursor: pointer; color: #cfc9b8; background: var(--glass); border: 1px solid var(--gold-dim); }

/* ---- reticle ---- */
.xmh-reticle { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%; background: rgba(255,255,255,0.55); box-shadow: 0 0 0 1px rgba(0,0,0,0.5); }

/* ---- off-screen objective arrow ---- */
.xmh-arrow { position: absolute; width: 0; height: 0; border-left: 9px solid transparent; border-right: 9px solid transparent; border-bottom: 16px solid var(--gold); filter: drop-shadow(0 1px 2px #000); transform-origin: 50% 65%; }

/* ---- dialog box ---- */
.xmh-dialog { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%); width: min(720px, 88vw); padding: 14px 18px; display: flex; gap: 14px; align-items: flex-start; }
.xmh-dPortrait { width: 56px; height: 56px; border-radius: 4px; border: 1px solid var(--gold-dim); background-size: cover; background-position: center; flex: none; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: bold; color: #fff; }
.xmh-dBody { flex: 1; min-width: 0; }
.xmh-dSpeaker { color: var(--gold); font-size: 15px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 2px; }
.xmh-dText { font-size: 14px; line-height: 1.4; color: #f1ede2; min-height: 2.6em; }
.xmh-dHint { margin-top: 6px; font-size: 10px; color: #9a9284; letter-spacing: 1px; text-align: right; opacity: 0; transition: opacity 200ms; }
.xmh-dHint.xmh-show { opacity: 1; }

/* ---- toast stack ---- */
.xmh-toasts { position: absolute; left: 50%; top: 24px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; align-items: center; }
.xmh-toast { padding: 6px 16px; font-size: 12px; letter-spacing: 0.5px; opacity: 0; transform: translateY(-6px); transition: all 220ms ease; }
.xmh-toast.xmh-in { opacity: 1; transform: translateY(0); }
.xmh-toast.xmh-out { opacity: 0; transform: translateY(-6px); }

/* ---- interaction prompt ---- */
.xmh-prompt { position: absolute; left: 50%; bottom: 130px; transform: translateX(-50%); padding: 6px 14px; font-size: 13px; letter-spacing: 0.5px; }
.xmh-prompt kbd { color: var(--gold); font-weight: bold; margin-right: 4px; }

/* ---- vignette / letterbox ---- */
.xmh-vignette { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse at center, rgba(224,67,63,0) 55%, rgba(224,67,63,0.55) 100%); opacity: 0; }
.xmh-vignette.xmh-flash { animation: xmh-flash 420ms ease-out; }
@keyframes xmh-flash { 0% { opacity: 0.95; } 100% { opacity: 0; } }
.xmh-bar { position: absolute; left: 0; right: 0; height: 12vh; background: #000; transform: scaleY(0); transition: transform 380ms ease; }
.xmh-barTop { top: 0; transform-origin: top; }
.xmh-barBottom { bottom: 0; transform-origin: bottom; }
.xmh-root.xmh-letterboxed .xmh-bar { transform: scaleY(1); }

/* ---- title / pause / gameover screens ---- */
.xmh-screen { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: radial-gradient(ellipse at center, rgba(20,22,26,0.72), rgba(4,5,6,0.92)); pointer-events: auto; text-align: center; }
.xmh-title1 { font-size: clamp(36px, 7vw, 76px); letter-spacing: 6px; color: #f1ede2; text-shadow: 0 0 24px rgba(217,180,92,0.5); }
.xmh-title2 { font-size: clamp(14px, 2.4vw, 20px); letter-spacing: 4px; color: var(--gold); margin-top: 6px; text-transform: uppercase; }
.xmh-prompt2 { margin-top: 34px; font-size: 14px; letter-spacing: 2px; color: #dcd7c9; animation: xmh-blink 1.6s infinite; }
@keyframes xmh-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.xmh-controls { margin-top: 30px; font-size: 11px; line-height: 1.9; color: #b8b2a2; letter-spacing: 0.5px; columns: 2; column-gap: 26px; }
.xmh-controls div span { color: var(--gold); margin-right: 6px; }
.xmh-credits { position: absolute; bottom: 14px; font-size: 10px; color: #756f61; letter-spacing: 0.5px; }
.xmh-menuBox { padding: 26px 34px; min-width: 280px; }
.xmh-menuTitle { font-size: 26px; letter-spacing: 3px; color: var(--gold); margin-bottom: 18px; text-transform: uppercase; }
.xmh-btn { display: block; width: 100%; margin: 8px 0; padding: 9px 12px; background: rgba(255,255,255,0.04); border: 1px solid var(--gold-dim); color: #f1ede2; font: inherit; font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; cursor: pointer; transition: all 120ms; }
.xmh-btn:hover { background: rgba(217,180,92,0.16); border-color: var(--gold); color: var(--gold); }
.xmh-row2 { display: flex; align-items: center; justify-content: space-between; margin: 10px 0; font-size: 12px; letter-spacing: 1px; }
.xmh-row2 select, .xmh-row2 input { pointer-events: auto; }

/* ---- character wheel ---- */
.xmh-wheel { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(4,5,6,0.35); }
.xmh-wheelRing { position: relative; width: 320px; height: 320px; }
.xmh-wheelItem { position: absolute; width: 74px; height: 74px; margin: -37px 0 0 -37px; border-radius: 50%; border: 2px solid rgba(217,180,92,0.4); background-size: cover; background-position: center; background-color: #1a1c20; transition: all 120ms ease; display: flex; align-items: flex-end; justify-content: center; }
.xmh-wheelItem span { font-size: 11px; background: rgba(0,0,0,0.6); width: 100%; text-align: center; padding: 2px 0; }
.xmh-wheelItem.xmh-hover { border-color: var(--gold); box-shadow: 0 0 14px 3px rgba(217,180,92,0.6); transform: scale(1.14); }
`;

const CONTROLS = [
  ['WASD', 'Move'], ['Shift', 'Sprint'], ['Space', 'Jump'], ['Mouse', 'Camera'],
  ['LMB / J', 'Attack'], ['RMB / K', 'Ability 1'], ['Q', 'Ability 2'], ['F', 'Ability 3'],
  ['Tab / 1-5', 'Switch character'], ['E', 'Interact'], ['Esc', 'Pause'],
];

const SLOT_HINTS = ['RMB', 'Q', 'F'];

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

export class HUD {
  constructor(state, bus, cityJson) {
    this.state = state;
    this.bus = bus;
    this.cityJson = cityJson || null;

    this._toastId = 0;
    this._toasts = [];
    this._markers = [];
    this._dialog = null; // {speaker, text, portrait, duration, elapsedMs}
    this._flashUntil = 0;
    this._cores = { n: 0, total: 0 };
    this._objective = { title: '', text: '' };
    this._promptText = null;
    this._minimapRotate = false;
    this._wheelOpen = false;
    this._wheelAngle = 0;
    this._wheelHover = -1;
    this.onSelect = null; // set by caller: hud.onSelect = (id) => player.switchTo(id)
    this._onStart = null;
    this._lastPhase = null;

    this._buildDom();
    this._buildMinimapBase();
    this._bindBusEvents();
    this._bindDomEvents();
  }

  // ---- DOM construction (only ever called from the constructor / instance methods) ----

  _buildDom() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this._styleEl = style;

    const root = document.createElement('div');
    root.className = 'xmh-root';
    root.innerHTML = `
      <div class="xmh-bar xmh-barTop"></div>
      <div class="xmh-bar xmh-barBottom"></div>
      <div class="xmh-vignette" data-el="vignette"></div>

      <div class="xmh-vitals xmh-panel xmh-hide" data-el="vitals">
        <div class="xmh-hpRow">
          <div class="xmh-hpName" data-el="hpName">—</div>
          <div class="xmh-hpBarWrap"><div class="xmh-hpBarFill" data-el="hpFill"></div><div class="xmh-hpNum" data-el="hpNum"></div></div>
        </div>
        <div class="xmh-hoverWrap xmh-hide" data-el="hoverWrap"><div class="xmh-hoverFill" data-el="hoverFill"></div></div>
        <div class="xmh-abilities" data-el="abilities"></div>
      </div>

      <div class="xmh-roster xmh-hide" data-el="roster"></div>

      <div class="xmh-objective xmh-panel xmh-hide" data-el="objectivePanel">
        <div class="xmh-missionTitle" data-el="missionTitle"></div>
        <div class="xmh-objText"><span class="xmh-check" data-el="objCheck"></span><span data-el="objText"></span></div>
        <div class="xmh-cores"><span class="xmh-coreDot"></span><span data-el="coreText">0 / 0 Cerebro cores</span></div>
      </div>

      <div class="xmh-minimapWrap xmh-hide" data-el="minimapWrap"><canvas width="200" height="200" data-el="minimapCanvas"></canvas></div>
      <div class="xmh-minimapToggle xmh-hide" data-el="minimapToggle">rotate: off</div>

      <div class="xmh-reticle xmh-hide" data-el="reticle"></div>
      <div class="xmh-arrow xmh-hide" data-el="arrow"></div>

      <div class="xmh-dialog xmh-panel xmh-hide" data-el="dialog">
        <div class="xmh-dPortrait" data-el="dPortrait"></div>
        <div class="xmh-dBody">
          <div class="xmh-dSpeaker" data-el="dSpeaker"></div>
          <div class="xmh-dText" data-el="dText"></div>
          <div class="xmh-dHint" data-el="dHint">press E to continue</div>
        </div>
      </div>

      <div class="xmh-toasts" data-el="toasts"></div>
      <div class="xmh-prompt xmh-panel xmh-hide" data-el="prompt"></div>

      <div class="xmh-screen xmh-hide" data-el="titleScreen">
        <div class="xmh-title1">X-MEN: MOUNTAIN HOME</div>
        <div class="xmh-title2">an Ozark open world</div>
        <div class="xmh-prompt2">Press Enter or Click to Start</div>
        <div class="xmh-controls" data-el="titleControls"></div>
        <div class="xmh-credits">map data © OpenStreetMap contributors</div>
      </div>

      <div class="xmh-screen xmh-hide" data-el="pauseScreen">
        <div class="xmh-menuBox xmh-panel">
          <div class="xmh-menuTitle">Paused</div>
          <button class="xmh-btn" data-el="btnResume">Resume</button>
          <div class="xmh-row2">Quality
            <select data-el="selQuality"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
          </div>
          <div class="xmh-row2">Mute <input type="checkbox" data-el="chkMute"></div>
          <div class="xmh-row2">Invert Y <input type="checkbox" data-el="chkInvert"></div>
          <button class="xmh-btn" data-el="btnControls">Controls</button>
          <div class="xmh-controls xmh-hide" data-el="pauseControls"></div>
          <button class="xmh-btn" data-el="btnRestart">Restart</button>
        </div>
      </div>

      <div class="xmh-screen xmh-hide" data-el="gameoverScreen">
        <div class="xmh-menuBox xmh-panel">
          <div class="xmh-menuTitle">You Are Down</div>
          <button class="xmh-btn" data-el="btnRetry">Retry</button>
        </div>
      </div>

      <div class="xmh-wheel xmh-hide" data-el="wheel"><div class="xmh-wheelRing" data-el="wheelRing"></div></div>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.el = {};
    root.querySelectorAll('[data-el]').forEach((n) => { this.el[n.getAttribute('data-el')] = n; });

    this.el.titleControls.innerHTML = CONTROLS.map(([k, d]) => `<div><span>${k}</span>${d}</div>`).join('');
    this.el.pauseControls.innerHTML = this.el.titleControls.innerHTML;
  }

  _buildMinimapBase() {
    // Pre-render roads once to an offscreen canvas at 1px = 2m; blitted centred on the player each frame.
    this._mmScale = 2; // metres per pixel
    const cj = this.cityJson;
    const bbox = cj?.bbox || { minX: -2500, maxX: 2500, minZ: -2500, maxZ: 2500 };
    const w = Math.max(1, Math.round((bbox.maxX - bbox.minX) / this._mmScale));
    const h = Math.max(1, Math.round((bbox.maxZ - bbox.minZ) / this._mmScale));
    this._mmBase = document.createElement('canvas');
    this._mmBase.width = w;
    this._mmBase.height = h;
    this._mmOriginX = bbox.minX;
    this._mmOriginZ = bbox.minZ;
    const ctx = this._mmBase.getContext('2d');
    ctx.fillStyle = '#12130f';
    ctx.fillRect(0, 0, w, h);
    if (cj?.water) {
      ctx.fillStyle = '#1c3a4a';
      for (const wtr of cj.water) this._fillPoly(ctx, wtr.poly);
    }
    if (cj?.green) {
      ctx.fillStyle = '#1f2e1a';
      for (const g of cj.green) this._fillPoly(ctx, g.poly);
    }
    if (cj?.roads) {
      for (const road of cj.roads) {
        ctx.strokeStyle = road.class === 'primary' ? '#8a7238' : road.class === 'secondary' ? '#6b6355' : '#3d3a33';
        ctx.lineWidth = Math.max(1, (road.width || 6) / this._mmScale);
        ctx.beginPath();
        (road.pts || []).forEach(([x, z], i) => {
          const px = (x - this._mmOriginX) / this._mmScale;
          const pz = (z - this._mmOriginZ) / this._mmScale;
          if (i === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
        });
        ctx.stroke();
      }
    }
  }

  _fillPoly(ctx, poly) {
    if (!poly || !poly.length) return;
    ctx.beginPath();
    poly.forEach(([x, z], i) => {
      const px = (x - this._mmOriginX) / this._mmScale;
      const pz = (z - this._mmOriginZ) / this._mmScale;
      if (i === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
    });
    ctx.closePath();
    ctx.fill();
  }

  // ---- bus wiring ----

  _bindBusEvents() {
    const b = this.bus;
    b.on('dialog', (line) => this.dialog(line));
    b.on('objective_update', (p) => {
      this._objective.text = p?.text || '';
      this.el.objText.textContent = this._objective.text;
      if (p?.done) {
        this.el.objCheck.classList.remove('xmh-done');
        // eslint-disable-next-line no-void
        void this.el.objCheck.offsetWidth; // restart animation
        this.el.objCheck.classList.add('xmh-done');
      } else {
        this.el.objCheck.classList.remove('xmh-done');
      }
    });
    b.on('mission_start', (p) => {
      const title = this.state?.missions?.current?.()?.title || p?.title || p?.id || '';
      this._objective.title = title;
      this.el.missionTitle.textContent = title;
      this.toast(`Mission: ${title}`);
    });
    b.on('mission_complete', (p) => {
      this.toast('Mission Complete');
      this.el.objCheck.classList.remove('xmh-done');
      // eslint-disable-next-line no-void
      void this.el.objCheck.offsetWidth;
      this.el.objCheck.classList.add('xmh-done');
    });
    b.on('toast', (p) => this.toast(p?.text || ''));
    b.on('collect', (p) => {
      if (p?.kind === 'cerebro') {
        this.setCores(p.count ?? this._cores.n + 1, p.total ?? this._cores.total);
        this.toast(`Cerebro core ${this._cores.n} / ${this._cores.total}`);
      } else {
        this.toast(`Collected ${p?.kind || 'item'}`);
      }
    });
    b.on('hit', (p) => {
      const player = this.state?.player;
      const isPlayer = p && (p.targetId === 'player' || (player && p.targetId === player.id));
      if (isPlayer) this.flash();
    });
    b.on('switch_character', () => this._refreshRoster());
    b.on('phase', (p) => this._onPhase(p?.phase));
  }

  _bindDomEvents() {
    this.el.btnResume.addEventListener('click', () => { this.state.phase = 'play'; this.hidePause(); });
    this.el.btnRestart.addEventListener('click', () => { try { location.reload(); } catch (e) { /* non-browser */ } });
    this.el.btnRetry.addEventListener('click', () => { try { location.reload(); } catch (e) { /* non-browser */ } });
    this.el.btnControls.addEventListener('click', () => this.el.pauseControls.classList.toggle('xmh-hide'));
    this.el.selQuality.addEventListener('change', (e) => { if (this.state.settings) this.state.settings.quality = e.target.value; });
    this.el.chkMute.addEventListener('change', (e) => { if (this.state.settings) this.state.settings.mute = e.target.checked; });
    this.el.chkInvert.addEventListener('change', (e) => { if (this.state.settings) this.state.settings.invertY = e.target.checked; });
    this.el.minimapToggle.addEventListener('click', () => {
      this._minimapRotate = !this._minimapRotate;
      this.el.minimapToggle.textContent = `rotate: ${this._minimapRotate ? 'on' : 'off'}`;
    });

    this._keydownHandler = (e) => {
      if (this._titleActive && (e.key === 'Enter')) this._startFromTitle();
      if (this._dialog && (e.key === 'e' || e.key === 'E')) this._advanceDialog(true);
    };
    window.addEventListener('keydown', this._keydownHandler);

    this._clickHandler = () => { if (this._titleActive) this._startFromTitle(); };
    this.el.titleScreen.addEventListener('click', this._clickHandler);
  }

  // ---- phase handling ----

  _onPhase(phase) {
    if (phase === 'paused') this.showPause(); else if (this._lastPhase === 'paused') this.hidePause();
    if (phase === 'gameover') this.el.gameoverScreen.classList.remove('xmh-hide'); else this.el.gameoverScreen.classList.add('xmh-hide');
    if (phase === 'title') this._showTitleScreen(); else this._titleActive = false;
    this.letterbox(phase === 'dialog');
    const playHud = phase === 'play' || phase === 'dialog';
    ['vitals', 'roster', 'objectivePanel', 'minimapWrap', 'minimapToggle', 'reticle'].forEach((k) => {
      this.el[k].classList.toggle('xmh-hide', !playHud);
    });
    this._lastPhase = phase;
  }

  // ---- public API (per SPEC contract) ----

  update(dt) {
    const st = this.state;
    if (!st) return;
    this._updateVitals();
    this._updateRosterHighlight();
    this._updateMinimap();
    this._updateArrow();
    this._updateDialog(dt);
    this._updateToasts(dt);
    this._updateWheel(dt);
  }

  showTitle(onStart) {
    this._onStart = onStart || null;
    this._showTitleScreen();
  }

  _showTitleScreen() {
    this._titleActive = true;
    this.el.titleScreen.classList.remove('xmh-hide');
  }

  _startFromTitle() {
    if (!this._titleActive) return;
    this._titleActive = false;
    this.el.titleScreen.classList.add('xmh-hide');
    if (this._onStart) { const cb = this._onStart; this._onStart = null; cb(); }
  }

  showPause() {
    this.el.selQuality.value = this.state?.settings?.quality || 'high';
    this.el.chkMute.checked = !!this.state?.settings?.mute;
    this.el.chkInvert.checked = !!this.state?.settings?.invertY;
    this.el.pauseScreen.classList.remove('xmh-hide');
  }

  hidePause() {
    this.el.pauseScreen.classList.add('xmh-hide');
  }

  dialog(line) {
    if (!line) { this._dialog = null; this.el.dialog.classList.add('xmh-hide'); return; }
    this._dialog = { ...line, elapsedMs: 0 };
    this.el.dialog.classList.remove('xmh-hide');
    this.el.dSpeaker.textContent = line.speaker || '';
    this.el.dHint.classList.remove('xmh-show');
    const portraitUrl = line.portrait || CHARACTERS?.[line.speaker]?.portrait || null;
    if (portraitUrl) {
      this.el.dPortrait.style.backgroundImage = `url(${portraitUrl})`;
      this.el.dPortrait.style.backgroundColor = 'transparent';
      this.el.dPortrait.textContent = '';
    } else {
      this.el.dPortrait.style.backgroundImage = 'none';
      this.el.dPortrait.style.backgroundColor = colorFromString(line.speaker || '?');
      this.el.dPortrait.textContent = initials(line.speaker);
    }
  }

  toast(text) {
    if (!text) return;
    const id = ++this._toastId;
    const node = document.createElement('div');
    node.className = 'xmh-toast xmh-panel';
    node.textContent = text;
    this.el.toasts.appendChild(node);
    requestAnimationFrame(() => node.classList.add('xmh-in'));
    this._toasts.push({ id, node, life: 2.6 });
    while (this._toasts.length > 4) {
      const dead = this._toasts.shift();
      dead.node.remove();
    }
  }

  setObjective(text) {
    this._objective.text = text;
    this.el.objText.textContent = text;
  }

  setMarkers(list) {
    this._markers = Array.isArray(list) ? list : [];
  }

  characterWheel(open) {
    if (open && !this._wheelOpen) {
      this._wheelOpen = true;
      this._wheelHover = this.state?.activeIndex ?? 0;
      this._wheelAngle = 0;
      this.el.wheel.classList.remove('xmh-hide');
      this._layoutWheel();
    } else if (!open && this._wheelOpen) {
      this._wheelOpen = false;
      this.el.wheel.classList.add('xmh-hide');
      const roster = this.state?.roster || [];
      const id = roster[this._wheelHover];
      if (id && typeof this.onSelect === 'function') this.onSelect(id);
    }
  }

  setPrompt(text) {
    this._promptText = text || null;
    if (this._promptText) {
      this.el.prompt.classList.remove('xmh-hide');
      this.el.prompt.innerHTML = this._promptText.replace(/^([A-Za-z0-9]+)\s*[—\-]\s*/, '<kbd>$1</kbd>');
      if (this.el.prompt.innerHTML === this._promptText) this.el.prompt.textContent = this._promptText;
    } else {
      this.el.prompt.classList.add('xmh-hide');
    }
  }

  setCores(n, total) {
    this._cores = { n: n || 0, total: total || 0 };
    this.el.coreText.textContent = `${this._cores.n} / ${this._cores.total} Cerebro cores`;
  }

  flash() {
    const v = this.el.vignette;
    v.classList.remove('xmh-flash');
    // eslint-disable-next-line no-void
    void v.offsetWidth;
    v.classList.add('xmh-flash');
  }

  letterbox(bool) {
    this.root.classList.toggle('xmh-letterboxed', !!bool);
  }

  // ---- per-frame internals ----

  _updateVitals() {
    const st = this.state;
    const p = st.player;
    if (!p) return;
    const charDef = CHARACTERS?.[p.character];
    const color = charDef?.color || '#d9b45c';
    this.el.hpName.textContent = charDef?.name || p.character || '';
    this.el.hpName.style.color = color;
    const pct = clamp((p.hp ?? 0) / Math.max(1, p.maxHp ?? 1), 0, 1);
    this.el.hpFill.style.width = `${(pct * 100).toFixed(1)}%`;
    this.el.hpFill.style.background = `linear-gradient(90deg, ${color}, #ffffff22)`;
    this.el.hpNum.textContent = `${Math.max(0, Math.round(p.hp ?? 0))} / ${Math.round(p.maxHp ?? 0)}`;
    if (typeof p.hoverMeter === 'number') {
      this.el.hoverWrap.classList.remove('xmh-hide');
      this.el.hoverFill.style.width = `${clamp(p.hoverMeter, 0, 1) * 100}%`;
    } else {
      this.el.hoverWrap.classList.add('xmh-hide');
    }

    const abilities = charDef?.abilities || [];
    if (this._abilitiesFor !== p.character) {
      this._abilitiesFor = p.character;
      this.el.abilities.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const name = abilities[i];
        const def = name ? ABILITIES?.[name] : null;
        const slot = document.createElement('div');
        slot.className = `xmh-slot${def ? '' : ' xmh-empty'}`;
        slot.innerHTML = `<div class="xmh-slotSweep"></div><div class="xmh-slotIcon">${def?.icon || ''}</div><div class="xmh-slotKey">${SLOT_HINTS[i]}</div>`;
        slot.dataset.ability = name || '';
        this.el.abilities.appendChild(slot);
      }
    }
    [...this.el.abilities.children].forEach((slot) => {
      const name = slot.dataset.ability;
      if (!name) return;
      const frac = typeof abilityCooldown === 'function' ? (abilityCooldown(name) || 0) : 0;
      slot.querySelector('.xmh-slotSweep').style.background = cooldownGradient(frac);
      const active = typeof abilityState === 'function' ? !!abilityState(name) : false;
      slot.classList.toggle('xmh-active', active);
    });
  }

  _refreshRoster() {
    const st = this.state;
    const roster = st.roster || [];
    this.el.roster.innerHTML = roster.map((id, i) => {
      const c = CHARACTERS?.[id];
      const bg = c?.portrait ? `background-image:url(${c.portrait});background-color:transparent;` : `background-color:${colorFromString(id)};`;
      return `<div class="xmh-portrait${i === st.activeIndex ? ' xmh-activeChar' : ''}" style="${bg}" data-idx="${i}"><span class="xmh-pKey">${i + 1}</span></div>`;
    }).join('');
  }

  _updateRosterHighlight() {
    if (!this.el.roster.children.length) this._refreshRoster();
    else {
      [...this.el.roster.children].forEach((n, i) => n.classList.toggle('xmh-activeChar', i === this.state.activeIndex));
    }
  }

  _cameraMats() {
    const cam = this.state?.camera;
    const vEl = cam?.matrixWorldInverse?.elements;
    const pEl = cam?.projectionMatrix?.elements;
    if (!vEl || !pEl) return null;
    return { vEl, pEl };
  }

  _updateMinimap() {
    if (this.el.minimapWrap.classList.contains('xmh-hide')) return;
    const canvas = this.el.minimapCanvas;
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const st = this.state;
    const p = st.player;
    if (!p) return;
    const px = p.pos?.x ?? 0;
    const pz = p.pos?.z ?? 0;
    const yaw = this._minimapRotate ? (p.yaw || 0) : 0;

    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    if (yaw) ctx.rotate(yaw);
    ctx.translate(-size / 2, -size / 2);
    const bx = (px - this._mmOriginX) / this._mmScale;
    const bz = (pz - this._mmOriginZ) / this._mmScale;
    ctx.drawImage(this._mmBase, bx - size / 2, bz - size / 2, size, size, 0, 0, size, size);
    ctx.restore();

    // markers: main objectives white/gold diamonds, side quests yellow diamonds, collectibles cyan dots.
    for (const m of this._markers) {
      const pt = worldToMinimap(m.x, m.z, px, pz, this._mmScale, size, yaw);
      if (!withinMinimapRadius(pt.x, pt.y, size, 4)) continue;
      if (m.kind === 'collectible' || m.kind === 'cerebro') {
        ctx.fillStyle = '#7fd0ff';
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = m.kind === 'side' ? '#e8d24a' : '#d9b45c';
        ctx.save(); ctx.translate(pt.x, pt.y); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-4, -4, 8, 8);
        ctx.restore();
      }
    }

    // enemies within 150m as red dots.
    for (const e of st.enemies || []) {
      const ex = e.pos?.x ?? e.x;
      const ez = e.pos?.z ?? e.z;
      if (ex == null || ez == null) continue;
      if (distance2D(ex, ez, px, pz) > 150) continue;
      const pt = worldToMinimap(ex, ez, px, pz, this._mmScale, size, yaw);
      if (!withinMinimapRadius(pt.x, pt.y, size, 2)) continue;
      ctx.fillStyle = '#e0433f';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2); ctx.fill();
    }

    // player arrow, always centred, pointing along yaw (or up if rotating map).
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(this._minimapRotate ? 0 : (p.yaw || 0));
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  _currentObjectiveMarker() {
    if (!this._markers.length) return null;
    return this._markers.find((m) => m.kind === 'main') || this._markers[0];
  }

  _updateArrow() {
    const marker = this._currentObjectiveMarker();
    const mats = this._cameraMats();
    const p = this.state?.player;
    if (!marker || !mats || !p) { this.el.arrow.classList.add('xmh-hide'); return; }
    const width = window.innerWidth || 1280;
    const height = window.innerHeight || 720;
    const proj = projectToScreen(mats.vEl, mats.pEl, { x: marker.x, y: (p.pos?.y ?? 0) + 1, z: marker.z }, width, height);
    const dist = distance2D(marker.x, marker.z, p.pos?.x ?? 0, p.pos?.z ?? 0);
    if (dist < 4) { this.el.arrow.classList.add('xmh-hide'); return; }
    const edge = edgeArrow(proj, width, height, 34);
    this.el.arrow.classList.remove('xmh-hide');
    this.el.arrow.style.left = `${edge.x - 9}px`;
    this.el.arrow.style.top = `${edge.y - 8}px`;
    this.el.arrow.style.transform = `rotate(${edge.angle + Math.PI / 2}rad)`;
    this.el.arrow.style.opacity = edge.onEdge ? '1' : '0.55';
  }

  _updateDialog(dt) {
    if (!this._dialog) return;
    this._dialog.elapsedMs += dt * 1000;
    const text = this._dialog.text || '';
    const visible = typewriterSlice(text, this._dialog.elapsedMs, 42);
    this.el.dText.textContent = visible;
    const done = typewriterDone(text, this._dialog.elapsedMs, 42);
    this.el.dHint.classList.toggle('xmh-show', done);
    const durationMs = (this._dialog.duration ?? 4) * 1000;
    if (this._dialog.elapsedMs >= durationMs && done) this._advanceDialog(false);
  }

  _advanceDialog(force) {
    if (!this._dialog) return;
    const text = this._dialog.text || '';
    const done = typewriterDone(text, this._dialog.elapsedMs, 42);
    if (force && !done) { this._dialog.elapsedMs = 1e9; return; } // E press: reveal full line first
    this.dialog(null);
  }

  _updateToasts(dt) {
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.life -= dt;
      if (t.life <= 0.5 && t.life > 0) t.node.classList.add('xmh-out');
      if (t.life <= 0) { t.node.remove(); this._toasts.splice(i, 1); }
    }
  }

  _layoutWheel() {
    const roster = this.state?.roster || [];
    const n = roster.length || 1;
    const R = 130;
    this.el.wheelRing.innerHTML = roster.map((id, i) => {
      const c = CHARACTERS?.[id];
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = 160 + Math.cos(angle) * R - 37;
      const y = 160 + Math.sin(angle) * R - 37;
      const bg = c?.portrait ? `background-image:url(${c.portrait});background-color:transparent;` : `background-color:${colorFromString(id)};`;
      return `<div class="xmh-wheelItem" data-idx="${i}" style="left:${x}px;top:${y}px;${bg}"><span>${c?.name || id}</span></div>`;
    }).join('');
  }

  _updateWheel(dt) {
    if (!this._wheelOpen) return;
    const st = this.state;
    const dx = st.input?.mouse?.dx || 0;
    const dy = st.input?.mouse?.dy || 0;
    if (dx || dy) this._wheelAngle += Math.atan2(dy, dx) * 0; // placeholder no-op to keep dt/lint quiet without side effects
    // accumulate a simple pointer vector from mouse deltas to find nearest wedge
    this._wheelVecX = (this._wheelVecX || 0) + dx;
    this._wheelVecY = (this._wheelVecY || 0) + dy;
    const roster = st.roster || [];
    const n = roster.length || 1;
    let hover = this._wheelHover;
    if (Math.hypot(this._wheelVecX, this._wheelVecY) > 6) {
      const ang = Math.atan2(this._wheelVecY, this._wheelVecX) + Math.PI / 2;
      const norm = ((ang / (Math.PI * 2)) + 1) % 1;
      hover = Math.round(norm * n) % n;
    }
    if (hover !== this._wheelHover) {
      this._wheelHover = hover;
      [...this.el.wheelRing.children].forEach((n2, i) => n2.classList.toggle('xmh-hover', i === hover));
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._keydownHandler);
    this.root?.remove();
    this._styleEl?.remove();
  }
}
