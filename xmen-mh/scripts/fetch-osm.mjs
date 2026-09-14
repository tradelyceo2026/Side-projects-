#!/usr/bin/env node
// Fetches OSM data for Mountain Home, AR via the plain OSM API (Overpass is unreachable
// from this machine), tiles the area to stay under API limits, merges nodes/ways by id,
// projects to the game's local metre coordinate system, simplifies polygons, classifies
// roads/buildings/water/green, locates required POIs, and writes:
//   - src/data/city.json  (the data consumed by the game)
//   - src/data/city.js    (ES module wrapper: `export default <json>;`)
// It also (re)writes docs/DATA.md with a summary of what was fetched.
//
// Usage: node scripts/fetch-osm.mjs
//
// Data source: OpenStreetMap, © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const USER_AGENT = 'xmen-mh-dev';
const API_BASE = 'https://api.openstreetmap.org/api/0.6/map';

// Origin: Baxter County Courthouse square, downtown Mountain Home, AR (matches docs/SPEC.md).
const LAT0 = 36.3353;
const LON0 = -92.3852;

// Overall coverage area (~5km x ~6.6km around downtown), extended south to cover the
// ASUMH campus at approx 36.3196, -92.3829 (already inside this range).
const AREA = { minLon: -92.42, maxLon: -92.34, minLat: 36.31, maxLat: 36.37 };
const TILE = 0.012; // degrees per tile edge, keeps each request tiny (well under API limits)

// The playable world box, in metres, derived from AREA's four corners (computed once
// `project` is defined, below).
let PLAY_BOX = null;

// ---------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getAttr(attrStr, name) {
  const m = attrStr.match(new RegExp(name + '="([^"]*)"'));
  return m ? decodeXmlEntities(m[1]) : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------
// OSM XML parsing (no DOMParser in Node) — regex-based, tuned to the flat structure
// the OSM API emits (<osm><node/><way><nd/><tag/></way></osm>, no nesting of node/way).
// ---------------------------------------------------------------------------------

const NODE_RE = /<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
const WAY_RE = /<way\b([^>]*?)(?:\/>|>([\s\S]*?)<\/way>)/g;
const TAG_RE = /<tag\b([^>]*?)\/>/g;
const ND_RE = /<nd\b([^>]*?)\/>/g;

function parseTags(inner) {
  const tags = {};
  if (!inner) return tags;
  TAG_RE.lastIndex = 0;
  let tm;
  while ((tm = TAG_RE.exec(inner))) {
    const k = getAttr(tm[1], 'k');
    const v = getAttr(tm[1], 'v');
    if (k !== undefined) tags[k] = v;
  }
  return tags;
}

