// node --test test/characters.test.js
// Runs entirely in Node: no DOM, no WebGL. Textures/portraits degrade to null/''.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {
  CHARACTERS, NPC_PRESETS, ANIM_NAMES, Rig,
  createCharacterRig, createNpcRig, rigMeshCount, makeRng, hashSeed,
} from '../src/entities/characters.js';

const IDS = ['wolverine', 'quicksilver', 'jean', 'cyclops', 'emma'];
const REQUIRED_PARTS = [
  'head', 'torso', 'hips',
  'upperArmL', 'upperArmR', 'forearmL', 'forearmR', 'handL', 'handR',
  'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR',
];
const ALL_ANIMS = [
  'idle', 'walk', 'run', 'sprint', 'jump', 'fall', 'land',
  'attack1', 'attack2', 'attack3', 'ability', 'hurt', 'dead', 'skydive', 'hover',
];

function assertFinite(rig, label) {
  rig.group.updateMatrixWorld(true);
  rig.group.traverse((o) => {
    for (const v of [o.position, o.rotation, o.scale]) {
      for (const k of ['x', 'y', 'z']) {
        assert.ok(Number.isFinite(v[k]), `${label}: ${o.name} ${k} not finite (${v[k]})`);
      }
    }
    for (const e of o.matrixWorld.elements) {
      assert.ok(Number.isFinite(e), `${label}: ${o.name} matrixWorld NaN`);
    }
  });
}

test('CHARACTERS has the five heroes with the spec fields', () => {
  assert.deepEqual(Object.keys(CHARACTERS).sort(), IDS.slice().sort());
  const expected = {
    wolverine: { hp: 160, speed: 7, jump: 5.5, color: '#f2c200', abilities: ['claws', 'regen'] },
    quicksilver: { hp: 100, speed: 13, jump: 5, color: '#7fd0ff', abilities: ['dash', 'slowmo'] },
    jean: { hp: 110, speed: 6.5, jump: 5, color: '#2fa84f', abilities: ['telekinesis', 'hover'] },
    cyclops: { hp: 120, speed: 7, jump: 5, color: '#c72d2d', abilities: ['blast', 'sweep'] },
    emma: { hp: 110, speed: 6.5, jump: 5, color: '#ffffff', abilities: ['diamond', 'psychic'] },
  };
  for (const id of IDS) {
    const c = CHARACTERS[id];
    assert.equal(c.id, id);
    assert.ok(typeof c.name === 'string' && c.name.length > 2, `${id} name`);
    assert.equal(c.hp, expected[id].hp);
    assert.equal(c.speed, expected[id].speed);
    assert.equal(c.jump, expected[id].jump);
    assert.equal(c.color, expected[id].color);
    assert.deepEqual(c.abilities, expected[id].abilities);
    assert.ok(typeof c.description === 'string' && c.description.length > 20, `${id} description`);
    // no DOM in Node -> portrait is ''
    assert.equal(typeof c.portrait, 'string');
    assert.equal(c.portrait, '');
  }
});

test('each hero rig builds with the named parts and sane dimensions', () => {
  for (const id of IDS) {
    const rig = createCharacterRig(id);
    assert.ok(rig instanceof Rig);
    assert.ok(rig.group.isGroup, `${id} group`);
    for (const p of REQUIRED_PARTS) {
      assert.ok(rig.parts[p], `${id} missing part ${p}`);
      assert.equal(rig.parts[p].name, p, `${id} part ${p} name`);
    }
    assert.ok(rig.height > 1.6 && rig.height < 1.95, `${id} height ${rig.height}`);
    assert.ok(rig.radius > 0.2 && rig.radius < 0.6, `${id} radius ${rig.radius}`);
    assert.ok(rigMeshCount(rig) <= 25, `${id} mesh count ${rigMeshCount(rig)}`);

    // group origin sits at the feet: lowest vertex is at (or a hair below) y = 0
    rig.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rig.group);
    assert.ok(box.min.y > -0.09 && box.min.y < 0.09, `${id} feet at origin (min.y=${box.min.y})`);
    assert.ok(box.max.y > 1.6 && box.max.y < 2.0, `${id} head height (max.y=${box.max.y})`);
    const width = box.max.x - box.min.x;
    assert.ok(width > 0.35 && width < 0.75, `${id} shoulder width ${width}`);
    rig.dispose();
  }
});

