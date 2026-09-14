// Sawyer — project bin, effect controls (inspector), effects list, dialogs, AI panel.
import { findClip, clipEnd, setKeyframe, removeKeyframe, valueAt, setTransition, allClips, summarize, sequenceDuration } from './model.js';
import { runtime, importFile } from './media.js';
import { PRESETS, exportProject, webCodecsAvailable, pickCodecs } from './export.js';
import { buildTools, sampleBackend, apiBackend } from './ai.js';
import { fmtTC } from './timeline.js';

const TRANSITIONS = [['dissolve', 'Cross dissolve'], ['dip', 'Dip to black'], ['wipe', 'Wipe'], ['slide', 'Slide'], ['zoom', 'Zoom']];
const PRESET_FX = [
  ['Black & white', { grayscale: 1 }], ['Sepia', { sepia: 0.8 }], ['Warm', { hueRotate: -12, saturate: 1.15 }], ['Cool', { hueRotate: 12, saturate: 1.05 }],
  ['Punchy', { contrast: 1.2, saturate: 1.3 }], ['Faded', { contrast: 0.85, brightness: 1.1, saturate: 0.8 }], ['Dreamy blur', { blur: 3, brightness: 1.05 }], ['Reset colour', { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, blur: 0, grayscale: 0, sepia: 0 }],
];

