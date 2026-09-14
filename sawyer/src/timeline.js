// Sawyer — DOM timeline: tracks, clips, trimming, moving, razor, ruler, snapping, drag-drop from the bin.
import { track, findClip, clipEnd, allClips, sequenceDuration, moveClip, trimStart, trimEnd, splitClip, snapPoints, snap, placeClip } from './model.js';
import { runtime } from './media.js';

export function fmtTC(t, fps = 30) {
  if (!isFinite(t)) t = 0;
  t = Math.max(0, t);
  const f = Math.floor((t - Math.floor(t)) * fps);
  const s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export function createTimeline(app) {
  const $ = (id) => document.getElementById(id);
  const scroll = $('tl-scroll'), content = $('tl-content'), lanes = $('lanes'), heads = $('tl-heads'), ruler = $('ruler'), rulerCanvas = ruler.querySelector('canvas'), playhead = $('playhead'), inout = $('inout'), snapline = $('snapline');
  const LEFT_PAD = 10;
  const tl = { render, setPlayhead, zoomFit, ensureVisible, pxPerSec: () => app.zoom };
  const x2t = (x) => (x - LEFT_PAD) / app.zoom;
  const t2x = (t) => LEFT_PAD + t * app.zoom;

  function contentWidth() { return Math.max(scroll.clientWidth, t2x(sequenceDuration(app.project) + 30)); }

  function drawRuler() {
    const W = contentWidth();
    const dpr = window.devicePixelRatio || 1;
    rulerCanvas.width = W * dpr; rulerCanvas.height = 26 * dpr; rulerCanvas.style.width = W + 'px'; rulerCanvas.style.height = '26px';
    const c = rulerCanvas.getContext('2d'); c.scale(dpr, dpr);
    c.fillStyle = '#202126'; c.fillRect(0, 0, W, 26);
    const pps = app.zoom;
    const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let major = steps.find(s => s * pps >= 80) || 600;
    const minor = major / (major >= 1 ? 5 : 2);
    c.strokeStyle = '#4a4b52'; c.fillStyle = '#b8bac2'; c.font = '10.5px ui-monospace, Menlo, monospace'; c.textBaseline = 'top';
    const tEnd = x2t(W);
    for (let t = 0; t <= tEnd; t += minor) {
      const x = t2x(t);
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      c.beginPath(); c.moveTo(x + 0.5, isMajor ? 12 : 19); c.lineTo(x + 0.5, 26); c.stroke();
      if (isMajor) c.fillText(fmtTC(t, app.fps()).replace(/^00:/, ''), x + 3, 2);
    }
  }

  function trackRow(t) {
    const div = document.createElement('div');
    div.className = `head ${t.kind}`;
    div.innerHTML = `<span class="nm">${t.name}</span>
      <button class="m ${t.muted ? 'on' : ''}" title="Mute">M</button>
      ${t.kind === 'audio' ? `<button class="s ${t.solo ? 'on' : ''}" title="Solo">S</button>` : ''}
      <button class="l ${t.locked ? 'on' : ''}" title="Lock">🔒</button>`;
    div.querySelector('.m').onclick = () => { t.muted = !t.muted; app.refresh(); app.player.refresh(); };
    const s = div.querySelector('.s'); if (s) s.onclick = () => { t.solo = !t.solo; app.refresh(); app.player.refresh(); };
    div.querySelector('.l').onclick = () => { t.locked = !t.locked; app.refresh(); };
    return div;
  }

  function clipEl(c, t) {
    const el = document.createElement('div');
    el.className = `clip ${c.kind} ${app.selection.has(c.id) ? 'selected' : ''} ${c.enabled ? '' : 'disabled'}`;
    el.dataset.id = c.id;
    el.style.left = t2x(c.start) + 'px';
    el.style.width = Math.max(2, c.duration * app.zoom) + 'px';
    const rt = c.mediaId ? runtime.get(c.mediaId) : null;
    if (c.kind === 'video' && rt && rt.thumbs && rt.thumbs.length) {
      const strip = document.createElement('div'); strip.className = 'thumbs';
      const w = c.duration * app.zoom; const per = 48 * (16 / 9);
      const n = Math.max(1, Math.min(60, Math.ceil(w / per)));
      const md = app.project.media[c.mediaId];
      for (let i = 0; i < n; i++) {
        const srcT = c.inPoint + (i + 0.5) / n * c.duration * c.speed;
        const idx = Math.min(rt.thumbs.length - 1, Math.max(0, Math.floor(srcT / (md.duration || 1) * rt.thumbs.length)));
        const img = document.createElement('img'); if (rt.thumbs[idx]) img.src = rt.thumbs[idx]; strip.appendChild(img);
      }
      el.appendChild(strip);
    }
    if (c.kind === 'audio' && rt && rt.peaks) {
      const cv = document.createElement('canvas'); cv.className = 'wave';
      const w = Math.max(2, Math.floor(c.duration * app.zoom)), h = 42; cv.width = Math.min(w, 4000); cv.height = h;
      const g = cv.getContext('2d'); g.fillStyle = 'rgba(255,255,255,0.55)';
      const pps = rt.peaksPerSecond;
      for (let x = 0; x < cv.width; x++) {
        const tt = c.inPoint + (x / cv.width) * c.duration * c.speed;
        const i = Math.floor(tt * pps);
        const v = Math.min(1, (rt.peaks[i] || 0) * 3.2) * c.props.volume;
        const bh = Math.max(1, v * (h - 4));
        g.fillRect(x, (h - bh) / 2, 1, bh);
      }
      el.appendChild(cv);
    }
    const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = c.kind === 'text' ? `T  ${c.props.text.content.split('\n')[0]}` : c.name; el.appendChild(lbl);
    if (c.transitionIn) { const d = document.createElement('div'); d.className = 'tr in'; d.style.width = c.transitionIn.duration * app.zoom + 'px'; d.title = c.transitionIn.type; el.appendChild(d); }
    if (c.transitionOut) { const d = document.createElement('div'); d.className = 'tr out'; d.style.width = c.transitionOut.duration * app.zoom + 'px'; d.title = c.transitionOut.type; el.appendChild(d); }
    if (Object.keys(c.keyframes).length) { const k = document.createElement('div'); k.className = 'kfm'; k.textContent = '◆ ' + Object.keys(c.keyframes).join(' '); el.appendChild(k); }
    if (!t.locked) {
      const hl = document.createElement('div'); hl.className = 'h l'; const hr = document.createElement('div'); hr.className = 'h r';
      el.appendChild(hl); el.appendChild(hr);
      hl.addEventListener('pointerdown', (e) => startTrim(e, c, 'l'));
      hr.addEventListener('pointerdown', (e) => startTrim(e, c, 'r'));
    }
    el.addEventListener('pointerdown', (e) => onClipDown(e, c, t));
    el.addEventListener('dblclick', () => { app.selectTab('inspector'); });
    return el;
  }

  function render() {
    const p = app.project;
    heads.innerHTML = ''; lanes.innerHTML = '';
    const sp = document.createElement('div'); sp.className = 'head spacer'; heads.appendChild(sp);
    content.style.width = contentWidth() + 'px';
    for (const t of p.tracks) {
      heads.appendChild(trackRow(t));
      const lane = document.createElement('div'); lane.className = `lane ${t.kind}`; lane.dataset.track = t.id;
      lane.style.backgroundSize = `${app.zoom}px 100%`; lane.style.backgroundPosition = `${LEFT_PAD}px 0`;
      for (const c of t.clips) lane.appendChild(clipEl(c, t));
      lane.addEventListener('pointerdown', (e) => { if (e.target === lane) onLaneDown(e, lane); });
      lane.addEventListener('dragover', (e) => { if (canDropOn(e, t)) { e.preventDefault(); lane.classList.add('over'); } });
      lane.addEventListener('dragleave', () => lane.classList.remove('over'));
      lane.addEventListener('drop', (e) => { lane.classList.remove('over'); onDrop(e, t); });
      lanes.appendChild(lane);
    }
    // markers
    for (const m of p.markers) {
      const el = document.createElement('div'); el.className = 'marker'; el.style.left = t2x(m.time) + 'px'; el.title = m.name || 'marker';
      el.onclick = (e) => { e.stopPropagation(); app.seek(m.time); };
      el.ondblclick = (e) => { e.stopPropagation(); app.commit('remove marker'); p.markers = p.markers.filter(x => x !== m); app.refresh(); };
      ruler.appendChild(el);
    }
    ruler.querySelectorAll('.marker').forEach(m => { if (!p.markers.length) m.remove(); });
    if (p.inPoint !== null && p.outPoint !== null && p.outPoint > p.inPoint) { inout.hidden = false; inout.style.left = t2x(p.inPoint) + 'px'; inout.style.width = (p.outPoint - p.inPoint) * app.zoom + 'px'; }
    else if (p.inPoint !== null || p.outPoint !== null) { inout.hidden = false; const a = p.inPoint ?? 0, b = p.outPoint ?? sequenceDuration(p); inout.style.left = t2x(Math.min(a, b)) + 'px'; inout.style.width = Math.max(2, Math.abs(b - a) * app.zoom) + 'px'; }
    else inout.hidden = true;
    drawRuler();
    setPlayhead(app.time());
    heads.scrollTop = scroll.scrollTop;
  }

  function setPlayhead(t) { playhead.style.left = t2x(t) + 'px'; }
  function ensureVisible(t) {
    const x = t2x(t);
    if (x < scroll.scrollLeft + 20 || x > scroll.scrollLeft + scroll.clientWidth - 20) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.3);
  }
  function zoomFit() {
    const d = Math.max(1, sequenceDuration(app.project));
    app.setZoom((scroll.clientWidth - LEFT_PAD - 40) / d);
  }
  scroll.addEventListener('scroll', () => { heads.scrollTop = scroll.scrollTop; });
  scroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); const t = x2t(e.clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft); app.setZoom(app.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); scroll.scrollLeft = t2x(t) - (e.clientX - scroll.getBoundingClientRect().left); }
    else if (e.shiftKey || Math.abs(e.deltaX) < Math.abs(e.deltaY) && !e.shiftKey && false) { }
  }, { passive: false });

  // ----- ruler scrub -----
  const pointerTime = (e) => Math.max(0, x2t(e.clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft));
  ruler.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('marker')) return;
    ruler.setPointerCapture(e.pointerId);
    const move = (ev) => app.seek(pointerTime(ev));
    move(e);
    ruler.addEventListener('pointermove', move);
    ruler.addEventListener('pointerup', () => ruler.removeEventListener('pointermove', move), { once: true });
  });

  function onLaneDown(e, lane) {
    if (app.tool === 'razor') return;
    // click on empty lane: deselect + scrub
    if (!e.shiftKey) app.select([]);
    app.seek(pointerTime(e));
    lane.setPointerCapture(e.pointerId);
    const move = (ev) => app.seek(pointerTime(ev));
    lane.addEventListener('pointermove', move);
    lane.addEventListener('pointerup', () => lane.removeEventListener('pointermove', move), { once: true });
  }

  // ----- clip drag / select / razor -----
  function onClipDown(e, c, t) {
    if (e.target.classList.contains('h')) return;
    e.stopPropagation();
    if (app.tool === 'razor') {
      const time = pointerTime(e);
      app.commit('razor');
      const r = splitClip(app.project, c.id, snapTime(time, [c.id]));
      if (r && c.linkId) for (const o of allClips(app.project)) if (o.linkId === c.linkId && o.id !== c.id && o.id !== r.right.id) splitClip(app.project, o.id, r.right.start);
      app.refresh(); return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) app.select([c.id], true);
    else if (!app.selection.has(c.id)) app.select(linkedIds(c));
    if (t.locked) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const origin = [...app.selection].map(id => { const f = findClip(app.project, id); return f ? { id, start: f.clip.start, track: f.track.id } : null; }).filter(Boolean);
    let moved = false, committed = false;
    const laneAt = (y) => document.elementsFromPoint(e.clientX, y).find(n => n.classList && n.classList.contains('lane'));
    const move = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!committed) { app.commit('move'); committed = true; }
      moved = true;
      let dt = dx / app.zoom;
      // snap the primary clip's edges
      const prim = origin.find(o => o.id === c.id) || origin[0];
      const excl = origin.map(o => o.id);
      const pts = snapPoints(app.project, excl, app.time());
      const s = prim.start + dt, en = s + c.duration;
      if (app.snapOn) {
        const tol = 8 / app.zoom;
        const ss = snap(s, pts, tol), se = snap(en, pts, tol);
        if (ss !== s) { dt += ss - s; showSnap(ss); } else if (se !== en) { dt += se - en; showSnap(se); } else hideSnap();
      }
      // vertical: only the primary clip changes track (same kind)
      const lane = laneAt(ev.clientY);
      let newTrack = null;
      if (lane && lane.dataset.track !== prim.track) { const tt = track(app.project, lane.dataset.track); if (tt && tt.kind === t.kind && !tt.locked) newTrack = tt.id; }
      // restore originals then move (so repeated moves don't accumulate overwrite damage)
      restore(origin);
      for (const o of origin) moveClip(app.project, o.id, Math.max(0, o.start + dt), o.id === c.id ? (newTrack || o.track) : null);
      app.refresh(false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move); hideSnap();
      if (moved) { app.refresh(); }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  }
  const snapshotClips = new Map();
  function restore(origin) {
    for (const o of origin) { const f = findClip(app.project, o.id); if (!f) continue; if (f.track.id !== o.track) { f.track.clips = f.track.clips.filter(x => x.id !== o.id); f.clip.trackId = o.track; track(app.project, o.track).clips.push(f.clip); } f.clip.start = o.start; }
  }
  function linkedIds(c) { const ids = [c.id]; if (c.linkId) for (const o of allClips(app.project)) if (o.linkId === c.linkId && o.id !== c.id) ids.push(o.id); return ids; }
  function snapTime(t, excl = []) { if (!app.snapOn) return t; return snap(t, snapPoints(app.project, excl, app.time()), 8 / app.zoom); }
  function showSnap(t) { snapline.style.display = 'block'; snapline.style.left = t2x(t) + 'px'; }
  function hideSnap() { snapline.style.display = 'none'; }

  function startTrim(e, c, side) {
    e.stopPropagation(); e.preventDefault();
    const h = e.currentTarget; h.setPointerCapture(e.pointerId);
    app.commit('trim');
    const ids = linkedIds(c);
    const md = app.project.media[c.mediaId]?.duration ?? Infinity;
    const move = (ev) => {
      let t = snapTime(pointerTime(ev), ids);
      for (const id of ids) { if (side === 'l') trimStart(app.project, id, t, md); else trimEnd(app.project, id, t, md); }
      app.refresh(false); app.player.draw();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', () => { h.removeEventListener('pointermove', move); hideSnap(); app.refresh(); }, { once: true });
  }

  // ----- drag from bin -----
  function canDropOn(e, t) { const kind = e.dataTransfer.types.includes('text/x-sawyer-kind') ? null : null; return !t.locked; }
  function onDrop(e, t) {
    e.preventDefault();
    const mediaId = e.dataTransfer.getData('text/x-sawyer-media');
    if (!mediaId) return;
    const m = app.project.media[mediaId]; if (!m) return;
    const time = snapTime(pointerTime(e));
    const wantKind = m.type === 'audio' ? 'audio' : 'video';
    if (t.kind !== wantKind) { app.toast(`${m.type} goes on a ${wantKind} track`, true); return; }
    app.commit('add media');
    app.addMedia(mediaId, time, { trackId: t.id });
    app.refresh();
  }

  return tl;
}
