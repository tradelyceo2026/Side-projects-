// Sawyer — project model and pure editing operations. No DOM. Testable in Node.

let _id = 0;
export function uid(prefix = 'c') { _id += 1; return `${prefix}${Date.now().toString(36)}${_id.toString(36)}`; }

export const DEFAULT_SETTINGS = { width: 1920, height: 1080, fps: 30, sampleRate: 48000 };

export function defaultProps(kind) {
  return {
    opacity: 1, x: 0, y: 0, scale: 1, rotation: 0,
    volume: 1, fadeIn: 0, fadeOut: 0,
    filters: { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, blur: 0, grayscale: 0, sepia: 0 },
    text: kind === 'text' ? { content: 'Title', font: 'Inter, system-ui, sans-serif', size: 96, color: '#ffffff', bg: 'transparent', weight: 700, align: 'center', outline: 0 } : null,
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
  };
}

export function createProject(name = 'Untitled') {
  return {
    version: 1,
    id: uid('p'),
    name,
    settings: { ...DEFAULT_SETTINGS },
    media: {},
    tracks: [
      { id: 'V3', kind: 'video', name: 'V3', muted: false, locked: false, clips: [] },
      { id: 'V2', kind: 'video', name: 'V2', muted: false, locked: false, clips: [] },
      { id: 'V1', kind: 'video', name: 'V1', muted: false, locked: false, clips: [] },
      { id: 'A1', kind: 'audio', name: 'A1', muted: false, solo: false, locked: false, clips: [] },
      { id: 'A2', kind: 'audio', name: 'A2', muted: false, solo: false, locked: false, clips: [] },
      { id: 'A3', kind: 'audio', name: 'A3', muted: false, solo: false, locked: false, clips: [] },
    ],
    markers: [],
    inPoint: null,
    outPoint: null,
  };
}

export function videoTracks(p) { return p.tracks.filter(t => t.kind === 'video'); }
export function audioTracks(p) { return p.tracks.filter(t => t.kind === 'audio'); }
export function track(p, id) { return p.tracks.find(t => t.id === id); }
export function allClips(p) { return p.tracks.flatMap(t => t.clips); }
export function findClip(p, id) {
  for (const t of p.tracks) { const c = t.clips.find(c => c.id === id); if (c) return { clip: c, track: t }; }
  return null;
}
export function clipEnd(c) { return c.start + c.duration; }
export function sequenceDuration(p) { return Math.max(0, ...allClips(p).map(clipEnd)); }
export function clipAt(t, time) { return t.clips.find(c => time >= c.start && time < clipEnd(c)) || null; }
export function sortTrack(t) { t.clips.sort((a, b) => a.start - b.start); }

export function newClip({ mediaId, kind, start, duration, inPoint = 0, name = '', speed = 1, trackId }) {
  return {
    id: uid('c'), mediaId: mediaId || null, kind, name, trackId,
    start, duration, inPoint, speed,
    props: defaultProps(kind),
    keyframes: {},
    transitionIn: null, transitionOut: null,
    linkId: null, enabled: true,
  };
}

