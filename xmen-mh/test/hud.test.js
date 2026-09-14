// Pure-math tests for src/ui/hud.js — no DOM, no THREE. Run with `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  distance2D,
  projectToScreen,
  edgeArrow,
  worldToMinimap,
  withinMinimapRadius,
  cooldownDegrees,
  cooldownGradient,
  typewriterSlice,
  typewriterDone,
  initials,
  colorFromString,
} from '../src/ui/hud.js';

// Identity-ish camera looking down -Z from the origin: view = identity, a simple perspective
// projection matrix (fov 90, aspect 1, near 1, far 1000) built by hand (column-major, THREE layout).
function perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  // column-major 16-element array matching THREE.Matrix4.elements
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ];
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PROJ = perspective(Math.PI / 2, 1, 1, 1000);

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('distance2D ignores y', () => {
  assert.equal(distance2D(0, 0, 3, 4), 5);
});

test('projectToScreen maps a point straight ahead to the screen centre', () => {
  // camera at origin looking down -Z (view = identity), point directly ahead at (0,0,-10)
  const proj = projectToScreen(IDENTITY, PROJ, { x: 0, y: 0, z: -10 }, 800, 600);
  assert.ok(Math.abs(proj.x - 400) < 0.5, `expected x~400, got ${proj.x}`);
  assert.ok(Math.abs(proj.y - 300) < 0.5, `expected y~300, got ${proj.y}`);
  assert.equal(proj.behind, false);
  assert.equal(proj.visible, true);
});

test('projectToScreen offsets right for a point to the right', () => {
  const proj = projectToScreen(IDENTITY, PROJ, { x: 10, y: 0, z: -10 }, 800, 600);
  assert.ok(proj.x > 400, 'point to the +X should project right of centre');
});

test('projectToScreen flags a point behind the camera', () => {
  const proj = projectToScreen(IDENTITY, PROJ, { x: 0, y: 0, z: 10 }, 800, 600);
  assert.equal(proj.behind, true);
  assert.equal(proj.visible, false);
});

test('edgeArrow keeps an on-screen, centred point unclamped-ish and marks it not on-edge', () => {
  const proj = { x: 400, y: 300, ndcX: 0, ndcY: 0, behind: false, visible: true };
  const arrow = edgeArrow(proj, 800, 600, 30);
  assert.equal(arrow.onEdge, false);
  assert.equal(arrow.x, 400);
  assert.equal(arrow.y, 300);
});

test('edgeArrow clamps a far-right target to the right margin', () => {
  const proj = { x: 5000, y: 300, ndcX: 5, ndcY: 0, behind: false, visible: false };
  const arrow = edgeArrow(proj, 800, 600, 30);
  assert.ok(arrow.onEdge);
  assert.ok(Math.abs(arrow.x - (800 - 30)) < 1, `expected clamp near right margin, got ${arrow.x}`);
  assert.ok(Math.abs(arrow.y - 300) < 1);
});

test('edgeArrow flips direction for a target behind the camera', () => {
  // Projected "behind" point lands top-left of screen in raw NDC terms; edgeArrow should flip it
  // to point toward the bottom-right edge instead, since the real-world target is actually there.
  const behindProj = { x: 100, y: 100, ndcX: -1, ndcY: 1, behind: true, visible: false };
  const arrow = edgeArrow(behindProj, 800, 600, 30);
  assert.ok(arrow.x > 400, 'flipped arrow should sit right of centre');
  assert.ok(arrow.y > 300, 'flipped arrow should sit below centre');
});

test('worldToMinimap centres the player and scales by metersPerPixel', () => {
  const pt = worldToMinimap(0, 0, 0, 0, 2, 200);
  assert.equal(pt.x, 100);
  assert.equal(pt.y, 100);
  const pt2 = worldToMinimap(20, 0, 0, 0, 2, 200); // 20m east -> 10px at 2 m/px
  assert.equal(pt2.x, 110);
  assert.equal(pt2.y, 100);
});

test('worldToMinimap rotates by yaw when given', () => {
  // a point due east (dx=10,dz=0) rotated by +90deg camera yaw swings onto the screen's -Z (north) axis
  const pt = worldToMinimap(10, 0, 0, 0, 1, 200, Math.PI / 2);
  assert.ok(Math.abs(pt.x - 100) < 1e-6, `expected x~100, got ${pt.x}`);
  assert.ok(Math.abs(pt.y - 90) < 1e-6, `expected y~90, got ${pt.y}`);
});

test('withinMinimapRadius accepts centre and rejects far corner', () => {
  assert.equal(withinMinimapRadius(100, 100, 200), true);
  assert.equal(withinMinimapRadius(0, 0, 200), false); // corner of bounding box, outside the circle
});

test('cooldownDegrees maps 0..1 to 0..360 and clamps', () => {
  assert.equal(cooldownDegrees(0), 0);
  assert.equal(cooldownDegrees(1), 360);
  assert.equal(cooldownDegrees(0.5), 180);
  assert.equal(cooldownDegrees(-1), 0);
  assert.equal(cooldownDegrees(2), 360);
});

test('cooldownGradient produces a conic-gradient string proportional to fraction, and base color at 0', () => {
  assert.equal(cooldownGradient(0), 'transparent');
  const g = cooldownGradient(0.25);
  assert.match(g, /conic-gradient/);
  assert.match(g, /90deg/);
});

test('typewriterSlice reveals characters over time and stops at full length', () => {
  const text = 'hello world';
  assert.equal(typewriterSlice(text, 0, 10), '');
  assert.equal(typewriterSlice(text, 500, 10), 'hello');
  assert.equal(typewriterSlice(text, 10000, 10), text);
});

test('typewriterDone reflects whether the full text has been revealed', () => {
  const text = 'abcdef';
  assert.equal(typewriterDone(text, 0, 10), false);
  assert.equal(typewriterDone(text, 600, 10), true);
  assert.equal(typewriterDone('', 0, 10), true);
});

test('initials derives from one or two name parts', () => {
  assert.equal(initials('Deputy Hallie'), 'DH');
  assert.equal(initials('Wolverine'), 'WO');
  assert.equal(initials(''), '?');
});

test('colorFromString is deterministic for the same input', () => {
  assert.equal(colorFromString('thug'), colorFromString('thug'));
  assert.notEqual(colorFromString('thug'), colorFromString('drone'));
});
