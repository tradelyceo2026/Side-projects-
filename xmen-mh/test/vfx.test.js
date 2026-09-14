import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticlePool } from '../src/vfx.js';
import { timeOfDayColors, sunDirection } from '../src/world/sky.js';
import { computeDeckLayout } from '../src/world/helicarrier.js';

// --------------------------------------------------------------------------
// ParticlePool: allocation, lifetime, wrap
// --------------------------------------------------------------------------
test('ParticlePool allocates sequentially and wraps round-robin', () => {
  const pool = new ParticlePool(4);
  const idx = [pool.alloc(1), pool.alloc(1), pool.alloc(1), pool.alloc(1)];
  assert.deepEqual(idx, [0, 1, 2, 3]);
  // capacity is full; the 5th alloc recycles slot 0 (round robin)
  const wrapped = pool.alloc(1);
  assert.equal(wrapped, 0);
});

test('ParticlePool tracks which slots are active', () => {
  const pool = new ParticlePool(3);
  assert.equal(pool.isActive(0), false);
  const i = pool.alloc(1);
  assert.equal(pool.isActive(i), true);
});

test('ParticlePool lifetime counts down and expires', () => {
  const pool = new ParticlePool(2);
  const i = pool.alloc(1); // 1 second life
  let alive = pool.step(0.4);
  assert.deepEqual(alive, [i]);
  assert.equal(pool.isActive(i), true);
  alive = pool.step(0.4);
  assert.deepEqual(alive, [i]);
  alive = pool.step(0.4); // total elapsed 1.2s > 1s life
  assert.deepEqual(alive, []);
  assert.equal(pool.isActive(i), false);
});

test('ParticlePool.progress runs from 0 at birth to 1 at death', () => {
  const pool = new ParticlePool(1);
  const i = pool.alloc(2);
  assert.equal(pool.progress(i), 0);
  pool.step(1);
  assert.ok(Math.abs(pool.progress(i) - 0.5) < 1e-6);
  pool.step(1);
  assert.ok(pool.progress(i) >= 1 - 1e-6);
});

test('ParticlePool.killAll deactivates every slot', () => {
  const pool = new ParticlePool(3);
  pool.alloc(1); pool.alloc(1); pool.alloc(1);
  pool.killAll();
  for (let i = 0; i < 3; i++) assert.equal(pool.isActive(i), false);
});

test('ParticlePool handles a zero-or-negative life without breaking progress math', () => {
  const pool = new ParticlePool(1);
  const i = pool.alloc(0);
  assert.ok(Number.isFinite(pool.progress(i)));
});

// --------------------------------------------------------------------------
// Sky: time-of-day colour interpolation
// --------------------------------------------------------------------------
test('timeOfDayColors returns the exact keyframe at its own hour', () => {
  const noon17 = timeOfDayColors(17);
  assert.ok(Math.abs(noon17.horizon[0] - 1.0) < 1e-6);
  assert.ok(Math.abs(noon17.sunIntensity - 2.1) < 1e-6);
});

test('timeOfDayColors interpolates linearly between two keyframes', () => {
  // halfway between the 6h and 17h keyframes is 11.5h
  const mid = timeOfDayColors(11.5);
  const a = timeOfDayColors(6);
  const b = timeOfDayColors(17);
  const expected = (a.sunIntensity + b.sunIntensity) / 2;
  assert.ok(Math.abs(mid.sunIntensity - expected) < 1e-6);
});

test('timeOfDayColors wraps around midnight (21h -> 6h keyframe span)', () => {
  const midnight = timeOfDayColors(0);
  const dusk = timeOfDayColors(21);
  const dawn = timeOfDayColors(6);
  // midnight should sit strictly between dusk and dawn intensities
  const lo = Math.min(dusk.sunIntensity, dawn.sunIntensity);
  const hi = Math.max(dusk.sunIntensity, dawn.sunIntensity);
  assert.ok(midnight.sunIntensity >= lo - 1e-6 && midnight.sunIntensity <= hi + 1e-6);
});

test('timeOfDayColors is periodic in hour (24h wraps to 0h)', () => {
  const h0 = timeOfDayColors(0);
  const h24 = timeOfDayColors(24);
  assert.deepEqual(h0, h24);
});

test('sunDirection returns a unit vector', () => {
  const [x, y, z] = sunDirection(35);
  const len = Math.sqrt(x * x + y * y + z * z);
  assert.ok(Math.abs(len - 1) < 1e-6);
});

test('sunDirection elevation increases the y component', () => {
  const low = sunDirection(5);
  const high = sunDirection(60);
  assert.ok(high[1] > low[1]);
});

// --------------------------------------------------------------------------
// Helicarrier: deck bounds and jump point
// --------------------------------------------------------------------------
test('computeDeckLayout produces symmetric bounds around the origin', () => {
  const layout = computeDeckLayout({ length: 250, width: 58, deckY: 600 });
  assert.equal(layout.deckBounds.minX, -layout.deckBounds.maxX);
  assert.equal(layout.deckBounds.minZ, -layout.deckBounds.maxZ);
  assert.equal(layout.deckBounds.maxX - layout.deckBounds.minX, 58);
  assert.equal(layout.deckBounds.maxZ - layout.deckBounds.minZ, 250);
});

test('computeDeckLayout places the jump point at the bow edge, at deck height', () => {
  const layout = computeDeckLayout({ length: 250, width: 58, deckY: 600 });
  assert.equal(layout.jumpPoint.y, 600);
  assert.equal(layout.jumpPoint.x, 0);
  assert.equal(layout.jumpPoint.z, layout.deckBounds.minZ);
});

test('computeDeckLayout honours a custom deckY and defaults sensibly', () => {
  const custom = computeDeckLayout({ deckY: 610 });
  assert.equal(custom.deckY, 610);
  const defaults = computeDeckLayout();
  assert.equal(defaults.deckY, 600);
  assert.ok(defaults.deckBounds.maxZ > defaults.deckBounds.maxX); // longer than wide
});