/** Insert a clip on a track in overwrite mode: existing clips under it are trimmed or split. */
export function placeClip(p, trackId, clip) {
  const t = track(p, trackId);
  if (!t) throw new Error(`no track ${trackId}`);
  if (t.kind !== (clip.kind === 'audio' ? 'audio' : 'video')) throw new Error(`clip kind ${clip.kind} cannot go on ${t.kind} track`);
  clip.trackId = trackId;
  clip.start = Math.max(0, clip.start);
  const s = clip.start, e = clipEnd(clip);
  const keep = [];
  for (const c of t.clips) {
    if (c.id === clip.id) continue;
    const cs = c.start, ce = clipEnd(c);
    if (ce <= s || cs >= e) { keep.push(c); continue; }
    if (cs < s && ce > e) { // split around: c becomes the left part, a new clip is the right part
      const right = { ...c, id: uid('c'), start: e, inPoint: c.inPoint + (e - cs) * c.speed, duration: ce - e, transitionIn: null, keyframes: shiftKeyframes(c.keyframes, -(e - cs)), props: JSON.parse(JSON.stringify(c.props)) };
      c.duration = s - cs; c.transitionOut = null;
      keep.push(c, right); continue;
    }
    if (cs < s) { c.duration = s - cs; c.transitionOut = null; keep.push(c); continue; }
    if (ce > e) { c.inPoint += (e - cs) * c.speed; c.keyframes = shiftKeyframes(c.keyframes, -(e - cs)); c.start = e; c.duration = ce - e; c.transitionIn = null; keep.push(c); continue; }
    // fully covered: dropped
  }
  keep.push(clip);
  t.clips = keep;
  sortTrack(t);
  return clip;
}

function shiftKeyframes(kf, dt) {
  const out = {};
  for (const k of Object.keys(kf || {})) out[k] = kf[k].map(f => ({ ...f, t: f.t + dt }));
  return out;
}

export function removeClip(p, id) {
  const f = findClip(p, id);
  if (!f) return false;
  f.track.clips = f.track.clips.filter(c => c.id !== id);
  return true;
}

/** Ripple delete: remove the clip and close the gap on every track (Premiere's Shift+Delete). */
export function rippleDelete(p, id) {
  const f = findClip(p, id);
  if (!f) return false;
  const { clip } = f;
  const gapStart = clip.start, gapLen = clip.duration;
  removeClip(p, id);
  // only close the gap if nothing else occupies it on other tracks
  const blocked = allClips(p).some(c => c.start < gapStart + gapLen && clipEnd(c) > gapStart);
  if (!blocked) for (const t of p.tracks) for (const c of t.clips) if (c.start >= gapStart + gapLen - 1e-6) c.start -= gapLen;
  return true;
}

/** Close all gaps on the timeline (ripple everything left). */
export function closeGaps(p) {
  const clips = allClips(p).sort((a, b) => a.start - b.start);
  let shift = 0, cursor = 0;
  for (const c of clips) {
    const s = c.start - shift;
    if (s > cursor + 1e-6) { shift += s - cursor; }
    c.start -= shift;
    cursor = Math.max(cursor, clipEnd(c));
  }
}

export function splitClip(p, id, time) {
  const f = findClip(p, id);
  if (!f) return null;
  const c = f.clip;
  if (time <= c.start + 1e-4 || time >= clipEnd(c) - 1e-4) return null;
  const off = time - c.start;
  // bake the animated value at the cut on both sides so the motion is continuous
  for (const k of Object.keys(c.keyframes)) setKeyframe(c, k, off, valueAt(c, k, off));
  const right = { ...c, id: uid('c'), start: time, duration: c.duration - off, inPoint: c.inPoint + off * c.speed, transitionIn: null, keyframes: shiftKeyframes(c.keyframes, -off), props: JSON.parse(JSON.stringify(c.props)) };
  c.duration = off; c.transitionOut = null;
  for (const k of Object.keys(c.keyframes)) c.keyframes[k] = c.keyframes[k].filter(fk => fk.t <= off + 1e-9);
  for (const k of Object.keys(right.keyframes)) right.keyframes[k] = right.keyframes[k].filter(fk => fk.t >= -1e-9);
  f.track.clips.push(right); sortTrack(f.track);
  return { left: c, right };
}

/** Split every clip (on every track) at time. */
export function splitAll(p, time, onlyIds = null) {
  const out = [];
  for (const t of p.tracks) for (const c of [...t.clips]) {
    if (onlyIds && !onlyIds.includes(c.id)) continue;
    const r = splitClip(p, c.id, time); if (r) out.push(r);
  }
  return out;
}

