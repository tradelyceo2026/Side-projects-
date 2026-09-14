# X-Men: Mountain Home

An open-world, third-person X-Men action game set in Mountain Home, Arkansas, in the spirit of
LEGO Marvel Super Heroes but with a traditional 3D look. It runs in the browser from one HTML file.

- **Play:** open `dist/xmen-mh.html` in Chrome or Edge on a machine with a GPU. No install.
- **The city is real.** Streets, buildings, parks and water come from OpenStreetMap data for Mountain Home
  (2,004 road segments, 1,720 building footprints), rebuilt procedurally in Three.js. US-62, AR-5, AR-201 and
  Cardinal Drive are where they are in town. The Baxter County Courthouse square is the origin, Baxter Regional
  Medical Center, Walmart, Mountain Home High School and Cooper Park are at their real coordinates, and the
  X-Mansion is the ASUMH campus on South College Street.
- **You start on a helicarrier** 600 m above downtown, walk to the bow, and jump. Steer the skydive with WASD
  and land on the courthouse square.
- **Five playable X-Men**, switchable at any time with Tab or 1–5: Wolverine (claws, regeneration), Quicksilver
  (dash, slow-motion), Jean Grey (telekinesis, hover), Cyclops (optic blast, sweep), Emma Frost (diamond form,
  psychic control).
- **Six story missions** from the drop zone to a Sentinel boss fight on the square, six side characters with their
  own small missions, 25 Cerebro cores to collect, Brotherhood thugs, Sentinel drones, and a 12 m Sentinel.

## Controls

| Key | Action |
|---|---|
| WASD · Shift · Space | Move · sprint · jump (Jean: double-tap to hover, Wolverine: mantle ledges) |
| Mouse · wheel | Camera (click for pointer lock) · distance |
| LMB / J | Three-hit melee combo |
| RMB / K · Q · F | Ability 1 · 2 · 3 |
| Tab · 1–5 | Switch character |
| E | Talk, collect, jump off the deck, advance dialog |
| Esc | Pause |
| Gamepad | Left stick move, right stick camera, A jump, X attack, B/Y abilities, RB switch |

## How it was built

Ten single-task agents worked in parallel against `docs/SPEC.md`, each owning one module, while the coordinator
wrote the spec, `src/main.js`, the bundler and the browser test harness, then integrated and fixed the seams.
A separate QA agent play-tested the result and wrote `docs/QA-REPORT.md`.

| Module | Agent task |
|---|---|
| `scripts/fetch-osm.mjs`, `src/data/city.json` | Fetch and project OpenStreetMap data for Mountain Home; find the required points of interest |
| `src/world/city.js` | Terrain, roads, extruded buildings with canvas facades, trees, lamps, cars, collision grid |
| `src/entities/characters.js` | Procedural humanoid rigs, costumes, 16 procedural animations, NPC generator |
| `src/player/controller.js` | Third-person controller, camera, input (keyboard, mouse, gamepad), skydive |
| `src/abilities.js`, `src/combat.js` | Ten abilities, melee, damage model, throwable physics props |
| `src/enemies.js` | Thugs, drones, Sentinel boss, AI state machine, waves |
| `src/missions.js`, `src/story.js` | Mission system, story script, side characters, collectible placement |
| `src/ui/hud.js` | HUD, minimap from the road data, dialog, title, pause, character wheel |
| `src/world/helicarrier.js`, `src/world/sky.js`, `src/vfx.js` | Helicarrier, sky and lighting, pooled particle effects |
| `src/audio.js` | Every sound and the adaptive music, synthesized with Web Audio |

Everything is procedural: no model files, no textures, no audio files. Three.js 0.160 is vendored.

## Verified

- `npm test`: 207 tests across the modules (geometry math, collision, animation states, abilities, AI, missions,
  HUD projection, particle pools, audio math, map data integrity).
- `node scripts/e2e.mjs`: headless Chromium runs the whole opening: boot in under 2 s, 50 draw calls and 350k
  triangles for the city, intro dialog, deck walk, skydive from 600 m, hero landing on the square, mission 1
  starting, character switching, melee hits, slow-motion, with zero console errors.

## Develop

```
npm test           # unit tests
npm run build      # dist/xmen-mh.html
npm run serve      # dev server for index.html (loads src/ as modules)
node scripts/e2e.mjs   # browser smoke test with screenshots (SHOTS=dir)
```

## Data and licensing

Map data © OpenStreetMap contributors, ODbL. See `docs/DATA.md` for the extraction details and the
placeholders (the ASUMH campus has no building footprints in OSM, so four campus blocks are synthetic).
The X-Men characters are Marvel's; this is a non-commercial fan project. Code is MIT.
