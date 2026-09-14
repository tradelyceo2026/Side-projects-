// Node test suite for src/data/city.json (and its city.js wrapper).
// Run with: node --test test/city-data.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, '../src/data/city.json');
const JS_PATH = path.join(__dirname, '../src/data/city.js');

const raw = readFileSync(JSON_PATH, 'utf8');
const city = JSON.parse(raw);

const REQUIRED_POI_IDS = [
  'courthouse',
  'asumh',
  'hospital',
  'walmart',
  'high_school',
  'lake',
  'airport',
  'downtown',
  'park',
  'landing_zone',
];

function inBbox(x, z, bbox, margin = 0.5) {
  return x >= bbox.minX - margin && x <= bbox.maxX + margin && z >= bbox.minZ - margin && z <= bbox.maxZ + margin;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

test('city.json is well-formed and has the top-level shape the spec requires', () => {
  assert.equal(typeof city, 'object');
  assert.ok(city.origin && isFiniteNumber(city.origin.lat) && isFiniteNumber(city.origin.lon));
  assert.ok(city.bbox);
  for (const k of ['minX', 'maxX', 'minZ', 'maxZ']) assert.ok(isFiniteNumber(city.bbox[k]), `bbox.${k}`);
  assert.ok(city.bbox.minX < city.bbox.maxX);
  assert.ok(city.bbox.minZ < city.bbox.maxZ);
  assert.ok(Array.isArray(city.roads));
  assert.ok(Array.isArray(city.buildings));
  assert.ok(Array.isArray(city.water));
  assert.ok(Array.isArray(city.green));
  assert.ok(Array.isArray(city.pois));
});

test('origin matches the Baxter County Courthouse square per docs/SPEC.md', () => {
  assert.ok(Math.abs(city.origin.lat - 36.3353) < 0.01);
  assert.ok(Math.abs(city.origin.lon - (-92.3852)) < 0.01);
});

test('city.js exports the same object as city.json (bundles without fetch)', async () => {
  const mod = await import(JS_PATH);
  assert.deepEqual(mod.default, city);
});

test('file size is within the 1.5 MB spec target', () => {
  const bytes = Buffer.byteLength(raw, 'utf8');
  assert.ok(bytes <= 1.5 * 1024 * 1024, `city.json is ${(bytes / 1024 / 1024).toFixed(2)} MB, over the 1.5 MB target`);
});

test('all required POI ids are present exactly once, with sane fields', () => {
  const ids = city.pois.map((p) => p.id);
  for (const id of REQUIRED_POI_IDS) {
    const count = ids.filter((i) => i === id).length;
    assert.equal(count, 1, `expected exactly one POI with id "${id}", found ${count}`);
  }
  for (const p of city.pois) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.name, 'string');
    assert.ok(p.name.length > 0, `poi ${p.id} has an empty name`);
    assert.ok(isFiniteNumber(p.x), `poi ${p.id}.x`);
    assert.ok(isFiniteNumber(p.z), `poi ${p.id}.z`);
    assert.ok(isFiniteNumber(p.radius) && p.radius > 0, `poi ${p.id}.radius`);
  }
});

test('courthouse and downtown POIs sit at the origin (0, 0)', () => {
  const courthouse = city.pois.find((p) => p.id === 'courthouse');
  const downtown = city.pois.find((p) => p.id === 'downtown');
  assert.ok(courthouse);
  assert.ok(downtown);
  assert.ok(Math.abs(courthouse.x) < 1 && Math.abs(courthouse.z) < 1);
  assert.ok(Math.abs(downtown.x) < 1 && Math.abs(downtown.z) < 1);
});

test('every required POI lies within (or on) the world bbox', () => {
  for (const id of REQUIRED_POI_IDS) {
    const p = city.pois.find((poi) => poi.id === id);
    assert.ok(p, `missing poi ${id}`);
    assert.ok(inBbox(p.x, p.z, city.bbox), `poi ${id} at (${p.x}, ${p.z}) is outside bbox ${JSON.stringify(city.bbox)}`);
  }
});