/** Trim the clip head to a new start time (keeps the tail fixed). */
export function trimStart(p, id, newStart, mediaDuration = Infinity) {
  const f = findClip(p, id); if (!f) return;
  const c = f.clip;
  const end = clipEnd(c);
  newStart = Math.min(newStart, end - 1 / 120);
  const minStart = c.start - c.inPoint / c.speed; // cannot reveal before source 0
  newStart = Math.max(newStart, minStart, 0);
  // avoid overlapping the previous clip
  const prev = f.track.clips.filter(o => o.id !== id && clipEnd(o) <= end && o.start < c.start).sort((a, b) => clipEnd(b) - clipEnd(a))[0];
  if (prev) newStart = Math.max(newStart, clipEnd(prev));
  const delta = newStart - c.start;
  c.inPoint += delta * c.speed; c.start = newStart; c.duration = end - newStart;
  c.keyframes = shiftKeyframes(c.keyframes, -delta);
}
/** Trim the clip tail to a new end time. */
export function trimEnd(p, id, newEnd, mediaDuration = Infinity) {
  const f = findClip(p, id); if (!f) return;
  const c = f.clip;
  newEnd = Math.max(newEnd, c.start + 1 / 120);
  if (isFinite(mediaDuration) && c.kind !== 'image' && c.kind !== 'text') newEnd = Math.min(newEnd, c.start + (mediaDuration - c.inPoint) / c.speed);
  const next = f.track.clips.filter(o => o.id !== id && o.start >= c.start + 1e-6).sort((a, b) => a.start - b.start)[0];
  if (next) newEnd = Math.min(newEnd, next.start);
  c.duration = newEnd - c.start;
}

/** Move a clip (and its linked partner) to a new start/track. Overwrite semantics. */
export function moveClip(p, id, newStart, newTrackId = null) {
  const f = findClip(p, id); if (!f) return;
  const c = f.clip;
  const delta = Math.max(0, newStart) - c.start;
  const targets = [c];
  if (c.linkId) for (const o of allClips(p)) if (o.id !== c.id && o.linkId === c.linkId) targets.push(o);
  for (const o of targets) {
    const tr = findClip(p, o.id).track;
    tr.clips = tr.clips.filter(x => x.id !== o.id);
    const dest = (o === c && newTrackId) ? newTrackId : o.trackId;
    o.start = Math.max(0, o.start + delta);
    placeClip(p, dest, o);
  }
}

export function setTransition(p, id, side, type, duration) {
  const f = findClip(p, id); if (!f) return;
  const key = side === 'in' ? 'transitionIn' : 'transitionOut';
  f.clip[key] = type ? { type, duration: Math.min(duration, f.clip.duration) } : null;
  // mirror onto the neighbour so both sides animate
  const t = f.track;
  const idx = t.clips.indexOf(f.clip);
  const nb = side === 'in' ? t.clips[idx - 1] : t.clips[idx + 1];
  if (nb && Math.abs((side === 'in' ? clipEnd(nb) - f.clip.start : nb.start - clipEnd(f.clip))) < 1e-3) {
    nb[side === 'in' ? 'transitionOut' : 'transitionIn'] = type ? { type, duration: Math.min(duration, nb.duration) } : null;
  }
}

// ---------- keyframes ----------
export function setKeyframe(clip, prop, t, v) {
  const list = clip.keyframes[prop] || (clip.keyframes[prop] = []);
  const ex = list.find(k => Math.abs(k.t - t) < 1e-4);
  if (ex) ex.v = v; else { list.push({ t, v }); list.sort((a, b) => a.t - b.t); }
}
export function removeKeyframe(clip, prop, t) {
  if (!clip.keyframes[prop]) return;
  clip.keyframes[prop] = clip.keyframes[prop].filter(k => Math.abs(k.t - t) >= 1e-4);
  if (!clip.keyframes[prop].length) delete clip.keyframes[prop];
}
/** Value of an animatable prop at clip-local time (seconds from clip start). */
export function valueAt(clip, prop, localT) {
  const kf = clip.keyframes[prop];
  const base = prop.startsWith('filters.') ? clip.props.filters[prop.slice(8)] : clip.props[prop];
  if (!kf || !kf.length) return base;
  if (localT <= kf[0].t) return kf[0].v;
  if (localT >= kf[kf.length - 1].t) return kf[kf.length - 1].v;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    if (localT >= a.t && localT <= b.t) {
      const u = (localT - a.t) / (b.t - a.t || 1);
      const s = u * u * (3 - 2 * u); // smoothstep ease
      return a.v + (b.v - a.v) * s;
    }
  }
  return base;
}

