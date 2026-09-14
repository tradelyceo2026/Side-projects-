// Sawyer — application shell: state, commands, keyboard, transport, persistence.
import * as M from './model.js';
import { runtime, restoreMedia, saveProjectJson, loadProjectJson, deleteFileBlob, clearAll } from './media.js';
import { Player } from './engine.js';
import { createTimeline, fmtTC } from './timeline.js';
import { createPanels } from './panels.js';
import { buildTools } from './ai.js';

const $ = (id) => document.getElementById(id);

const app = {
  project: M.createProject(),
  history: M.createHistory(),
  selection: new Set(),
  tool: 'select',
  snapOn: true,
  zoom: 40,
  clipboard: [],
  binSelection: null,
  player: null, tl: null, panels: null,
  fps() { return this.project.settings.fps; },
  time() { return this.player.time; },
};
window.sawyer = app;

// ---------- helpers ----------
app.toast = (text, err = false) => { const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.textContent = text; $('toasts').appendChild(el); setTimeout(() => el.remove(), err ? 5000 : 2600); };
app.status = (t) => { $('status').textContent = t; };
app.commit = (label) => { M.commit(app.history, app.project); };
let saveTimer = 0;
app.save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveProjectJson(app.project).catch(() => {}), 600); };
app.refresh = (full = true) => {
  // drop selection ids that vanished
  for (const id of [...app.selection]) if (!M.findClip(app.project, id)) app.selection.delete(id);
  app.tl.render();
  if (full) { app.panels.renderInspector(); app.panels.renderBin(); app.player.refresh(); app.save(); }
  $('tc-dur').textContent = fmtTC(M.sequenceDuration(app.project), app.fps());
};
app.select = (ids, additive = false) => {
  if (!additive) app.selection.clear();
  for (const id of ids) { if (additive && app.selection.has(id)) app.selection.delete(id); else app.selection.add(id); }
  app.tl.render(); app.panels.renderInspector();
};
app.primaryClip = () => { const id = [...app.selection][0]; return id ? M.findClip(app.project, id)?.clip || null : null; };
app.selectedClips = () => [...app.selection].map(id => M.findClip(app.project, id)?.clip).filter(Boolean);
app.seek = (t) => { const d = M.sequenceDuration(app.project); app.player.seek(Math.max(0, Math.min(Math.max(d, 0), t))); };
app.setZoom = (z) => { app.zoom = Math.max(2, Math.min(800, z)); $('zoom').value = Math.round(Math.log(app.zoom / 2) / Math.log(400) * 100); app.tl.render(); };
app.selectTab = (name) => { const btn = document.querySelector(`[data-tab="${name}"]`); if (btn) btn.click(); };
app.applySettings = () => { const c = $('program'); c.width = app.project.settings.width; c.height = app.project.settings.height; $('stage-info').textContent = `${c.width}×${c.height} · ${app.fps()} fps`; };

