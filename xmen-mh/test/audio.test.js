import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  getNoteFrequency,
  calculatePan,
  calculateAttenuation,
  calculateMoodCrossfade,
  getSequencerStepTime,
} from '../src/audio.js';

test('getNoteFrequency returns correct A4 frequency', () => {
  const freq = getNoteFrequency(0);
  assert.strictEqual(freq, 440);
});

test('getNoteFrequency calculates semitone offsets', () => {
  const c5 = getNoteFrequency(3); // 3 semitones above A4
  assert.ok(Math.abs(c5 - 523.25) < 1);

  const a5 = getNoteFrequency(12); // 1 octave above A4
  assert.strictEqual(a5, 880);
});

test('calculatePan returns 0 when positions are equal', () => {
  const pos = { x: 0, y: 0, z: 0 };
  const pan = calculatePan(pos, pos, 0);
  assert.strictEqual(pan, 0);
});

test('calculatePan returns -1 to 1 range', () => {
  const playerPos = { x: 0, y: 0, z: 0 };
  for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.5) {
    const fromPos = { x: 100, y: 0, z: 0 };
    const pan = calculatePan(fromPos, playerPos, yaw);
    assert.ok(pan >= -1 && pan <= 1, `pan ${pan} out of range at yaw ${yaw}`);
  }
});

test('calculatePan respects camera yaw', () => {
  const playerPos = { x: 0, y: 0, z: 0 };
  const fromPos = { x: 50, y: 0, z: 0 };

  const pan0 = calculatePan(fromPos, playerPos, 0); // x-axis
  const panPi2 = calculatePan(fromPos, playerPos, Math.PI / 2); // y-axis rotation

  // Pans should differ when rotated
  assert.notStrictEqual(pan0, panPi2);
});

test('calculateAttenuation returns 1 at close range', () => {
  const playerPos = { x: 0, y: 0, z: 0 };
  const fromPos = { x: 1, y: 0, z: 0 };
  const atten = calculateAttenuation(fromPos, playerPos, 100);
  assert.ok(atten > 0.9);
});

test('calculateAttenuation returns 0 at max distance', () => {
  const playerPos = { x: 0, y: 0, z: 0 };
  const fromPos = { x: 100, y: 0, z: 0 };
  const atten = calculateAttenuation(fromPos, playerPos, 100);
  assert.strictEqual(atten, 0);
});

test('calculateAttenuation returns 0 beyond max distance', () => {
  const playerPos = { x: 0, y: 0, z: 0 };
  const fromPos = { x: 150, y: 0, z: 0 };
  const atten = calculateAttenuation(fromPos, playerPos, 100);
  assert.strictEqual(atten, 0);
});

test('calculateAttenuation is smooth between 0 and max distance', () => {
  const playerPos = { x: 0, y: 0, z: 0 };
  const atten25 = calculateAttenuation({ x: 25, y: 0, z: 0 }, playerPos, 100);
  const atten50 = calculateAttenuation({ x: 50, y: 0, z: 0 }, playerPos, 100);
  const atten75 = calculateAttenuation({ x: 75, y: 0, z: 0 }, playerPos, 100);

  assert.ok(atten25 > atten50);
  assert.ok(atten50 > atten75);
  assert.ok(atten75 > 0);
});

test('calculateMoodCrossfade returns 0 at start', () => {
  const fade = calculateMoodCrossfade(0, 2);
  assert.strictEqual(fade, 0);
});

test('calculateMoodCrossfade returns 1 at duration', () => {
  const fade = calculateMoodCrossfade(2, 2);
  assert.strictEqual(fade, 1);
});

test('calculateMoodCrossfade returns 0.5 at half duration', () => {
  const fade = calculateMoodCrossfade(1, 2);
  assert.strictEqual(fade, 0.5);
});

test('calculateMoodCrossfade clamps to 0-1 range', () => {
  const fadeNeg = calculateMoodCrossfade(-1, 2);
  const fadeOver = calculateMoodCrossfade(3, 2);
  assert.strictEqual(fadeNeg, 0);
  assert.strictEqual(fadeOver, 1);
});

test('getSequencerStepTime returns monotonically increasing times', () => {
  const times = [];
  for (let i = 0; i < 16; i++) {
    times.push(getSequencerStepTime(i, 120));
  }

  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], `step ${i} time not increasing`);
  }
});

test('getSequencerStepTime cycles correctly', () => {
  const time0 = getSequencerStepTime(0, 120);
  const time16 = getSequencerStepTime(16, 120);
  const time32 = getSequencerStepTime(32, 120);

  // 16 steps should complete one cycle
  const cycleDuration = time16 - time0;
  assert.ok(Math.abs(cycleDuration - 2) < 0.01, `16 steps should be 2 seconds at 120 bpm, got ${cycleDuration}`);

  // 32 steps should be 2 cycles
  assert.ok(Math.abs(time32 - time0 - cycleDuration * 2) < 0.01);
});

test('getSequencerStepTime is consistent with different BPMs', () => {
  const bpm120_step0 = getSequencerStepTime(0, 120);
  const bpm60_step0 = getSequencerStepTime(0, 60);

  // 60 BPM is half speed, so times should be proportionally different
  const bpm120_step8 = getSequencerStepTime(8, 120);
  const bpm60_step8 = getSequencerStepTime(8, 60);

  assert.ok(bpm60_step8 > bpm120_step8);
});

test('calculatePan with null positions returns 0', () => {
  const pan1 = calculatePan(null, { x: 0, y: 0, z: 0 }, 0);
  const pan2 = calculatePan({ x: 0, y: 0, z: 0 }, null, 0);
  assert.strictEqual(pan1, 0);
  assert.strictEqual(pan2, 0);
});

test('calculateAttenuation with null positions returns 1', () => {
  const atten1 = calculateAttenuation(null, { x: 0, y: 0, z: 0 }, 100);
  const atten2 = calculateAttenuation({ x: 0, y: 0, z: 0 }, null, 100);
  assert.strictEqual(atten1, 1);
  assert.strictEqual(atten2, 1);
});

test('note frequency table for common musical notes', () => {
  const notes = {
    '-9': 261.63, // C4
    '-3': 369.99, // F#4
    '0': 440.00,  // A4
    '3': 523.25,  // C5
    '7': 659.25,  // E5
    '12': 880.00, // A5
  };

  for (const [semitones, expected] of Object.entries(notes)) {
    const freq = getNoteFrequency(parseInt(semitones));
    assert.ok(Math.abs(freq - expected) < 1,
      `Semitone ${semitones}: expected ~${expected}, got ${freq}`);
  }
});
