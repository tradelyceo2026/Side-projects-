# X-Men: Mountain Home — build spec (all agents read this first)

An open-world, third-person action game in the browser, in the spirit of LEGO Marvel Super Heroes but with a
traditional 3D "live-action" look (no bricks, no minifigs). Setting: Mountain Home, Arkansas, rebuilt from real
OpenStreetMap data. Playable X-Men: Wolverine, Quicksilver, Jean Grey, Cyclops, Emma Frost. The X-Mansion is the
ASUMH campus (Arkansas State University–Mountain Home). The game opens on the deck of a helicarrier above the
city; the player jumps off and skydives down onto downtown.

## Ground rules for every agent
- **One task, one set of files.** Write ONLY the files assigned to you. Do not edit `docs/SPEC.md`, `src/main.js`,
  `src/core/*`, or another agent's files. If you need something from another module, code against the interface
  below; if the interface is missing something, add a clearly named export on YOUR side and mention it in your
  final report.
- Plain ES modules, no build step, no npm packages. Three.js is vendored: `import * as THREE from '../vendor/three.module.js'`
  (adjust the relative path to your file's depth). No Three addons (no GLTFLoader, no OrbitControls, no postprocessing).
- Everything is procedural: geometry, textures (canvas), sound (Web Audio). No external asset files, no image URLs.
- Performance budget: must run at 60 fps on an integrated GPU. Merge static geometry into few meshes, use
  `InstancedMesh` for repeated things (trees, lamps, cars, enemies), keep draw calls under ~300, keep per-frame
  allocations near zero (reuse Vector3s).
- Units: metres. Y is up. X is east. Z is SOUTH (so north is -Z). Origin (0,0,0) is the Baxter County Courthouse
  square in downtown Mountain Home (approx lat 36.3353, lon -92.3852). 1 unit = 1 metre.
- Every module exports plain functions/classes; no globals except what `src/core/state.js` provides.
- Node-testable logic (pure math, data, state machines) goes in functions that do not touch DOM or THREE at import
  time; add a `test/<yourmodule>.test.js` using `node --test` where reasonable.
- Report at the end: files written, exports, anything you deviated from, and known gaps. Keep the report short.

## Shared core (provided, do not edit)
```js
// src/core/bus.js
export const bus = { on(evt, fn), off(evt, fn), emit(evt, payload) };
// src/core/state.js  — the single game state object
export const state = {
  time: 0, dt: 0,                    // seconds
  phase: 'title',                    // title | intro | skydive | play | paused | dialog | gameover
  activeIndex: 0,                    // index into roster
  roster: ['wolverine','quicksilver','jean','cyclops','emma'],
  player: null,                      // { pos: THREE.Vector3, vel, yaw, hp, maxHp, grounded, character: id }
  camera: null, scene: null, renderer: null,
  city: null,                        // City instance (see city.js)
  enemies: [],                       // Enemy instances
  props: [],                         // physics props (throwable)
  missions: null,                    // MissionManager
  settings: { quality: 'high', mute: false, invertY: false },
  input: { keys: Set, mouse: {dx,dy,buttons}, gamepad: null },
  timeScale: 1,                      // Quicksilver slow-mo sets < 1
  debug: false,
};
```
Events on the bus (emit/subscribe; payloads are plain objects):
- `hit` {targetId, damage, source, pos}  — something took damage
- `enemy_dead` {enemy} · `enemy_spawn` {enemy}
- `ability` {character, name, pos, dir}  — an ability fired (VFX/audio listen)
- `footstep` {pos, speed} · `land` {pos, impact} · `jump` {pos}
- `switch_character` {id}
- `mission_start` {id} · `objective_update` {missionId, objectiveIndex, text, done} · `mission_complete` {id}
- `dialog` {speaker, text, portrait, duration}  — HUD shows it
- `toast` {text}
- `collect` {kind, pos, count, total}
- `phase` {phase}
- `sfx` {name, pos, gain}  — audio module plays a named sound

## Data: `src/data/city.json` (Agent A) — consumed by city.js, hud.js (minimap), missions.js
```json
{
  "origin": {"lat": 36.3353, "lon": -92.3852},
  "bbox": {"minX": -2500, "maxX": 2500, "minZ": -2500, "maxZ": 2500},
  "roads": [ {"id": 1, "name": "US 62", "class": "primary|secondary|tertiary|residential|service", "width": 12, "pts": [[x,z],[x,z],...]} ],
  "buildings": [ {"id": 1, "name": "", "kind": "house|commercial|civic|campus|hospital|church|industrial", "height": 6, "poly": [[x,z],...]} ],
  "water": [ {"name": "", "poly": [[x,z],...]} ],
  "green": [ {"name": "", "kind": "park|forest|grass", "poly": [[x,z],...]} ],
  "pois": [ {"id": "asumh", "name": "ASUMH campus", "kind": "campus", "x": 0, "z": 0, "radius": 200} ]
}
```
Required POIs (ids fixed): `courthouse` (origin), `asumh` (the X-Mansion), `hospital` (Baxter Regional Medical
Center), `walmart`, `high_school` (Mountain Home High School), `lake` (nearest Lake Norfork shore point inside or
at the edge of the bbox, or Dam/Norfork if the lake is out of range), `airport` (Baxter County Airport, if in range),
`downtown` (courthouse square), `park` (a city park, e.g. Cooper Park), `landing_zone` (a clear spot near downtown
where the skydive ends, e.g. a parking lot or the square). Roads must include US-62 (Hwy 62/412), AR-5, AR-201,
and Cardinal Drive if present. Coordinates are metres from origin: x = (lon − lon0)·cos(lat0)·111320,
z = −(lat − lat0)·110540. Simplify polygons (Douglas-Peucker ≈ 1 m). Target file size ≤ 1.5 MB.

## City: `src/world/city.js` (Agent B)
```js
export class City {
  constructor(scene, cityJson, opts = { quality: 'high' })
  build()                                  // adds all meshes to scene; returns this
  getGroundHeight(x, z)                    // number (terrain is gentle; roads/lots are flat at their level)
  collideCapsule(pos, radius, height, out) // resolves the capsule out of buildings: writes corrected position into out (THREE.Vector3), returns true if it collided
  raycastDown(x, y, z)                     // ground/roof height below the point (for landing on roofs)
  nearestRoadPoint(x, z)                   // {x, z, roadId}
  poi(id)                                  // {id, name, x, z, radius}
  bounds                                   // {minX,maxX,minZ,maxZ}
  update(dt, playerPos)                    // optional LOD / streaming
}
```
Look: Ozark small town. Downtown square with brick two-storey buildings, US-62 commercial strip, residential
streets with houses and trees, ASUMH campus with distinct light-stone buildings and lawns, hospital as a big pale
block, green hills (subtle noise heightfield) beyond the streets, lake water if present. Windows via canvas
textures, street lamps and parked cars as instanced meshes. Provide a road-following AABB grid for the collider.

## Characters: `src/entities/characters.js` (Agent C)
```js
export const CHARACTERS = {
  wolverine:  { id, name: 'Wolverine',  color: '#f2c200', hp: 160, speed: 7,  jump: 5.5, abilities: ['claws','regen'],     portrait: dataUrl },
  quicksilver:{ ..., color: '#7fd0ff', hp: 100, speed: 13, jump: 5,   abilities: ['dash','slowmo'] },
  jean:       { ..., color: '#2fa84f', hp: 110, speed: 6.5, jump: 5, abilities: ['telekinesis','hover'] },
  cyclops:    { ..., color: '#c72d2d', hp: 120, speed: 7,  jump: 5,   abilities: ['blast','sweep'] },
  emma:       { ..., color: '#ffffff', hp: 110, speed: 6.5, jump: 5, abilities: ['diamond','psychic'] },
};
export function createCharacterRig(id, opts)  // returns Rig
export function createNpcRig(seedOrSpec)      // civilians / side characters; spec {gender, outfit, skin, hair, hat}
export class Rig {  // a THREE.Group with named parts (head, torso, upperArmL/R, forearmL/R, thighL/R, shinL/R)
  group;            // THREE.Group — add to scene, set position/rotation.y
  setAnim(name, params) // 'idle' | 'walk' | 'run' | 'sprint' | 'jump' | 'fall' | 'land' | 'attack1' | 'attack2' | 'attack3' | 'ability' | 'hurt' | 'dead' | 'skydive'
  update(dt)        // procedural animation
  setColorScheme(scheme)
  dispose()
}
```
Realistic proportions (about 1.8 m tall), costumes: Wolverine yellow/blue with mask and claws (extendable),
Quicksilver silver hair and light blue/white suit, Jean green/gold with red hair, Cyclops blue suit with red visor
that glows, Emma white outfit with a diamond-form material toggle (`rig.setDiamond(true)`). Faces are simple but not
blocky: a smooth head with hair mass. Animations are procedural (sinusoidal limb swings, attack lunges).

## Player: `src/player/controller.js` (Agent D)
```js
export class PlayerController {
  constructor(state, city, rigs /* {id: Rig} */, camera, domElement)
  update(dt)                    // reads state.input; moves state.player; drives the active rig; camera follow
  switchTo(id)                  // swaps rig, emits switch_character
  startSkydive(fromPos)         // phase 'skydive': free-fall with steering, auto-landing → phase 'play'
  teleport(x, z)                // places on the ground at x,z
  get rig()                     // active rig
}
```
Third-person camera: orbit with mouse (pointer lock on click) or right-stick, collision with buildings (pull in),
smooth follow. Movement: WASD relative to camera yaw, Shift sprint, Space jump (double-jump for Jean = hover),
left mouse / J = attack combo, right mouse / K = ability 1, Q = ability 2, Tab / 1-5 = switch character, E =
interact, F = ability 3 if any, Esc = pause. Gamepad supported. Capsule collision via `city.collideCapsule`.
Abilities are invoked through `abilities.js` (`useAbility(state, name, ctx)`) — you only call it.

## Abilities & combat: `src/abilities.js` + `src/combat.js` (Agent E)
```js
// abilities.js
export const ABILITIES = { claws: {name, cooldown, icon, describe}, regen:{}, dash:{}, slowmo:{}, telekinesis:{}, hover:{}, blast:{}, sweep:{}, diamond:{}, psychic:{} };
export function useAbility(state, name, ctx /* {player, rig, camera, city, enemies, props, dir: Vector3} */)  // returns true if it fired
export function updateAbilities(state, dt)   // ongoing effects: beam, TK hold, dash, slow-mo timer, diamond
export function abilityCooldown(name)        // 0..1 remaining fraction for HUD
// combat.js
export function meleeAttack(state, ctx, comboIndex)      // hit test in an arc, emits hit
export function damageEntity(state, target, amount, source)
export class PhysicsProp { constructor(mesh, mass); update(dt, city); throwWith(vel) }  // crates, benches, cars
export function spawnProps(state, city, count)
```
Telekinesis: hold to lift the nearest prop/enemy in front, move it with the camera, release to throw. Optic blast:
hold to fire a red beam from the visor (raycast every frame, damage per second), sweep = wide short burst.
Quicksilver dash: 25 m burst ignoring enemies, slow-mo: `state.timeScale = 0.25` for 3 s. Diamond form: takes no
damage for 6 s, slower; psychic: enemies within 12 m turn on each other for 5 s. Wolverine claws: 3-hit combo with
bleed; regen: heal 40 hp over 4 s.

## Enemies: `src/enemies.js` (Agent F)
```js
export class Enemy { id; kind /* thug | drone | sentinel */; hp; pos; mesh; state /* idle|patrol|chase|attack|stagger|dead|controlled */; update(dt, state); takeDamage(n, source); dispose() }
export class EnemyManager { constructor(scene, city, rigFactory /* createNpcRig */); spawn(kind, x, z, opts); spawnWave(spec); update(dt, state); nearest(pos, maxDist); all(); clear() }
```
Thugs (Brotherhood goons) use NPC rigs with a dark outfit; drones are small flying Sentinel scouts; the Sentinel is
a 12 m mech boss with a chest beam. AI: sense radius, chase with steering around buildings (use
`city.nearestRoadPoint` / simple avoidance), attack with wind-up, stagger on hit, ragdoll-ish fall on death.

## Missions & story: `src/missions.js` + `src/story.js` (Agent G)
```js
export class MissionManager { constructor(state, city, enemies, bus); start(id); update(dt); current(); markers() /* [{x,z,label,kind}] */; completedIds() }
export const STORY = { intro: [...dialog lines], missions: [ { id, title, giver, at: poiId, objectives: [ {type:'goto'|'defeat'|'collect'|'talk'|'protect'|'escort'|'destroy', ...} ] } ], sideCharacters: [ {id, name, role, at, lines, rigSpec} ], collectibles: {kind:'cerebro', count: 25, placement: 'rooftops|pois|roads'} };
```
Story beats (must match): helicarrier intro (Storm/Beast on comms; "Sentinel activity over Baxter County");
M1 "Drop Zone" land downtown, reach the X-Mansion (ASUMH); M2 "Campus Lockdown" defend the campus from a
Brotherhood raid; M3 "Code Blue" clear drones from Baxter Regional Medical Center; M4 "Highway 62" chase along
US-62 to Walmart, Quicksilver required; M5 "Lake Run" retrieve a Cerebro core near the lake, Jean required;
M6 "Square Off" Sentinel boss at the courthouse square. Side characters are locals with real-place jobs (sheriff's
deputy, ASUMH dean, diner cook at the square, high-school coach, a bass fisherman, a hospital nurse) — fictional
names, warm Ozark voice, short lines.

## HUD & UI: `src/ui/hud.js` (Agent H)
```js
export class HUD { constructor(state, bus, cityJson); update(dt); showTitle(onStart); showPause(); hidePause(); dialog(line); toast(text); setObjective(text); setMarkers(list); characterWheel(open) }
```
Pure DOM + one minimap canvas (roads from city.json, player arrow, markers, enemies as red dots). Health bar,
ability icons with cooldown sweep, character portraits row (active highlighted), objective tracker top-left,
dialog box bottom with speaker name and portrait, off-screen objective arrow, title screen, pause menu with
settings (quality, mute, invert Y), controls sheet. Dark cinematic style, not LEGO-like.

## World dressing: `src/world/helicarrier.js`, `src/world/sky.js`, `src/vfx.js` (Agent I)
```js
export function createHelicarrier(scene)  // returns { group, deckY, deckBounds: {minX,maxX,minZ,maxZ}, update(dt) } hovering ~600 m over downtown, rotors spinning
export function createSky(scene, renderer) // returns { sun (DirectionalLight), update(dt, playerPos), setTimeOfDay(h) } — sky gradient dome, clouds, fog, warm Ozark late-afternoon light
export class VFX { constructor(scene); update(dt); clawSlash(pos, dir); speedTrail(pos); opticBeam(from, to, active); tkGlow(target, active); diamondShimmer(rig, active); explosion(pos, size); hitSpark(pos); dust(pos); }
```
VFX listen to `bus` events (`ability`, `hit`, `land`, `enemy_dead`) themselves so other modules need not call them.

## Audio: `src/audio.js` (Agent J)
```js
export class Audio { constructor(state, bus); resume(); play(name, opts); setMusic(mood /* title|explore|combat|boss */); update(dt); mute(bool) }
```
All synthesized with Web Audio: footsteps, jump/land, claw snikt and slashes, dash whoosh, slow-mo filter sweep,
TK hum, optic blast beam, diamond chime, psychic shimmer, hits, explosions, drone buzz, Sentinel stomp, UI clicks,
ambient (wind, birds, distant traffic), and a simple adaptive music loop per mood. Listens to `bus` `sfx`, `ability`,
`hit`, `footstep`, `land`, `jump`, `enemy_dead`, `phase`.

## Integration (coordinator, `src/main.js`)
Boot: renderer → sky → city from json → helicarrier → rigs → player on the deck → HUD title → intro dialog →
player jumps off the deck (or presses E at the edge) → skydive → land → missions start. Game loop: input, player,
abilities, enemies, props, missions, vfx, sky, hud, audio, render.
