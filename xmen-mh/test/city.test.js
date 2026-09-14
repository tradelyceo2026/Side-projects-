// test/city.test.js — node --test test/city.test.js
// Runs head-lessly: city.js never touches `document` at import time and its canvas
// textures degrade to flat colours, so the whole city can be built in Node.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {
  City, buildCityFromJson, CITY_DEFAULTS, DISTRICT, REQUIRED_POIS,
  AabbGrid, FlattenField, MeshBuilder,
  clamp, lerp, smoothstep, hash2i, makeRng, makeValueNoise2D, createTerrainSampler,
  polygonArea, polygonBounds, polygonCentroid, pointInPolygon, pointInTriangle, earClip,
  pointSegmentDistance, douglasPeucker, polylineLength, resamplePolyline, smoothSeries,
  offsetPolyline, resolveCapsuleBoxes, roadRibbonPolylines, sidewalkPolylines,
  addGableRoof, facadeKeyFor, hasDOM, roadClass,
} from '../src/world/city.js';

/* ------------------------------------------------------------------ *
 * synthetic city.json — the shape docs/SPEC.md promises
 * ------------------------------------------------------------------ */

function rect(cx, cz, w, d) {
  return [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];
}
function lshape(cx, cz, w, d) {
  return [
    [cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz],
    [cx, cz], [cx, cz + d / 2], [cx - w / 2, cz + d / 2],
  ];
}

export function makeSyntheticCity() {
  const rng = makeRng(7);
  const roads = [
    { id: 1, name: 'US 62', class: 'primary', width: 14, pts: [[-600, -40], [-200, -40], [120, -30], [600, -20]] },
    { id: 2, name: 'AR 5', class: 'primary', width: 13, pts: [[10, -600], [10, -120], [0, 60], [-10, 600]] },
    { id: 3, name: 'AR 201', class: 'secondary', width: 11, pts: [[-600, 180], [0, 180], [600, 200]] },
    { id: 4, name: 'Cardinal Drive', class: 'tertiary', width: 9, pts: [[-300, -600], [-300, 600]] },
  ];
  for (let i = 0; i < 6; i++) {
    const z = 240 + i * 60;
    roads.push({ id: 10 + i, name: 'Residential ' + i, class: 'residential', width: 7, pts: [[-450, z], [450, z]] });
  }

  const kinds = ['house', 'commercial', 'civic', 'campus', 'hospital', 'church', 'industrial'];
  const buildings = [];
  let id = 1;
  for (const kind of kinds) {
    for (let i = 0; i < 30; i++) {
      const lane = kinds.indexOf(kind);
      const cx = -420 + i * 29 + lane * 3;
      const cz = -320 + lane * 90;
      const w = kind === 'hospital' ? 44 : kind === 'campus' ? 30 : 14 + rng() * 8;
      const d = kind === 'hospital' ? 34 : kind === 'campus' ? 24 : 12 + rng() * 8;
      const height = kind === 'house' ? 5.5 : kind === 'hospital' ? 26 : kind === 'church' ? 9
        : kind === 'campus' ? 12 : 8 + rng() * 6;
      buildings.push({
        id: id++, name: '', kind, height,
        poly: (kind === 'commercial' && i % 5 === 0) ? lshape(cx, cz, w, d) : rect(cx, cz, w, d),
      });
    }
  }

  return {
    origin: { lat: 36.3353, lon: -92.3852 },
    bbox: { minX: -650, maxX: 650, minZ: -650, maxZ: 650 },
    roads,
    buildings,
    water: [{ name: 'Lake Norfork', poly: rect(480, 480, 240, 240) }],
    green: [
      { name: 'Cooper Park', kind: 'park', poly: rect(-200, 320, 180, 140) },
      { name: '', kind: 'forest', poly: rect(400, -420, 260, 200) },
    ],
    pois: REQUIRED_POIS.map((pid, i) => ({
      id: pid, name: pid, kind: pid,
      x: pid === 'asumh' ? 220 : pid === 'courthouse' || pid === 'downtown' ? 0 : -300 + i * 70,
      z: pid === 'asumh' ? -240 : pid === 'courthouse' || pid === 'downtown' ? 0 : 120 + i * 20,
      radius: pid === 'asumh' ? 160 : 60,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * scalars, noise, terrain
 * ------------------------------------------------------------------ */

test('clamp / lerp / smoothstep', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(lerp(0, 10, 0.25), 2.5);
  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 2), 1);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
});

test('hash2i is deterministic and in 0..1', () => {
  assert.equal(hash2i(3, -7, 11), hash2i(3, -7, 11));
  assert.notEqual(hash2i(3, -7, 11), hash2i(4, -7, 11));
  for (let i = 0; i < 500; i++) {
    const v = hash2i(i, i * 7 - 3, 5);
    assert.ok(v >= 0 && v < 1, `hash out of range: ${v}`);
  }
});

test('makeRng is deterministic and uniform-ish', () => {
  const a = makeRng(42), b = makeRng(42);
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / 1000 - 0.5) < 0.05);
});

