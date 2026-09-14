// Sawyer — AI assistant: tool definitions shared by two backends
//  (1) claude.use('sample') inside a claude.ai artifact (no key needed, viewer's account)
//  (2) the Anthropic Messages API with the user's own key (raw HTTP; this page has no build step or SDK)
import { summarize, findClip, splitLinked, removeClip, rippleDelete, moveClip, trimStart, trimEnd, setTransition, setKeyframe, cutRangesFromClip, detectSilence, closeGaps, allClips, sequenceDuration, clipEnd } from './model.js';
import { runtime } from './media.js';

export const SYSTEM_PROMPT = `You are the editing assistant inside Sawyer, an open-source non-linear video editor.
You edit the user's timeline by calling tools. Times are in seconds from the start of the sequence. Tracks are V1..V3 (video, V1 is the bottom layer) and A1..A3 (audio). Clip ids look like "c...". Media ids look like "m...".
Rules:
- Read the project summary first (it is given to you). Call get_project when you need fresh state after edits.
- Make the edit directly with tools; do not ask for confirmation for reversible edits (the user can undo).
- Keep video and its linked audio together unless asked otherwise (tools already do this for moves and splits).
- After editing, reply with two or three short sentences saying exactly what changed, with times.
- If a request is impossible with the available tools, say what you can do instead.`;