export function createPanels(app) {
  const $ = (id) => document.getElementById(id);
  const fmtDur = (s) => { if (!isFinite(s)) return ''; const m = Math.floor(s / 60), sec = (s % 60).toFixed(1); return `${m}:${sec.padStart(4, '0')}`; };

  // ---------- project bin ----------
  function renderBin() {
    const bin = $('bin'); bin.innerHTML = '';
    const items = Object.values(app.project.media);
    if (!items.length) { bin.innerHTML = '<div class="hint">No media yet. Import files or drop them below.</div>'; return; }
    for (const m of items) {
      const rt = runtime.get(m.id);
      const el = document.createElement('div'); el.className = 'media'; el.draggable = true; el.dataset.id = m.id;
      const th = rt?.thumbs?.[1] ? `<img src="${rt.thumbs[1]}">` : (m.type === 'image' && rt ? `<img src="${rt.url}">` : (m.type === 'audio' ? '♪ audio' : (rt ? 'video' : 'offline')));
      el.innerHTML = `<div class="th">${th}</div><div><div class="nm" title="${m.name}">${m.name}</div><div class="meta">${m.type} · ${fmtDur(m.duration)}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.hasAudio ? ' · audio' : ''}${rt ? '' : ' · <span style="color:var(--danger)">offline</span>'}</div></div>`;
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-sawyer-media', m.id); e.dataTransfer.effectAllowed = 'copy'; });
      el.addEventListener('dblclick', () => { app.commit('insert'); app.addMedia(m.id, app.time()); app.refresh(); });
      el.addEventListener('click', () => { bin.querySelectorAll('.media').forEach(x => x.classList.remove('on')); el.classList.add('on'); app.binSelection = m.id; });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (confirm(`Remove ${m.name} from the project? Clips using it are removed too.`)) app.removeMedia(m.id); });
      bin.appendChild(el);
    }
  }

  async function importFiles(files) {
    for (const f of files) {
      try {
        app.status(`Importing ${f.name}…`);
        const rec = await importFile(f, { onProgress: (s) => app.status(`${f.name}: ${s}`) });
        app.project.media[rec.id] = rec;
        app.refresh();
        app.toast(`Imported ${rec.name}`);
      } catch (e) { app.toast(`${f.name}: ${e.message}`, true); }
    }
    app.status('Ready');
    app.save();
  }
  $('file-input').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
  const dz = $('dropzone');
  for (const target of [dz, document.body]) {
    target.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dz.classList.add('over'); } });
    target.addEventListener('dragleave', () => dz.classList.remove('over'));
    target.addEventListener('drop', (e) => { if (e.dataTransfer.files?.length) { e.preventDefault(); dz.classList.remove('over'); importFiles([...e.dataTransfer.files]); } });
  }

  // ---------- effects list ----------
  function renderFx() {
    const g = $('fx-grid'); g.innerHTML = '';
    const add = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { const c = app.primaryClip(); if (!c) { app.toast('Select a clip first', true); return; } app.commit(label); fn(c); app.refresh(); }; g.appendChild(b); };
    for (const [type, label] of TRANSITIONS) { add(`${label} → in`, (c) => setTransition(app.project, c.id, 'in', type, 1)); add(`${label} → out`, (c) => setTransition(app.project, c.id, 'out', type, 1)); }
    for (const [label, vals] of PRESET_FX) add(label, (c) => Object.assign(c.props.filters, vals));
    add('Fade audio in/out 1 s', (c) => { c.props.fadeIn = 1; c.props.fadeOut = 1; });
    add('Ken Burns (slow zoom)', (c) => { setKeyframe(c, 'scale', 0, 1); setKeyframe(c, 'scale', c.duration, 1.15); });
    add('Fade to black at end', (c) => { setKeyframe(c, 'opacity', Math.max(0, c.duration - 1), 1); setKeyframe(c, 'opacity', c.duration, 0); });
    add('Reverse speed ramp 2×', (c) => { const src = c.duration * c.speed; c.speed = 2; c.duration = src / 2; });
  }

  // ---------- inspector ----------
  function renderInspector() {
    const box = $('inspector');
    const c = app.primaryClip();
    if (!c) { box.innerHTML = '<div class="hint">Select a clip to edit its motion, opacity, audio, colour and text.</div>'; return; }
    const f = findClip(app.project, c.id);
    const lt = () => Math.min(c.duration, Math.max(0, app.time() - c.start));
    box.innerHTML = '';
    const sec = (title, extra = '') => { const s = document.createElement('div'); s.className = 'sec'; s.innerHTML = `<h4><span>${title}</span><span>${extra}</span></h4>`; box.appendChild(s); return s; };

    const head = sec('Clip', `${f.track.name} · ${fmtTC(c.start, app.fps())}`);
    head.innerHTML += `<div class="row2"><label>Name</label><input type="text" id="i-name" value="${escapeHtml(c.name)}"></div>
      <div class="row2"><label>Enabled</label><label><input type="checkbox" id="i-enabled" ${c.enabled ? 'checked' : ''}> visible / audible</label></div>
      <div class="row2"><label>Speed</label><div style="display:flex;gap:6px;align-items:center"><input type="number" id="i-speed" step="0.05" min="0.1" max="8" value="${c.speed}"><span style="color:var(--dim)">× (${c.duration.toFixed(2)} s)</span></div></div>`;
    head.querySelector('#i-name').onchange = (e) => { app.commit('rename'); c.name = e.target.value; app.refresh(); };
    head.querySelector('#i-enabled').onchange = (e) => { app.commit('enable'); c.enabled = e.target.checked; app.refresh(); };
    head.querySelector('#i-speed').onchange = (e) => { const s = Math.max(0.1, Math.min(8, +e.target.value || 1)); app.commit('speed'); const src = c.duration * c.speed; c.speed = s; c.duration = src / s; for (const o of allClips(app.project)) if (c.linkId && o.linkId === c.linkId && o.id !== c.id) { o.speed = s; o.duration = c.duration; } app.refresh(); };

    const animRow = (parent, label, prop, min, max, step, fmt = (v) => v) => {
      const row = document.createElement('div'); row.className = 'row';
      const hasKf = !!(c.keyframes[prop] && c.keyframes[prop].length);
      const atKf = hasKf && c.keyframes[prop].some(k => Math.abs(k.t - lt()) < 1 / app.fps());
      const cur = valueAt(c, prop, lt());
      row.innerHTML = `<label title="${prop}">${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${cur}"><input type="number" step="${step}" value="${+(+cur).toFixed(3)}"><button class="kf ${hasKf ? 'on' : ''}" title="${atKf ? 'Remove keyframe here' : 'Add keyframe at playhead'} (${hasKf ? c.keyframes[prop].length + ' keyframes' : 'no keyframes'})">${atKf ? '◆' : hasKf ? '◇' : '○'}</button>`;
      const [range, num, kf] = [row.children[1], row.children[2], row.children[3]];
      const apply = (v, final) => {
        v = +v; if (!Number.isFinite(v)) return;
        if (final) app.commit(prop);
        if (hasKf) setKeyframe(c, prop, lt(), v);
        else if (prop.startsWith('filters.')) c.props.filters[prop.slice(8)] = v; else c.props[prop] = v;
        range.value = v; num.value = +v.toFixed(3);
        app.player.draw(); if (final) app.refresh();
      };
      range.oninput = (e) => apply(e.target.value, false); range.onchange = (e) => apply(e.target.value, true);
      num.onchange = (e) => apply(e.target.value, true);
      kf.onclick = () => { app.commit('keyframe'); if (atKf) removeKeyframe(c, prop, c.keyframes[prop].find(k => Math.abs(k.t - lt()) < 1 / app.fps()).t); else setKeyframe(c, prop, lt(), cur); app.refresh(); };
      parent.appendChild(row);
    };

    if (c.kind !== 'audio') {
      const m = sec('Motion', 'position in px at 1080p');
      animRow(m, 'Position X', 'x', -1920, 1920, 1); animRow(m, 'Position Y', 'y', -1080, 1080, 1);
      animRow(m, 'Scale', 'scale', 0, 4, 0.01); animRow(m, 'Rotation', 'rotation', -180, 180, 0.5);
      animRow(m, 'Opacity', 'opacity', 0, 1, 0.01);
      const cr = document.createElement('div'); cr.className = 'row2'; cr.innerHTML = `<label>Crop L/R/T/B %</label><div style="display:flex;gap:4px">${['left', 'right', 'top', 'bottom'].map(k => `<input type="number" data-crop="${k}" min="0" max="90" step="1" value="${Math.round(c.props.crop[k] * 100)}" style="width:52px">`).join('')}</div>`;
      cr.querySelectorAll('input').forEach(i => i.onchange = () => { app.commit('crop'); c.props.crop[i.dataset.crop] = Math.max(0, Math.min(0.9, (+i.value || 0) / 100)); app.refresh(); });
      m.appendChild(cr);

      const col = sec('Colour');
      animRow(col, 'Brightness', 'filters.brightness', 0, 2, 0.01); animRow(col, 'Contrast', 'filters.contrast', 0, 2, 0.01); animRow(col, 'Saturation', 'filters.saturate', 0, 2, 0.01);
      animRow(col, 'Hue', 'filters.hueRotate', -180, 180, 1); animRow(col, 'Blur', 'filters.blur', 0, 20, 0.5); animRow(col, 'Grayscale', 'filters.grayscale', 0, 1, 0.01); animRow(col, 'Sepia', 'filters.sepia', 0, 1, 0.01);

      const tr = sec('Transitions');
      for (const side of ['in', 'out']) {
        const cur = side === 'in' ? c.transitionIn : c.transitionOut;
        const r = document.createElement('div'); r.className = 'row2';
        r.innerHTML = `<label>${side === 'in' ? 'Start' : 'End'}</label><div style="display:flex;gap:6px"><select><option value="">none</option>${TRANSITIONS.map(([v, l]) => `<option value="${v}" ${cur?.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select><input type="number" step="0.1" min="0.1" max="10" value="${cur?.duration ?? 1}" style="width:64px"> s</div>`;
        const [sel, dur] = r.querySelectorAll('select, input');
        const upd = () => { app.commit('transition'); setTransition(app.project, c.id, side, sel.value || null, +dur.value || 1); app.refresh(); };
        sel.onchange = upd; dur.onchange = upd;
        tr.appendChild(r);
      }
    }
    if (c.kind === 'text') {
      const t = sec('Text');
      const tx = c.props.text;
      t.innerHTML += `<div class="row2"><label>Content</label><textarea id="t-content" rows="3">${escapeHtml(tx.content)}</textarea></div>
        <div class="row2"><label>Font</label><select id="t-font">${['Inter, system-ui, sans-serif', 'Georgia, serif', 'Impact, Haettenschweiler, sans-serif', '"Courier New", monospace', '"Comic Sans MS", cursive', 'Verdana, sans-serif'].map(f => `<option value='${f}' ${tx.font === f ? 'selected' : ''}>${f.split(',')[0].replace(/"/g, '')}</option>`).join('')}</select></div>
        <div class="row2"><label>Size</label><input type="number" id="t-size" value="${tx.size}" min="8" max="600"></div>
        <div class="row2"><label>Weight</label><select id="t-weight"><option value="400" ${tx.weight == 400 ? 'selected' : ''}>Regular</option><option value="700" ${tx.weight == 700 ? 'selected' : ''}>Bold</option><option value="900" ${tx.weight == 900 ? 'selected' : ''}>Black</option></select></div>
        <div class="row2"><label>Align</label><select id="t-align">${['left', 'center', 'right'].map(a => `<option ${tx.align === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
        <div class="row2"><label>Colour</label><input type="color" id="t-color" value="${tx.color}"></div>
        <div class="row2"><label>Background</label><div style="display:flex;gap:6px;align-items:center"><input type="color" id="t-bg" value="${tx.bg === 'transparent' ? '#000000' : tx.bg}"><label><input type="checkbox" id="t-bgon" ${tx.bg !== 'transparent' ? 'checked' : ''}> on</label></div></div>
        <div class="row2"><label>Outline</label><input type="number" id="t-outline" value="${tx.outline || 0}" min="0" max="40"></div>`;
      const bind = (id, fn) => { const el = t.querySelector('#' + id); el.oninput = () => { fn(el); app.player.draw(); }; el.onchange = () => { app.commit('text'); fn(el); app.refresh(); }; };
      bind('t-content', (el) => tx.content = el.value); bind('t-font', (el) => tx.font = el.value); bind('t-size', (el) => tx.size = +el.value || 96);
      bind('t-weight', (el) => tx.weight = +el.value); bind('t-align', (el) => tx.align = el.value); bind('t-color', (el) => tx.color = el.value);
      bind('t-outline', (el) => tx.outline = +el.value || 0);
      const bgOn = t.querySelector('#t-bgon'), bg = t.querySelector('#t-bg');
      const upBg = () => { tx.bg = bgOn.checked ? bg.value : 'transparent'; };
      bgOn.onchange = () => { app.commit('text'); upBg(); app.refresh(); }; bg.oninput = () => { if (!bgOn.checked) bgOn.checked = true; upBg(); app.player.draw(); }; bg.onchange = () => { app.commit('text'); upBg(); app.refresh(); };
    }
    if (c.kind === 'audio') {
      const a = sec('Audio');
      animRow(a, 'Volume', 'volume', 0, 2, 0.01);
      const r = document.createElement('div'); r.className = 'row2'; r.innerHTML = `<label>Fade in / out</label><div style="display:flex;gap:6px"><input type="number" id="a-fi" step="0.1" min="0" value="${c.props.fadeIn}"> <input type="number" id="a-fo" step="0.1" min="0" value="${c.props.fadeOut}"> s</div>`;
      r.querySelector('#a-fi').onchange = (e) => { app.commit('fade'); c.props.fadeIn = Math.max(0, +e.target.value || 0); app.refresh(); };
      r.querySelector('#a-fo').onchange = (e) => { app.commit('fade'); c.props.fadeOut = Math.max(0, +e.target.value || 0); app.refresh(); };
      a.appendChild(r);
    }
    const kfs = Object.keys(c.keyframes);
    if (kfs.length) {
      const k = sec('Keyframes', `${kfs.length} animated`);
      for (const prop of kfs) {
        const r = document.createElement('div'); r.className = 'row2';
        r.innerHTML = `<label>${prop}</label><div style="display:flex;gap:4px;flex-wrap:wrap">${c.keyframes[prop].map(f => `<button data-t="${f.t}" title="Jump to keyframe">${f.t.toFixed(2)}s → ${(+f.v).toFixed(2)}</button>`).join('')}<button data-clear="1" class="danger">clear</button></div>`;
        r.querySelectorAll('button[data-t]').forEach(b => b.onclick = () => app.seek(c.start + +b.dataset.t));
        r.querySelector('[data-clear]').onclick = () => { app.commit('clear keyframes'); delete c.keyframes[prop]; app.refresh(); };
        k.appendChild(r);
      }
    }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }

  // ---------- dialogs ----------
  function modal(html) { const m = $('modal'); m.innerHTML = `<div class="dlg">${html}</div>`; m.hidden = false; m.onclick = (e) => { if (e.target === m) close(); }; return m.firstElementChild; }
  function close() { const m = $('modal'); m.hidden = true; m.innerHTML = ''; m.onclick = null; }

  async function showExport() {
    const p = app.project;
    const dur = sequenceDuration(p);
    if (dur <= 0) { app.toast('The timeline is empty', true); return; }
    const hasRange = p.inPoint !== null && p.outPoint !== null && p.outPoint > p.inPoint;
    const dlg = modal(`<h2>Export</h2>
      <div class="row2"><label>Preset</label><select id="x-preset">${PRESETS.map((pr, i) => `<option value="${i}" ${pr.width === p.settings.width && pr.height === p.settings.height && pr.fps === p.settings.fps ? 'selected' : ''}>${pr.label}</option>`).join('')}</select></div>
      <div class="row2"><label>Format</label><select id="x-format"><option value="mp4">MP4 (H.264 + AAC) when the browser can encode it</option><option value="webm">WebM (VP9 + Opus)</option></select></div>
      <div class="row2"><label>Range</label><label><input type="checkbox" id="x-range" ${hasRange ? 'checked' : 'disabled'}> in/out only ${hasRange ? `(${fmtTC(p.inPoint, app.fps())} – ${fmtTC(p.outPoint, app.fps())})` : '(no in/out set)'}</label></div>
      <div class="row2"><label>Encoder</label><span id="x-codec" style="color:var(--dim)">checking…</span></div>
      <div class="progress"><i id="x-bar"></i></div>
      <div id="x-text" style="color:var(--dim);min-height:1.2em">${(dur).toFixed(1)} s of video</div>
      <div class="actions"><button id="x-cancel">Close</button><button class="primary" id="x-go">Export</button><button class="primary" id="x-save" hidden>Save file</button></div>`);
    const q = (s) => dlg.querySelector(s);
    const updateCodec = async () => {
      const pr = PRESETS[+q('#x-preset').value];
      const c = await pickCodecs({ width: pr.width, height: pr.height, fps: pr.fps, bitrate: pr.bitrate, prefer: q('#x-format').value });
      q('#x-codec').textContent = c ? `${c.video.codec} in ${c.video.container} · audio ${c.audio ? c.audio.codec : 'none'} · WebCodecs` : (webCodecsAvailable() ? 'no supported encoder' : 'MediaRecorder fallback (real-time, WebM)');
    };
    updateCodec(); q('#x-preset').onchange = updateCodec; q('#x-format').onchange = updateCodec;
    let ctl = null, result = null;
    q('#x-cancel').onclick = () => { if (ctl) ctl.abort(); close(); };
    q('#x-go').onclick = async () => {
      const pr = PRESETS[+q('#x-preset').value];
      ctl = new AbortController(); q('#x-go').disabled = true;
      app.player.pause();
      try {
        result = await exportProject(p, { ...pr, prefer: q('#x-format').value, useRange: q('#x-range').checked }, { signal: ctl.signal, onProgress: ({ fraction, text }) => { q('#x-bar').style.width = (fraction * 100).toFixed(1) + '%'; q('#x-text').textContent = text; } });
        q('#x-text').textContent = `Done · ${result.info.videoCodec} / ${result.info.audioCodec} · ${result.info.frames} frames · ${(result.blob.size / 1048576).toFixed(1)} MB`;
        q('#x-save').hidden = false; q('#x-go').hidden = true;
        app.lastExport = result;
        // save immediately if we can do so without a second click
        q('#x-save').onclick = () => app.saveBlob(result.blob, result.filename);
      } catch (e) { q('#x-text').textContent = 'Failed: ' + e.message; q('#x-go').disabled = false; console.error(e); }
    };
  }

  function showSettings() {
    const s = app.project.settings;
    const dlg = modal(`<h2>Sequence settings</h2>
      <div class="row2"><label>Name</label><input type="text" id="s-name" value="${escapeHtml(app.project.name)}"></div>
      <div class="row2"><label>Frame size</label><div style="display:flex;gap:6px;align-items:center"><input type="number" id="s-w" value="${s.width}" min="16" step="2"> × <input type="number" id="s-h" value="${s.height}" min="16" step="2"></div></div>
      <div class="row2"><label>Frame rate</label><select id="s-fps">${[24, 25, 30, 50, 60].map(f => `<option ${s.fps === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      <div class="row2"><label>Quick</label><div style="display:flex;gap:6px;flex-wrap:wrap">${PRESETS.slice(0, 5).map(pr => `<button data-w="${pr.width}" data-h="${pr.height}">${pr.width}×${pr.height}</button>`).join('')}</div></div>
      <div class="actions"><button id="s-cancel">Cancel</button><button class="primary" id="s-ok">Apply</button></div>`);
    dlg.querySelectorAll('button[data-w]').forEach(b => b.onclick = () => { dlg.querySelector('#s-w').value = b.dataset.w; dlg.querySelector('#s-h').value = b.dataset.h; });
    dlg.querySelector('#s-cancel').onclick = close;
    dlg.querySelector('#s-ok').onclick = () => { app.commit('settings'); app.project.name = dlg.querySelector('#s-name').value || 'Untitled'; s.width = Math.max(16, +dlg.querySelector('#s-w').value | 0); s.height = Math.max(16, +dlg.querySelector('#s-h').value | 0); s.fps = +dlg.querySelector('#s-fps').value; app.applySettings(); close(); app.refresh(); };
  }

  function showShortcuts() {
    const rows = [['Space', 'Play / pause'], ['J / K / L', 'Reverse / stop / forward (press L again for 2×)'], ['← →', 'Step one frame (Shift: 10 frames)'], ['Home / End', 'Start / end of sequence'], ['I / O', 'Mark in / out'], ['M', 'Add marker'], ['V / C', 'Selection / razor tool'], ['Ctrl+K', 'Split selected (or all) clips at playhead'], ['Delete', 'Delete selection'], ['Shift+Delete', 'Ripple delete'], ['Q / W', 'Ripple trim head / tail to playhead'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+C / Ctrl+V / Ctrl+D', 'Copy / paste at playhead / duplicate'], ['Ctrl+A', 'Select all'], ['Ctrl+T', 'New title at playhead'], ['Ctrl+L', 'Link / unlink audio'], ['Shift+E', 'Enable / disable clip'], ['S', 'Toggle snapping'], ['+ / − / \\', 'Zoom in / out / fit'], ['Ctrl+I', 'Import media'], ['Ctrl+M', 'Export'], ['Ctrl+S', 'Save project file'], ['?', 'This list']];
    const dlg = modal(`<h2>Keyboard shortcuts</h2><table class="kbd-table">${rows.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table><div class="actions"><button id="k-ok" class="primary">Close</button></div>`);
    dlg.querySelector('#k-ok').onclick = close;
  }
  function showAbout() {
    const dlg = modal(`<h2>Sawyer</h2><p>An open-source non-linear video editor that runs entirely in your browser. Media never leaves your machine: decoding uses the browser's own codecs, mixing uses Web Audio, and export uses WebCodecs with an MP4/WebM muxer.</p><p style="color:var(--dim)">MIT licensed. Muxing by <code>mp4-muxer</code> and <code>webm-muxer</code> (MIT).</p><div class="actions"><button id="a-ok" class="primary">Close</button></div>`);
    dlg.querySelector('#a-ok').onclick = close;
  }

  // ---------- AI panel ----------
  const ai = { turns: [], backend: null, sample: null, busy: false, ctl: null };
  async function initAI() {
    try { if (window.claude?.use) ai.sample = await window.claude.use('sample'); } catch { ai.sample = null; }
    $('ai-key').value = localStorage.getItem('sawyer-api-key') || '';
    $('ai-model').value = localStorage.getItem('sawyer-api-model') || 'claude-opus-5';
    $('ai-backend').value = localStorage.getItem('sawyer-ai-backend') || 'auto';
    $('ai-key').onchange = () => { localStorage.setItem('sawyer-api-key', $('ai-key').value.trim()); updateAIStatus(); };
    $('ai-model').onchange = () => localStorage.setItem('sawyer-api-model', $('ai-model').value);
    $('ai-backend').onchange = () => { localStorage.setItem('sawyer-ai-backend', $('ai-backend').value); updateAIStatus(); };
    $('ai-send').onclick = () => sendAI();
    $('ai-stop').onclick = () => ai.ctl?.abort();
    $('ai-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAI(); } });
    document.querySelectorAll('.chips button').forEach(b => b.onclick = () => { $('ai-text').value = b.dataset.prompt; sendAI(); });
    updateAIStatus();
  }
  function pickBackend() {
    const mode = $('ai-backend').value;
    const tools = buildTools(app.editorFacade());
    const key = $('ai-key').value.trim();
    if ((mode === 'auto' || mode === 'sample') && ai.sample) return sampleBackend(ai.sample, tools);
    if ((mode === 'auto' || mode === 'api') && key) return apiBackend({ apiKey: key, model: $('ai-model').value }, tools);
    return null;
  }
  function updateAIStatus() {
    const b = pickBackend();
    $('ai-status').textContent = b ? `· ${b.name}` : (ai.sample ? '' : '· paste an Anthropic API key (this copy is not running inside claude.ai)');
    $('ai-key-line').style.display = ($('ai-backend').value === 'sample' && ai.sample) ? 'none' : 'flex';
  }
  function aiMsg(cls, text) { const el = document.createElement('div'); el.className = 'msg ' + cls; el.textContent = text; $('ai-log').appendChild(el); $('ai-log').scrollTop = 1e9; return el; }
  async function sendAI(prompt) {
    const text = (prompt ?? $('ai-text').value).trim();
    if (!text || ai.busy) return;
    const backend = pickBackend();
    if (!backend) { aiMsg('err', 'No AI backend available. Inside claude.ai this uses your account automatically; elsewhere paste an Anthropic API key above.'); return; }
    $('ai-text').value = '';
    aiMsg('user', text);
    ai.turns.push({ role: 'user', content: text });
    const out = aiMsg('ai', 'Thinking…');
    ai.busy = true; $('ai-send').disabled = true; $('ai-stop').hidden = false;
    ai.ctl = new AbortController();
    try {
      const reply = await backend.chat(ai.turns, {
        signal: ai.ctl.signal,
        projectSummary: summarize(app.project),
        onText: ({ text }) => { out.textContent = text; $('ai-log').scrollTop = 1e9; },
        onTool: ({ name, input, result, error }) => { const t = aiMsg('tool', `${name}(${JSON.stringify(input || {})}) → ${error ? 'Error: ' + error : (result?.message || 'ok')}`); $('ai-log').insertBefore(t, out); },
      });
      out.textContent = reply || '(no reply)';
      ai.turns.push({ role: 'assistant', content: reply || '(no reply)' });
      if (ai.turns.length > 16) ai.turns.splice(0, ai.turns.length - 16);
      app.refresh();
    } catch (e) {
      out.remove();
      aiMsg('err', e.code === 'cancelled' || e.name === 'AbortError' ? 'Stopped.' : `${e.message || e.code || e}`);
      ai.turns.pop();
    } finally { ai.busy = false; $('ai-send').disabled = false; $('ai-stop').hidden = true; }
  }

  return { renderBin, renderInspector, renderFx, showExport, showSettings, showShortcuts, showAbout, initAI, importFiles, closeModal: close };
}
