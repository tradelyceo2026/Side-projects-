import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';
import { buildTools } from '../src/ai.js';

function fakeEditor() {
  const p = M.createProject('t');
  p.media.m1 = { id: 'm1', name: 'talk.mp4', type: 'video', duration: 20, hasAudio: true };
  const v = M.newClip({ mediaId: 'm1', kind: 'video', start: 0, duration: 20, name: 'talk.mp4' });
  const a = M.newClip({ mediaId: 'm1', kind: 'audio', start: 0, duration: 20, name: 'talk.mp4' });
  v.linkId = a.linkId = 'L1';
  M.placeClip(p, 'V1', v); M.placeClip(p, 'A1', a);
  const log = [];
  const ed = {
    project: () => p, commit: (l) => log.push('commit:' + l), refresh: () => log.push('refresh'),
    addTextClip: ({ text, start, duration, trackId }) => { const c = M.newClip({ kind: 'text', start, duration, name: 'Title' }); c.props.text.content = text; M.placeClip(p, trackId || 'V2', c); return c; },
    addMedia: (id, start) => { const c = M.newClip({ mediaId: id, kind: 'video', start, duration: p.media[id].duration, name: p.media[id].name }); M.placeClip(p, 'V1', c); return [c.id]; },
    select: (ids) => log.push('select:' + ids.join(',')), seek: (t) => log.push('seek:' + t),
  };
  return { p, ed, log, v, a };
}
const byName = (tools) => Object.fromEntries(tools.map(t => [t.name, t]));

test('tools expose descriptions and schemas', () => {
  const { ed } = fakeEditor();
  const tools = buildTools(ed);
  assert.ok(tools.length >= 12);
  for (const t of tools) { assert.ok(t.description.length > 20, t.name); if (t.inputSchema) assert.equal(t.inputSchema.type, 'object'); }
});

test('split, trim, transition, keyframe and delete through the tool layer', () => {
  const { p, ed, v, a } = fakeEditor();
  const T = byName(buildTools(ed));
  const r = T.split_clip.execute({ clip_id: v.id, time: 8 });
  assert.equal(r.ok, true);
  assert.equal(M.track(p, 'V1').clips.length, 2);
  assert.equal(M.track(p, 'A1').clips.length, 2, 'linked audio split too');
  T.add_transition.execute({ clip_id: r.right_id, side: 'in', type: 'dissolve', duration: 1.5 });
  assert.deepEqual(M.findClip(p, r.right_id).clip.transitionIn, { type: 'dissolve', duration: 1.5 });
  assert.deepEqual(M.findClip(p, r.left_id).clip.transitionOut, { type: 'dissolve', duration: 1.5 });
  T.add_keyframe.execute({ clip_id: r.left_id, property: 'opacity', time: 0, value: 0 });
  T.add_keyframe.execute({ clip_id: r.left_id, property: 'opacity', time: 2, value: 1 });
  assert.equal(M.valueAt(M.findClip(p, r.left_id).clip, 'opacity', 1), 0.5);
  T.trim_clip.execute({ clip_id: r.right_id, end: 12 });
  assert.equal(M.clipEnd(M.findClip(p, r.right_id).clip), 12);
  T.delete_clip.execute({ clip_id: r.left_id, ripple: true });
  assert.equal(M.findClip(p, r.right_id).clip.start, 0, 'rippled to the start');
  assert.equal(M.track(p, 'A1').clips.length, 1);
  assert.throws(() => T.split_clip.execute({ clip_id: 'nope', time: 1 }), /No clip/);
});

test('set_clip_property handles filters, speed and text; add_text and set_in_out work', () => {
  const { p, ed, v } = fakeEditor();
  const T = byName(buildTools(ed));
  T.set_clip_property.execute({ clip_id: v.id, property: 'grayscale', value: 1 });
  T.set_clip_property.execute({ clip_id: v.id, property: 'speed', value: 2 });
  assert.equal(v.props.filters.grayscale, 1);
  assert.equal(v.duration, 10);
  assert.equal(M.track(p, 'A1').clips[0].duration, 10, 'linked audio follows speed');
  const t = T.add_text.execute({ text: 'Welcome', start: 1, duration: 3 });
  const tc = M.findClip(p, t.clip_id).clip;
  assert.equal(tc.props.text.content, 'Welcome');
  T.set_clip_property.execute({ clip_id: t.clip_id, property: 'text', value: 'Hi' });
  assert.equal(tc.props.text.content, 'Hi');
  T.set_in_out.execute({ in_point: 1, out_point: 4 });
  assert.deepEqual([p.inPoint, p.outPoint], [1, 4]);
  const s = T.get_project.execute();
  assert.equal(s.tracks.find(t => t.id === 'V2').clips[0].text, 'Hi');
});