/** Build the tool set against an editor facade. editor = { project(), commit(label), refresh(), addTextClip(...), addMedia(...), select(ids), seek(t) } */
export function buildTools(editor) {
  const P = () => editor.project();
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const need = (id) => { const f = findClip(P(), String(id)); if (!f) throw new Error(`No clip with id ${id}`); return f; };
  const ok = (msg, extra = {}) => ({ ok: true, message: msg, ...extra });
  const tools = [
    {
      name: 'get_project', description: 'Returns the current project summary: settings, media, tracks and clips with ids and times. Use after edits to see fresh state.',
      execute: () => summarize(P()),
    },
    {
      name: 'split_clip', description: 'Split a clip at a sequence time (like the razor tool). Splits its linked audio/video partner too. Returns the ids of the two halves.',
      inputSchema: { type: 'object', properties: { clip_id: { type: 'string' }, time: { type: 'number', description: 'sequence time in seconds' } }, required: ['clip_id', 'time'] },
      execute: ({ clip_id, time }) => {
        const f = need(clip_id); const t = num(time);
        editor.commit('AI split');
        const rs = splitLinked(P(), f.clip.id, t);
        if (!rs.length) throw new Error('Time is outside the clip');
        const r = rs[0];
        editor.refresh();
        return ok(`Split ${f.clip.name} at ${t.toFixed(2)}s`, { left_id: r.left.id, right_id: r.right.id, partner_right_ids: rs.slice(1).map(x => x.right.id) });
      },
    },
    {
      name: 'delete_clip', description: 'Delete a clip. With ripple=true the gap is closed and later clips move left. Deletes the linked partner too.',
      inputSchema: { type: 'object', properties: { clip_id: { type: 'string' }, ripple: { type: 'boolean' } }, required: ['clip_id'] },
      execute: ({ clip_id, ripple }) => {
        const f = need(clip_id);
        editor.commit('AI delete');
        const ids = [f.clip.id];
        if (f.clip.linkId) for (const o of allClips(P())) if (o.linkId === f.clip.linkId && o.id !== f.clip.id) ids.push(o.id);
        for (const id of ids) (ripple ? rippleDelete : removeClip)(P(), id);
        editor.refresh();
        return ok(`Deleted ${ids.length} clip(s)${ripple ? ' and closed the gap' : ''}`);
      },
    },
    {
      name: 'move_clip', description: 'Move a clip so it starts at a new time, optionally to another track (same kind). Overlapped clips are trimmed (overwrite). Linked partner moves too.',
      inputSchema: { type: 'object', properties: { clip_id: { type: 'string' }, start: { type: 'number' }, track_id: { type: 'string' } }, required: ['clip_id', 'start'] },
      execute: ({ clip_id, start, track_id }) => { const f = need(clip_id); editor.commit('AI move'); moveClip(P(), f.clip.id, num(start), track_id ? String(track_id) : null); editor.refresh(); return ok(`Moved ${f.clip.name} to ${num(start).toFixed(2)}s`); },
    },
    {
      name: 'trim_clip', description: 'Set a new start and/or end time for a clip by trimming its head or tail (content is not stretched). Times are sequence seconds.',
      inputSchema: { type: 'object', properties: { clip_id: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['clip_id'] },
      execute: ({ clip_id, start, end }) => {
        const f = need(clip_id); editor.commit('AI trim');
        const md = P().media[f.clip.mediaId]?.duration ?? Infinity;
        const ids = [f.clip.id]; if (f.clip.linkId) for (const o of allClips(P())) if (o.linkId === f.clip.linkId && o.id !== f.clip.id) ids.push(o.id);
        for (const id of ids) { if (start !== undefined) trimStart(P(), id, num(start), md); if (end !== undefined) trimEnd(P(), id, num(end), md); }
        editor.refresh(); const c = need(clip_id).clip;
        return ok(`${c.name} now runs ${c.start.toFixed(2)}–${clipEnd(c).toFixed(2)}s`);
      },
    },
    {
      name: 'set_clip_property', description: 'Set a property on a clip: opacity (0-1), volume (0-2), scale (1 = fit), x, y (pixels at 1920x1080, 0 = centred), rotation (deg), speed (0.25-4), fadeIn, fadeOut (seconds), brightness, contrast, saturate (1 = normal), hueRotate (deg), blur (px), grayscale, sepia (0-1), enabled (true/false), name, or text (for text clips).',
      inputSchema: { type: 'object', properties: { clip_id: { type: 'string' }, property: { type: 'string' }, value: {} }, required: ['clip_id', 'property', 'value'] },
      execute: ({ clip_id, property, value }) => {
        const f = need(clip_id); const c = f.clip; editor.commit('AI property');
        const p = String(property);
        const filters = ['brightness', 'contrast', 'saturate', 'hueRotate', 'blur', 'grayscale', 'sepia'];
        if (filters.includes(p)) c.props.filters[p] = num(value, c.props.filters[p]);
        else if (['opacity', 'volume', 'scale', 'x', 'y', 'rotation', 'fadeIn', 'fadeOut'].includes(p)) c.props[p] = num(value, c.props[p]);
        else if (p === 'speed') { const s = Math.max(0.25, Math.min(4, num(value, 1))); const srcLen = c.duration * c.speed; c.speed = s; c.duration = srcLen / s; for (const o of allClips(P())) if (c.linkId && o.linkId === c.linkId && o.id !== c.id) { o.speed = s; o.duration = c.duration; } }
        else if (p === 'enabled') c.enabled = value !== false && value !== 'false';
        else if (p === 'name') c.name = String(value);
        else if (p === 'text') { if (!c.props.text) throw new Error('Not a text clip'); c.props.text.content = String(value); }
        else throw new Error(`Unknown property ${p}`);
        editor.refresh(); return ok(`Set ${p} = ${JSON.stringify(value)} on ${c.name}`);
      },
    },
    {
      name: 'add_keyframe', description: 'Add an animation keyframe on a clip for opacity, scale, x, y, rotation or volume at a clip-local time (seconds from the clip start). Two or more keyframes animate smoothly between values.',
      inputSchema: { type: 'object', properties: { clip_id: { type: 'string' }, property: { type: 'string' }, time: { type: 'number' }, value: { type: 'number' } }, required: ['clip_id', 'property', 'time', 'value'] },
      execute: ({ clip_id, property, time, value }) => { const f = need(clip_id); editor.commit('AI keyframe'); setKeyframe(f.clip, String(property), num(time), num(value)); editor.refresh(); return ok(`Keyframe ${property}=${value} at +${num(time).toFixed(2)}s on ${f.clip.name}`); },
    },
    {
      name: 'add_transition', description: 'Add a transition at the start (side "in") or end (side "out") of a clip: dissolve, dip (to black), wipe, slide or zoom. Applies the matching half to the adjacent clip.',
      inputSchema: { type: 'object', properties: { clip_id: { type: 'string' }, side: { type: 'string', enum: ['in', 'out'] }, type: { type: 'string', enum: ['dissolve', 'dip', 'wipe', 'slide', 'zoom', 'none'] }, duration: { type: 'number' } }, required: ['clip_id', 'side', 'type'] },
      execute: ({ clip_id, side, type, duration }) => { const f = need(clip_id); editor.commit('AI transition'); setTransition(P(), f.clip.id, side === 'out' ? 'out' : 'in', type === 'none' ? null : String(type), num(duration, 1)); editor.refresh(); return ok(`${type} ${side} on ${f.clip.name}`); },
    },
    {
      name: 'add_text', description: 'Add a title / text clip on a video track. Returns its id. size is font size in px at 1080p; y positive moves down.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, start: { type: 'number' }, duration: { type: 'number' }, track_id: { type: 'string', description: 'V1..V3, default V2' }, size: { type: 'number' }, color: { type: 'string' }, y: { type: 'number' }, background: { type: 'string' } }, required: ['text', 'start', 'duration'] },
      execute: ({ text, start, duration, track_id, size, color, y, background }) => {
        editor.commit('AI text');
        const c = editor.addTextClip({ text: String(text), start: num(start), duration: num(duration, 3), trackId: track_id ? String(track_id) : 'V2', size: size ? num(size) : undefined, color: color ? String(color) : undefined, y: y !== undefined ? num(y) : undefined, bg: background ? String(background) : undefined });
        editor.refresh(); return ok(`Added title "${text}" at ${num(start).toFixed(2)}s`, { clip_id: c.id });
      },
    },
    {
      name: 'add_media', description: 'Place a media item from the project bin onto the timeline at a time (video goes on V1 with its audio on A1 unless a track is given). Optional in/out trim the source in seconds.',
      inputSchema: { type: 'object', properties: { media_id: { type: 'string' }, start: { type: 'number' }, track_id: { type: 'string' }, source_in: { type: 'number' }, source_out: { type: 'number' } }, required: ['media_id', 'start'] },
      execute: ({ media_id, start, track_id, source_in, source_out }) => {
        if (!P().media[media_id]) throw new Error(`No media ${media_id}`);
        editor.commit('AI add media');
        const ids = editor.addMedia(String(media_id), num(start), { trackId: track_id ? String(track_id) : null, inPoint: source_in !== undefined ? num(source_in) : 0, outPoint: source_out !== undefined ? num(source_out) : null });
        editor.refresh(); return ok(`Placed ${P().media[media_id].name} at ${num(start).toFixed(2)}s`, { clip_ids: ids });
      },
    },
    {
      name: 'remove_silence', description: 'Cut silent parts out of a clip that has audio (jump-cut). threshold is RMS 0-1 (default 0.02), min_length seconds (default 0.6), padding seconds kept around speech (default 0.08). Later clips ripple left. Returns the number of cuts.',
      inputSchema: { type: 'object', properties: { clip_id: { type: 'string' }, threshold: { type: 'number' }, min_length: { type: 'number' }, padding: { type: 'number' } }, required: ['clip_id'] },
      execute: ({ clip_id, threshold, min_length, padding }) => {
        const f = need(clip_id);
        const rt = runtime.get(f.clip.mediaId);
        if (!rt || !rt.peaks) throw new Error('That clip has no decoded audio');
        const ranges = detectSilence(rt.peaks, 1 / rt.peaksPerSecond, num(threshold, 0.02), num(min_length, 0.6), num(padding, 0.08));
        const inRange = ranges.filter(r => r.end > f.clip.inPoint && r.start < f.clip.inPoint + f.clip.duration * f.clip.speed);
        if (!inRange.length) return ok('No silence found with those settings', { cuts: 0 });
        editor.commit('AI remove silence');
        const partners = f.clip.linkId ? allClips(P()).filter(o => o.linkId === f.clip.linkId && o.id !== f.clip.id) : [];
        const out = cutRangesFromClip(P(), f.clip.id, inRange, 'all');
        for (const o of partners) { const parts = cutRangesFromClip(P(), o.id, inRange, 'none'); parts.forEach((pc, i) => { if (out[i]) { const link = 'L' + out[i].id; out[i].linkId = link; pc.linkId = link; } }); }
        editor.refresh();
        const removed = inRange.reduce((s, r) => s + (r.end - r.start), 0);
        return ok(`Removed ${inRange.length} silent section(s), ${removed.toFixed(1)} s total; clip is now ${out.length} pieces`, { cuts: inRange.length, seconds_removed: +removed.toFixed(2), clip_ids: out.map(c => c.id) });
      },
    },
    {
      name: 'close_gaps', description: 'Remove every empty gap on the timeline by moving clips left.',
      execute: () => { editor.commit('AI close gaps'); closeGaps(P()); editor.refresh(); return ok('Closed all gaps'); },
    },
    {
      name: 'set_in_out', description: 'Set the sequence in/out range (used by export with "range only"). Pass null to clear.',
      inputSchema: { type: 'object', properties: { in_point: { type: ['number', 'null'] }, out_point: { type: ['number', 'null'] } } },
      execute: ({ in_point, out_point }) => { editor.commit('AI in/out'); P().inPoint = in_point === null || in_point === undefined ? null : num(in_point); P().outPoint = out_point === null || out_point === undefined ? null : num(out_point); editor.refresh(); return ok('Range set'); },
    },
    {
      name: 'seek', description: 'Move the playhead to a time so the user sees that frame in the program monitor.',
      inputSchema: { type: 'object', properties: { time: { type: 'number' } }, required: ['time'] },
      execute: ({ time }) => { editor.seek(num(time)); return ok(`Playhead at ${num(time).toFixed(2)}s`); },
    },
    {
      name: 'select_clips', description: 'Highlight clips in the timeline for the user.',
      inputSchema: { type: 'object', properties: { clip_ids: { type: 'array', items: { type: 'string' } } }, required: ['clip_ids'] },
      execute: ({ clip_ids }) => { editor.select((clip_ids || []).map(String)); return ok('Selected'); },
    },
  ];
  return tools;
}

function safeExec(tool, input, log) {
  try {
    const r = tool.execute(input || {});
    log?.({ name: tool.name, input, result: r });
    return r;
  } catch (e) {
    log?.({ name: tool.name, input, error: e.message });
    throw e;
  }
}

/** Backend 1: claude.use('sample') — the viewer's own Claude account inside an artifact. */
export function sampleBackend(sample, tools) {
  return {
    name: 'Claude (built in)',
    async chat(turns, { onText, signal, onTool, projectSummary }) {
      const input = [{ role: 'user', content: SYSTEM_PROMPT + '\n\nCurrent project summary (JSON):\n' + JSON.stringify(projectSummary) }, ...turns];
      const wrapped = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: (inp) => safeExec(t, inp, onTool) }));
      const { text } = await sample(input, { tools: wrapped, cache: false, onText, signal, modelTier: 'default' });
      return text;
    },
  };
}