/** Effective opacity including fades and transitions (0..1). */
export function opacityAt(clip, localT) {
  let o = valueAt(clip, 'opacity', localT);
  const d = clip.duration;
  if (clip.transitionIn) {
    const { type, duration } = clip.transitionIn;
    if (localT < duration && (type === 'dissolve' || type === 'dip')) o *= type === 'dip' ? Math.min(1, localT / (duration / 2) - 1 + 1) * (localT < duration / 2 ? 0 : 1) : localT / duration;
  }
  if (clip.transitionOut) {
    const { type, duration } = clip.transitionOut;
    const rem = d - localT;
    if (rem < duration && (type === 'dissolve' || type === 'dip')) o *= type === 'dip' ? (rem < duration / 2 ? 0 : 1) : rem / duration;
  }
  return Math.max(0, Math.min(1, o));
}

/** Effective gain including fades (0..1+). */
export function gainAt(clip, localT) {
  let g = valueAt(clip, 'volume', localT);
  const { fadeIn, fadeOut } = clip.props;
  if (fadeIn > 0 && localT < fadeIn) g *= localT / fadeIn;
  const rem = clip.duration - localT;
  if (fadeOut > 0 && rem < fadeOut) g *= Math.max(0, rem / fadeOut);
  if (clip.transitionIn && clip.transitionIn.duration && localT < clip.transitionIn.duration) g *= localT / clip.transitionIn.duration;
  if (clip.transitionOut && clip.transitionOut.duration && rem < clip.transitionOut.duration) g *= Math.max(0, rem / clip.transitionOut.duration);
  return g;
}

/** Source (media) time for a clip-local time. */
export function sourceTime(clip, localT) { return clip.inPoint + localT * clip.speed; }

// ---------- silence detection ----------
/**
 * peaks: array of RMS/peak values per window; windowSec: seconds per value.
 * Returns [{start,end}] silent ranges (seconds) at least minLen long.
 */
export function detectSilence(peaks, windowSec, threshold = 0.02, minLen = 0.5, pad = 0.05) {
  const out = [];
  let runStart = null;
  for (let i = 0; i <= peaks.length; i++) {
    const silent = i < peaks.length && peaks[i] < threshold;
    if (silent && runStart === null) runStart = i;
    if (!silent && runStart !== null) {
      const s = runStart * windowSec, e = i * windowSec;
      if (e - s >= minLen) out.push({ start: s + pad, end: e - pad });
      runStart = null;
    }
  }
  return out.filter(r => r.end > r.start);
}