test('value noise is continuous and bounded', () => {
  const n = makeValueNoise2D(5);
  for (let i = 0; i < 200; i++) {
    const x = i * 0.37, z = i * -0.21;
    const a = n(x, z), b = n(x + 0.001, z);
    assert.ok(a >= 0 && a <= 1);
    assert.ok(Math.abs(a - b) < 0.02, 'noise should be smooth');
  }
});

test('terrain stays within +-12 m and is not flat', () => {
  const t = createTerrainSampler({ seed: 1, amplitude: 12, scale: 1400 });
  let min = Infinity, max = -Infinity;
  for (let x = -2500; x <= 2500; x += 37) {
    for (let z = -2500; z <= 2500; z += 173) {
      const h = t(x, z);
      assert.ok(Number.isFinite(h));
      min = Math.min(min, h); max = Math.max(max, h);
    }
  }
  assert.ok(min >= -12.0001 && max <= 12.0001, `range ${min}..${max}`);
  assert.ok(max - min > 6, 'terrain should actually undulate');
  // gentle: less than ~1 m of rise per 10 m step
  for (let i = 0; i < 300; i++) {
    const x = -2000 + i * 13, z = 700 - i * 9;
    assert.ok(Math.abs(t(x + 10, z) - t(x, z)) < 1.0);
  }
});

/* ------------------------------------------------------------------ *
 * polygons
 * ------------------------------------------------------------------ */

test('polygonArea / bounds / centroid', () => {
  const sq = rect(0, 0, 10, 10);
  assert.equal(Math.abs(polygonArea(sq)), 100);
  const b = polygonBounds(sq);
  assert.deepEqual(b, { minX: -5, minZ: -5, maxX: 5, maxZ: 5 });
  const c = polygonCentroid(sq);
  assert.ok(Math.abs(c[0]) < 1e-9 && Math.abs(c[1]) < 1e-9);
  assert.equal(polygonArea(sq.slice().reverse()), -polygonArea(sq));
});

test('pointInPolygon / pointInTriangle', () => {
  const L = lshape(0, 0, 20, 20);
  assert.ok(pointInPolygon(-5, -5, L));
  assert.ok(pointInPolygon(-5, 5, L));
  assert.ok(!pointInPolygon(5, 5, L), 'the notch is outside');
  assert.ok(!pointInPolygon(50, 0, L));
  assert.ok(pointInTriangle(0.1, 0.1, [0, 0], [1, 0], [0, 1]));
  assert.ok(!pointInTriangle(1, 1, [0, 0], [1, 0], [0, 1]));
});

