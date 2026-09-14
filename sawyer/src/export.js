// Sawyer — export: WebCodecs (VideoEncoder/AudioEncoder) + mp4-muxer / webm-muxer, with a MediaRecorder fallback.
import { sequenceDuration, clipEnd, videoTracks, sourceTime } from './model.js';
import { runtime, newVideoElement, seekTo } from './media.js';
import { renderFrame, scheduleAudio } from './engine.js';

export const PRESETS = [
  { id: '1080p', label: '1080p · 30 fps · 12 Mb/s', width: 1920, height: 1080, fps: 30, bitrate: 12e6 },
  { id: '1080p60', label: '1080p · 60 fps · 16 Mb/s', width: 1920, height: 1080, fps: 60, bitrate: 16e6 },
  { id: '720p', label: '720p · 30 fps · 6 Mb/s', width: 1280, height: 720, fps: 30, bitrate: 6e6 },
  { id: 'vertical', label: 'Vertical 1080×1920 · 30 fps', width: 1080, height: 1920, fps: 30, bitrate: 10e6 },
  { id: 'square', label: 'Square 1080×1080 · 30 fps', width: 1080, height: 1080, fps: 30, bitrate: 8e6 },
  { id: '4k', label: '4K UHD · 30 fps · 40 Mb/s', width: 3840, height: 2160, fps: 30, bitrate: 40e6 },
];

export function webCodecsAvailable() { return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'; }

/** Pick the best codec/container combination this browser can encode. */
export async function pickCodecs({ width, height, fps, bitrate, prefer = 'mp4' }) {
  if (!webCodecsAvailable()) return null;
  const tryV = async (codec, extra = {}) => {
    try { const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps, ...extra }); return r.supported; } catch { return false; }
  };
  const tryA = async (codec, sampleRate) => {
    try { const r = await AudioEncoder.isConfigSupported({ codec, sampleRate, numberOfChannels: 2, bitrate: 128000 }); return r.supported; } catch { return false; }
  };
  const candidates = prefer === 'webm'
    ? [['vp09.00.10.08', 'webm'], ['vp8', 'webm'], ['avc1.640028', 'mp4'], ['avc1.42001f', 'mp4']]
    : [['avc1.640028', 'mp4'], ['avc1.4d0028', 'mp4'], ['avc1.42001f', 'mp4'], ['vp09.00.10.08', 'webm'], ['vp8', 'webm']];
  let video = null;
  for (const [codec, container] of candidates) {
    const extra = codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {};
    if (await tryV(codec, extra)) { video = { codec, container, extra }; break; }
  }
  if (!video) return null;
  let audio = null;
  if (typeof AudioEncoder !== 'undefined') {
    if (video.container === 'mp4' && await tryA('mp4a.40.2', 48000)) audio = { codec: 'mp4a.40.2', muxCodec: 'aac', sampleRate: 48000 };
    else if (await tryA('opus', 48000)) audio = { codec: 'opus', muxCodec: 'opus', sampleRate: 48000 };
  }
  return { video, audio };
}

function waitForQueue(encoder, max = 6) {
  if (encoder.encodeQueueSize <= max) return Promise.resolve();
  return new Promise(resolve => {
    const check = () => { if (encoder.encodeQueueSize <= max) { encoder.removeEventListener('dequeue', check); resolve(); } };
    encoder.addEventListener('dequeue', check);
  });
}

/** Render the mixed audio for [from,to) with an OfflineAudioContext. */
export async function renderAudio(project, from, to, sampleRate = 48000) {
  const length = Math.max(1, Math.ceil((to - from) * sampleRate));
  const off = new OfflineAudioContext(2, length, sampleRate);
  scheduleAudio(off, off.destination, project, from, to, 0);
  return await off.startRendering();
}

/**
 * Export the project. opts: {width,height,fps,bitrate,prefer:'mp4'|'webm',useRange:boolean}
 * Returns {blob, filename, info}. Calls onProgress({phase, fraction, text}).
 */
