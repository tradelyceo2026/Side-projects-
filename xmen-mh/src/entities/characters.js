// src/entities/characters.js — Agent C
// Procedural humanoid rigs (~1.8 m) with canvas-textured costumes and procedural animation.
// No addons, no npm, no external assets. Imports cleanly in Node (no DOM) — textures/portraits
// simply become null/'' when `document` is unavailable.

import * as THREE from '../../vendor/three.module.js';

// ---------------------------------------------------------------------------
// small math helpers
// ---------------------------------------------------------------------------
const HAS_DOM = typeof document !== 'undefined' && !!document.createElement;
const PI = Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** deterministic PRNG (mulberry32) */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** stable string/number -> uint32 seed */
export function hashSeed(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(Math.abs(v)) >>> 0;
  const s = String(v == null ? '' : v);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// proportions (metres). group origin is at the feet, Y up, character faces -Z.
// ---------------------------------------------------------------------------
const P = {
  height: 1.80,
  radius: 0.34,
  hipY: 0.98,         // root/pelvis joint height
  spine: 0.06,        // hips -> torso joint
  chest: 0.40,        // torso joint -> shoulder line
  neck: 0.46,         // torso joint -> neck joint
  headR: 0.118,       // head sphere radius (≈0.24 m diameter)
  shoulderX: 0.19,    // shoulder joint offset (mesh spans ~0.45 m)
  upperArm: 0.30,
  foreArm: 0.27,
  hand: 0.11,
  hipX: 0.095,
  thigh: 0.45,
  shin: 0.42,
  ankleY: 0.09,
};

// ---------------------------------------------------------------------------
// shared caches (geometry + canvas textures + npc materials)
// ---------------------------------------------------------------------------
const geoCache = new Map();
const texCache = new Map();
const matCache = new Map();

function getGeo(key, factory) {
  let g = geoCache.get(key);
  if (!g) { g = factory(); g.userData.shared = true; geoCache.set(key, g); }
  return g;
}
function getTex(key, factory) {
  if (!HAS_DOM) return null;
  if (texCache.has(key)) return texCache.get(key);
  let t = null;
  try { t = factory(); } catch (e) { t = null; }
  if (t) { t.userData = t.userData || {}; t.userData.shared = true; }
  texCache.set(key, t);
  return t;
}

/** merge a list of non-indexed-able geometries into one (position/normal/uv only). */
function mergeGeos(geos) {
  const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of list) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o3 = 0, o2 = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o2);
    o3 += n * 3; o2 += n * 2;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  for (let i = 0; i < list.length; i++) {
    if (list[i] !== geos[i]) list[i].dispose();
    geos[i].dispose();
  }
  return out;
}

// ---------------------------------------------------------------------------
// canvas textures
// ---------------------------------------------------------------------------
function canvas2d(w, h) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext && c.getContext('2d');
  if (!ctx) return null;
  return { c, ctx };
}
function finishTex(c, repeat) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

/** subtle fabric/panel texture used on most suits */
function suitTexture(base, accent, kind) {
  return getTex(`suit:${base}:${accent}:${kind}`, () => {
    const cc = canvas2d(128, 128); if (!cc) return null;
    const { c, ctx } = cc;
    ctx.fillStyle = base; ctx.fillRect(0, 0, 128, 128);
    ctx.globalAlpha = 0.16; ctx.fillStyle = '#000';
    for (let i = 0; i < 128; i += 8) ctx.fillRect(0, i, 128, 1);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent; ctx.lineWidth = 4;
    if (kind === 'stripe') {
      for (let i = -128; i < 256; i += 44) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 40, 128); ctx.stroke(); }
    } else if (kind === 'chevron') {
      ctx.lineWidth = 7;
      for (let k = 0; k < 3; k++) {
        const y = 22 + k * 36;
        ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(64, y + 28); ctx.lineTo(118, y); ctx.stroke();
      }
    } else if (kind === 'sash') {
      ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(-10, 96); ctx.lineTo(138, 30); ctx.stroke();
    } else if (kind === 'panel') {
      ctx.lineWidth = 3; ctx.globalAlpha = 0.75;
      ctx.strokeRect(20, 14, 88, 100);
      ctx.beginPath(); ctx.moveTo(64, 14); ctx.lineTo(64, 114); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (kind === 'facet') {
      ctx.globalAlpha = 0.35;
      for (let i = 0; i < 22; i++) {
        ctx.beginPath();
        ctx.moveTo(Math.random() * 128, Math.random() * 128);
        ctx.lineTo(Math.random() * 128, Math.random() * 128);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    return finishTex(c, [1, 1]);
  });
}

/** simple face: eyes/brows/mouth positioned for SphereGeometry UVs (face at u≈0.75) */
function faceTexture(skin, eye, brow, mouthW) {
  return getTex(`face:${skin}:${eye}:${brow}:${mouthW}`, () => {
    const cc = canvas2d(128, 64); if (!cc) return null;
    const { c, ctx } = cc;
    ctx.fillStyle = skin; ctx.fillRect(0, 0, 128, 64);
    // soft shading top/bottom
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.18)'); g.addColorStop(0.45, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 64);
    const cx = 96, cy = 25;
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#f4f0ea';
      ctx.beginPath(); ctx.ellipse(cx + s * 9, cy, 5.2, 3.2, 0, 0, PI * 2); ctx.fill();
      ctx.fillStyle = eye;
      ctx.beginPath(); ctx.arc(cx + s * 9, cy, 2.4, 0, PI * 2); ctx.fill();
      ctx.fillStyle = '#20170f';
      ctx.beginPath(); ctx.arc(cx + s * 9, cy, 1.1, 0, PI * 2); ctx.fill();
      ctx.strokeStyle = brow; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx + s * 4, cy - 6.5); ctx.lineTo(cx + s * 14, cy - 8.2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(80,40,35,0.65)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - mouthW, 40); ctx.lineTo(cx + mouthW, 40); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.beginPath(); ctx.moveTo(cx, 28); ctx.lineTo(cx, 36); ctx.stroke();
    return finishTex(c, null);
  });
}

/** Wolverine cowl: yellow with black stripes */
function maskTexture(base, stripe) {
  return getTex(`mask:${base}:${stripe}`, () => {
    const cc = canvas2d(128, 64); if (!cc) return null;
    const { c, ctx } = cc;
    ctx.fillStyle = base; ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = stripe;
    ctx.fillRect(0, 0, 128, 10);                 // crown band
    ctx.fillRect(78, 10, 8, 34); ctx.fillRect(106, 10, 8, 34); // side stripes toward the points
    ctx.globalAlpha = 0.5; ctx.fillStyle = '#000';
    ctx.fillRect(0, 52, 128, 12);
    ctx.globalAlpha = 1;
    return finishTex(c, null);
  });
}