/** Place media on the timeline. Returns created clip ids. */
app.addMedia = (mediaId, start, { trackId = null, inPoint = 0, outPoint = null } = {}) => {
  const m = app.project.media[mediaId]; if (!m) return [];
  const p = app.project;
  const wasEmpty = M.allClips(p).length === 0;
  if (wasEmpty) setTimeout(() => app.tl.zoomFit(), 0);
  const srcLen = (outPoint ?? m.duration) - inPoint;
  const ids = [];
  if (m.type === 'audio') {
    const c = M.newClip({ mediaId, kind: 'audio', start, duration: srcLen, inPoint, name: m.name });
    M.placeClip(p, trackId || 'A1', c); ids.push(c.id); return ids;
  }
  const v = M.newClip({ mediaId, kind: m.type === 'image' ? 'image' : 'video', start, duration: m.type === 'image' ? 5 : srcLen, inPoint, name: m.name });
  const vt = trackId && M.track(p, trackId)?.kind === 'video' ? trackId : 'V1';
  M.placeClip(p, vt, v); ids.push(v.id);
  if (m.type === 'video' && m.hasAudio) {
    const a = M.newClip({ mediaId, kind: 'audio', start, duration: srcLen, inPoint, name: m.name });
    const link = 'L' + v.id; v.linkId = link; a.linkId = link;
    const at = trackId && M.track(p, trackId)?.kind === 'audio' ? trackId : ('A' + vt.slice(1));
    M.placeClip(p, M.track(p, at) ? at : 'A1', a); ids.push(a.id);
  }
  return ids;
};
app.addTextClip = ({ text = 'Title', start = null, duration = 5, trackId = 'V2', size, color, y, bg } = {}) => {
  const c = M.newClip({ mediaId: null, kind: 'text', start: start ?? app.time(), duration, name: 'Title' });
  c.props.text.content = text; if (size) c.props.text.size = size; if (color) c.props.text.color = color; if (bg) c.props.text.bg = bg; if (y !== undefined) c.props.y = y;
  M.placeClip(app.project, M.track(app.project, trackId)?.kind === 'video' ? trackId : 'V2', c);
  return c;
};
app.removeMedia = async (id) => {
  app.commit('remove media');
  for (const t of app.project.tracks) t.clips = t.clips.filter(c => c.mediaId !== id);
  delete app.project.media[id];
  const rt = runtime.get(id); if (rt) { URL.revokeObjectURL(rt.url); runtime.delete(id); }
  await deleteFileBlob(id).catch(() => {});
  app.refresh();
};
app.saveBlob = async (blob, filename) => {
  try {
    if (window.claude?.use) { const dl = await window.claude.use('downloads'); if (dl) { await dl.save({ filename, data: blob }); app.toast('Saved ' + filename); return; } }
  } catch (e) { if (e && e.code === 'declined') return; if (e && e.code && e.code !== 'unavailable') { app.toast('Save failed: ' + (e.message || e.code), true); } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
};
app.editorFacade = () => ({
  project: () => app.project, commit: (l) => app.commit(l), refresh: () => app.refresh(),
  addTextClip: (o) => app.addTextClip(o), addMedia: (id, s, o) => app.addMedia(id, s, o), select: (ids) => app.select(ids), seek: (t) => app.seek(t),
});

// ---------- commands ----------
const cmds = {
  new: async () => { if (!confirm('Start a new project? Imported media stays in the bin of the current one only.')) return; app.player.pause(); app.project = M.createProject(); app.history = M.createHistory(); app.selection.clear(); app.player.setProject(app.project); app.applySettings(); app.refresh(); await saveProjectJson(app.project).catch(() => {}); },
  open: () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json'; i.onchange = async () => { const f = i.files[0]; if (!f) return; try { const p = JSON.parse(await f.text()); if (!p.tracks) throw new Error('not a Sawyer project'); app.commit('open'); app.project = p; app.player.setProject(p); const missing = await restoreMedia(p, app.status); if (missing.length) app.toast(`${missing.length} media file(s) are offline; re-import them with the same names`, true); app.applySettings(); app.refresh(); } catch (e) { app.toast('Open failed: ' + e.message, true); } }; i.click(); },
  saveas: () => { const blob = new Blob([JSON.stringify(app.project, null, 1)], { type: 'application/json' }); app.saveBlob(blob, `${(app.project.name || 'project').replace(/[^\w-]+/g, '_')}.sawyer.json`); },
  import: () => $('file-input').click(),
  export: () => app.panels.showExport(),
  undo: () => { const p = M.undo(app.history, app.project); if (p) { app.project = p; app.player.setProject(p); app.refresh(); } else app.toast('Nothing to undo'); },
  redo: () => { const p = M.redo(app.history, app.project); if (p) { app.project = p; app.player.setProject(p); app.refresh(); } else app.toast('Nothing to redo'); },
  copy: () => { app.clipboard = app.selectedClips().map(c => JSON.parse(JSON.stringify(c))); if (app.clipboard.length) app.toast(`Copied ${app.clipboard.length} clip(s)`); },
  paste: () => { if (!app.clipboard.length) return; app.commit('paste'); const t0 = Math.min(...app.clipboard.map(c => c.start)); const linkMap = {}; const ids = []; for (const src of app.clipboard) { const c = JSON.parse(JSON.stringify(src)); c.id = M.uid('c'); c.start = app.time() + (src.start - t0); if (c.linkId) { linkMap[c.linkId] = linkMap[c.linkId] || 'L' + c.id; c.linkId = linkMap[c.linkId]; } M.placeClip(app.project, c.trackId, c); ids.push(c.id); } app.select(ids); app.refresh(); },
  dup: () => { cmds.copy(); const end = Math.max(...app.selectedClips().map(M.clipEnd)); if (isFinite(end)) { const t = app.time(); app.player.time = end; cmds.paste(); app.player.time = t; app.player.draw(); } },
  split: () => { const t = app.time(); const ids = app.selection.size ? [...app.selection] : null; app.commit('split'); const r = M.splitAll(app.project, t, ids); if (!r.length) app.toast('Nothing to split at the playhead'); app.refresh(); },
  delete: () => { if (!app.selection.size) return; app.commit('delete'); for (const id of [...app.selection]) M.removeClip(app.project, id); app.selection.clear(); app.refresh(); },
  ripple: () => { if (!app.selection.size) return; app.commit('ripple delete'); const ids = [...app.selection].map(id => M.findClip(app.project, id)?.clip).filter(Boolean).sort((a, b) => b.start - a.start); for (const c of ids) M.rippleDelete(app.project, c.id); app.selection.clear(); app.refresh(); },
  closegaps: () => { app.commit('close gaps'); M.closeGaps(app.project); app.refresh(); },
  selectall: () => app.select(M.allClips(app.project).map(c => c.id)),
  unlink: () => { const cs = app.selectedClips(); if (!cs.length) return; app.commit('link'); const anyLinked = cs.some(c => c.linkId); if (anyLinked) { for (const c of cs) c.linkId = null; app.toast('Unlinked'); } else if (cs.length === 2 && cs[0].kind !== cs[1].kind) { const l = 'L' + cs[0].id; cs[0].linkId = l; cs[1].linkId = l; app.toast('Linked'); } app.refresh(); },
  toggle: () => { const cs = app.selectedClips(); if (!cs.length) return; app.commit('toggle'); for (const c of cs) c.enabled = !c.enabled; app.refresh(); },
  settings: () => app.panels.showSettings(),
  addtext: () => { app.commit('title'); const c = app.addTextClip({ text: 'Title', start: app.time() }); app.select([c.id]); app.refresh(); app.selectTab('inspector'); },
  marker: () => { app.commit('marker'); app.project.markers.push({ time: app.time(), name: `Marker ${app.project.markers.length + 1}` }); app.refresh(); },
  markin: () => { app.commit('in'); app.project.inPoint = app.time(); if (app.project.outPoint !== null && app.project.outPoint <= app.project.inPoint) app.project.outPoint = null; app.refresh(); },
  markout: () => { app.commit('out'); app.project.outPoint = app.time(); if (app.project.inPoint !== null && app.project.inPoint >= app.project.outPoint) app.project.inPoint = null; app.refresh(); },
  clearinout: () => { app.commit('clear in/out'); app.project.inPoint = null; app.project.outPoint = null; app.refresh(); },
  shortcuts: () => app.panels.showShortcuts(),
  about: () => app.panels.showAbout(),
  home: () => app.seek(0),
  end: () => app.seek(M.sequenceDuration(app.project)),
  stepback: (n = 1) => app.seek(app.time() - n / app.fps()),
  stepfwd: (n = 1) => app.seek(app.time() + n / app.fps()),
  playpause: () => { if (app.player.playing) app.player.pause(); else app.player.play(1); updatePlayBtn(); },
  loop: () => { app.player.loopRange = !app.player.loopRange; $('btn-loop').classList.toggle('on', app.player.loopRange); },
  snap: () => { app.snapOn = !app.snapOn; $('btn-snap').classList.toggle('on', app.snapOn); },
  zoomin: () => app.setZoom(app.zoom * 1.4), zoomout: () => app.setZoom(app.zoom / 1.4), zoomfit: () => app.tl.zoomFit(),
  rippleTrimHead: () => { const c = app.primaryClip(); if (!c) return; app.commit('ripple trim'); const md = app.project.media[c.mediaId]?.duration ?? Infinity; const old = c.start; for (const o of linked(c)) M.trimStart(app.project, o.id, app.time(), md); const d = c.start - old; for (const o of M.allClips(app.project)) if (o.start >= old && !linked(c).includes(o)) o.start -= d; for (const o of linked(c)) o.start = old; app.refresh(); },
  rippleTrimTail: () => { const c = app.primaryClip(); if (!c) return; app.commit('ripple trim'); const md = app.project.media[c.mediaId]?.duration ?? Infinity; const oldEnd = M.clipEnd(c); for (const o of linked(c)) M.trimEnd(app.project, o.id, app.time(), md); const d = oldEnd - M.clipEnd(c); for (const o of M.allClips(app.project)) if (o.start >= oldEnd - 1e-6) o.start -= d; app.refresh(); },
};
app.cmds = cmds;
app.tools = () => buildTools(app.editorFacade());
function linked(c) { const ids = [c]; if (c.linkId) for (const o of M.allClips(app.project)) if (o.linkId === c.linkId && o.id !== c.id) ids.push(o); return ids; }
function updatePlayBtn() { $('btn-play').textContent = app.player.playing ? '❚❚' : '▶'; }

document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); const c = cmds[b.dataset.cmd]; if (c) c(); closeMenus(); }));
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
function setTool(t) { app.tool = t; document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); $('tl-scroll').classList.toggle('razor', t === 'razor'); }
document.querySelectorAll('.menu > button').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); const m = b.parentElement; const open = m.classList.contains('open'); closeMenus(); if (!open) m.classList.add('open'); }));
function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
document.addEventListener('click', closeMenus);
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { const tabs = b.parentElement; tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); tabs.parentElement.querySelectorAll('.tabpage').forEach(pg => pg.classList.toggle('on', pg.dataset.page === b.dataset.tab)); }));
$('zoom').addEventListener('input', (e) => { app.zoom = 2 * Math.pow(400, e.target.value / 100); app.tl.render(); });

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key === 'Escape') e.target.blur(); return; }
  if (!$('modal').hidden) { if (e.key === 'Escape') app.panels.closeModal(); return; }
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  const run = (fn) => { e.preventDefault(); fn(); };
  if (mod && k.toLowerCase() === 'z') return run(e.shiftKey ? cmds.redo : cmds.undo);
  if (mod && k.toLowerCase() === 'y') return run(cmds.redo);
  if (mod && k.toLowerCase() === 'k') return run(cmds.split);
  if (mod && k.toLowerCase() === 'c') return run(cmds.copy);
  if (mod && k.toLowerCase() === 'v') return run(cmds.paste);
  if (mod && k.toLowerCase() === 'd') return run(cmds.dup);
  if (mod && k.toLowerCase() === 'a') return run(cmds.selectall);
  if (mod && k.toLowerCase() === 't') return run(cmds.addtext);
  if (mod && k.toLowerCase() === 'l') return run(cmds.unlink);
  if (mod && k.toLowerCase() === 'i') return run(cmds.import);
  if (mod && k.toLowerCase() === 'm') return run(cmds.export);
  if (mod && k.toLowerCase() === 's') return run(cmds.saveas);
  if (mod && e.shiftKey && k.toLowerCase() === 'x') return run(cmds.clearinout);
  if (mod) return;
  switch (k) {
    case ' ': return run(cmds.playpause);
    case 'k': case 'K': return run(() => { app.player.pause(); updatePlayBtn(); });
    case 'l': case 'L': return run(() => { app.player.play(app.player.playing && app.player.rate > 0 ? Math.min(8, app.player.rate * 2) : 1); updatePlayBtn(); });
    case 'j': case 'J': return run(() => { app.player.play(app.player.playing && app.player.rate < 0 ? Math.max(-8, app.player.rate * 2) : -1); updatePlayBtn(); });
    case 'ArrowLeft': return run(() => cmds.stepback(e.shiftKey ? 10 : 1));
    case 'ArrowRight': return run(() => cmds.stepfwd(e.shiftKey ? 10 : 1));
    case 'Home': return run(cmds.home);
    case 'End': return run(cmds.end);
    case 'i': case 'I': return run(cmds.markin);
    case 'o': case 'O': return run(cmds.markout);
    case 'm': case 'M': return run(cmds.marker);
    case 'v': case 'V': return run(() => setTool('select'));
    case 'c': case 'C': return run(() => setTool('razor'));
    case 's': case 'S': return run(cmds.snap);
    case 'q': case 'Q': return run(cmds.rippleTrimHead);
    case 'w': case 'W': return run(cmds.rippleTrimTail);
    case 'e': case 'E': if (e.shiftKey) return run(cmds.toggle); break;
    case 'Delete': case 'Backspace': return run(e.shiftKey ? cmds.ripple : cmds.delete);
    case '+': case '=': return run(cmds.zoomin);
    case '-': case '_': return run(cmds.zoomout);
    case '\\': return run(cmds.zoomfit);
    case '?': return run(cmds.shortcuts);
    case 'Escape': return run(() => app.select([]));
  }
});