export async function exportProject(project, opts, { onProgress = () => {}, signal } = {}) {
  const dur = sequenceDuration(project);
  let from = 0, to = dur;
  if (opts.useRange && project.inPoint !== null && project.outPoint !== null && project.outPoint > project.inPoint) { from = project.inPoint; to = project.outPoint; }
  if (to - from <= 0) throw new Error('Nothing to export: the timeline is empty');
  const { width, height, fps, bitrate } = opts;
  const codecs = await pickCodecs({ width, height, fps, bitrate, prefer: opts.prefer || 'mp4' });
  if (!codecs) return exportWithMediaRecorder(project, opts, from, to, { onProgress, signal });

  const total = Math.round((to - from) * fps);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  // muxer
  const M = codecs.video.container === 'mp4' ? window.Mp4Muxer : window.WebMMuxer;
  if (!M) throw new Error('Muxer library not loaded');
  const target = new M.ArrayBufferTarget();
  const muxer = codecs.video.container === 'mp4'
    ? new M.Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, audio: codecs.audio ? { codec: codecs.audio.muxCodec, numberOfChannels: 2, sampleRate: codecs.audio.sampleRate } : undefined, fastStart: 'in-memory', firstTimestampBehavior: 'offset' })
    : new M.Muxer({ target, video: { codec: codecs.video.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8', width, height, frameRate: fps }, audio: codecs.audio ? { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: codecs.audio.sampleRate } : undefined, firstTimestampBehavior: 'offset' });

  let encError = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encError = e; } });
  venc.configure({ codec: codecs.video.codec, width, height, bitrate, framerate: fps, latencyMode: 'quality', ...codecs.video.extra });

  // audio first (fast): offline render then encode
  let aenc = null;
  if (codecs.audio) {
    onProgress({ phase: 'audio', fraction: 0, text: 'Mixing audio' });
    const buf = await renderAudio(project, from, to, codecs.audio.sampleRate);
    aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encError = e; } });
    aenc.configure({ codec: codecs.audio.codec, sampleRate: codecs.audio.sampleRate, numberOfChannels: 2, bitrate: 128000 });
    const frames = 4096;
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    for (let s = 0; s < buf.length; s += frames) {
      const n = Math.min(frames, buf.length - s);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(s, s + n), 0); data.set(R.subarray(s, s + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: codecs.audio.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(s / codecs.audio.sampleRate * 1e6), data });
      aenc.encode(ad); ad.close();
      if (aenc.encodeQueueSize > 20) await waitForQueue(aenc, 10);
    }
    await aenc.flush();
  }

  // video frames
  const els = new Map(); // mediaId -> video element dedicated to export
  const sources = async (time) => {
    // pre-seek every active video source for this frame
    const jobs = [];
    for (const t of videoTracks(project)) if (!t.muted) for (const c of t.clips) {
      if (!c.enabled || time < c.start || time >= clipEnd(c) || c.kind !== 'video') continue;
      let el = els.get(c.mediaId);
      if (!el) { el = newVideoElement(c.mediaId); if (!el) continue; els.set(c.mediaId, el); }
      const st = sourceTime(c, time - c.start);
      jobs.push(seekTo(el, st).catch(() => {}));
    }
    await Promise.all(jobs);
    return (clip) => {
      const rt = runtime.get(clip.mediaId);
      if (!rt) return null;
      if (rt.kind === 'image') return rt.element;
      const el = els.get(clip.mediaId);
      return el && el.readyState >= 2 ? el : null;
    };
  };
  const keyInt = fps * 2;
  const t0 = performance.now();
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) { venc.close(); aenc?.close(); throw new Error('Export cancelled'); }
    if (encError) throw encError;
    const time = from + i / fps;
    const src = await sources(time);
    renderFrame(ctx, width, height, project, time, src);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: i % keyInt === 0 });
    frame.close();
    await waitForQueue(venc, 6);
    if (i % 5 === 0) {
      const el = (performance.now() - t0) / 1000;
      const eta = i > 0 ? el / i * (total - i) : 0;
      onProgress({ phase: 'video', fraction: i / total, text: `Frame ${i + 1} / ${total} · ${eta.toFixed(0)} s left` });
    }
  }
  await venc.flush();
  venc.close(); aenc?.close();
  muxer.finalize();
  for (const el of els.values()) el.src = '';
  const mime = codecs.video.container === 'mp4' ? 'video/mp4' : 'video/webm';
  const blob = new Blob([target.buffer], { type: mime });
  const ext = codecs.video.container;
  const filename = `${(project.name || 'sequence').replace(/[^\w\-]+/g, '_')}_${width}x${height}.${ext}`;
  onProgress({ phase: 'done', fraction: 1, text: `Done · ${(blob.size / 1048576).toFixed(1)} MB` });
  return { blob, filename, info: { container: ext, videoCodec: codecs.video.codec, audioCodec: codecs.audio?.codec || 'none', frames: total, width, height, fps } };
}

/** Realtime fallback for browsers without WebCodecs (Firefox, Safari < 26). Produces WebM. */
async function exportWithMediaRecorder(project, opts, from, to, { onProgress, signal }) {
  const { width, height, fps } = opts;
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser can neither use WebCodecs nor MediaRecorder');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(fps);
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = actx.createMediaStreamDestination();
  for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = res; });
  const els = new Map();
  rec.start(500);
  await actx.resume();
  const stopAudio = scheduleAudio(actx, dest, project, from, to, actx.currentTime + 0.1);
  const total = Math.round((to - from) * fps);
  const start = performance.now() + 100;
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) break;
    const time = from + i / fps;
    for (const t of videoTracks(project)) for (const c of t.clips) {
      if (c.kind !== 'video' || time < c.start || time >= clipEnd(c)) continue;
      let el = els.get(c.mediaId); if (!el) { el = newVideoElement(c.mediaId); els.set(c.mediaId, el); }
      const st = sourceTime(c, time - c.start);
      if (Math.abs(el.currentTime - st) > 0.03) { el.currentTime = st; }
    }
    renderFrame(ctx, width, height, project, time, (clip) => { const rt = runtime.get(clip.mediaId); if (!rt) return null; if (rt.kind === 'image') return rt.element; const el = els.get(clip.mediaId); return el && el.readyState >= 2 ? el : null; });
    if (i % 10 === 0) onProgress({ phase: 'video', fraction: i / total, text: `Recording in real time · ${(time - from).toFixed(1)} / ${(to - from).toFixed(1)} s` });
    const due = start + (i + 1) * 1000 / fps;
    const wait = due - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  stopAudio();
  rec.stop();
  await done;
  const blob = new Blob(chunks, { type: 'video/webm' });
  onProgress({ phase: 'done', fraction: 1, text: `Done · ${(blob.size / 1048576).toFixed(1)} MB` });
  return { blob, filename: `${(project.name || 'sequence').replace(/[^\w\-]+/g, '_')}.webm`, info: { container: 'webm', videoCodec: mime, audioCodec: 'opus', frames: total, width, height, fps, realtime: true } };
}