// ---------------------------------------------------------------------------
// portraits (96×96 data URLs)
// ---------------------------------------------------------------------------
function drawPortrait(spec) {
  if (!HAS_DOM) return '';
  const cc = canvas2d(96, 96); if (!cc) return '';
  const { c, ctx } = cc;
  const g = ctx.createLinearGradient(0, 0, 0, 96);
  g.addColorStop(0, spec.color); g.addColorStop(1, '#101318');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(0, 70, 96, 26);
  // shoulders
  ctx.fillStyle = spec.suit;
  ctx.beginPath(); ctx.ellipse(48, 104, 40, 30, 0, 0, PI * 2); ctx.fill();
  // hair mass behind
  ctx.fillStyle = spec.hair;
  ctx.beginPath(); ctx.ellipse(48, 46, 28, 32, 0, 0, PI * 2); ctx.fill();
  if (spec.longHair) { ctx.beginPath(); ctx.ellipse(48, 68, 30, 26, 0, 0, PI * 2); ctx.fill(); }
  // face
  ctx.fillStyle = spec.skin;
  ctx.beginPath(); ctx.ellipse(48, 48, 21, 25, 0, 0, PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(48, 64, 14, 12, 0, 0, PI * 2); ctx.fill();
  // hair front
  ctx.fillStyle = spec.hair;
  ctx.beginPath(); ctx.ellipse(48, 32, 24, 15, 0, 0, PI * 2); ctx.fill();
  if (spec.points) {
    ctx.beginPath(); ctx.moveTo(24, 34); ctx.lineTo(12, 8); ctx.lineTo(34, 26); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(72, 34); ctx.lineTo(84, 8); ctx.lineTo(62, 26); ctx.closePath(); ctx.fill();
  }
  if (spec.mask) {
    ctx.fillStyle = spec.mask;
    ctx.beginPath(); ctx.ellipse(48, 38, 23, 17, 0, 0, PI * 2); ctx.fill();
    ctx.fillStyle = '#15171c';
    ctx.fillRect(26, 22, 5, 18); ctx.fillRect(65, 22, 5, 18);
  }
  if (spec.visor) {
    ctx.fillStyle = '#1b2647'; ctx.fillRect(24, 42, 48, 11);
    ctx.fillStyle = spec.visor; ctx.fillRect(27, 45, 42, 5);
    ctx.shadowColor = spec.visor; ctx.shadowBlur = 10;
    ctx.fillRect(27, 45, 42, 5); ctx.shadowBlur = 0;
  } else {
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#f6f2ec';
      ctx.beginPath(); ctx.ellipse(48 + s * 8, 48, 4.6, 3, 0, 0, PI * 2); ctx.fill();
      ctx.fillStyle = spec.eye || '#3a2a1c';
      ctx.beginPath(); ctx.arc(48 + s * 8, 48, 2.1, 0, PI * 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(70,35,30,0.7)'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(42, 60); ctx.lineTo(54, 60); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 94, 94);
  try { return c.toDataURL('image/png'); } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------
// costume definitions
// ---------------------------------------------------------------------------
const SKIN = { pale: '#e8c4a6', light: '#e0b492', tan: '#cd9c73', mid: '#b07a4f', deep: '#7c5232', rich: '#5b3a24' };

const COSTUMES = {
  wolverine: {
    primary: '#f2c200', secondary: '#1d3fa5', accent: '#1a1a1e', trim: '#8c6a12',
    skin: SKIN.tan, hair: '#211a14', eye: '#3a2a1a',
    suitKind: 'stripe', hairStyle: 'points',
    headgear: 'cowl', claws: true, beltColor: '#5a3a16',
  },
  quicksilver: {
    primary: '#7fd0ff', secondary: '#f2f6fb', accent: '#2f6f9e', trim: '#cfe8f7',
    skin: SKIN.pale, hair: '#dfe6ee', eye: '#6a8fa8',
    suitKind: 'chevron', hairStyle: 'swept', beltColor: '#f2f6fb',
  },
  jean: {
    primary: '#2fa84f', secondary: '#e8c33a', accent: '#1b6b32', trim: '#f2d96a',
    skin: SKIN.light, hair: '#a8321a', eye: '#2f6b4a',
    suitKind: 'sash', hairStyle: 'long', beltColor: '#e8c33a',
  },
  cyclops: {
    primary: '#21356b', secondary: '#c72d2d', accent: '#e8c33a', trim: '#16224a',
    skin: SKIN.light, hair: '#4a3524', eye: '#7a6a55',
    suitKind: 'panel', hairStyle: 'short', headgear: 'visor', beltColor: '#e8c33a',
  },
  emma: {
    primary: '#ffffff', secondary: '#eaeaf0', accent: '#d8d2c0', trim: '#f7f5ef',
    skin: SKIN.pale, hair: '#efe6cf', eye: '#7fa9c7',
    suitKind: 'panel', hairStyle: 'longStraight', diamond: true, beltColor: '#e6e2d6',
  },
};

/**
 * Playable roster. Colours/hp/speed/jump/abilities are the contract in docs/SPEC.md.
 * `portrait` is a 96×96 PNG data URL in the browser, '' in Node.
 */
export const CHARACTERS = {
  wolverine: {
    id: 'wolverine', name: 'Wolverine', color: '#f2c200', hp: 160, speed: 7, jump: 5.5,
    abilities: ['claws', 'regen'], portrait: '',
    description: 'Adamantium claws, a bad attitude and a healing factor — the heaviest hitter in Mountain Home.',
  },
  quicksilver: {
    id: 'quicksilver', name: 'Quicksilver', color: '#7fd0ff', hp: 100, speed: 13, jump: 5,
    abilities: ['dash', 'slowmo'], portrait: '',
    description: 'Silver blur down Highway 62 — dashes 25 m at a time and drags the world into slow motion.',
  },
  jean: {
    id: 'jean', name: 'Jean Grey', color: '#2fa84f', hp: 110, speed: 6.5, jump: 5,
    abilities: ['telekinesis', 'hover'], portrait: '',
    description: 'Telekinetic: lifts cars, benches and goons, and hovers above the courthouse square.',
  },
  cyclops: {
    id: 'cyclops', name: 'Cyclops', color: '#c72d2d', hp: 120, speed: 7, jump: 5,
    abilities: ['blast', 'sweep'], portrait: '',
    description: 'Field leader with a ruby visor — a sustained optic beam and a wide sweeping burst.',
  },
  emma: {
    id: 'emma', name: 'Emma Frost', color: '#ffffff', hp: 110, speed: 6.5, jump: 5,
    abilities: ['diamond', 'psychic'], portrait: '',
    description: 'Diamond form shrugs off damage; her psychic push turns the Brotherhood on each other.',
  },
};

// fill portraits (no-ops to '' in Node)
for (const id of Object.keys(CHARACTERS)) {
  const c = COSTUMES[id];
  CHARACTERS[id].portrait = drawPortrait({
    color: CHARACTERS[id].color, suit: c.primary, skin: c.skin, hair: c.hair, eye: c.eye,
    longHair: c.hairStyle === 'long' || c.hairStyle === 'longStraight',
    points: c.hairStyle === 'points',
    mask: c.headgear === 'cowl' ? c.primary : null,
    visor: c.headgear === 'visor' ? '#ff2b1c' : null,
  });
}

// ---------------------------------------------------------------------------
// pose buffer layout
// ---------------------------------------------------------------------------
const JOINT_ORDER = [
  'root', 'hips', 'torso', 'head',
  'upperArmL', 'upperArmR', 'forearmL', 'forearmR', 'handL', 'handR',
  'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR',
];
const J = {};
JOINT_ORDER.forEach((n, i) => { J[n] = i; });
const POSE_LEN = 3 + JOINT_ORDER.length * 3;
const newPose = () => new Float32Array(POSE_LEN);
function setJ(pose, j, x, y, z) { const k = 3 + j * 3; pose[k] = x; pose[k + 1] = y; pose[k + 2] = z; }
function addJ(pose, j, x, y, z) { const k = 3 + j * 3; pose[k] += x; pose[k + 1] += y; pose[k + 2] += z; }

// ---------------------------------------------------------------------------
// procedural animations — each writes a full pose into `o`
// `s` side factor: left = -1, right = +1. Positive X rotation swings a limb forward (-Z).
// ---------------------------------------------------------------------------
function poseIdle(o, t) {
  const br = Math.sin(t * 1.7);
  o[1] = 0.008 * br;
  setJ(o, J.root, 0, 0.035 * Math.sin(t * 0.63), 0);
  setJ(o, J.hips, 0.01 * br, 0.02 * Math.sin(t * 0.63 + 0.6), 0.012 * Math.sin(t * 0.5));
  setJ(o, J.torso, -0.02 + 0.02 * br, -0.02 * Math.sin(t * 0.63), 0);
  setJ(o, J.head, 0.03 * Math.sin(t * 0.9), 0.12 * Math.sin(t * 0.31), 0);
  for (const side of [-1, 1]) {
    const ua = side < 0 ? J.upperArmL : J.upperArmR;
    const fa = side < 0 ? J.forearmL : J.forearmR;
    setJ(o, ua, 0.04 * br, 0, side * (0.11 + 0.012 * br));
    setJ(o, fa, 0.22 + 0.03 * br, 0, side * 0.05);
  }
  setJ(o, J.thighL, 0, 0, -0.03); setJ(o, J.thighR, 0, 0, 0.03);
  setJ(o, J.shinL, -0.05, 0, 0); setJ(o, J.shinR, -0.05, 0, 0);
}

function poseLocomotion(o, t, speed, gain) {
  const sp = clamp(finite(speed, 4), 0.2, 22);
  const w = t * (2.3 + sp * 0.62);
  const amp = clamp(0.22 + sp * 0.055, 0.22, 1.05) * gain;
  const s = Math.sin(w), c = Math.cos(w);
  const lean = clamp(sp * 0.028, 0, 0.42) * gain;
  o[1] = -0.018 * amp * Math.abs(c) + 0.012 * amp;
  setJ(o, J.root, 0, 0, 0.02 * amp * s);
  setJ(o, J.hips, 0, -0.10 * amp * s, 0.04 * amp * c);
  setJ(o, J.torso, lean, 0.09 * amp * s, 0);
  setJ(o, J.head, -lean * 0.55, -0.05 * amp * s, 0);
  // legs
  setJ(o, J.thighL, s * amp, 0, -0.03);
  setJ(o, J.thighR, -s * amp, 0, 0.03);
  setJ(o, J.shinL, -(0.12 + 1.15 * amp * Math.max(0, -Math.sin(w + 0.75))), 0, 0);
  setJ(o, J.shinR, -(0.12 + 1.15 * amp * Math.max(0, Math.sin(w + 0.75))), 0, 0);
  setJ(o, J.footL, clamp(0.35 * amp * Math.sin(w + 1.9), -0.5, 0.5), 0, 0);
  setJ(o, J.footR, clamp(-0.35 * amp * Math.sin(w + 1.9), -0.5, 0.5), 0, 0);
  // arms counter-swing
  const aAmp = amp * 0.85;
  setJ(o, J.upperArmL, -s * aAmp + lean * 0.2, 0, -(0.10 + 0.05 * amp));
  setJ(o, J.upperArmR, s * aAmp + lean * 0.2, 0, (0.10 + 0.05 * amp));
  const bend = 0.30 + 0.85 * amp;
  setJ(o, J.forearmL, bend + 0.25 * Math.max(0, -s), 0, 0);
  setJ(o, J.forearmR, bend + 0.25 * Math.max(0, s), 0, 0);
}

function poseWalk(o, t, p) { poseLocomotion(o, t, p.speed != null ? p.speed : 3.2, 1); }
function poseRun(o, t, p) { poseLocomotion(o, t, p.speed != null ? p.speed : 7, 1.18); }
function poseSprint(o, t, p) {
  poseLocomotion(o, t, p.speed != null ? p.speed : 12, 1.35);
  addJ(o, J.torso, 0.18, 0, 0);
  addJ(o, J.head, -0.1, 0, 0);
}

function poseJump(o, t) {
  const crouch = t < 0.13 ? smoothstep(t / 0.13) : Math.max(0, 1 - (t - 0.13) / 0.10);
  const air = smoothstep((t - 0.17) / 0.25);
  o[1] = -0.24 * crouch + 0.03 * air;
  setJ(o, J.hips, 0.30 * crouch, 0, 0);
  setJ(o, J.torso, 0.42 * crouch - 0.10 * air, 0, 0);
  setJ(o, J.head, -0.20 * crouch + 0.12 * air, 0, 0);
  setJ(o, J.thighL, 1.05 * crouch + 0.38 * air, 0, -0.08);
  setJ(o, J.thighR, 1.05 * crouch + 0.30 * air, 0, 0.08);
  setJ(o, J.shinL, -1.55 * crouch - 0.70 * air, 0, 0);
  setJ(o, J.shinR, -1.55 * crouch - 0.50 * air, 0, 0);
  setJ(o, J.footL, 0.35 * crouch + 0.45 * air, 0, 0);
  setJ(o, J.footR, 0.35 * crouch + 0.45 * air, 0, 0);
  setJ(o, J.upperArmL, -0.9 * crouch + 2.1 * air, 0, -(0.2 + 0.35 * air));
  setJ(o, J.upperArmR, -0.9 * crouch + 2.1 * air, 0, (0.2 + 0.35 * air));
  setJ(o, J.forearmL, 0.55 * crouch + 0.30 * air, 0, 0);
  setJ(o, J.forearmR, 0.55 * crouch + 0.30 * air, 0, 0);
}

function poseFall(o, t) {
  const fl = Math.sin(t * 9) * 0.07;
  o[1] = 0.02;
  setJ(o, J.root, -0.06, 0.04 * Math.sin(t * 1.4), 0);
  setJ(o, J.torso, -0.12, 0.05 * Math.sin(t * 1.9), 0);
  setJ(o, J.head, 0.16, 0, 0);
  setJ(o, J.upperArmL, 0.30 + fl, 0, -1.10);
  setJ(o, J.upperArmR, 0.30 - fl, 0, 1.10);
  setJ(o, J.forearmL, 0.45, 0, -0.25);
  setJ(o, J.forearmR, 0.45, 0, 0.25);
  setJ(o, J.thighL, 0.28 + fl, 0, -0.20);
  setJ(o, J.thighR, 0.16 - fl, 0, 0.20);
  setJ(o, J.shinL, -0.85, 0, 0);
  setJ(o, J.shinR, -0.45, 0, 0);
  setJ(o, J.footL, 0.3, 0, 0); setJ(o, J.footR, 0.3, 0, 0);
}

function poseLand(o, t) {
  const c = 1 - smoothstep(clamp(t / 0.34, 0, 1));
  o[1] = -0.30 * c;
  setJ(o, J.hips, 0.34 * c, 0, 0);
  setJ(o, J.torso, 0.52 * c, 0, 0);
  setJ(o, J.head, -0.30 * c, 0, 0);
  setJ(o, J.thighL, 1.20 * c, 0, -0.16);
  setJ(o, J.thighR, 1.20 * c, 0, 0.16);
  setJ(o, J.shinL, -1.75 * c, 0, 0);
  setJ(o, J.shinR, -1.75 * c, 0, 0);
  setJ(o, J.footL, 0.55 * c, 0, 0); setJ(o, J.footR, 0.55 * c, 0, 0);
  setJ(o, J.upperArmL, 0.95 * c, 0, -0.55 * c - 0.1);
  setJ(o, J.upperArmR, 0.95 * c, 0, 0.55 * c + 0.1);
  setJ(o, J.forearmL, 0.9 * c + 0.2, 0, 0);
  setJ(o, J.forearmR, 0.9 * c + 0.2, 0, 0);
}

/** right-arm horizontal slash */
function poseAttack1(o, t) {
  const u = clamp(t / 0.35, 0, 1);
  const wind = u < 0.34 ? smoothstep(u / 0.34) : 1 - smoothstep((u - 0.34) / 0.30);
  const strike = u < 0.34 ? 0 : smoothstep((u - 0.34) / 0.40);
  o[2] = -0.10 * strike;
  setJ(o, J.root, 0, -0.55 * wind + 0.80 * strike, 0);
  setJ(o, J.hips, 0, -0.20 * wind + 0.30 * strike, 0);
  setJ(o, J.torso, 0.10 * strike, -0.45 * wind + 0.75 * strike, 0);
  setJ(o, J.head, 0.05, 0.30 * wind - 0.35 * strike, 0);
  setJ(o, J.upperArmR, -0.55 * wind + 1.45 * strike, -0.9 * wind + 0.5 * strike, 0.95 * wind + 0.30 * strike);
  setJ(o, J.forearmR, 1.35 * wind + 0.15, 0, -0.25 * strike);
  setJ(o, J.upperArmL, 0.35 * wind - 0.25 * strike, 0, -0.35 - 0.25 * wind);
  setJ(o, J.forearmL, 0.85, 0, -0.2);
  setJ(o, J.thighL, 0.22 * strike, 0, -0.05);
  setJ(o, J.thighR, -0.18 * strike, 0, 0.05);
  setJ(o, J.shinL, -0.30, 0, 0); setJ(o, J.shinR, -0.22, 0, 0);
}

/** left-arm backhand slash */
function poseAttack2(o, t) {
  const u = clamp(t / 0.35, 0, 1);
  const wind = u < 0.30 ? smoothstep(u / 0.30) : 1 - smoothstep((u - 0.30) / 0.32);
  const strike = u < 0.30 ? 0 : smoothstep((u - 0.30) / 0.42);
  o[2] = -0.08 * strike;
  setJ(o, J.root, 0, 0.55 * wind - 0.80 * strike, 0);
  setJ(o, J.hips, 0, 0.20 * wind - 0.28 * strike, 0);
  setJ(o, J.torso, 0.14 * strike, 0.45 * wind - 0.78 * strike, 0);
  setJ(o, J.head, 0.06, -0.28 * wind + 0.32 * strike, 0);
  setJ(o, J.upperArmL, -0.5 * wind + 1.55 * strike, 0.9 * wind - 0.5 * strike, -0.95 * wind - 0.30 * strike);
  setJ(o, J.forearmL, 1.25 * wind + 0.2, 0, 0.25 * strike);
  setJ(o, J.upperArmR, 0.35 * wind - 0.25 * strike, 0, 0.35 + 0.25 * wind);
  setJ(o, J.forearmR, 0.85, 0, 0.2);
  setJ(o, J.thighR, 0.22 * strike, 0, 0.05);
  setJ(o, J.thighL, -0.18 * strike, 0, -0.05);
  setJ(o, J.shinL, -0.22, 0, 0); setJ(o, J.shinR, -0.30, 0, 0);
}

/** two-handed overhead slam with a lunge */
function poseAttack3(o, t) {
  const u = clamp(t / 0.35, 0, 1);
  const wind = u < 0.38 ? smoothstep(u / 0.38) : 1 - smoothstep((u - 0.38) / 0.28);
  const slam = u < 0.38 ? 0 : smoothstep((u - 0.38) / 0.34);
  o[1] = 0.10 * wind - 0.16 * slam;
  o[2] = -0.45 * slam;
  setJ(o, J.root, -0.18 * wind + 0.30 * slam, 0, 0);
  setJ(o, J.hips, 0.10 * slam, 0, 0);
  setJ(o, J.torso, -0.30 * wind + 0.75 * slam, 0, 0);
  setJ(o, J.head, 0.25 * wind - 0.42 * slam, 0, 0);
  for (const side of [-1, 1]) {
    const ua = side < 0 ? J.upperArmL : J.upperArmR;
    const fa = side < 0 ? J.forearmL : J.forearmR;
    setJ(o, ua, 2.75 * wind - 1.6 * slam, 0, side * (0.32 + 0.25 * wind));
    setJ(o, fa, 0.30 + 0.55 * wind + 0.45 * slam, 0, 0);
  }
  setJ(o, J.thighL, 0.55 * slam, 0, -0.12);
  setJ(o, J.thighR, -0.25 * slam, 0, 0.12);
  setJ(o, J.shinL, -0.70 * slam - 0.15, 0, 0);
  setJ(o, J.shinR, -0.30, 0, 0);
  setJ(o, J.footL, 0.3 * slam, 0, 0); setJ(o, J.footR, 0.2 * slam, 0, 0);
}

function poseAbility(o, t, p, rig) {
  const id = rig ? rig.id : 'wolverine';
  const ramp = smoothstep(t / 0.22);
  const pulse = Math.sin(t * 6.5);
  if (id === 'jean') {
    o[1] = 0.05 * ramp + 0.02 * Math.sin(t * 2.1);
    setJ(o, J.torso, -0.16 * ramp, 0, 0);
    setJ(o, J.head, -0.22 * ramp, 0, 0);
    for (const s of [-1, 1]) {
      const ua = s < 0 ? J.upperArmL : J.upperArmR, fa = s < 0 ? J.forearmL : J.forearmR;
      setJ(o, ua, (2.45 + 0.06 * pulse) * ramp, 0, s * 0.42 * ramp);
      setJ(o, fa, -0.30 * ramp, 0, s * 0.18);
    }
    setJ(o, J.thighL, 0, 0, -0.06); setJ(o, J.thighR, 0, 0, 0.06);
    setJ(o, J.shinL, -0.08, 0, 0); setJ(o, J.shinR, -0.08, 0, 0);
  } else if (id === 'cyclops') {
    setJ(o, J.torso, 0.10 * ramp, -0.05 * ramp, 0);
    setJ(o, J.head, 0.06 * ramp, 0, 0);
    setJ(o, J.upperArmR, 1.55 * ramp, -0.55 * ramp, 0.30 * ramp);   // hand to visor
    setJ(o, J.forearmR, 1.95 * ramp, 0, -0.55 * ramp);
    setJ(o, J.handR, 0, 0, -0.3 * ramp);
    setJ(o, J.upperArmL, 0.25 * ramp, 0, -0.22);
    setJ(o, J.forearmL, 0.75, 0, 0);
    setJ(o, J.thighL, 0.16 * ramp, 0, -0.10);
    setJ(o, J.thighR, -0.12 * ramp, 0, 0.10);
    setJ(o, J.shinL, -0.22, 0, 0); setJ(o, J.shinR, -0.30, 0, 0);
    o[2] = -0.05 * ramp;
  } else if (id === 'emma') {
    setJ(o, J.torso, -0.06 * ramp, 0, 0);
    setJ(o, J.head, -0.10 * ramp, 0.05 * Math.sin(t * 1.6), 0);
    setJ(o, J.upperArmL, 1.15 * ramp, 0.25 * ramp, 0.55 * ramp);    // crossed arms
    setJ(o, J.upperArmR, 1.15 * ramp, -0.25 * ramp, -0.55 * ramp);
    setJ(o, J.forearmL, 1.55 * ramp, 0, 0.55 * ramp);
    setJ(o, J.forearmR, 1.55 * ramp, 0, -0.55 * ramp);
    setJ(o, J.thighL, 0, 0, -0.05); setJ(o, J.thighR, 0, 0, 0.05);
    setJ(o, J.shinL, -0.06, 0, 0); setJ(o, J.shinR, -0.06, 0, 0);
  } else if (id === 'quicksilver') {
    // crouched sprint-start
    const w = t * 16;
    o[1] = -0.16 * ramp;
    o[2] = -0.06 * ramp;
    setJ(o, J.torso, 0.85 * ramp, 0.10 * Math.sin(w), 0);
    setJ(o, J.head, -0.55 * ramp, 0, 0);
    setJ(o, J.thighL, (0.95 + 0.5 * Math.sin(w)) * ramp, 0, -0.08);
    setJ(o, J.thighR, (0.55 - 0.5 * Math.sin(w)) * ramp, 0, 0.08);
    setJ(o, J.shinL, -1.25 * ramp, 0, 0);
    setJ(o, J.shinR, -0.75 * ramp, 0, 0);
    setJ(o, J.footL, 0.45 * ramp, 0, 0); setJ(o, J.footR, 0.35 * ramp, 0, 0);
    setJ(o, J.upperArmL, (-1.05 - 0.4 * Math.sin(w)) * ramp, 0, -0.18);
    setJ(o, J.upperArmR, (-1.05 + 0.4 * Math.sin(w)) * ramp, 0, 0.18);
    setJ(o, J.forearmL, 1.35 * ramp, 0, 0); setJ(o, J.forearmR, 1.35 * ramp, 0, 0);
  } else {
    // wolverine berserker stance
    const sh = Math.sin(t * 24) * 0.035;
    o[1] = -0.12 * ramp;
    setJ(o, J.root, 0, sh, 0);
    setJ(o, J.hips, 0.16 * ramp, 0, 0);
    setJ(o, J.torso, 0.45 * ramp, sh * 2, 0);
    setJ(o, J.head, -0.30 * ramp, -sh * 3, 0);
    setJ(o, J.upperArmL, (0.45 + sh) * ramp, 0.35 * ramp, -0.95 * ramp);
    setJ(o, J.upperArmR, (0.45 - sh) * ramp, -0.35 * ramp, 0.95 * ramp);
    setJ(o, J.forearmL, 0.95 * ramp, 0, -0.25);
    setJ(o, J.forearmR, 0.95 * ramp, 0, 0.25);
    setJ(o, J.thighL, 0.42 * ramp, 0, -0.22);
    setJ(o, J.thighR, 0.42 * ramp, 0, 0.22);
    setJ(o, J.shinL, -0.75 * ramp, 0, 0);
    setJ(o, J.shinR, -0.75 * ramp, 0, 0);
    setJ(o, J.footL, 0.3 * ramp, 0, 0); setJ(o, J.footR, 0.3 * ramp, 0, 0);
  }
}

function poseHurt(o, t) {
  const k = Math.max(0, 1 - t / 0.32) * (0.6 + 0.4 * Math.cos(t * 30));
  o[2] = 0.10 * k;
  setJ(o, J.root, -0.12 * k, 0.10 * k, 0.05 * k);
  setJ(o, J.hips, -0.10 * k, 0, 0);
  setJ(o, J.torso, -0.38 * k, 0.16 * k, 0);
  setJ(o, J.head, -0.34 * k, 0.22 * k, 0);
  setJ(o, J.upperArmL, -0.35 * k, 0, 0.35 * k - 0.12);
  setJ(o, J.upperArmR, -0.35 * k, 0, -0.35 * k + 0.12);
  setJ(o, J.forearmL, 1.15 * k + 0.25, 0, 0);
  setJ(o, J.forearmR, 1.15 * k + 0.25, 0, 0);
  setJ(o, J.thighL, -0.22 * k, 0, -0.06);
  setJ(o, J.thighR, -0.12 * k, 0, 0.06);
  setJ(o, J.shinL, -0.25 * k - 0.05, 0, 0);
  setJ(o, J.shinR, -0.35 * k - 0.05, 0, 0);
}

function poseDead(o, t) {
  const u = smoothstep(clamp(t / 0.85, 0, 1));
  const settle = smoothstep(clamp((t - 0.5) / 0.9, 0, 1));
  o[1] = -(P.hipY - 0.14) * u;
  o[2] = 0.18 * u;
  setJ(o, J.root, 1.50 * u, 0.22 * u, 0.10 * u);
  setJ(o, J.hips, -0.12 * u, 0, 0);
  setJ(o, J.torso, -0.20 * u, 0.10 * u, 0);
  setJ(o, J.head, 0.32 * u - 0.12 * settle, 0.42 * u, 0);
  setJ(o, J.upperArmL, -0.45 * u, 0, -1.05 * u);
  setJ(o, J.upperArmR, -0.25 * u, 0, 0.85 * u);
  setJ(o, J.forearmL, 0.55 * u, 0, -0.35 * u);
  setJ(o, J.forearmR, 0.30 * u, 0, 0.25 * u);
  setJ(o, J.thighL, -0.18 * u, 0, -0.28 * u);
  setJ(o, J.thighR, -0.10 * u, 0, 0.18 * u);
  setJ(o, J.shinL, -0.55 * u, 0, 0);
  setJ(o, J.shinR, -0.30 * u, 0, 0);
  setJ(o, J.footL, 0.25 * u, 0, 0); setJ(o, J.footR, 0.18 * u, 0, 0);
}

function poseSkydive(o, t) {
  const fl = Math.sin(t * 13) * 0.09;
  const fl2 = Math.sin(t * 11 + 1.3) * 0.09;
  setJ(o, J.root, -1.38 + 0.05 * Math.sin(t * 1.7), 0.08 * Math.sin(t * 0.9), 0.06 * Math.sin(t * 1.3));
  setJ(o, J.hips, 0.12, 0, 0);
  setJ(o, J.torso, -0.28 + 0.04 * fl, 0.05 * Math.sin(t * 1.1), 0);
  setJ(o, J.head, -0.45, 0.08 * Math.sin(t * 0.8), 0);
  setJ(o, J.upperArmL, 0.55 + fl, -0.15, -1.32);
  setJ(o, J.upperArmR, 0.55 + fl2, 0.15, 1.32);
  setJ(o, J.forearmL, 0.95 + fl * 0.5, 0, -0.45);
  setJ(o, J.forearmR, 0.95 + fl2 * 0.5, 0, 0.45);
  setJ(o, J.handL, 0, 0, -0.3); setJ(o, J.handR, 0, 0, 0.3);
  setJ(o, J.thighL, 0.30 + fl2 * 0.4, 0, -0.42);
  setJ(o, J.thighR, 0.30 + fl * 0.4, 0, 0.42);
  setJ(o, J.shinL, -1.05 - fl * 0.5, 0, 0);
  setJ(o, J.shinR, -1.05 - fl2 * 0.5, 0, 0);
  setJ(o, J.footL, 0.35, 0, 0); setJ(o, J.footR, 0.35, 0, 0);
}

function poseHover(o, t) {
  const b = Math.sin(t * 1.25);
  o[1] = 0.10 + 0.045 * b;
  setJ(o, J.root, -0.06 + 0.02 * b, 0.05 * Math.sin(t * 0.55), 0);
  setJ(o, J.hips, 0.05, 0, 0);
  setJ(o, J.torso, -0.10 - 0.02 * b, 0, 0);
  setJ(o, J.head, 0.06, 0.08 * Math.sin(t * 0.7), 0);
  setJ(o, J.upperArmL, 0.20 + 0.05 * b, 0, -0.62);
  setJ(o, J.upperArmR, 0.20 - 0.05 * b, 0, 0.62);
  setJ(o, J.forearmL, 0.28, 0, -0.20);
  setJ(o, J.forearmR, 0.28, 0, 0.20);
  setJ(o, J.thighL, -0.10, 0, 0.015);   // legs together
  setJ(o, J.thighR, -0.10, 0, -0.015);
  setJ(o, J.shinL, 0.06, 0, 0); setJ(o, J.shinR, 0.06, 0, 0);
  setJ(o, J.footL, -0.55, 0, 0); setJ(o, J.footR, -0.55, 0, 0);  // toes pointed
}

const ANIMS = {
  idle: poseIdle, walk: poseWalk, run: poseRun, sprint: poseSprint,
  jump: poseJump, fall: poseFall, land: poseLand,
  attack1: poseAttack1, attack2: poseAttack2, attack3: poseAttack3,
  ability: poseAbility, hurt: poseHurt, dead: poseDead,
  skydive: poseSkydive, hover: poseHover,
};
/** nominal length in seconds; `loop:false` states hold their final pose */
export const ANIM_INFO = {
  idle: { dur: 0, loop: true }, walk: { dur: 0, loop: true }, run: { dur: 0, loop: true },
  sprint: { dur: 0, loop: true }, jump: { dur: 0.42, loop: false }, fall: { dur: 0, loop: true },
  land: { dur: 0.34, loop: false }, attack1: { dur: 0.35, loop: false }, attack2: { dur: 0.35, loop: false },
  attack3: { dur: 0.35, loop: false }, ability: { dur: 0, loop: true }, hurt: { dur: 0.32, loop: false },
  dead: { dur: 1.4, loop: false }, skydive: { dur: 0, loop: true }, hover: { dur: 0, loop: true },
};
export const ANIM_NAMES = Object.keys(ANIMS);
const BLEND_TIME = 0.15;

// ---------------------------------------------------------------------------
// geometry builders (all cached)
// ---------------------------------------------------------------------------
function capsule(key, r, len, rs = 8, cs = 3) {
  return getGeo(key, () => new THREE.CapsuleGeometry(r, len, cs, rs));
}
function headGeo() {
  return getGeo('head', () => {
    const g = new THREE.SphereGeometry(P.headR, 20, 14);
    g.scale(0.95, 1.06, 1.0);
    return g;
  });
}
function jawGeo() {
  return getGeo('jaw', () => {
    const jaw = new THREE.SphereGeometry(P.headR * 0.82, 14, 10);
    jaw.scale(0.86, 0.62, 0.94);
    jaw.translate(0, -0.058, 0.010);
    const nose = new THREE.CylinderGeometry(0.004, 0.019, 0.045, 6);
    nose.rotateX(PI * 0.5);
    nose.translate(0, 0.022, -P.headR * 0.92);
    const ears = [];
    for (const s of [-1, 1]) {
      const e = new THREE.SphereGeometry(0.026, 8, 6);
      e.scale(0.45, 1.0, 0.75);
      e.translate(s * P.headR * 0.95, -0.005, 0.012);
      ears.push(e);
    }
    return mergeGeos([jaw, nose, ...ears]);
  });
}
function hairGeo(style) {
  return getGeo(`hair:${style}`, () => {
    const parts = [];
    const cap = new THREE.SphereGeometry(P.headR * 1.06, 16, 12, 0, PI * 2, 0, PI * 0.62);
    cap.scale(1.0, 1.0, 1.05);
    cap.translate(0, 0.012, 0.004);
    parts.push(cap);
    if (style === 'points') {
      for (const s of [-1, 1]) {
        const spike = new THREE.CylinderGeometry(0.004, 0.045, 0.20, 6);
        spike.rotateZ(s * 0.95);
        spike.rotateX(0.18);
        spike.translate(s * 0.105, 0.055, 0.018);
        parts.push(spike);
      }
      const back = new THREE.SphereGeometry(P.headR * 0.9, 12, 8, 0, PI * 2, 0, PI * 0.55);
      back.scale(0.9, 0.7, 0.8); back.rotateX(1.9); back.translate(0, -0.02, 0.075);
      parts.push(back);
    } else if (style === 'swept') {
      const swept = new THREE.SphereGeometry(P.headR * 0.95, 14, 10);
      swept.scale(0.92, 0.62, 1.25);
      swept.translate(0, 0.055, 0.055);
      parts.push(swept);
      for (const s of [-1, 0.4]) {
        const sp = new THREE.CylinderGeometry(0.006, 0.030, 0.13, 5);
        sp.rotateX(-1.15); sp.rotateZ(s * 0.25);
        sp.translate(s * 0.055, 0.085, 0.085);
        parts.push(sp);
      }
    } else if (style === 'long' || style === 'longStraight') {
      const wide = style === 'longStraight' ? 1.12 : 1.02;
      const mass = new THREE.CapsuleGeometry(P.headR * 0.92, 0.26, 4, 12);
      mass.scale(wide, 1.0, 0.62);
      mass.translate(0, -0.20, 0.045);
      parts.push(mass);
      const back = new THREE.SphereGeometry(P.headR * 1.02, 14, 10);
      back.scale(wide, 0.95, 0.85);
      back.translate(0, -0.03, 0.03);
      parts.push(back);
      for (const s of [-1, 1]) {
        const lock = new THREE.CapsuleGeometry(0.036, 0.22, 3, 8);
        lock.scale(0.7, 1, 0.7);
        lock.translate(s * (P.headR * 0.92), -0.14, -0.012);
        parts.push(lock);
      }
      if (style === 'long') {
        const fringe = new THREE.SphereGeometry(P.headR * 0.9, 12, 8);
        fringe.scale(0.95, 0.35, 0.55);
        fringe.translate(0, 0.055, -0.055);
        parts.push(fringe);
      }
    } else if (style === 'bob') {
      const mass = new THREE.SphereGeometry(P.headR * 1.05, 14, 10);
      mass.scale(1.02, 0.95, 0.98);
      mass.translate(0, -0.03, 0.01);
      parts.push(mass);
    } else {
      // 'short'
      const back = new THREE.SphereGeometry(P.headR * 1.0, 12, 8);
      back.scale(0.98, 0.72, 0.98);
      back.translate(0, 0.012, 0.012);
      parts.push(back);
    }
    return mergeGeos(parts);
  });
}
function cowlGeo() {
  return getGeo('cowl', () => {
    const cap = new THREE.SphereGeometry(P.headR * 1.045, 18, 12, 0, PI * 2, 0, PI * 0.72);
    cap.scale(1.0, 1.08, 1.02);
    return cap;
  });
}
function visorGeo() {
  return getGeo('visor', () => {
    const band = new THREE.CylinderGeometry(P.headR * 1.02, P.headR * 1.02, 0.052, 18, 1, true, PI * 0.60, PI * 0.80);
    const front = new THREE.BoxGeometry(0.09, 0.05, 0.02);
    front.translate(0, 0, -P.headR * 1.0);
    return mergeGeos([band, front]);
  });
}
function maskGeo() { // simple balaclava for thugs
  return getGeo('thugmask', () => {
    const g = new THREE.SphereGeometry(P.headR * 1.04, 16, 12, 0, PI * 2, 0, PI * 0.80);
    g.scale(1.0, 1.1, 1.0);
    return g;
  });
}
function hatGeo(kind) {
  return getGeo(`hat:${kind}`, () => {
    const parts = [];
    if (kind === 'campaign' || kind === 'bucket') {
      const brim = new THREE.CylinderGeometry(0.20, 0.21, 0.014, 16);
      brim.translate(0, 0.10, 0);
      const crown = new THREE.CylinderGeometry(0.105, 0.125, kind === 'bucket' ? 0.10 : 0.13, 14);
      crown.translate(0, 0.10 + (kind === 'bucket' ? 0.05 : 0.065), 0);
      parts.push(brim, crown);
    } else { // cap
      const crown = new THREE.SphereGeometry(P.headR * 1.07, 14, 10, 0, PI * 2, 0, PI * 0.52);
      crown.translate(0, 0.02, 0);
      const bill = new THREE.CylinderGeometry(0.115, 0.115, 0.012, 14, 1, false, PI * 0.62, PI * 0.76);
      bill.scale(1, 1, 1.5);
      bill.translate(0, 0.048, -0.03);
      parts.push(crown, bill);
    }
    return mergeGeos(parts);
  });
}
function torsoGeo(kind) {
  return getGeo(`torso:${kind}`, () => {
    const chest = new THREE.CapsuleGeometry(0.15, 0.28, 4, 14);
    chest.scale(kind === 'f' ? 1.34 : 1.5, 1.0, 0.76);
    chest.translate(0, 0.22, 0);
    const neck = new THREE.CylinderGeometry(0.052, 0.062, 0.09, 10);
    neck.translate(0, 0.435, 0);
    const shoulders = [];
    for (const s of [-1, 1]) {
      const d = new THREE.SphereGeometry(0.082, 10, 8);
      d.scale(1.0, 0.9, 0.9);
      d.translate(s * P.shoulderX, P.chest, 0);
      shoulders.push(d);
    }
    return mergeGeos([chest, neck, ...shoulders]);
  });
}
function hipsGeo(kind) {
  return getGeo(`hips:${kind}`, () => {
    const g = new THREE.CapsuleGeometry(0.125, 0.09, 4, 12);
    g.scale(kind === 'f' ? 1.34 : 1.2, 0.95, 0.80);
    g.translate(0, 0.015, 0);
    return g;
  });
}
function beltGeo() {
  return getGeo('belt', () => {
    const band = new THREE.CylinderGeometry(0.165, 0.175, 0.075, 16, 1, true);
    band.scale(1.05, 1, 0.82);
    const buckle = new THREE.BoxGeometry(0.085, 0.058, 0.03);
    buckle.translate(0, 0, -0.145);
    return mergeGeos([band, buckle]);
  });
}
function handGeo() {
  return getGeo('hand', () => {
    const palm = new THREE.BoxGeometry(0.052, 0.10, 0.085);
    palm.translate(0, -0.052, 0);
    const thumb = new THREE.CylinderGeometry(0.016, 0.014, 0.05, 6);
    thumb.rotateZ(0.6); thumb.translate(0.026, -0.036, -0.018);
    return mergeGeos([palm, thumb]);
  });
}
function footGeo() {
  return getGeo('foot', () => {
    const boot = new THREE.BoxGeometry(0.105, 0.09, 0.255);
    boot.translate(0, -0.045, -0.052);
    const toe = new THREE.SphereGeometry(0.052, 10, 8);
    toe.scale(1.0, 0.75, 1.0);
    toe.translate(0, -0.048, -0.165);
    const heel = new THREE.BoxGeometry(0.095, 0.062, 0.075);
    heel.translate(0, -0.06, 0.055);
    return mergeGeos([boot, toe, heel]);
  });
}
function clawsGeo() {
  return getGeo('claws', () => {
    const blades = [];
    for (let i = -1; i <= 1; i++) {
      const b = new THREE.CylinderGeometry(0.0035, 0.012, 0.30, 4);
      b.rotateX(-PI * 0.5);           // +Y -> -Z (forward)
      b.translate(i * 0.028, 0, -0.15);
      b.rotateY(i * 0.05);
      blades.push(b);
    }
    return mergeGeos(blades);
  });
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------
function stdMat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: opts.roughness != null ? opts.roughness : 0.72,
    metalness: opts.metalness != null ? opts.metalness : 0.05,
    map: opts.map || null,
    emissive: new THREE.Color(opts.emissive || 0x000000),
    emissiveIntensity: opts.emissiveIntensity != null ? opts.emissiveIntensity : 1,
    flatShading: !!opts.flatShading,
    side: opts.side || THREE.FrontSide,
  });
}
function cachedMat(key, factory) {
  let m = matCache.get(key);
  if (!m) { m = factory(); m.userData.shared = true; matCache.set(key, m); }
  return m;
}
function makeDiamondMat() {
  return stdMat('#dff3ff', {
    roughness: 0.07, metalness: 0.92, flatShading: true,
    emissive: 0x6fa8d8, emissiveIntensity: 0.42,
    map: suitTexture('#dff3ff', '#ffffff', 'facet'),
  });
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------
export class Rig {
  constructor(cfg) {
    this.id = cfg.id || 'npc';
    this.kind = cfg.kind || 'npc';
    this.scheme = cfg;
    this.height = P.height * (cfg.scale || 1);
    this.radius = P.radius * (cfg.scale || 1);
    this.anim = 'idle';
    this.animTime = 0;
    this.animDone = false;
    this.params = {};
    this.time = 0;

    this._pose = newPose();
    this._target = newPose();
    this._from = newPose();
    this._blend = 1;
    this._mats = [];          // rig-owned materials (disposed)
    this._bodyMats = [];      // materials swapped by diamond form
    this._clawMeshes = [];
    this._claw = 0;           // current extension 0..1
    this._clawTarget = 0;
    this._clawLock = false;
    this._visor = null;
    this._visorGlow = 0;
    this.diamond = false;
    this.meshes = {};
    this.parts = {};

    this.group = new THREE.Group();
    this.group.name = `rig_${this.id}`;
    if (cfg.scale && cfg.scale !== 1) this.group.scale.setScalar(cfg.scale);
    this._build(cfg);
    this._joints = JOINT_ORDER.map((n) => this.parts[n] || null);
    this.setAnim('idle');
    this._blend = 1;
    this.update(0);
  }

  // --- construction --------------------------------------------------------
  _joint(name, parent, x, y, z) {
    const o = new THREE.Group();
    o.name = name;
    o.position.set(x, y, z);
    parent.add(o);
    this.parts[name] = o;
    return o;
  }
  _mesh(name, joint, geo, mat, pos) {
    const m = new THREE.Mesh(geo, mat);
    m.name = `${name}_mesh`;
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    m.castShadow = true; m.receiveShadow = false;
    joint.add(m);
    this.meshes[name] = m;
    return m;
  }

  _build(cfg) {
    // heroes own their materials (per-rig visor/diamond tweaks); NPCs share them from a cache
    const shared = cfg.kind !== 'hero';
    this._sharedMats = shared;
    const own = (m) => { if (!shared) this._mats.push(m); return m; };
    const mk = (key, factory) => (shared ? cachedMat(key, factory) : own(factory()));
    const body = (m) => { this._bodyMats.push(m); return m; };
    const eye = cfg.eye || '#3a2a1c';

    const skinMat = mk(`skin:${cfg.skin}:${eye}:${cfg.hair}:${cfg.mouthW || 7}`,
      () => stdMat(cfg.skin, { roughness: 0.82, map: faceTexture(cfg.skin, eye, cfg.brow || cfg.hair, cfg.mouthW || 7) }));
    const plainSkin = mk(`skinp:${cfg.skin}`, () => stdMat(cfg.skin, { roughness: 0.82 }));
    const hairMat = mk(`hair:${cfg.hair}`, () => stdMat(cfg.hair, { roughness: 0.58, metalness: 0.12 }));
    const primMat = body(mk(`prim:${cfg.primary}:${cfg.secondary}:${cfg.suitKind}`,
      () => stdMat(cfg.primary, { roughness: 0.62, map: suitTexture(cfg.primary, cfg.secondary, cfg.suitKind || 'panel') })));
    const secMat = body(mk(`sec:${cfg.secondary}`, () => stdMat(cfg.secondary, { roughness: 0.60 })));
    const accMat = body(mk(`acc:${cfg.accent}`, () => stdMat(cfg.accent, { roughness: 0.45, metalness: 0.25 })));
    const legMat = body(mk(`leg:${cfg.legColor || cfg.primary}`, () => stdMat(cfg.legColor || cfg.primary, { roughness: 0.66 })));
    const beltMat = mk(`belt:${cfg.beltColor || cfg.accent}`, () => stdMat(cfg.beltColor || cfg.accent, { roughness: 0.4, metalness: 0.4 }));
    this._skinMats = [skinMat, plainSkin];
    this._hairMat = hairMat;
    this._matRefs = { primMat, secMat, accMat, legMat, beltMat, skinMat, plainSkin, hairMat };

    const gender = cfg.gender === 'f' ? 'f' : 'm';

    // root -> hips -> { torso -> {head, arms}, legs }
    const root = this._joint('root', this.group, 0, P.hipY, 0);
    const hips = this._joint('hips', root, 0, 0, 0);
    this._mesh('hips', hips, hipsGeo(gender), legMat);
    this._mesh('belt', hips, beltGeo(), beltMat, [0, 0.045, 0]);

    const torso = this._joint('torso', hips, 0, P.spine, 0);
    this._mesh('torso', torso, torsoGeo(gender), primMat);

    const head = this._joint('head', torso, 0, P.neck, 0);
    this._mesh('head', head, headGeo(), skinMat, [0, 0.118, 0]);
    this._mesh('jaw', head, jawGeo(), plainSkin, [0, 0.118, 0]);
    this._mesh('hair', head, hairGeo(cfg.hairStyle || 'short'), hairMat, [0, 0.118, 0]);

    if (cfg.headgear === 'cowl') {
      const m = own(stdMat(cfg.primary, { roughness: 0.55, map: maskTexture(cfg.primary, cfg.accent) }));
      this._bodyMats.push(m);
      this._mesh('headgear', head, cowlGeo(), m, [0, 0.122, 0]);
    } else if (cfg.headgear === 'visor') {
      const m = own(stdMat('#3a0a0a', {
        roughness: 0.22, metalness: 0.55, emissive: 0xff2b1c, emissiveIntensity: 0.6,
      }));
      this._visor = this._mesh('headgear', head, visorGeo(), m, [0, 0.134, 0]);
      this._visorMat = m;
      this._visorGlow = 0.35;
      m.emissiveIntensity = 0.6 * this._visorGlow + 0.15;
    } else if (cfg.headgear === 'mask') {
      const m = mk(`mask:${cfg.maskColor || '#1a1c22'}`, () => stdMat(cfg.maskColor || '#1a1c22', { roughness: 0.8 }));
      this._bodyMats.push(m);
      this._mesh('headgear', head, maskGeo(), m, [0, 0.120, 0]);
    } else if (cfg.headgear === 'hat') {
      const m = mk(`hat:${cfg.hatColor || '#3a3a3a'}`, () => stdMat(cfg.hatColor || '#3a3a3a', { roughness: 0.8 }));
      this._mesh('headgear', head, hatGeo(cfg.hatKind || 'cap'), m, [0, 0.118, 0]);
    }

    // arms
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      const sh = this._joint(`upperArm${L}`, torso, s * P.shoulderX, P.chest, 0);
      this._mesh(`upperArm${L}`, sh, capsule('ua', 0.055, 0.19, 8, 3), secMat, [0, -0.152, 0]);
      const el = this._joint(`forearm${L}`, sh, 0, -P.upperArm, 0);
      this._mesh(`forearm${L}`, el, capsule('fa', 0.048, 0.17, 8, 3), secMat, [0, -0.135, 0]);
      const wr = this._joint(`hand${L}`, el, 0, -P.foreArm, 0);
      this._mesh(`hand${L}`, wr, handGeo(), accMat);
      if (cfg.claws) {
        const cm = own(stdMat('#e9edf2', { roughness: 0.12, metalness: 0.95 }));
        const claw = this._mesh(`claws${L}`, wr, clawsGeo(), cm, [0, -0.085, -0.035]);
        claw.rotation.x = -0.18;
        claw.visible = false;
        claw.scale.z = 0.02;
        this._clawMeshes.push(claw);
        this.parts[`claws${L}`] = claw;
      }
    }

    // legs
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      const hip = this._joint(`thigh${L}`, hips, s * P.hipX, -0.02, 0);
      this._mesh(`thigh${L}`, hip, capsule('th', 0.077, 0.30, 8, 3), legMat, [0, -0.225, 0]);
      const kn = this._joint(`shin${L}`, hip, 0, -P.thigh, 0);
      this._mesh(`shin${L}`, kn, capsule('sh', 0.062, 0.26, 8, 3), legMat, [0, -0.21, 0]);
      const an = this._joint(`foot${L}`, kn, 0, -P.shin, 0);
      this._mesh(`foot${L}`, an, footGeo(), accMat);
    }
  }

  // --- animation -----------------------------------------------------------
  /**
   * @param {string} name one of ANIM_NAMES
   * @param {object} [params] {speed, restart, ...}
   */
  setAnim(name, params) {
    const n = ANIMS[name] ? name : 'idle';
    if (params) this.params = params;
    if (n === this.anim && !(params && params.restart)) return this;
    // snapshot current pose so the new state blends out of it
    this._from.set(this._pose);
    this._blend = 0;
    this.anim = n;
    this.animTime = 0;
    this.animDone = false;
    if (!this._clawLock && this._clawMeshes.length) {
      const out = n === 'attack1' || n === 'attack2' || n === 'attack3' || n === 'ability';
      this._clawTarget = out ? 1 : 0;
    }
    return this;
  }

  /** advance the procedural animation. Safe with dt = 0 or bad input. */
  update(dt) {
    let d = finite(dt, 0);
    if (d < 0) d = 0;
    if (d > 0.25) d = 0.25;
    this.time += d;
    this.animTime += d;
    const info = ANIM_INFO[this.anim] || ANIM_INFO.idle;
    if (info.dur > 0 && this.animTime >= info.dur) this.animDone = true;
    const t = info.loop || info.dur <= 0 ? this.animTime : Math.min(this.animTime, info.dur);

    const tgt = this._target;
    tgt.fill(0);
    (ANIMS[this.anim] || poseIdle)(tgt, t, this.params || {}, this);

    if (this._blend < 1) {
      this._blend = Math.min(1, this._blend + (BLEND_TIME > 0 ? d / BLEND_TIME : 1));
      const k = smoothstep(this._blend);
      const from = this._from, out = this._pose;
      for (let i = 0; i < POSE_LEN; i++) out[i] = lerp(from[i], tgt[i], k);
    } else {
      this._pose.set(tgt);
    }
    this._apply();

    // claw extension
    if (this._clawMeshes.length) {
      const spd = this._clawTarget > this._claw ? 10 : 8;
      this._claw += clamp(this._clawTarget - this._claw, -1, 1) * Math.min(1, spd * d);
      if (Math.abs(this._clawTarget - this._claw) < 0.002) this._claw = this._clawTarget;
      const e = clamp(this._claw, 0, 1);
      for (const c of this._clawMeshes) {
        c.visible = e > 0.01;
        c.scale.z = Math.max(0.02, e);
      }
    }
    if (this.diamond && this._diamondMat) {
      this._diamondMat.emissiveIntensity = 0.34 + 0.10 * Math.sin(this.time * 2.4);
    }
    return this;
  }

  _apply() {
    const p = this._pose;
    const root = this.parts.root;
    root.position.set(finite(p[0]), P.hipY + finite(p[1]), finite(p[2]));
    const joints = this._joints;
    for (let i = 0; i < joints.length; i++) {
      const o = joints[i];
      if (!o) continue;
      const k = 3 + i * 3;
      o.rotation.set(finite(p[k]), finite(p[k + 1]), finite(p[k + 2]));
    }
  }

  // --- feature toggles -----------------------------------------------------
  /** Wolverine: extend/retract the three blades on each hand. lock keeps them out across anim changes. */
  setClaws(on, lock) {
    this._clawTarget = on ? 1 : 0;
    this._clawLock = !!on && !!lock;
    return this;
  }
  get clawsOut() { return this._claw > 0.5; }

  /** Cyclops: 0..1 visor emission. */
  setVisorGlow(v) {
    this._visorGlow = clamp(finite(v, 0), 0, 1);
    if (this._visorMat) {
      this._visorMat.emissiveIntensity = 0.15 + 2.6 * this._visorGlow;
      this._visorMat.color.setHex(this._visorGlow > 0.5 ? 0x6b1010 : 0x3a0a0a);
    }
    return this;
  }

  /** Emma: swap the costume to a faceted crystal material. */
  setDiamond(on) {
    const want = !!on;
    if (want === this.diamond) return this;
    this.diamond = want;
    if (want) {
      if (!this._diamondMat) { this._diamondMat = makeDiamondMat(); this._mats.push(this._diamondMat); }
      this._savedMats = [];
      for (const key of Object.keys(this.meshes)) {
        const m = this.meshes[key];
        if (key === 'head' || key === 'jaw') continue;
        this._savedMats.push([m, m.material]);
        m.material = this._diamondMat;
      }
      // face/hair take a frosted tint too
      for (const key of ['head', 'jaw', 'hair']) {
        const m = this.meshes[key];
        if (!m) continue;
        if (!this._savedMats.some((e) => e[0] === m)) this._savedMats.push([m, m.material]);
        m.material = this._diamondMat;
      }
    } else if (this._savedMats) {
      for (const [m, mat] of this._savedMats) m.material = mat;
      this._savedMats = null;
    }
    return this;
  }

  /** recolour the costume: {primary, secondary, accent, skin, hair, belt} */
  setColorScheme(scheme) {
    if (!scheme) return this;
    if (this._sharedMats) this._unshareMaterials();
    const r = this._matRefs;
    if (scheme.primary) { r.primMat.color.set(scheme.primary); this.scheme.primary = scheme.primary; }
    if (scheme.secondary) { r.secMat.color.set(scheme.secondary); this.scheme.secondary = scheme.secondary; }
    if (scheme.accent) { r.accMat.color.set(scheme.accent); this.scheme.accent = scheme.accent; }
    if (scheme.legColor) r.legMat.color.set(scheme.legColor);
    if (scheme.belt) r.beltMat.color.set(scheme.belt);
    if (scheme.skin) { r.skinMat.color.set(scheme.skin); r.plainSkin.color.set(scheme.skin); }
    if (scheme.hair) { r.hairMat.color.set(scheme.hair); this.scheme.hair = scheme.hair; }
    return this;
  }

  /** clone cached materials so this rig can be recoloured without touching its neighbours */
  _unshareMaterials() {
    const map = new Map();
    for (const key of Object.keys(this._matRefs)) {
      const old = this._matRefs[key];
      let next = map.get(old);
      if (!next) { next = old.clone(); next.userData = {}; map.set(old, next); this._mats.push(next); }
      this._matRefs[key] = next;
    }
    this.group.traverse((o) => { if (o.isMesh && map.has(o.material)) o.material = map.get(o.material); });
    this._bodyMats = this._bodyMats.map((m) => map.get(m) || m);
    this._sharedMats = false;
    return this;
  }

  /** world position of a named part (writes into `out` if given) */
  partWorldPos(name, out) {
    const o = this.parts[name] || this.meshes[name];
    const v = out || new THREE.Vector3();
    if (!o) return v.set(0, 0, 0);
    o.updateWorldMatrix(true, false);
    return v.setFromMatrixPosition(o.matrixWorld);
  }

  setVisible(v) { this.group.visible = !!v; return this; }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh && o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    });
    for (const m of this._mats) {
      if (m.map && !(m.map.userData && m.map.userData.shared)) m.map.dispose();
      m.dispose();
    }
    this._mats.length = 0;
    this._bodyMats.length = 0;
    this._clawMeshes.length = 0;
    if (this.group.parent) this.group.parent.remove(this.group);
    this.parts = {}; this.meshes = {}; this._joints = [];
  }
}