test('earClip triangulates convex and concave rings, preserving area', () => {
  for (const poly of [rect(3, -2, 12, 8), lshape(0, 0, 20, 20), rect(0, 0, 5, 5).reverse()]) {
    const tris = earClip(poly);
    assert.equal(tris.length % 3, 0);
    assert.equal(tris.length / 3, poly.length - 2, 'n-2 triangles');
    let area = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = poly[tris[i]], b = poly[tris[i + 1]], c = poly[tris[i + 2]];
      assert.ok(tris[i] < poly.length && tris[i + 1] < poly.length && tris[i + 2] < poly.length);
      area += Math.abs(polygonArea([a, b, c]));
    }
    assert.ok(Math.abs(area - Math.abs(polygonArea(poly))) < 1e-6, 'triangles must tile the polygon');
  }
  assert.deepEqual(earClip([[0, 0], [1, 0]]), []);
});

/* ------------------------------------------------------------------ *
 * polylines
 * ------------------------------------------------------------------ */

test('pointSegmentDistance', () => {
  const r = pointSegmentDistance(0, 5, -10, 0, 10, 0);
  assert.equal(r.d, 5);
  assert.equal(r.x, 0);
  const past = pointSegmentDistance(20, 0, -10, 0, 10, 0);
  assert.equal(past.d, 10);
});

test('douglasPeucker drops collinear points, keeps corners', () => {
  const line = [];
  for (let i = 0; i <= 20; i++) line.push([i * 5, 0]);
  assert.equal(douglasPeucker(line, 1).length, 2);
  const bent = [[0, 0], [10, 0], [20, 0], [20, 40], [20, 80]];
  const s = douglasPeucker(bent, 1);
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], [0, 0]);
  assert.deepEqual(s[s.length - 1], [20, 80]);
});

test('resamplePolyline gives near-uniform spacing and keeps endpoints', () => {
  const pts = [[0, 0], [100, 0], [100, 60]];
  const out = resamplePolyline(pts, 12);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [100, 60]);
  for (let i = 1; i < out.length - 1; i++) {
    const d = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    assert.ok(d > 1 && d < 20, `spacing ${d}`);
  }
  assert.ok(Math.abs(polylineLength(out) - polylineLength(pts)) < 1e-6);
});

test('smoothSeries levels a spike but keeps the mean', () => {
  const v = [0, 0, 0, 0, 10, 0, 0, 0, 0];
  const s = smoothSeries(v, 2);
  assert.ok(s[4] < 3, 'spike flattened');
  const flat = smoothSeries([5, 5, 5, 5], 2);
  for (const x of flat) assert.ok(Math.abs(x - 5) < 1e-9);
});

test('offsetPolyline offsets a straight line by exactly the distance', () => {
  const pts = [[0, 0], [50, 0], [100, 0]];
  const right = offsetPolyline(pts, 5);
  const left = offsetPolyline(pts, -5);
  for (let i = 0; i < pts.length; i++) {
    assert.ok(Math.abs(right[i][1] - (-5)) < 1e-6 || Math.abs(right[i][1] - 5) < 1e-6);
    assert.ok(Math.abs(Math.hypot(right[i][0] - pts[i][0], right[i][1] - pts[i][1]) - 5) < 1e-6);
    assert.ok(Math.abs(Math.hypot(left[i][0] - pts[i][0], left[i][1] - pts[i][1]) - 5) < 1e-6);
    assert.ok(Math.abs(right[i][1] + left[i][1]) < 1e-6, 'mirrored about the centreline');
  }
});

test('roadRibbonPolylines makes a strip of the requested width', () => {
  const pts = [[0, 0], [30, 0], [60, 0]];
  const y = [2, 2, 2];
  const { left, right } = roadRibbonPolylines(pts, y, 12, 0.16);
  assert.equal(left.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(left[i][1], 2.16);
    assert.ok(Math.abs(Math.hypot(left[i][0] - right[i][0], left[i][2] - right[i][2]) - 12) < 1e-6);
  }
  const s = sidewalkPolylines(pts, y, 12, 1, 2.4, 0.16, 0);
  assert.ok(s.walkR[0][1] > s.curbL[0][1], 'sidewalk sits above the gutter');
  assert.ok(Math.abs(Math.hypot(s.walkL[0][0] - s.walkR[0][0], s.walkL[0][2] - s.walkR[0][2]) - 2.4) < 1e-6);
});