test('60 update steps in every animation state produce no NaNs', () => {
  for (const id of IDS) {
    const rig = createCharacterRig(id);
    for (const name of ALL_ANIMS) {
      rig.setAnim(name, { speed: name === 'sprint' ? 12 : name === 'run' ? 8 : 3.4, restart: true });
      for (let i = 0; i < 60; i++) rig.update(1 / 60);
      assertFinite(rig, `${id}/${name}`);
    }
    // interleaved transitions exercise the 0.15 s blend
    for (let i = 0; i < 60; i++) {
      rig.setAnim(ALL_ANIMS[i % ALL_ANIMS.length], { speed: 5 });
      rig.update(1 / 120);
    }
    assertFinite(rig, `${id}/blend`);
    rig.dispose();
  }
});

test('update tolerates bad dt and animation names', () => {
  const rig = createCharacterRig('jean');
  rig.setAnim('does-not-exist');
  assert.equal(rig.anim, 'idle');
  rig.update(NaN); rig.update(-5); rig.update(undefined); rig.update(10);
  assertFinite(rig, 'bad-dt');
  assert.deepEqual(ANIM_NAMES.slice().sort(), ALL_ANIMS.slice().sort());
  rig.dispose();
});

test('character features: claws, visor glow, diamond', () => {
  const wolf = createCharacterRig('wolverine');
  assert.equal(typeof wolf.setClaws, 'function');
  assert.ok(wolf.parts.clawsL && wolf.parts.clawsR, 'three-blade claw meshes on both hands');
  assert.equal(wolf.parts.clawsL.visible, false);
  wolf.setClaws(true, true);
  for (let i = 0; i < 30; i++) wolf.update(1 / 60);
  assert.equal(wolf.clawsOut, true);
  assert.equal(wolf.parts.clawsL.visible, true);
  wolf.setAnim('idle');            // locked: stays out
  for (let i = 0; i < 30; i++) wolf.update(1 / 60);
  assert.equal(wolf.clawsOut, true);
  wolf.setClaws(false);
  for (let i = 0; i < 40; i++) wolf.update(1 / 60);
  assert.equal(wolf.clawsOut, false);
  wolf.setAnim('attack1', { restart: true });   // attacks pop them automatically
  for (let i = 0; i < 20; i++) wolf.update(1 / 60);
  assert.equal(wolf.clawsOut, true);
  assertFinite(wolf, 'claws');
  wolf.dispose();

  const cyc = createCharacterRig('cyclops');
  const visor = cyc.meshes.headgear;
  assert.ok(visor, 'cyclops has a visor mesh');
  cyc.setVisorGlow(0);
  const low = visor.material.emissiveIntensity;
  cyc.setVisorGlow(1);
  assert.ok(visor.material.emissiveIntensity > low, 'visor emits more at glow 1');
  cyc.setVisorGlow(0.5);
  assert.ok(Number.isFinite(visor.material.emissiveIntensity));
  cyc.dispose();

  const emma = createCharacterRig('emma');
  const before = emma.meshes.torso.material;
  emma.setDiamond(true);
  assert.equal(emma.diamond, true);
  const dia = emma.meshes.torso.material;
  assert.notEqual(dia, before);
  assert.ok(dia.metalness > 0.7 && dia.roughness < 0.2, 'crystal-like material');
  for (let i = 0; i < 60; i++) emma.update(1 / 60);
  emma.setDiamond(false);
  assert.equal(emma.meshes.torso.material, before);
  assertFinite(emma, 'diamond');
  emma.dispose();
});