function parseOsmXml(xml, allNodes, allWays) {
  NODE_RE.lastIndex = 0;
  let m;
  while ((m = NODE_RE.exec(xml))) {
    const attrs = m[1];
    const inner = m[2];
    const id = getAttr(attrs, 'id');
    const lat = parseFloat(getAttr(attrs, 'lat'));
    const lon = parseFloat(getAttr(attrs, 'lon'));
    if (!id || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    if (allNodes.has(id)) continue; // already have it from another tile
    allNodes.set(id, { id, lat, lon, tags: parseTags(inner) });
  }

  WAY_RE.lastIndex = 0;
  while ((m = WAY_RE.exec(xml))) {
    const attrs = m[1];
    const inner = m[2] || '';
    const id = getAttr(attrs, 'id');
    if (!id) continue;
    if (allWays.has(id)) continue;
    const nodeRefs = [];
    ND_RE.lastIndex = 0;
    let nm;
    while ((nm = ND_RE.exec(inner))) {
      const ref = getAttr(nm[1], 'ref');
      if (ref) nodeRefs.push(ref);
    }
    allWays.set(id, { id, nodeRefs, tags: parseTags(inner) });
  }
}

// ---------------------------------------------------------------------------------
// Fetching, tiled
// ---------------------------------------------------------------------------------

function buildTiles(area, step) {
  const tiles = [];
  for (let lon = area.minLon; lon < area.maxLon - 1e-9; lon += step) {
    const lon2 = Math.min(lon + step, area.maxLon);
    for (let lat = area.minLat; lat < area.maxLat - 1e-9; lat += step) {
      const lat2 = Math.min(lat + step, area.maxLat);
      tiles.push({ minLon: lon, minLat: lat, maxLon: lon2, maxLat: lat2 });
    }
  }
  return tiles;
}

async function fetchTile(tile, attempt = 1) {
  const bbox = `${tile.minLon.toFixed(6)},${tile.minLat.toFixed(6)},${tile.maxLon.toFixed(6)},${tile.maxLat.toFixed(6)}`;
  const url = `${API_BASE}?bbox=${bbox}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' } });
  if (!res.ok) {
    if ((res.status === 429 || res.status === 509 || res.status === 504 || res.status >= 500) && attempt < 5) {
      const backoff = 800 * attempt;
      console.error(`  tile ${bbox} -> HTTP ${res.status}, retrying in ${backoff}ms (attempt ${attempt})`);
      await sleep(backoff);
      return fetchTile(tile, attempt + 1);
    }
    throw new Error(`OSM API request failed (${res.status}) for bbox ${bbox}`);
  }
  return res.text();
}

async function fetchAll() {
  const tiles = buildTiles(AREA, TILE);
  const allNodes = new Map();
  const allWays = new Map();
  console.error(`Fetching ${tiles.length} tiles covering lon [${AREA.minLon}, ${AREA.maxLon}] lat [${AREA.minLat}, ${AREA.maxLat}]...`);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const xml = await fetchTile(t);
    parseOsmXml(xml, allNodes, allWays);
    console.error(`  [${i + 1}/${tiles.length}] nodes=${allNodes.size} ways=${allWays.size}`);
    await sleep(250); // be polite
  }
  return { allNodes, allWays };
}

// ---------------------------------------------------------------------------------
// Projection & geometry
// ---------------------------------------------------------------------------------

function project(lat, lon) {
  const x = (lon - LON0) * Math.cos((LAT0 * Math.PI) / 180) * 111320;
  const z = -(lat - LAT0) * 110540;
  return [x, z];
}

function computePlayBox(area) {
  const corners = [
    [area.minLat, area.minLon],
    [area.minLat, area.maxLon],
    [area.maxLat, area.minLon],
    [area.maxLat, area.maxLon],
  ];
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [lat, lon] of corners) {
    const [x, z] = project(lat, lon);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function wayCoords(way, allNodes) {
  const pts = [];
  for (const ref of way.nodeRefs) {
    const n = allNodes.get(ref);
    if (!n) continue;
    pts.push(project(n.lat, n.lon));
  }
  return pts;
}

function isClosed(way) {
  return way.nodeRefs.length >= 4 && way.nodeRefs[0] === way.nodeRefs[way.nodeRefs.length - 1];
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

function centroid(pts) {
  let x = 0,
    z = 0;
  for (const p of pts) {
    x += p[0];
    z += p[1];
  }
  return [x / pts.length, z / pts.length];
}

// Douglas-Peucker line/polygon simplification, epsilon in metres.
function perpendicularDistance(pt, a, b) {
  const [x, y] = pt;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(x - x1, y - y1);
  let t = ((x - x1) * dx + (y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return Math.hypot(x - px, y - py);
}

function douglasPeucker(points, epsilon) {
  if (points.length < 3) return points.slice();
  let maxDist = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

function simplifyPolygon(poly, epsilon) {
  if (poly.length < 4) return poly.map(([x, z]) => [round1(x), round1(z)]);
  // Closed polygon: simplify as a path from first to last (they're equal), then re-close.
  const simplified = douglasPeucker(poly, epsilon);
  if (simplified.length < 3) return poly.map(([x, z]) => [round1(x), round1(z)]);
  return simplified.map(([x, z]) => [round1(x), round1(z)]);
}

function simplifyLine(pts, epsilon) {
  const simplified = pts.length >= 3 ? douglasPeucker(pts, epsilon) : pts;
  return simplified.map(([x, z]) => [round1(x), round1(z)]);
}

function dist(x1, z1, x2, z2) {
  return Math.hypot(x2 - x1, z2 - z1);
}

// The OSM API returns *complete* ways (all their nodes) even when a way only partially
// enters the requested tiles — a long highway can carry nodes many km outside our small
// play area. Clip such lines to the play-area box before simplifying, so nothing renders
// (or fails the "coordinates lie in bbox" check) far outside the map.
function clampToBox(pt, box) {
  return [Math.max(box.minX, Math.min(box.maxX, pt[0])), Math.max(box.minZ, Math.min(box.maxZ, pt[1]))];
}

function isInsideBox(pt, box) {
  return pt[0] >= box.minX && pt[0] <= box.maxX && pt[1] >= box.minZ && pt[1] <= box.maxZ;
}

function clipLineToBox(pts, box) {
  const inside = pts.map((p) => isInsideBox(p, box));
  if (!inside.some(Boolean)) return null; // entirely outside the play area
  // find contiguous runs of inside points, keep the longest
  let runs = [];
  let start = -1;
  for (let i = 0; i < pts.length; i++) {
    if (inside[i] && start === -1) start = i;
    if (!inside[i] && start !== -1) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, pts.length - 1]);
  runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  const [s, e] = runs[0];
  const out = [];
  if (s > 0) out.push(clampToBox(pts[s - 1], box)); // clamped entry point for continuity
  for (let i = s; i <= e; i++) out.push(pts[i]);
  if (e < pts.length - 1) out.push(clampToBox(pts[e + 1], box)); // clamped exit point
  return out;
}

// ---------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------

const ROAD_CLASS_BY_HIGHWAY = {
  motorway: 'primary',
  motorway_link: 'primary',
  trunk: 'primary',
  trunk_link: 'primary',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'residential',
  unclassified: 'residential',
  living_street: 'residential',
  service: 'service',
};

const ROAD_WIDTH_BY_CLASS = { primary: 14, secondary: 12, tertiary: 10, residential: 8, service: 6 };

function classifyRoad(tags) {
  const hw = tags.highway;
  if (!hw) return null;
  const cls = ROAD_CLASS_BY_HIGHWAY[hw];
  if (!cls) return null; // drop footway/path/cycleway/track/steps/pedestrian/etc.
  return cls;
}

function buildingKind(tags) {
  const name = (tags.name || '').toLowerCase();
  if (tags.amenity === 'hospital' || /hospital|medical center|medical centre/.test(name)) return 'hospital';
  if (
    tags.amenity === 'university' ||
    tags.amenity === 'college' ||
    /\basu\b|arkansas state|asumh/.test(name)
  )
    return 'campus';
  if (tags.amenity === 'place_of_worship') return 'church';
  if (tags.building === 'industrial' || tags.building === 'warehouse' || tags.landuse === 'industrial') return 'industrial';
  if (
    ['townhall', 'courthouse', 'school', 'library', 'public', 'community_centre', 'fire_station', 'police'].includes(
      tags.amenity
    ) ||
    tags.building === 'public' ||
    tags.building === 'civic' ||
    tags.office === 'government'
  )
    return 'civic';
  if (tags.shop || ['commercial', 'retail'].includes(tags.building)) return 'commercial';
  return 'house';
}

const HEIGHT_BY_KIND = { house: 5, commercial: 6, civic: 9, campus: 8, hospital: 14, church: 10, industrial: 7 };

function buildingHeight(tags, kind) {
  const levels = parseFloat(tags['building:levels']);
  if (!Number.isNaN(levels) && levels > 0) return round1(levels * 3.2);
  const h = parseFloat(tags.height);
  if (!Number.isNaN(h) && h > 0) return round1(h);
  return HEIGHT_BY_KIND[kind] || 6;
}

function greenKind(tags) {
  if (tags.leisure === 'park') return 'park';
  if (tags.landuse === 'forest' || tags.natural === 'wood') return 'forest';
  return 'grass'; // grass, cemetery, meadow, etc.
}

// ---------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------

async function main() {
  const { allNodes, allWays } = await fetchAll();

  PLAY_BOX = computePlayBox(AREA);
  // Small safety margin: polygons (buildings/water/green) are compact real-world
  // features, so any one landing outside this padded box is almost certainly a
  // tagging oddity, not something we want to render.
  const PAD = 200;
  const PADDED_BOX = {
    minX: PLAY_BOX.minX - PAD,
    maxX: PLAY_BOX.maxX + PAD,
    minZ: PLAY_BOX.minZ - PAD,
    maxZ: PLAY_BOX.maxZ + PAD,
  };

  const roads = [];
  const buildings = [];
  const water = [];
  const green = [];

  // Track the actual extent of everything we keep, so the final bbox can be widened
  // to fully contain it (a building near a play-area corner can poke a few metres past
  // the raw corner-projected box; roads are already clipped to PLAY_BOX above).
  let minX = PLAY_BOX.minX,
    maxX = PLAY_BOX.maxX,
    minZ = PLAY_BOX.minZ,
    maxZ = PLAY_BOX.maxZ;
  function track(pts) {
    for (const [x, z] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }

  let roadId = 1;
  let buildingId = 1;

  // Candidate POI sources, gathered while walking nodes/ways.
  const poiCandidates = []; // {source:'node'|'way', tags, x, z, area?}

  for (const node of allNodes.values()) {
    if (Object.keys(node.tags).length === 0) continue;
    const [x, z] = project(node.lat, node.lon);
    poiCandidates.push({ source: 'node', tags: node.tags, x, z });
  }

  for (const way of allWays.values()) {
    const tags = way.tags;
    if (Object.keys(tags).length === 0) continue;
    const rawPts = wayCoords(way, allNodes);
    if (rawPts.length < 2) continue;
    const closed = isClosed(way);

    // Roads — clip to the play area first: the OSM API returns whole ways even when
    // only part of a long road passes through our tiles.
    const roadClass = classifyRoad(tags);
    if (roadClass && !closed) {
      const clipped = clipLineToBox(rawPts, PLAY_BOX);
      if (clipped && clipped.length >= 2) {
        const pts = simplifyLine(clipped, 1.0);
        track(pts);
        roads.push({
          id: roadId++,
          name: tags.name || tags.ref || '',
          ref: tags.ref || undefined,
          class: roadClass,
          width: ROAD_WIDTH_BY_CLASS[roadClass],
          pts,
        });
      }
    }

    // Buildings (closed ways only)
    if (closed && tags.building && tags.building !== 'no') {
      const [ccx, ccz] = centroid(rawPts);
      if (isInsideBox([ccx, ccz], PADDED_BOX)) {
        const poly = simplifyPolygon(rawPts, 1.0);
        const area = polygonArea(poly);
        if (area >= 15) {
          const kind = buildingKind(tags);
          track(poly);
          buildings.push({
            id: buildingId++,
            name: tags.name || '',
            kind,
            height: buildingHeight(tags, kind),
            poly,
          });
        }
      }
    }

    // Water
    if (closed && (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.landuse === 'reservoir')) {
      const [wcx, wcz] = centroid(rawPts);
      if (isInsideBox([wcx, wcz], PADDED_BOX)) {
        const poly = simplifyPolygon(rawPts, 1.0);
        if (polygonArea(poly) >= 15) {
          track(poly);
          water.push({ name: tags.name || '', poly });
        }
      }
    }

    // Green
    if (
      closed &&
      (tags.leisure === 'park' ||
        tags.landuse === 'grass' ||
        tags.landuse === 'forest' ||
        tags.landuse === 'cemetery' ||
        tags.natural === 'wood')
    ) {
      const [gcx, gcz] = centroid(rawPts);
      if (isInsideBox([gcx, gcz], PADDED_BOX)) {
        const poly = simplifyPolygon(rawPts, 1.0);
        if (polygonArea(poly) >= 15) {
          track(poly);
          green.push({ name: tags.name || '', kind: greenKind(tags), poly });
        }
      }
    }

    // POI candidate: use centroid of the way
    if (rawPts.length >= 1) {
      const [cx, cz] = centroid(rawPts);
      poiCandidates.push({ source: 'way', tags, x: cx, z: cz, area: closed ? polygonArea(rawPts) : 0 });
    }
  }

  // -------------------------------------------------------------------------
  // POIs
  // -------------------------------------------------------------------------

  // Named-feature search. Excludes plain roads by default (a street can be named after
  // the business it runs past — e.g. "North Walmart Drive" — which is not the business
  // itself); pass `requireAnyTag` to further restrict to features carrying one of those
  // tag keys (e.g. ['shop'] so only an actual shop=* feature named "Walmart" matches,
  // not an incidentally-named road or parking aisle).
  function findByName(re, opts = {}) {
    let matches = poiCandidates.filter((c) => c.tags.name && re.test(c.tags.name));
    if (!opts.allowRoads) matches = matches.filter((c) => !c.tags.highway);
    if (opts.requireAnyTag) matches = matches.filter((c) => opts.requireAnyTag.some((k) => c.tags[k] !== undefined));
    if (opts.preferTag) matches.sort((a, b) => (b.tags[opts.preferTag] ? 1 : 0) - (a.tags[opts.preferTag] ? 1 : 0));
    // Prefer an actual closed building/area (has meaningful `area`) over a bare POI node,
    // when both exist, since a building centroid is a better in-game marker position.
    matches.sort((a, b) => (b.area || 0) - (a.area || 0));
    return matches[0];
  }

  const pois = [];
  const notes = [];

  function addPoi(id, name, kind, x, z, radius, sourceNote) {
    pois.push({ id, name, kind, x: round1(x), z: round1(z), radius });
    if (sourceNote) notes.push(`- **${id}** (${name}): ${sourceNote}`);
  }

  // courthouse / downtown -> origin, by definition (spec: courthouse square is (0,0,0))
  const courthouseMatch =
    findByName(/baxter county courthouse/i) || poiCandidates.find((c) => c.tags.amenity === 'courthouse');
  addPoi(
    'courthouse',
    'Baxter County Courthouse',
    'civic',
    0,
    0,
    60,
    courthouseMatch
      ? `matched OSM feature "${courthouseMatch.tags.name || courthouseMatch.tags.amenity}" near (${round1(
          courthouseMatch.x
        )}, ${round1(courthouseMatch.z)}); pinned to origin (0,0) per spec (courthouse square defines the origin).`
      : `not found in fetched OSM data; placed at the origin (0,0) per spec — the courthouse square defines the origin at lat ${LAT0}, lon ${LON0}.`
  );
  addPoi('downtown', 'Downtown Mountain Home', 'civic', 0, 0, 150, 'courthouse square, same as `courthouse`, per spec.');

  // asumh
  const asumhMatch =
    findByName(/arkansas state university.*mountain home|asu[- ]?mh/i) ||
    poiCandidates.find(
      (c) => (c.tags.amenity === 'university' || c.tags.amenity === 'college') && c.area && c.area > 500
    );
  if (asumhMatch) {
    addPoi(
      'asumh',
      'ASUMH Campus',
      'campus',
      asumhMatch.x,
      asumhMatch.z,
      250,
      `matched OSM feature "${asumhMatch.tags.name || asumhMatch.tags.amenity}" at (${round1(asumhMatch.x)}, ${round1(
        asumhMatch.z
      )}).`
    );
  } else {
    // No amenity=university/college feature is tagged in the fetched OSM data (the
    // campus buildings appear untagged beyond plain `building=yes`). Verified via
    // Nominatim address geocoding of "1600 South College Street, Mountain Home, AR"
    // (the ASUMH campus address) -> lat 36.3196, lon -92.3829.
    const [x, z] = project(36.3196, -92.3829);
    addPoi(
      'asumh',
      'ASUMH Campus',
      'campus',
      x,
      z,
      250,
      'not found by name/amenity in fetched OSM data (campus buildings are tagged only building=yes, no university/college amenity or name); placed via Nominatim address geocoding of "1600 South College Street, Mountain Home, AR" (lat 36.3196, lon -92.3829).'
    );
  }

  // hospital
  const hospitalMatch =
    findByName(/baxter regional/i) || poiCandidates.find((c) => c.tags.amenity === 'hospital');
  if (hospitalMatch) {
    addPoi(
      'hospital',
      'Baxter Regional Medical Center',
      'hospital',
      hospitalMatch.x,
      hospitalMatch.z,
      150,
      `matched OSM feature "${hospitalMatch.tags.name || hospitalMatch.tags.amenity}" at (${round1(
        hospitalMatch.x
      )}, ${round1(hospitalMatch.z)}).`
    );
  } else {
    const [x, z] = project(36.3454, -92.3714); // documented approx location, 624 Hospital Dr
    addPoi(
      'hospital',
      'Baxter Regional Medical Center',
      'hospital',
      x,
      z,
      150,
      'not found in fetched OSM data; placed at the documented approximate address (624 Hospital Dr, lat 36.3454, lon -92.3714).'
    );
  }

  // walmart
  const walmartMatch = findByName(/walmart/i);
  if (walmartMatch) {
    addPoi(
      'walmart',
      'Walmart Supercenter',
      'commercial',
      walmartMatch.x,
      walmartMatch.z,
      120,
      `matched OSM feature "${walmartMatch.tags.name}" at (${round1(walmartMatch.x)}, ${round1(walmartMatch.z)}).`
    );
  } else {
    const [x, z] = project(36.3499, -92.3778); // documented approx location, 1315 Hwy 62 E
    addPoi(
      'walmart',
      'Walmart Supercenter',
      'commercial',
      x,
      z,
      120,
      'not found in fetched OSM data; placed at the documented approximate address (1315 US-62 E, lat 36.3499, lon -92.3778).'
    );
  }

  // high_school
  const schoolMatch = findByName(/mountain home high school/i);
  if (schoolMatch) {
    addPoi(
      'high_school',
      'Mountain Home High School',
      'civic',
      schoolMatch.x,
      schoolMatch.z,
      150,
      `matched OSM feature "${schoolMatch.tags.name}" at (${round1(schoolMatch.x)}, ${round1(schoolMatch.z)}).`
    );
  } else {
    const [x, z] = project(36.3465, -92.3823); // documented approx location, 1000 S Bomber Blvd
    addPoi(
      'high_school',
      'Mountain Home High School',
      'civic',
      x,
      z,
      150,
      'not found in fetched OSM data; placed at the documented approximate address (1000 S Bomber Blvd, lat 36.3465, lon -92.3823).'
    );
  }

  // park (Cooper Park)
  const parkMatch = findByName(/cooper park/i);
  if (parkMatch) {
    addPoi(
      'park',
      'Cooper Park',
      'park',
      parkMatch.x,
      parkMatch.z,
      100,
      `matched OSM feature "${parkMatch.tags.name}" at (${round1(parkMatch.x)}, ${round1(parkMatch.z)}).`
    );
  } else {
    const anyPark = green.find((g) => g.kind === 'park');
    if (anyPark) {
      const [cx, cz] = centroid(anyPark.poly);
      addPoi('park', anyPark.name || 'City Park', 'park', cx, cz, 100, `Cooper Park not found by name; used nearest park polygon "${anyPark.name || '(unnamed)'}" at (${round1(cx)}, ${round1(cz)}) instead.`);
    } else {
      addPoi('park', 'Cooper Park', 'park', -300, -150, 100, 'Cooper Park not found in fetched OSM data and no park polygon available; placed near downtown at a documented approximate location.');
    }
  }

  // airport (Baxter County Airport / M17)
  const airportMatch = findByName(/baxter county airport/i) || poiCandidates.find((c) => c.tags.aeroway === 'aerodrome');
  if (airportMatch && dist(airportMatch.x, airportMatch.z, 0, 0) < 4000) {
    addPoi(
      'airport',
      'Baxter County Airport',
      'civic',
      airportMatch.x,
      airportMatch.z,
      300,
      `matched OSM feature "${airportMatch.tags.name || 'aerodrome'}" at (${round1(airportMatch.x)}, ${round1(
        airportMatch.z
      )}).`
    );
  } else {
    // Baxter County Airport (M17) is well NW of downtown, verified via Nominatim
    // (lat 36.3691443, lon -92.4693810) — several km outside our fetch bbox, so it is
    // placed via that geocoded coordinate, not fetched geometry, and then clamped into
    // the world bbox below (with the rest of the POI-clamping pass) so its marker sits
    // at the correct edge of the playable map.
    const [x, z] = project(36.3691443, -92.469381);
    addPoi(
      'airport',
      'Baxter County Airport',
      'civic',
      x,
      z,
      300,
      'not found in fetched OSM data (it lies several km NW of our bbox); placed via Nominatim geocoding (lat 36.3691443, lon -92.469381, M17) and clamped to the map edge in that direction.'
    );
  }

  // lake (Norfork Lake) — verified via Nominatim (relation 8452802): the lake's bounding
  // box is huge, but its shoreline near Mountain Home is roughly 10+ km away (nearest
  // lakeside community is Gamaliel, AR, lat 36.4567317, lon -92.2332128, well NE of
  // downtown); nothing in our fetch bbox is tagged as part of it, confirmed below.
  const lakeMatch = findByName(/norfork lake|lake norfork/i) || water.find((w) => /norfork/i.test(w.name || ''));
  const bigWaterInBox = water
    .map((w) => ({ w, area: polygonArea(w.poly), c: centroid(w.poly) }))
    .filter((e) => e.area > 3000) // a real pond/reservoir, not a stray sliver
    .sort((a, b) => dist(a.c[0], a.c[1], 0, 0) - dist(b.c[0], b.c[1], 0, 0))[0];
  if (lakeMatch && lakeMatch.x !== undefined) {
    addPoi('lake', 'Norfork Lake', 'water', lakeMatch.x, lakeMatch.z, 200, `matched OSM feature "${lakeMatch.tags.name}".`);
  } else if (bigWaterInBox) {
    const [cx, cz] = bigWaterInBox.c;
    addPoi(
      'lake',
      bigWaterInBox.w.name || 'Pond',
      'water',
      cx,
      cz,
      150,
      `Norfork Lake itself is not in the fetched OSM data (its nearest shoreline near Mountain Home is ~10+ km away, near Gamaliel, AR); used the nearest sizeable fetched water feature "${bigWaterInBox.w.name || '(unnamed)'}" (~${Math.round(bigWaterInBox.area)} m²) instead.`
    );
  } else {
    // Per spec fallback ("Dam/Norfork if the lake is out of range"): document the real
    // nearest-lake coordinate (Gamaliel, a Norfork Lake community) and clamp its in-game
    // marker to the map edge in the correct compass direction (NE) so the minimap arrow
    // still points the right way.
    const realLat = 36.4567317,
      realLon = -92.2332128; // Gamaliel, AR — a Norfork Lake shoreline community NE of Mountain Home
    const [rx, rz] = project(realLat, realLon);
    const edgeX = Math.max(-2400, Math.min(2400, rx));
    const edgeZ = Math.max(-2400, Math.min(2400, rz));
    addPoi(
      'lake',
      'Norfork Lake (off-map)',
      'water',
      edgeX,
      edgeZ,
      200,
      `Norfork Lake is ~8 km from downtown, well outside the fetched bbox and not present in the data. Real-world nearest shoreline approx lat ${realLat}, lon ${realLon}; the POI marker is clamped to the edge of the playable map in that direction as documented fallback.`
    );
  }

  // landing_zone: prefer a real parking lot near downtown, else the courthouse square itself.
  const parkingCandidates = poiCandidates.filter((c) => c.tags.amenity === 'parking' && dist(c.x, c.z, 0, 0) < 300);
  if (parkingCandidates.length > 0) {
    parkingCandidates.sort((a, b) => dist(a.x, a.z, 0, 0) - dist(b.x, b.z, 0, 0));
    const lz = parkingCandidates[0];
    addPoi(
      'landing_zone',
      'Courthouse Square Parking',
      'civic',
      lz.x,
      lz.z,
      50,
      `matched a real parking lot near downtown at (${round1(lz.x)}, ${round1(lz.z)}).`
    );
  } else {
    addPoi('landing_zone', 'Courthouse Square', 'civic', 0, 30, 50, 'no nearby parking lot found in fetched OSM data; placed at the courthouse square itself (just north of the origin), per spec fallback.');
  }

  // Clamp every POI into the final world bbox: some real-world features (e.g. the
  // airport, near the southern fetch edge) sit just outside it, and the fully
  // out-of-range fallbacks (e.g. Norfork Lake) were only roughly clamped above.
  for (const p of pois) {
    const cx = Math.max(minX, Math.min(maxX, p.x));
    const cz = Math.max(minZ, Math.min(maxZ, p.z));
    if (cx !== p.x || cz !== p.z) {
      notes.push(`- **${p.id}**: clamped from real-world position (${p.x}, ${p.z}) to (${round1(cx)}, ${round1(cz)}) to stay within the world bbox.`);
      p.x = round1(cx);
      p.z = round1(cz);
    }
  }

  // -------------------------------------------------------------------------
  // Size guard: if too big, progressively trim per spec instructions.
  // -------------------------------------------------------------------------

  function estimateSize(obj) {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
  }

  function buildJson(roadsIn, buildingsIn) {
    return {
      origin: { lat: LAT0, lon: LON0 },
      bbox: {
        minX: Math.floor(minX / 10) * 10,
        maxX: Math.ceil(maxX / 10) * 10,
        minZ: Math.floor(minZ / 10) * 10,
        maxZ: Math.ceil(maxZ / 10) * 10,
      },
      roads: roadsIn,
      buildings: buildingsIn,
      water,
      green,
      pois,
    };
  }

  let finalRoads = roads;
  let finalBuildings = buildings;
  let cityJson = buildJson(finalRoads, finalBuildings);
  let size = estimateSize(cityJson);
  const LIMIT = 1.5 * 1024 * 1024;
  const trims = [];

  if (size > LIMIT) {
    finalRoads = roads.filter((r) => r.class !== 'service' || Math.min(...r.pts.map((p) => dist(p[0], p[1], 0, 0))) < 2000);
    cityJson = buildJson(finalRoads, finalBuildings);
    size = estimateSize(cityJson);
    trims.push(`Dropped service roads with all points beyond 2000 m from origin (${roads.length - finalRoads.length} removed).`);
  }
  if (size > LIMIT) {
    finalBuildings = finalBuildings.filter((b) => {
      if (b.kind !== 'house') return true;
      const [cx, cz] = centroid(b.poly);
      return dist(cx, cz, 0, 0) < 2500;
    });
    cityJson = buildJson(finalRoads, finalBuildings);
    size = estimateSize(cityJson);
    trims.push(`Dropped residential (house) buildings beyond 2500 m from origin (${buildings.length - finalBuildings.length} removed).`);
  }

  // -------------------------------------------------------------------------
  // Write outputs
  // -------------------------------------------------------------------------

  const jsonPath = path.join(ROOT, 'src/data/city.json');
  const jsonText = JSON.stringify(cityJson);
  writeFileSync(jsonPath, jsonText);

  const jsPath = path.join(ROOT, 'src/data/city.js');
  const jsText = `// Auto-generated by scripts/fetch-osm.mjs from OpenStreetMap data.\n// Data © OpenStreetMap contributors, ODbL 1.0. See docs/DATA.md for details.\n// Do not hand-edit — re-run the fetch script instead.\nexport default ${jsonText};\n`;
  writeFileSync(jsPath, jsText);

  const finalSize = Buffer.byteLength(jsonText, 'utf8');
  console.error(`\nWrote ${jsonPath} (${(finalSize / 1024).toFixed(1)} KB)`);
  console.error(`Wrote ${jsPath}`);
  console.error(`roads=${finalRoads.length} buildings=${finalBuildings.length} water=${water.length} green=${green.length} pois=${pois.length}`);

  writeDataDoc({ cityJson, finalSize, trims, notes, tileCount: buildTiles(AREA, TILE).length });
}

function writeDataDoc({ cityJson, finalSize, trims, notes, tileCount }) {
  const poiLines = cityJson.pois
    .map((p) => `| \`${p.id}\` | ${p.name} | ${p.x.toFixed(1)} | ${p.z.toFixed(1)} | ${p.radius} |`)
    .join('\n');

  const roadClassCounts = {};
  for (const r of cityJson.roads) roadClassCounts[r.class] = (roadClassCounts[r.class] || 0) + 1;
  const buildingKindCounts = {};
  for (const b of cityJson.buildings) buildingKindCounts[b.kind] = (buildingKindCounts[b.kind] || 0) + 1;

  const md = `# City data: Mountain Home, Arkansas

Generated by \`scripts/fetch-osm.mjs\` from live OpenStreetMap data via the plain OSM API
(\`https://api.openstreetmap.org/api/0.6/map\`), tiled into ${tileCount} requests of
${TILE}° x ${TILE}° each (Overpass is not reachable from the build machine). Coordinates
are metres from the origin using the spec's projection:

\`\`\`
x = (lon - lon0) * cos(lat0) * 111320
z = -(lat - lat0) * 110540
\`\`\`

## Origin

- lat0 = ${LAT0}, lon0 = ${LON0} (Baxter County Courthouse square, downtown Mountain Home)
- This is world position (0, 0, 0) per \`docs/SPEC.md\`.

## Fetch bounding box

- lon: [${AREA.minLon}, ${AREA.maxLon}]
- lat: [${AREA.minLat}, ${AREA.maxLat}]
- This covers a roughly 5-7 km square around downtown, including the ASUMH campus
  (verified via Nominatim address geocoding at lat 36.3196, lon -92.3829) in the south
  of the box.

## World bbox (\`city.json.bbox\`)

- minX=${cityJson.bbox.minX} maxX=${cityJson.bbox.maxX} minZ=${cityJson.bbox.minZ} maxZ=${cityJson.bbox.maxZ} (metres)
- Computed by projecting the four corners of the fetch bounding box, not a fixed ±2500
  box — it is asymmetric because the fetch lon/lat box is asymmetric around the origin.
  Roads that OSM returns as complete ways extending beyond this box (a long highway,
  for instance) are clipped to it before simplification, so every road/building/water/
  green coordinate in this file lies within (or exactly on) this bbox.

## Counts

- roads: ${cityJson.roads.length} (${Object.entries(roadClassCounts).map(([k, v]) => `${k}=${v}`).join(', ')})
- buildings: ${cityJson.buildings.length} (${Object.entries(buildingKindCounts).map(([k, v]) => `${k}=${v}`).join(', ')})
- water polygons: ${cityJson.water.length}
- green polygons: ${cityJson.green.length}
- POIs: ${cityJson.pois.length}
- final \`city.json\` size: ${(finalSize / 1024).toFixed(1)} KB (limit 1536 KB)

${trims.length ? `## Size trimming applied\n\n${trims.map((t) => `- ${t}`).join('\n')}\n` : '## Size trimming\n\nNot needed — file came in under the 1.5 MB target without trimming.\n'}

## Required POIs

| id | name | x | z | radius |
| --- | --- | ---: | ---: | ---: |
${poiLines}

### Notes on POI sourcing

${notes.length ? notes.join('\n') : '(all POIs matched directly from fetched OSM data)'}

## Roads required by spec

The spec requires US-62 (Hwy 62/412), AR-5, AR-201, and Cardinal Drive if present. These are
matched by \`name\`/\`ref\` tags in the source OSM data (e.g. \`ref=US 62\`, \`ref=AR 5\`) — see
\`test/city-data.test.js\` for the exact matching used to verify their presence.

## Attribution

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0.
See https://www.openstreetmap.org/copyright. This project uses OSM data to derive simplified,
non-map game geometry (roads/buildings/water/green polygons and points of interest); no OSM
map tiles or renders are shipped.

## Regenerating

\`\`\`
node scripts/fetch-osm.mjs
\`\`\`

Requires network access to \`api.openstreetmap.org\`. Takes roughly ${tileCount * 0.3 | 0}-${
    tileCount * 1
  }s depending on API latency (one request per tile, ~250ms apart to be polite).
`;

  writeFileSync(path.join(ROOT, 'docs/DATA.md'), md);
  console.error(`Wrote ${path.join(ROOT, 'docs/DATA.md')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