/* ------------------------------------------------------------------ *
 * spatial grid + collision
 * ------------------------------------------------------------------ */

test('AabbGrid returns overlapping items once, and nothing else', () => {
  const g = new AabbGrid(32);
  const a = g.insert({ name: 'a', minX: 0, minZ: 0, maxX: 100, maxZ: 100 });
  const b = g.insert({ name: 'b', minX: 500, minZ: 500, maxX: 520, maxZ: 520 });
  const hit = g.query(10, 10, 20, 20);
  assert.equal(hit.length, 1);
  assert.equal(hit[0], a);
  assert.equal(g.query(-400, -400, -300, -300).length, 0);
  assert.equal(g.queryPoint(505, 505)[0], b);
  assert.equal(g.query(0, 0, 600, 600).length, 2, 'no duplicates across cells');
});

test('resolveCapsuleBoxes pushes a capsule out of a building', () => {
  const box = { minX: -10, minZ: -10, maxX: 10, maxZ: 10, base: 0, top: 12 };
  const out = { x: 0, y: 0, z: 0 };

  // far away: untouched
  assert.equal(resolveCapsuleBoxes({ x: 40, y: 0, z: 0 }, 0.4, 1.8, [box], out), false);
  assert.equal(out.x, 40);

  // clipping the east face
  assert.equal(resolveCapsuleBoxes({ x: 10.2, y: 0, z: 0 }, 0.5, 1.8, [box], out), true);
  assert.ok(out.x >= 10.5 - 1e-6, `pushed to ${out.x}`);
  assert.equal(out.z, 0);

  // dead centre: leaves by the nearest face
  assert.equal(resolveCapsuleBoxes({ x: 1, y: 0, z: 0 }, 0.5, 1.8, [box], out), true);
  assert.ok(out.x > 10 || out.x < -10 || out.z > 10 || out.z < -10);

  // standing on the roof: no horizontal push
  assert.equal(resolveCapsuleBoxes({ x: 0, y: 12, z: 0 }, 0.5, 1.8, [box], out), false);

  // works with a THREE.Vector3 out param
  const v = new THREE.Vector3();
  resolveCapsuleBoxes(new THREE.Vector3(9.9, 1, 0), 0.5, 1.8, [box], v);
  assert.ok(v.x >= 10.5 - 1e-6);
  assert.equal(v.y, 1);
});

test('FlattenField levels terrain under a pad and leaves the hills alone', () => {
  const terrain = createTerrainSampler({ seed: 3 });
  const f = new FlattenField(terrain, 48);
  assert.equal(f.height(1000, 1000), terrain(1000, 1000));
  const h0 = terrain(0, 0);
  f.addPad(0, 0, h0, 30);
  for (let d = 0; d <= 10; d += 2) {
    assert.ok(Math.abs(f.height(d, 0) - h0) < 0.02, 'pad core is flat');
  }
  assert.ok(Math.abs(f.height(900, 900) - terrain(900, 900)) < 1e-9, 'far field untouched');
});

/* ------------------------------------------------------------------ *
 * mesh building
 * ------------------------------------------------------------------ */

test('MeshBuilder orients faces with the reference vector', () => {
  const mb = new MeshBuilder();
  mb.addQuad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], null, null, [0, 1, 0]);
  assert.equal(mb.triangleCount, 2);
  for (let i = 0; i < mb.nor.length; i += 3) assert.equal(mb.nor[i + 1], 1);

  const flipped = new MeshBuilder();
  flipped.addQuad([0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0], null, null, [0, 1, 0]);
  for (let i = 0; i < flipped.nor.length; i += 3) assert.equal(flipped.nor[i + 1], 1);

  const g = mb.toGeometry();
  assert.equal(g.getAttribute('position').count, 6);
  assert.equal(g.getIndex().count, 6);
  assert.ok(g.boundingSphere.radius > 0);
});