// ---------------------------------------------------------------------------
// factories
// ---------------------------------------------------------------------------
/**
 * Build a hero rig.
 * @param {string} id one of CHARACTERS
 * @param {object} [opts] {scale, scheme}
 */
export function createCharacterRig(id, opts = {}) {
  const key = CHARACTERS[id] ? id : 'wolverine';
  const c = COSTUMES[key];
  const cfg = Object.assign({}, c, {
    id: key, kind: 'hero', gender: key === 'jean' || key === 'emma' ? 'f' : 'm',
    scale: opts.scale || (key === 'wolverine' ? 0.955 : key === 'emma' ? 1.005 : 1),
    mouthW: key === 'wolverine' ? 8 : 7,
  }, opts.scheme || {});
  const rig = new Rig(cfg);
  rig.character = CHARACTERS[key];
  if (key === 'cyclops') rig.setVisorGlow(0.3);
  return rig;
}

const NPC_SKINS = [SKIN.pale, SKIN.light, SKIN.tan, SKIN.mid, SKIN.deep, SKIN.rich];
const NPC_HAIR = ['#2a2018', '#4a3524', '#6b5030', '#8c6a3f', '#a8321a', '#c9b47a', '#8d8d8d', '#e2e2e2', '#1a1512'];
const NPC_TOPS = ['#4a6a8c', '#8c4a4a', '#3f6b4a', '#6b5f8c', '#b5813f', '#3a3f4a', '#c2c2b8', '#7a4f3a', '#2f5f6b'];
const NPC_BOTTOMS = ['#2f3540', '#3f4a5a', '#5a4a3a', '#2a2f28', '#4a4a52', '#6b6152'];