test('setColorScheme recolours without touching other rigs', () => {
  const a = createNpcRig({ seed: 7 });
  const b = createNpcRig({ seed: 7 });
  const before = b.meshes.torso.material.color.getHex();
  a.setColorScheme({ primary: '#ff00ff', hair: '#00ff00' });
  assert.equal(a.meshes.torso.material.color.getHex(), 0xff00ff);
  assert.equal(b.meshes.torso.material.color.getHex(), before);
  a.dispose(); b.dispose();
});

test('createNpcRig: deterministic from a seed, accepts specs and presets', () => {
  const a = createNpcRig(12345);
  const b = createNpcRig({ seed: 12345 });
  assert.equal(a.scheme.primary, b.scheme.primary);
  assert.equal(a.scheme.hair, b.scheme.hair);
  assert.equal(a.scheme.skin, b.scheme.skin);
  assert.ok(Math.abs(a.height - b.height) < 1e-6);
  const c = createNpcRig(999);
  assert.ok(c.scheme.primary !== a.scheme.primary || c.scheme.hair !== a.scheme.hair);

  const spec = createNpcRig({ gender: 'f', skin: '#cd9c73', hair: '#a8321a', seed: 3, outfit: { top: '#123456', bottom: '#654321', hat: 'cap' } });
  assert.equal(spec.scheme.primary, '#123456');
  assert.equal(spec.scheme.legColor, '#654321');
  assert.ok(spec.meshes.headgear, 'hat mesh');
  for (const p of REQUIRED_PARTS) assert.ok(spec.parts[p], `npc missing ${p}`);
  assert.ok(rigMeshCount(spec) <= 25);
  for (const n of ALL_ANIMS) {
    spec.setAnim(n, { speed: 4 });
    for (let i = 0; i < 60; i++) spec.update(1 / 60);
    assertFinite(spec, `npc/${n}`);
  }
  [a, b, c, spec].forEach((r) => r.dispose());
});

test('NPC_PRESETS cover the side characters and the thug enemy', () => {
  for (const key of ['deputy', 'dean', 'cook', 'coach', 'fisherman', 'nurse', 'thug']) {
    assert.ok(NPC_PRESETS[key], `missing preset ${key}`);
    const rig = createNpcRig(key);
    assert.equal(rig.preset, key);
    assert.ok(rig.npcName.length > 2, `${key} name`);
    for (const p of REQUIRED_PARTS) assert.ok(rig.parts[p], `${key} missing ${p}`);
    rig.setAnim('walk', { speed: 1.6 });
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    assertFinite(rig, key);
    rig.dispose();
  }
  const thug = createNpcRig('thug');
  assert.ok(thug.meshes.headgear, 'thug wears a mask');
  assert.equal(thug.kind, 'enemy');
  thug.dispose();
});

test('rng helpers are deterministic', () => {
  const r1 = makeRng(42), r2 = makeRng(42);
  for (let i = 0; i < 10; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
  assert.equal(hashSeed('deputy'), hashSeed('deputy'));
  assert.notEqual(hashSeed('deputy'), hashSeed('nurse'));
});

test('animation actually moves the skeleton', () => {
  const rig = createCharacterRig('quicksilver');
  rig.setAnim('run', { speed: 9, restart: true });
  for (let i = 0; i < 30; i++) rig.update(1 / 60);
  const a = rig.parts.thighL.rotation.x;
  for (let i = 0; i < 18; i++) rig.update(1 / 60);
  const b = rig.parts.thighL.rotation.x;
  assert.ok(Math.abs(a - b) > 0.05, `legs should swing (${a} vs ${b})`);
  rig.setAnim('dead', { restart: true });
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  rig.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rig.group);
  assert.ok(box.max.y < 1.0, `dead rig lies down (max.y=${box.max.y})`);
  rig.dispose();
});