test('MeshBuilder polygon caps and prism walls', () => {
  const poly = lshape(0, 0, 20, 20);
  const cap = new MeshBuilder();
  cap.addPolygonCap(poly, 3, true, 8);
  assert.equal(cap.triangleCount, poly.length - 2);
  for (let i = 0; i < cap.nor.length; i += 3) assert.ok(cap.nor[i + 1] > 0.99);
  for (let i = 1; i < cap.pos.length; i += 3) assert.equal(cap.pos[i], 3);

  const walls = new MeshBuilder();
  walls.addPrismWalls(poly, 0, 10);
  assert.equal(walls.triangleCount, poly.length * 2);
  const c = polygonCentroid(poly);
  for (let t = 0; t < walls.triangleCount; t++) {
    const i = t * 9;
    const mx = (walls.pos[i] + walls.pos[i + 3] + walls.pos[i + 6]) / 3 - c[0];
    const mz = (walls.pos[i + 2] + walls.pos[i + 5] + walls.pos[i + 8]) / 3 - c[1];
    const n = [walls.nor[t * 9], walls.nor[t * 9 + 1], walls.nor[t * 9 + 2]];
    assert.ok(n[0] * mx + n[2] * mz >= -1e-6, 'wall normals face outward');
  }
});

test('MeshBuilder box and gable roof', () => {
  const mb = new MeshBuilder(true);
  mb.addBox(0, 5, 0, 2, 10, 2, [1, 0, 0]);
  assert.equal(mb.triangleCount, 12);
  assert.equal(mb.col.length, mb.pos.length);
  const roof = new MeshBuilder();
  const ridge = addGableRoof(roof, { minX: -6, maxX: 6, minZ: -4, maxZ: 4 }, 6);
  assert.ok(ridge > 6 && ridge < 6 + 3.5);
  assert.equal(roof.triangleCount, 6);
  let top = -Infinity;
  for (let i = 1; i < roof.pos.length; i += 3) top = Math.max(top, roof.pos[i]);
  assert.equal(top, ridge);
});

test('facadeKeyFor maps kind + district', () => {
  assert.equal(facadeKeyFor('house'), 'siding');
  assert.equal(facadeKeyFor('commercial', DISTRICT.DOWNTOWN), 'brick');
  assert.equal(facadeKeyFor('commercial', DISTRICT.STRIP), 'stripRetail');
  assert.equal(facadeKeyFor('hospital'), 'hospital');
  assert.equal(facadeKeyFor('campus'), 'campusStone');
  assert.equal(facadeKeyFor('church'), 'church');
  assert.equal(roadClass('nonsense'), roadClass('residential'));
  assert.equal(hasDOM(), false, 'these tests run without a DOM');
});

/* ------------------------------------------------------------------ *
 * full city build
 * ------------------------------------------------------------------ */

const JSON_CITY = makeSyntheticCity();
const scene = new THREE.Scene();
const city = buildCityFromJson(scene, JSON_CITY, {
  quality: 'medium',
  terrainSegments: { medium: 48 },
  treeCount: 700,
});

test('city builds head-lessly and stays inside the draw-call budget', () => {
  assert.ok(city.built);
  assert.equal(scene.children.includes(city.group), true);
  assert.ok(city.stats.draws > 10, 'something got built');
  assert.ok(city.stats.draws < 150, `draw calls ${city.stats.draws} must stay under 150`);
  assert.equal(city.buildings.length, 210);
  assert.equal(city.roads.length, 10);
  assert.ok(city.stats.trees > 100, `trees ${city.stats.trees}`);
  assert.ok(city.stats.lamps > 0);
  assert.ok(city.stats.cars > 0);
  const names = city.meshes.map((m) => m.name);
  for (const n of ['terrain', 'roads', 'sidewalks', 'road-markings', 'water', 'lawns',
    'campus-lawn', 'campus-paths', 'x-sign', 'roofs-flat', 'roofs-pitched', 'street-lamps', 'parked-cars']) {
    assert.ok(names.includes(n), `missing mesh: ${n}`);
  }
  assert.ok(names.some((n) => n.startsWith('buildings-brick')));
  assert.ok(names.some((n) => n.startsWith('buildings-siding')));
  assert.ok(names.some((n) => n.startsWith('buildings-hospital')));
  assert.ok(names.some((n) => n.startsWith('buildings-campusStone')));
});