/** Named locals from the story section, plus the Brotherhood `thug` enemy rig. */
export const NPC_PRESETS = {
  deputy: {
    name: 'Sheriff\'s Deputy', gender: 'm', skin: SKIN.tan, hair: '#3a2c1e', hairStyle: 'short',
    outfit: { top: '#c9bd93', bottom: '#2e3a2c', hat: 'campaign' }, hatColor: '#5a4a30', accent: '#1c1c20', seed: 1101,
  },
  dean: {
    name: 'ASUMH Dean', gender: 'f', skin: SKIN.light, hair: '#8d8d8d', hairStyle: 'bob',
    outfit: { top: '#1e2a44', bottom: '#3a3f4a' }, accent: '#14161c', seed: 1102,
  },
  cook: {
    name: 'Diner Cook', gender: 'm', skin: SKIN.mid, hair: '#2a2018', hairStyle: 'short',
    outfit: { top: '#f0ece2', bottom: '#4a4a52', hat: 'cap' }, hatColor: '#b23a2e', accent: '#2a2a2e', seed: 1103,
  },
  coach: {
    name: 'High School Coach', gender: 'm', skin: SKIN.deep, hair: '#1a1512', hairStyle: 'short',
    outfit: { top: '#b3352f', bottom: '#1f2126', hat: 'cap' }, hatColor: '#1f2126', accent: '#e8e8e8', seed: 1104,
  },
  fisherman: {
    name: 'Bass Fisherman', gender: 'm', skin: SKIN.tan, hair: '#6b5030', hairStyle: 'short',
    outfit: { top: '#5a6b3a', bottom: '#b6a37a', hat: 'bucket' }, hatColor: '#8a8f6a', accent: '#3a3a30', seed: 1105,
  },
  nurse: {
    name: 'Hospital Nurse', gender: 'f', skin: SKIN.rich, hair: '#1a1512', hairStyle: 'bob',
    outfit: { top: '#2a9d8f', bottom: '#2a9d8f' }, accent: '#e8e8ea', seed: 1106,
  },
  thug: {
    name: 'Brotherhood Thug', gender: 'm', skin: SKIN.light, hair: '#1a1512', hairStyle: 'short',
    outfit: { top: '#24262b', bottom: '#1a1c20' }, accent: '#0f1013',
    headgear: 'mask', maskColor: '#17181d', seed: 1107,
  },
};

