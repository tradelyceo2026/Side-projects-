// Sawyer — compositor and playback engine (canvas + Web Audio).
import { videoTracks, audioTracks, clipAt, clipEnd, valueAt, opacityAt, gainAt, sourceTime, sequenceDuration, allClips } from './model.js';
import { runtime, seekTo } from './media.js';

export function filterString(clip, localT) {
  const f = clip.props.filters;
  const v = (k) => valueAt(clip, 'filters.' + k, localT);
  const parts = [];
  if (v('brightness') !== 1) parts.push(`brightness(${v('brightness')})`);
  if (v('contrast') !== 1) parts.push(`contrast(${v('contrast')})`);
  if (v('saturate') !== 1) parts.push(`saturate(${v('saturate')})`);
  if (v('hueRotate')) parts.push(`hue-rotate(${v('hueRotate')}deg)`);
  if (v('blur')) parts.push(`blur(${v('blur')}px)`);
  if (v('grayscale')) parts.push(`grayscale(${v('grayscale')})`);
  if (v('sepia')) parts.push(`sepia(${v('sepia')})`);
  return parts.length ? parts.join(' ') : 'none';
}

/** Draw a text clip. */
export function drawText(ctx, clip, W, H, localT) {
  const t = clip.props.text;
  const size = t.size * (H / 1080);
  ctx.font = `${t.weight || 700} ${size}px ${t.font}`;
  ctx.textAlign = t.align || 'center';
  ctx.textBaseline = 'middle';
  const lines = String(t.content).split('\n');
  const lh = size * 1.2;
  const x = t.align === 'left' ? -W / 2 + size * 0.5 : t.align === 'right' ? W / 2 - size * 0.5 : 0;
  const y0 = -((lines.length - 1) * lh) / 2;
  if (t.bg && t.bg !== 'transparent') {
    const widths = lines.map(l => ctx.measureText(l).width);
    const bw = Math.max(...widths) + size, bh = lines.length * lh + size * 0.4;
    ctx.fillStyle = t.bg;
    const bx = t.align === 'left' ? x - size * 0.5 : t.align === 'right' ? x - bw + size * 0.5 : -bw / 2;
    ctx.fillRect(bx, -bh / 2, bw, bh);
  }
  lines.forEach((l, i) => {
    const y = y0 + i * lh;
    if (t.outline) { ctx.lineWidth = t.outline * (H / 1080); ctx.strokeStyle = '#000'; ctx.lineJoin = 'round'; ctx.strokeText(l, x, y); }
    ctx.fillStyle = t.color; ctx.fillText(l, x, y);
  });
}

/**
 * Render the composite at sequence time `time` into ctx (W×H).
 * sources(clip) must return a drawable (video/img/canvas) already positioned at the right source time, or null.
 */