test('bounds and POIs match the data', () => {
  assert.deepEqual(city.bounds, JSON_CITY.bbox);
  for (const id of REQUIRED_POIS) {
    const p = city.poi(id);
    assert.ok(p, `missing poi ${id}`);
    assert.equal(p.id, id);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z) && p.radius > 0);
  }
  assert.equal(city.missingPois.length, 0);
  assert.equal(city.poi('nope'), null);
});

test('a City with no POIs synthesises the required ids instead of crashing', () => {
  const bare = new City(new THREE.Scene(), { bbox: JSON_CITY.bbox, roads: [], buildings: [] }, { quality: 'low', terrainSegments: { low: 16 }, treeCount: 0 });
  bare.build();
  assert.equal(bare.missingPois.length, REQUIRED_POIS.length);
  assert.ok(bare.poi('asumh'));
  assert.equal(bare.nearestRoadPoint(5, 5).roadId, -1);
  assert.equal(bare.collideCapsule(new THREE.Vector3(0, 0, 0), 0.4, 1.8, new THREE.Vector3()), false);
  bare.dispose();
});

test('getGroundHeight is finite everywhere and level across a road', () => {
  for (let x = -640; x <= 640; x += 53) {
    for (let z = -640; z <= 640; z += 97) {
      const h = city.getGroundHeight(x, z);
      assert.ok(Number.isFinite(h), `ground NaN at ${x},${z}`);
      assert.ok(Math.abs(h) < 20, `ground ${h} out of range at ${x},${z}`);
    }
  }
  // US 62 runs east-west near z = -40: sample across its width
  const zc = -40;
  const base = city.getGroundHeight(-400, zc);
  for (let d = -5; d <= 5; d += 1) {
    const h = city.getGroundHeight(-400, zc + d);
    assert.ok(Math.abs(h - base) < 0.12, `street not level: ${h} vs ${base} at offset ${d}`);
  }
});

test('raycastDown returns roof height on a flat-roofed building, ground elsewhere', () => {
  const b = city.buildings.find((x) => x.kind === 'commercial' && x.poly.length === 4);
  const [cx, cz] = b.centroid;
  assert.ok(Math.abs(city.raycastDown(cx, b.top + 5, cz) - b.top) < 1e-6, 'lands on the roof');
  assert.ok(city.raycastDown(cx, b.top - 2, cz) < b.top, 'below the roof falls through to the ground');
  const open = city.getGroundHeight(-640, 640);
  assert.ok(Math.abs(city.raycastDown(-640, 100, 640) - open) < 1e-9);
});

test('collideCapsule keeps the player out of buildings', () => {
  const b = city.buildings.find((x) => x.kind === 'hospital');
  const out = new THREE.Vector3();
  const inside = new THREE.Vector3(b.centroid[0], b.padY + 1, b.centroid[1]);
  assert.equal(city.collideCapsule(inside, 0.45, 1.8, out), true);
  const outsideBox = out.x < b.minX || out.x > b.maxX || out.z < b.minZ || out.z > b.maxZ;
  assert.ok(outsideBox, `still inside: ${out.x},${out.z}`);
  assert.equal(out.y, inside.y, 'y is preserved');

  const far = new THREE.Vector3(-645, 0, 645);
  assert.equal(city.collideCapsule(far, 0.45, 1.8, out), false);
  assert.equal(out.x, -645);

  // standing on the roof is not a collision
  const onRoof = new THREE.Vector3(b.centroid[0], b.top + 0.01, b.centroid[1]);
  assert.equal(city.collideCapsule(onRoof, 0.45, 1.8, out), false);
});