/**
 * Civilians / side characters / enemies.
 * @param {number|string|object} seedOrSpec  a seed, an NPC_PRESETS key, or
 *        {gender, skin, hair, hairStyle, outfit:{top,bottom,hat}, seed, scale, name}
 */
export function createNpcRig(seedOrSpec) {
  let spec = {};
  if (seedOrSpec == null) spec = {};
  else if (typeof seedOrSpec === 'object') spec = Object.assign({}, seedOrSpec);
  else if (NPC_PRESETS[seedOrSpec]) spec = Object.assign({}, NPC_PRESETS[seedOrSpec], { preset: seedOrSpec });
  else spec = { seed: seedOrSpec };
  if (typeof spec.preset === 'string' && NPC_PRESETS[spec.preset]) {
    spec = Object.assign({}, NPC_PRESETS[spec.preset], spec);
  }

  const rng = makeRng(hashSeed(spec.seed != null ? spec.seed : Math.floor(Math.random() * 1e9)));
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];

  const gender = spec.gender || (rng() < 0.5 ? 'm' : 'f');
  const outfit = spec.outfit || {};
  const top = outfit.top || spec.top || pick(NPC_TOPS);
  const bottom = outfit.bottom || spec.bottom || pick(NPC_BOTTOMS);
  const hat = outfit.hat || spec.hat || null;
  const skin = spec.skin || pick(NPC_SKINS);
  const hair = spec.hair || pick(NPC_HAIR);
  const hairStyle = spec.hairStyle || (gender === 'f' ? (rng() < 0.5 ? 'bob' : 'long') : (rng() < 0.15 ? 'swept' : 'short'));
  const scale = spec.scale || (gender === 'f' ? 0.93 : 0.98) + rng() * 0.07;

  const cfg = {
    id: spec.preset || spec.id || 'npc',
    kind: spec.preset === 'thug' ? 'enemy' : 'npc',
    name: spec.name || '',
    gender, skin, hair, hairStyle,
    primary: top, secondary: top, accent: spec.accent || '#2a2a2e',
    legColor: bottom, beltColor: spec.beltColor || '#3a3026',
    suitKind: 'plain', eye: spec.eye || '#3a2a1c',
    scale,
    headgear: spec.headgear || (hat ? 'hat' : null),
    hatKind: hat || spec.hatKind || 'cap',
    hatColor: spec.hatColor || bottom,
    maskColor: spec.maskColor,
  };
  const rig = new Rig(cfg);
  rig.npcName = cfg.name;
  rig.preset = spec.preset || null;
  return rig;
}

/** number of meshes in a rig (kept small on purpose) */
export function rigMeshCount(rig) {
  let n = 0;
  rig.group.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

export default { CHARACTERS, NPC_PRESETS, createCharacterRig, createNpcRig, Rig, ANIM_NAMES };