/** Backend 2: the Anthropic Messages API with the user's own key (browser → api.anthropic.com). */
export function apiBackend({ apiKey, model = 'claude-opus-5' }, tools) {
  return {
    name: `Anthropic API · ${model}`,
    async chat(turns, { onText, signal, onTool, projectSummary }) {
      const messages = turns.map(t => ({ role: t.role, content: t.content }));
      const system = SYSTEM_PROMPT + '\n\nCurrent project summary (JSON):\n' + JSON.stringify(projectSummary);
      const apiTools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object', properties: {} } }));
      let text = '';
      for (let round = 0; round < 12; round++) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'server-side-fallback-2026-07-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({ model, max_tokens: 4096, system, messages, tools: apiTools, fallbacks: 'default' }),
        });
        if (!res.ok) { const err = await res.text(); throw new Error(`API ${res.status}: ${err.slice(0, 300)}`); }
        const msg = await res.json();
        if (msg.stop_reason === 'refusal') { text += '\n(The request was declined by the model.)'; break; }
        const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text);
        if (textParts.length) { text += (text ? '\n' : '') + textParts.join('\n'); onText?.({ text }); }
        messages.push({ role: 'assistant', content: msg.content });
        if (msg.stop_reason !== 'tool_use') break;
        const results = [];
        for (const b of msg.content) {
          if (b.type !== 'tool_use') continue;
          const tool = tools.find(t => t.name === b.name);
          let content, is_error = false;
          try { content = JSON.stringify(tool ? safeExec(tool, b.input, onTool) : { error: 'unknown tool' }); } catch (e) { content = `Error: ${e.message}`; is_error = true; }
          results.push({ type: 'tool_result', tool_use_id: b.id, content, is_error });
        }
        messages.push({ role: 'user', content: results });
      }
      return text;
    },
  };
}
