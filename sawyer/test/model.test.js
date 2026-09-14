import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';

function proj() {
  const p = M.createProject('t');
  p.media.m1 = { id: 'm1', name: 'a.mp4', type: 'video', duration: 10, hasAudio: true };
  return p;
}
function clip(p, start, duration, trackId = 'V1', kind = 'video', extra = {}) {
  const c = M.newClip({ mediaId: 'm1', kind, start, duration, name: 'x', trackId, ...extra });
  M.placeClip(p, trackId, c);
  return c;
}

test('placeClip overwrites: trims, splits and drops covered clips', () => {
  const p = proj();
  const a = clip(p, 0, 10);
  const b = clip(p, 4, 2);          // splits a into [0,4] + [6,10]
  const t = M.track(p, 'V1');
  assert.equal(t.clips.length, 3);
  const [l, mid, r] = t.clips;
  assert.deepEqual([l.start, l.duration], [0, 4]);
  assert.equal(mid.id, b.id);
  assert.deepEqual([r.start, r.duration, r.inPoint], [6, 4, 6]);
  clip(p, 0, 10); // covers everything
  assert.equal(M.track(p, 'V1').clips.length, 1);
});

test('splitClip keeps source continuity and total duration', () => {
  const p = proj();
  const a = clip(p, 2, 6, 'V1', 'video', { inPoint: 1, speed: 2 });
  const r = M.splitClip(p, a.id, 5);
  assert.deepEqual([r.left.start, r.left.duration], [2, 3]);
  assert.deepEqual([r.right.start, r.right.duration], [5, 3]);
  assert.equal(r.right.inPoint, 1 + 3 * 2);
  assert.equal(M.sequenceDuration(p), 8);
  assert.equal(M.splitClip(p, a.id, 2), null, 'no split at the edge');
});

test('rippleDelete closes the gap across tracks, closeGaps removes all gaps', () => {
  const p = proj();
  const a = clip(p, 0, 3); const b = clip(p, 3, 2); const c = clip(p, 5, 4);
  const au = clip(p, 5, 4, 'A1', 'audio');
  M.rippleDelete(p, b.id);
  assert.equal(c.start, 3); assert.equal(au.start, 3);
  c.start = 7; au.start = 7;
  M.closeGaps(p);
  assert.equal(c.start, 3); assert.equal(au.start, 3);
});

test('trim respects source bounds and neighbours', () => {
  const p = proj();
  const a = clip(p, 0, 4); const b = clip(p, 4, 4, 'V1', 'video', { inPoint: 2 });
  M.trimStart(p, b.id, 1);          // cannot reveal before source 0 (inPoint 2 → start 2) nor overlap a (end 4)
  assert.equal(b.start, 4);
  M.trimStart(p, b.id, 5);
  assert.deepEqual([b.start, b.duration, b.inPoint], [5, 3, 3]);
  M.trimEnd(p, b.id, 30, 10);       // media is 10 s: inPoint 3 → max 7 s long
  assert.equal(b.duration, 7);
  M.trimEnd(p, a.id, 9);            // blocked by b at 5
  assert.equal(a.duration, 5);
});

test('moveClip carries linked audio and overwrites', () => {
  const p = proj();
  const v = clip(p, 0, 4); const a = clip(p, 0, 4, 'A1', 'audio');
  v.linkId = a.linkId = 'L1';
  const other = clip(p, 6, 4);
  M.moveClip(p, v.id, 8);
  assert.equal(v.start, 8); assert.equal(a.start, 8);
  const t = M.track(p, 'V1');
  assert.equal(t.clips.length, 2);
  assert.equal(other.duration, 2, 'other trimmed to 6..8');
});

test('keyframes interpolate and shift on split', () => {
  const p = proj();
  const a = clip(p, 0, 10);
  M.setKeyframe(a, 'opacity', 0, 0); M.setKeyframe(a, 'opacity', 4, 1);
  assert.equal(M.valueAt(a, 'opacity', 0), 0);
  assert.equal(M.valueAt(a, 'opacity', 2), 0.5);
  assert.equal(M.valueAt(a, 'opacity', 9), 1);
  const r = M.splitClip(p, a.id, 2);
  assert.equal(M.valueAt(r.right, 'opacity', 0), 0.5, 'right half starts mid-fade');
  assert.equal(M.valueAt(r.right, 'opacity', 2), 1);
});

test('opacity and gain include fades and transitions', () => {
  const p = proj();
  const a = clip(p, 0, 4); const b = clip(p, 4, 4);
  M.setTransition(p, b.id, 'in', 'dissolve', 1);
  assert.deepEqual(a.transitionOut, { type: 'dissolve', duration: 1 });
  assert.equal(M.opacityAt(b, 0.5), 0.5);
  assert.equal(M.opacityAt(a, 3.5), 0.5);
  a.props.fadeIn = 2; a.props.volume = 0.5;
  assert.equal(M.gainAt(a, 1), 0.25);
});

test('detectSilence and cutRangesFromClip remove quiet parts and ripple', () => {
  const peaks = [];
  for (let i = 0; i < 100; i++) peaks.push(i >= 20 && i < 40 ? 0.001 : 0.5); // silence 2..4 s at 0.1 s windows
  const ranges = M.detectSilence(peaks, 0.1, 0.02, 0.5, 0);
  assert.deepEqual(ranges, [{ start: 2, end: 4 }]);
  const p = proj();
  const a = clip(p, 1, 10); const after = clip(p, 11, 2);
  const out = M.cutRangesFromClip(p, a.id, ranges);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].start, out[0].duration], [1, 2]);
  assert.deepEqual([out[1].start, out[1].duration, out[1].inPoint], [3, 6, 4]);
  assert.equal(after.start, 9, 'following clip rippled left by 2 s');
});

test('snap and history', () => {
  const p = proj();
  clip(p, 0, 3);
  const pts = M.snapPoints(p);
  assert.equal(M.snap(2.9, pts, 0.2), 3);
  assert.equal(M.snap(2.5, pts, 0.2), 2.5);
  const h = M.createHistory();
  M.commit(h, p);
  clip(p, 5, 1);
  const back = M.undo(h, p);
  assert.equal(M.allClips(back).length, 1);
  const fwd = M.redo(h, back);
  assert.equal(M.allClips(fwd).length, 2);
});

test('splitLinked re-links the right halves so partner lookups stay pairwise', () => {
  const p = proj();
  const v = clip(p, 0, 10); const a = clip(p, 0, 10, 'A1', 'audio');
  v.linkId = a.linkId = 'L1';
  const rs = M.splitLinked(p, v.id, 4);
  assert.equal(rs.length, 2);
  const [rv, ra] = rs.map(r => r.right);
  assert.equal(rv.linkId, ra.linkId);
  assert.notEqual(rv.linkId, 'L1');
  assert.equal(M.allClips(p).filter(c => c.linkId === 'L1').length, 2, 'left halves keep the old link');
  const rs2 = M.splitAll(p, 7);
  assert.equal(rs2.length, 2, 'splitAll splits each linked pair once');
});