export function renderFrame(ctx, W, H, project, time, sources) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const vts = videoTracks(project);
  for (let i = vts.length - 1; i >= 0; i--) { // V1 (last) drawn first
    const t = vts[i];
    if (t.muted) continue;
    for (const clip of t.clips) {
      if (!clip.enabled || time < clip.start || time >= clipEnd(clip)) continue;
      const lt = time - clip.start;
      const alpha = opacityAt(clip, lt);
      if (alpha <= 0) continue;
      let src = null;
      if (clip.kind === 'text') src = 'text';
      else src = sources(clip, lt);
      if (!src) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.filter = filterString(clip, lt);
      // wipe / slide transitions
      const tin = clip.transitionIn, tout = clip.transitionOut;
      let dx = 0;
      if (tin && lt < tin.duration) {
        const u = lt / tin.duration;
        if (tin.type === 'wipe') { ctx.beginPath(); ctx.rect(0, 0, W * u, H); ctx.clip(); }
        if (tin.type === 'slide') dx = -(1 - u) * W;
        if (tin.type === 'zoom') { ctx.translate(W / 2, H / 2); ctx.scale(0.6 + 0.4 * u, 0.6 + 0.4 * u); ctx.translate(-W / 2, -H / 2); ctx.globalAlpha = alpha * u; }
      }
      if (tout && clip.duration - lt < tout.duration) {
        const u = (clip.duration - lt) / tout.duration;
        if (tout.type === 'wipe') { ctx.beginPath(); ctx.rect(W * (1 - u), 0, W * u, H); ctx.clip(); }
        if (tout.type === 'slide') dx = (1 - u) * W;
        if (tout.type === 'zoom') ctx.globalAlpha = alpha * u;
      }
      const x = valueAt(clip, 'x', lt), y = valueAt(clip, 'y', lt), sc = valueAt(clip, 'scale', lt), rot = valueAt(clip, 'rotation', lt);
      ctx.translate(W / 2 + x * (W / 1920) + dx, H / 2 + y * (H / 1080));
      ctx.rotate(rot * Math.PI / 180);
      ctx.scale(sc, sc);
      if (src === 'text') { drawText(ctx, clip, W, H, lt); }
      else {
        const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
        if (sw && sh) {
          const fit = Math.min(W / sw, H / sh); // fit inside frame at scale 1
          const dw = sw * fit, dh = sh * fit;
          const cr = clip.props.crop || { left: 0, right: 0, top: 0, bottom: 0 };
          const sx = sw * cr.left, sy = sh * cr.top, sw2 = sw * (1 - cr.left - cr.right), sh2 = sh * (1 - cr.top - cr.bottom);
          try { ctx.drawImage(src, sx, sy, sw2, sh2, -dw / 2 + dw * cr.left, -dh / 2 + dh * cr.top, dw * (1 - cr.left - cr.right), dh * (1 - cr.top - cr.bottom)); } catch {}
        }
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

/** Audio clips that should sound at a given time (video clips with linked audio are represented by their own audio clips). */
export function audibleClips(project) {
  const ats = audioTracks(project);
  const anySolo = ats.some(t => t.solo);
  const out = [];
  for (const t of ats) {
    if (t.muted || (anySolo && !t.solo)) continue;
    for (const c of t.clips) if (c.enabled && c.mediaId && runtime.get(c.mediaId)?.audioBuffer) out.push(c);
  }
  return out;
}

/**
 * Schedule every audible clip overlapping [from, to) onto an AudioContext (live or offline).
 * Returns a stop() function.
 */
export function scheduleAudio(ctx, dest, project, from, to, startAt = ctx.currentTime) {
  const nodes = [];
  for (const clip of audibleClips(project)) {
    const cs = clip.start, ce = clipEnd(clip);
    if (ce <= from || cs >= to) continue;
    const rt = runtime.get(clip.mediaId);
    const buf = rt.audioBuffer;
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = clip.speed || 1;
    const gain = ctx.createGain();
    src.connect(gain); gain.connect(dest);
    const playFrom = Math.max(cs, from);           // sequence time where playback begins
    const offsetLocal = playFrom - cs;             // clip-local
    const srcOffset = sourceTime(clip, offsetLocal);
    const when = startAt + (playFrom - from);
    const playLen = Math.min(ce, to) - playFrom;
    if (srcOffset >= buf.duration || playLen <= 0) { continue; }
    // gain automation: sample the gain curve at 20 Hz (covers fades, keyframes, transitions)
    const g0 = gainAt(clip, offsetLocal);
    gain.gain.setValueAtTime(Math.max(0, g0), when);
    const steps = Math.max(2, Math.ceil(playLen * 20));
    for (let i = 1; i <= steps; i++) {
      const lt = offsetLocal + (i / steps) * playLen;
      gain.gain.linearRampToValueAtTime(Math.max(0, gainAt(clip, lt)), when + (i / steps) * playLen);
    }
    try { src.start(when, srcOffset, Math.min(playLen * (clip.speed || 1), buf.duration - srcOffset)); } catch (e) { continue; }
    nodes.push(src, gain);
  }
  return () => { for (const n of nodes) { try { n.stop && n.stop(); } catch {} try { n.disconnect(); } catch {} } };
}

/** Live playback controller for the program monitor. */
export class Player {
  constructor(project, canvas) {
    this.project = project;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.playing = false;
    this.rate = 1;
    this.videoEls = new Map(); // clipId -> video element
    this.audioCtx = null;
    this.stopAudio = null;
    this.onTime = () => {};
    this.loopRange = false;
    this._raf = 0;
    this._t0 = 0; this._p0 = 0;
  }
  setProject(p) { this.project = p; }
  ensureAudio() {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.project.settings.sampleRate || 48000 });
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }
  videoFor(clip) {
    let v = this.videoEls.get(clip.id);
    const rt = runtime.get(clip.mediaId);
    if (!rt) return null;
    if (rt.kind === 'image') return rt.element;
    if (!v) {
      v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = rt.url;
      const redraw = () => { if (!this.playing) this.draw(); };
      v.addEventListener('seeked', redraw); v.addEventListener('loadeddata', redraw);
      this.videoEls.set(clip.id, v);
    }
    return v;
  }
  /** Draw the frame at this.time using live video elements (no awaiting). */
  draw() {
    const p = this.project;
    const W = this.canvas.width, H = this.canvas.height;
    const active = new Set();
    renderFrame(this.ctx, W, H, p, this.time, (clip, lt) => {
      const el = this.videoFor(clip);
      if (!el) return null;
      if (el.tagName !== 'VIDEO') return el;
      active.add(clip.id);
      const want = sourceTime(clip, lt);
      const speed = clip.speed || 1;
      if (this.playing) {
        if (el.paused) { el.playbackRate = Math.min(16, Math.max(0.0625, speed * this.rate)); el.currentTime = want; el.play().catch(() => {}); }
        else if (Math.abs(el.currentTime - want) > 0.12) el.currentTime = want;
      } else if (Math.abs(el.currentTime - want) > 0.02) { el.currentTime = want; }
      return el.readyState >= 2 ? el : null;
    });
    for (const [id, el] of this.videoEls) if (!active.has(id) && !el.paused) el.pause();
  }
  seek(t) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.time = Math.max(0, t);
    this.draw();
    this.onTime(this.time);
    if (wasPlaying) this.play();
  }
  play(rate = 1) {
    if (this.playing && rate === this.rate) return;
    if (this.playing) this.pause();
    const dur = sequenceDuration(this.project);
    if (rate > 0 && this.time >= dur - 1e-3) this.time = 0;
    this.playing = true; this.rate = rate;
    const ctx = this.ensureAudio();
    if (rate > 0) this.stopAudio = scheduleAudio(ctx, ctx.destination, this.project, this.time, dur + 1, ctx.currentTime + 0.05);
    this._t0 = performance.now() + 50; this._p0 = this.time;
    const tick = () => {
      if (!this.playing) return;
      this.time = this._p0 + ((performance.now() - this._t0) / 1000) * this.rate;
      const end = this.project.outPoint !== null && this.loopRange ? this.project.outPoint : dur;
      if (this.time >= end || this.time < 0) {
        if (this.loopRange && this.project.inPoint !== null) { this.pause(); this.time = this.project.inPoint; this.play(rate); return; }
        this.time = Math.max(0, Math.min(end, this.time)); this.pause(); this.draw(); this.onTime(this.time); return;
      }
      this.draw(); this.onTime(this.time);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
  pause() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    if (this.stopAudio) { this.stopAudio(); this.stopAudio = null; }
    for (const el of this.videoEls.values()) if (!el.paused) el.pause();
  }
  /** Re-plan audio after an edit while playing. */
  refresh() { if (this.playing) { const r = this.rate; this.pause(); this.play(r); } else this.draw(); }
  dispose() { this.pause(); for (const el of this.videoEls.values()) { el.src = ''; } this.videoEls.clear(); }
}
