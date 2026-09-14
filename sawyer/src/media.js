// Sawyer — media import, probing, thumbnails, waveforms, and IndexedDB persistence.
import { uid } from './model.js';

const DB_NAME = 'sawyer';
const DB_VERSION = 1;
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
function idb(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
    tx.onerror = () => reject(tx.error);
    if (r && 'onsuccess' in r) r.onsuccess = () => { r._v = r.result; };
  }).then(v => v));
}
export async function saveFileBlob(id, file) { await idb('files', 'readwrite', s => s.put({ id, blob: file, name: file.name, type: file.type })); }
export async function loadFileBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => { const r = db.transaction('files').objectStore('files').get(id); r.onsuccess = () => resolve(r.result || null); r.onerror = () => reject(r.error); });
}
export async function deleteFileBlob(id) { await idb('files', 'readwrite', s => s.delete(id)); }
export async function saveProjectJson(project) { await idb('projects', 'readwrite', s => s.put({ id: 'current', json: JSON.stringify(project), savedAt: Date.now() })); }
export async function loadProjectJson() {
  const db = await openDb();
  return new Promise((resolve, reject) => { const r = db.transaction('projects').objectStore('projects').get('current'); r.onsuccess = () => resolve(r.result ? JSON.parse(r.result.json) : null); r.onerror = () => reject(r.error); });
}
export async function clearAll() {
  await idb('files', 'readwrite', s => s.clear());
  await idb('projects', 'readwrite', s => s.clear());
}

/** Runtime registry: mediaId -> { url, file, element cache, peaks, audioBuffer } (not serialized). */
export const runtime = new Map();

export function kindOf(file) {
  const t = (file.type || '').toLowerCase();
  const n = file.name.toLowerCase();
  if (t.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi|ogv)$/.test(n)) return 'video';
  if (t.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/.test(n)) return 'audio';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(n)) return 'image';
  return null;
}

function loadMeta(url, kind) {
  return new Promise((resolve, reject) => {
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 5, element: img });
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = url;
      return;
    }
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'metadata'; el.muted = true; el.crossOrigin = 'anonymous';
    const timer = setTimeout(() => reject(new Error('Timed out reading media metadata')), 20000);
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      let duration = el.duration;
      if (!isFinite(duration)) { // some WebM recordings report Infinity until seeked to the end
        el.currentTime = 1e9;
        el.ontimeupdate = () => { el.ontimeupdate = null; duration = el.duration; el.currentTime = 0; resolve({ width: el.videoWidth || 0, height: el.videoHeight || 0, duration, element: el }); };
        return;
      }
      resolve({ width: el.videoWidth || 0, height: el.videoHeight || 0, duration, element: el });
    };
    el.onerror = () => { clearTimeout(timer); reject(new Error('Browser cannot decode this file')); };
    el.src = url;
  });
}

async function hasAudioTrack(el, file) {
  if (typeof el.mozHasAudio !== 'undefined') return el.mozHasAudio;
  if (el.audioTracks) return el.audioTracks.length > 0;
  if (typeof el.webkitAudioDecodedByteCount !== 'undefined') {
    // needs some playback to count decoded bytes; try a quick decode instead
  }
  try { const buf = await decodeAudio(file); return !!buf && buf.duration > 0; } catch { return false; }
}

const audioCtxForDecode = () => { if (!decodeCtx) decodeCtx = new (window.AudioContext || window.webkitAudioContext)(); return decodeCtx; };
let decodeCtx = null;
export async function decodeAudio(file) {
  const ab = await file.arrayBuffer();
  const ctx = audioCtxForDecode();
  return await ctx.decodeAudioData(ab.slice(0));
}

/** RMS peaks at `perSecond` resolution from an AudioBuffer (mixed to mono). */
export function computePeaks(buffer, perSecond = 40) {
  const n = Math.ceil(buffer.duration * perSecond);
  const peaks = new Float32Array(n);
  const win = Math.floor(buffer.sampleRate / perSecond);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    const s0 = i * win, s1 = Math.min(s0 + win, buffer.length);
    for (const ch of chans) for (let s = s0; s < s1; s += 4) { sum += ch[s] * ch[s]; cnt++; }
    peaks[i] = cnt ? Math.sqrt(sum / cnt) : 0;
  }
  return peaks;
}

export async function makeThumbnails(el, duration, count = 8, size = 96) {
  const out = [];
  const w = size, h = Math.round(size * (el.videoHeight / el.videoWidth || 9 / 16));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, (i + 0.5) / count * duration);
    try {
      await seekTo(el, Math.max(0, t));
      ctx.drawImage(el, 0, 0, w, h);
      out.push(canvas.toDataURL('image/jpeg', 0.6));
    } catch { out.push(null); }
  }
  return out;
}

export function seekTo(el, t, timeout = 4000) {
  return new Promise((resolve, reject) => {
    if (Math.abs(el.currentTime - t) < 0.001 && el.readyState >= 2) return resolve();
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeout);
    const onSeeked = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('seek failed')); };
    const cleanup = () => { clearTimeout(timer); el.removeEventListener('seeked', onSeeked); el.removeEventListener('error', onErr); };
    el.addEventListener('seeked', onSeeked); el.addEventListener('error', onErr);
    el.currentTime = t;
  });
}

/**
 * Import a File: returns a media record for the project and fills the runtime registry.
 * onProgress(stage) is optional.
 */
export async function importFile(file, { persist = true, id = null, onProgress = () => {} } = {}) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`Unsupported file: ${file.name}`);
  const mediaId = id || uid('m');
  const url = URL.createObjectURL(file);
  onProgress('Reading metadata');
  const meta = await loadMeta(url, kind);
  const rec = { id: mediaId, name: file.name, type: kind, duration: meta.duration, width: meta.width, height: meta.height, hasAudio: false, size: file.size };
  const rt = { url, file, kind, element: meta.element, peaks: null, peaksPerSecond: 40, audioBuffer: null, thumbs: [] };
  runtime.set(mediaId, rt);
  if (kind === 'audio' || kind === 'video') {
    onProgress('Decoding audio');
    try {
      const buf = await decodeAudio(file);
      if (buf && buf.duration > 0) { rt.audioBuffer = buf; rt.peaks = computePeaks(buf, rt.peaksPerSecond); rec.hasAudio = true; }
    } catch (e) { rec.hasAudio = false; }
  }
  if (kind === 'video') {
    onProgress('Making thumbnails');
    try { rt.thumbs = await makeThumbnails(meta.element, meta.duration, 8); } catch {}
    try { await seekTo(meta.element, 0); } catch {}
  }
  if (persist) { onProgress('Saving'); try { await saveFileBlob(mediaId, file); } catch (e) { console.warn('persist failed', e); } }
  return rec;
}

/** Recreate runtime entries from IndexedDB for a loaded project. Returns ids that could not be restored. */
export async function restoreMedia(project, onProgress = () => {}) {
  const missing = [];
  for (const m of Object.values(project.media)) {
    if (runtime.has(m.id)) continue;
    const row = await loadFileBlob(m.id).catch(() => null);
    if (!row) { missing.push(m.id); continue; }
    onProgress(`Restoring ${m.name}`);
    try {
      const file = new File([row.blob], row.name || m.name, { type: row.type || row.blob.type });
      await importFile(file, { persist: false, id: m.id });
    } catch (e) { missing.push(m.id); }
  }
  return missing;
}

/** A fresh, independent video element for a media id (used by export so preview is undisturbed). */
export function newVideoElement(mediaId) {
  const rt = runtime.get(mediaId);
  if (!rt) return null;
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = rt.url;
  return v;
}