test('roads include US-62 and AR-5 (and AR-201, Cardinal Drive if present, per spec)', () => {
  const roadText = (r) => `${r.name || ''} ${r.ref || ''}`;
  const us62 = city.roads.filter((r) => /\bus[\s-]?62\b/i.test(roadText(r)));
  const ar5 = city.roads.filter((r) => /\bar[\s-]?5\b/i.test(roadText(r)));
  assert.ok(us62.length > 0, 'expected at least one road matching US-62 / US 62 / Hwy 62');
  assert.ok(ar5.length > 0, 'expected at least one road matching AR-5 / AR 5');

  // AR-201 and Cardinal Drive are required "if present" in the source data — this run's
  // fetch does include them (see docs/DATA.md); assert they're there, but don't hard-fail
  // future re-fetches where OSM tagging might shift, since the spec only requires them
  // conditionally.
  const ar201 = city.roads.filter((r) => /\bar[\s-]?201\b/i.test(roadText(r)));
  const cardinal = city.roads.filter((r) => /cardinal/i.test(roadText(r)));
  assert.ok(ar201.length > 0, 'expected AR-201 to be present in this dataset (see docs/DATA.md)');
  assert.ok(cardinal.length > 0, 'expected Cardinal Drive to be present in this dataset (see docs/DATA.md)');
});

test('roads have valid class/width/pts', () => {
  const validClasses = new Set(['primary', 'secondary', 'tertiary', 'residential', 'service']);
  assert.ok(city.roads.length > 100, `expected a substantial number of roads, got ${city.roads.length}`);
  for (const r of city.roads) {
    assert.ok(validClasses.has(r.class), `road ${r.id} has invalid class "${r.class}"`);
    assert.ok(isFiniteNumber(r.width) && r.width > 0, `road ${r.id}.width`);
    assert.ok(Array.isArray(r.pts) && r.pts.length >= 2, `road ${r.id}.pts`);
    for (const pt of r.pts) {
      assert.equal(pt.length, 2);
      assert.ok(isFiniteNumber(pt[0]) && isFiniteNumber(pt[1]));
      assert.ok(inBbox(pt[0], pt[1], city.bbox), `road ${r.id} has a point outside bbox: ${pt}`);
    }
  }
});

test('buildings have valid kind/height/poly and sane area', () => {
  const validKinds = new Set(['house', 'commercial', 'civic', 'campus', 'hospital', 'church', 'industrial']);
  assert.ok(city.buildings.length > 100, `expected a substantial number of buildings, got ${city.buildings.length}`);
  function polygonArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, z1] = poly[i];
      const [x2, z2] = poly[(i + 1) % poly.length];
      a += x1 * z2 - x2 * z1;
    }
    return Math.abs(a) / 2;
  }
  for (const b of city.buildings) {
    assert.ok(validKinds.has(b.kind), `building ${b.id} has invalid kind "${b.kind}"`);
    assert.ok(isFiniteNumber(b.height) && b.height > 0, `building ${b.id}.height`);
    assert.ok(Array.isArray(b.poly) && b.poly.length >= 3, `building ${b.id}.poly`);
    for (const pt of b.poly) {
      assert.ok(inBbox(pt[0], pt[1], city.bbox), `building ${b.id} has a point outside bbox: ${pt}`);
    }
    assert.ok(polygonArea(b.poly) >= 15, `building ${b.id} area is below the 15 m^2 floor`);
  }
});

test('at least one building of each key kind exists (hospital, campus, house, civic, commercial)', () => {
  const kinds = new Set(city.buildings.map((b) => b.kind));
  assert.ok(kinds.has('hospital'), 'expected at least one hospital building');
  assert.ok(kinds.has('civic'), 'expected at least one civic building');
  assert.ok(kinds.has('commercial'), 'expected at least one commercial building');
  assert.ok(kinds.has('house'), 'expected residential (house) buildings');
  assert.ok(kinds.has('campus'), 'expected at least one campus building (see docs/DATA.md for the ASUMH note)');
});

test('water and green polygons are well-formed and within bbox', () => {
  for (const w of city.water) {
    assert.ok(Array.isArray(w.poly) && w.poly.length >= 3, 'water poly');
    for (const pt of w.poly) assert.ok(inBbox(pt[0], pt[1], city.bbox), `water "${w.name}" point outside bbox: ${pt}`);
  }
  const validGreenKinds = new Set(['park', 'forest', 'grass']);
  for (const g of city.green) {
    assert.ok(validGreenKinds.has(g.kind), `green "${g.name}" has invalid kind "${g.kind}"`);
    assert.ok(Array.isArray(g.poly) && g.poly.length >= 3, 'green poly');
    for (const pt of g.poly) assert.ok(inBbox(pt[0], pt[1], city.bbox), `green "${g.name}" point outside bbox: ${pt}`);
  }
});

test('no duplicate building ids or road ids', () => {
  const roadIds = new Set();
  for (const r of city.roads) {
    assert.ok(!roadIds.has(r.id), `duplicate road id ${r.id}`);
    roadIds.add(r.id);
  }
  const buildingIds = new Set();
  for (const b of city.buildings) {
    assert.ok(!buildingIds.has(b.id), `duplicate building id ${b.id}`);
    buildingIds.add(b.id);
  }
});