test('nearestRoadPoint finds the closest centreline sample', () => {
  const r = city.nearestRoadPoint(-400, 0);
  assert.ok(r.roadId === 1, `expected US 62, got road ${r.roadId}`);
  assert.ok(Math.abs(r.z - (-40)) < 12, `z ${r.z}`);
  assert.ok(Math.hypot(r.x + 400, r.z) < 45);
  const far = city.nearestRoadPoint(640, -640);
  assert.ok(far.roadId >= 0, 'always resolves to some road');
});

test('trees are instanced, chunked, and never on roads or buildings', () => {
  assert.ok(city.treeChunks.length >= 2, 'trees are chunked for LOD');
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  let checked = 0, bad = 0;
  for (const c of city.treeChunks) {
    assert.ok(c.mesh.isInstancedMesh);
    for (let i = 0; i < c.mesh.count; i++) {
      c.mesh.getMatrixAt(i, m);
      v.setFromMatrixPosition(m);
      if (city._blocked(v.x, v.z, 0)) bad++;
      checked++;
    }
  }
  assert.ok(checked > 100);
  assert.equal(bad, 0, `${bad}/${checked} trees are on a road or building`);
});

test('update() animates water and culls distant tree chunks', () => {
  const mat = city.materials.water;
  const before = mat.map ? mat.map.offset.x : null;
  const near = city.treeChunks[0];
  city.update(0.016, new THREE.Vector3(near.cx, 0, near.cz));
  assert.equal(near.mesh.visible, true);
  city.update(0.016, new THREE.Vector3(near.cx + 5000, 0, near.cz + 5000));
  assert.equal(near.mesh.visible, false);
  city.update(0.016, new THREE.Vector3(near.cx, 0, near.cz));
  assert.equal(near.mesh.visible, true);
  if (before !== null) assert.notEqual(mat.map.offset.x, before);
  city.update(0.016, null);   // must tolerate a missing player
});

test('districts separate downtown, the strip and the neighbourhoods', () => {
  assert.equal(city.districtAt(0, 0), DISTRICT.DOWNTOWN);
  assert.equal(city.districtAt(220, -240), DISTRICT.CAMPUS);
  assert.equal(city.districtAt(-500, -40), DISTRICT.STRIP);
  assert.equal(city.districtAt(-450, 450), DISTRICT.RESIDENTIAL);
});

test('geometry is merged: buildings use a handful of draw calls', () => {
  const buildingMeshes = city.meshes.filter((m) => m.name.startsWith('buildings-'));
  assert.ok(buildingMeshes.length <= 8, `${buildingMeshes.length} building materials`);
  let tris = 0;
  for (const m of buildingMeshes) tris += m.geometry.getIndex().count / 3;
  assert.ok(tris > 210 * 8, 'every footprint got walls');
  for (const m of city.meshes) {
    const g = m.geometry;
    assert.ok(g.getAttribute('position').count > 0, `${m.name} is empty`);
    assert.ok(Number.isFinite(g.boundingSphere.radius), `${m.name} has no bounds`);
  }
});

test('CITY_DEFAULTS keeps the documented contract', () => {
  assert.equal(CITY_DEFAULTS.colliderCell, 32);
  assert.equal(CITY_DEFAULTS.terrainAmplitude, 12);
  for (const fn of ['build', 'getGroundHeight', 'collideCapsule', 'raycastDown',
    'nearestRoadPoint', 'poi', 'update']) {
    assert.equal(typeof City.prototype[fn], 'function', `City#${fn} missing`);
  }
  assert.ok(city.bounds && typeof city.bounds.minX === 'number');
});