/** Remove ranges of source time from a clip, returning the replacement clips on the same track. */
export function cutRangesFromClip(p, clipId, sourceRanges, ripple = 'track') {
  const f = findClip(p, clipId); if (!f) return [];
  const c = f.clip;
  const localRanges = sourceRanges
    .map(r => ({ start: (r.start - c.inPoint) / c.speed, end: (r.end - c.inPoint) / c.speed }))
    .map(r => ({ start: Math.max(0, r.start), end: Math.min(c.duration, r.end) }))
    .filter(r => r.end - r.start > 0.02)
    .sort((a, b) => a.start - b.start);
  if (!localRanges.length) return [c];
  const pieces = [];
  let cursor = 0;
  for (const r of localRanges) {
    if (r.start > cursor + 0.02) pieces.push({ from: cursor, to: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (c.duration > cursor + 0.02) pieces.push({ from: cursor, to: c.duration });
  const out = [];
  let tStart = c.start;
  for (const pc of pieces) {
    const nc = { ...c, id: uid('c'), start: tStart, duration: pc.to - pc.from, inPoint: c.inPoint + pc.from * c.speed, keyframes: {}, transitionIn: null, transitionOut: null, props: JSON.parse(JSON.stringify(c.props)) };
    out.push(nc); tStart += nc.duration;
  }
  const removed = c.duration - (tStart - c.start);
  f.track.clips = f.track.clips.filter(x => x.id !== c.id);
  // ripple later clips: on this track only (default), on every track, or not at all
  if (ripple !== 'none') for (const t of p.tracks) { if (ripple === 'track' && t !== f.track) continue; for (const o of t.clips) if (o.start >= clipEnd(c) - 1e-6) o.start -= removed; }
  for (const nc of out) f.track.clips.push(nc);
  sortTrack(f.track);
  return out;
}

// ---------- snapping ----------
export function snapPoints(p, excludeIds = [], playhead = null) {
  const pts = [0];
  for (const c of allClips(p)) { if (excludeIds.includes(c.id)) continue; pts.push(c.start, clipEnd(c)); }
  for (const m of p.markers) pts.push(m.time);
  if (playhead !== null) pts.push(playhead);
  if (p.inPoint !== null) pts.push(p.inPoint);
  if (p.outPoint !== null) pts.push(p.outPoint);
  return pts;
}
export function snap(time, points, tolerance) {
  let best = time, bd = tolerance;
  for (const pt of points) { const d = Math.abs(pt - time); if (d < bd) { bd = d; best = pt; } }
  return best;
}

// ---------- undo ----------
export function createHistory(limit = 100) { return { past: [], future: [], limit }; }
export function commit(h, project) {
  h.past.push(JSON.stringify(project));
  if (h.past.length > h.limit) h.past.shift();
  h.future.length = 0;
}
export function undo(h, project) {
  if (!h.past.length) return null;
  h.future.push(JSON.stringify(project));
  return JSON.parse(h.past.pop());
}
export function redo(h, project) {
  if (!h.future.length) return null;
  h.past.push(JSON.stringify(project));
  return JSON.parse(h.future.pop());
}

/** Compact summary for the AI assistant. */
export function summarize(p) {
  return {
    name: p.name,
    settings: p.settings,
    duration: +sequenceDuration(p).toFixed(3),
    inPoint: p.inPoint, outPoint: p.outPoint,
    media: Object.values(p.media).map(m => ({ id: m.id, name: m.name, type: m.type, duration: m.duration && +m.duration.toFixed(3), hasAudio: !!m.hasAudio, width: m.width, height: m.height })),
    tracks: p.tracks.map(t => ({ id: t.id, kind: t.kind, muted: t.muted, clips: t.clips.map(c => ({
      id: c.id, name: c.name, kind: c.kind, mediaId: c.mediaId, start: +c.start.toFixed(3), end: +clipEnd(c).toFixed(3), duration: +c.duration.toFixed(3), inPoint: +c.inPoint.toFixed(3), speed: c.speed,
      opacity: c.props.opacity, volume: c.props.volume, scale: c.props.scale, x: c.props.x, y: c.props.y, rotation: c.props.rotation,
      fadeIn: c.props.fadeIn, fadeOut: c.props.fadeOut,
      text: c.props.text ? c.props.text.content : undefined,
      transitionIn: c.transitionIn, transitionOut: c.transitionOut,
      keyframes: Object.keys(c.keyframes).length ? Object.fromEntries(Object.entries(c.keyframes).map(([k, v]) => [k, v.map(f => [+f.t.toFixed(2), +(+f.v).toFixed(3)])])) : undefined,
      linkId: c.linkId,
    })) })),
    markers: p.markers,
  };
}