// ---------- resizable timeline ----------
(() => {
  const split = $('split'); const appEl = $('app');
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    const move = (ev) => { const h = Math.max(140, Math.min(window.innerHeight * 0.7, window.innerHeight - ev.clientY)); appEl.style.gridTemplateRows = `34px 1fr 6px ${h}px`; app.tl.render(); };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', () => split.removeEventListener('pointermove', move), { once: true });
  });
})();

// ---------- boot ----------
async function boot() {
  app.player = new Player(app.project, $('program'));
  app.player.onTime = (t) => { $('tc').textContent = fmtTC(t, app.fps()); $('tc2').textContent = fmtTC(t, app.fps()); app.tl.setPlayhead(t); if (app.player.playing) app.tl.ensureVisible(t); if (!app.player.playing) app.panels.renderInspectorSoft?.(); };
  app.tl = createTimeline(app);
  app.panels = createPanels(app);
  app.applySettings();
  try {
    const saved = await loadProjectJson();
    if (saved && saved.tracks) {
      app.project = saved; app.player.setProject(saved);
      app.status('Restoring media…');
      const missing = await restoreMedia(saved, app.status);
      if (missing.length) app.toast(`${missing.length} media file(s) could not be restored`, true);
      app.applySettings();
    }
  } catch (e) { console.warn('restore failed', e); }
  app.panels.renderFx();
  app.refresh();
  app.tl.zoomFit();
  app.player.draw();
  app.status('Ready');
  app.panels.initAI();
  window.addEventListener('resize', () => app.tl.render());
  // keep the inspector's keyframe buttons in sync when the playhead moves (cheap re-render when idle)
  let lastT = -1; setInterval(() => { if (!app.player.playing && app.selection.size && Math.abs(app.time() - lastT) > 1e-6) { lastT = app.time(); app.panels.renderInspector(); } }, 400);
  $('program').addEventListener('click', () => { if (app.player.playing) { app.player.pause(); updatePlayBtn(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden && app.player.playing) { app.player.pause(); updatePlayBtn(); } });
  const origPause = app.player.pause.bind(app.player); app.player.pause = () => { origPause(); updatePlayBtn(); };
}
boot();
