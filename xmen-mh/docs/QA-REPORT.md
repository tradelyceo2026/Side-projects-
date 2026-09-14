# QA report — X-Men: Mountain Home

Play-tested against `docs/SPEC.md` with `npm test` (207 pass), `npm run build` (1.25 MB single HTML) and four
Playwright sessions (headless Chromium + SwiftShader, ~4 fps, so sim time runs ≈0.2× real) driving every ability,
both mission paths and the world, plus `scripts/e2e.mjs` before and after the fixes.

## 1. What works — with the numbers I measured

* **Boot & budget.** Loads in 1.7–1.8 s, no console errors in any session. 50–53 draw calls idle, 72 in combat,
  ~350 k triangles, 65 geometries, 29 textures — well inside the ≤300 draw-call budget.
* **City data.** 2004 roads, 1720 buildings, 33 water bodies, 19 green areas; all 10 required POIs present and
  inside the bbox (`courthouse@0,0`, `asumh@206,1736`, `hospital@-1056,-889`, `walmart@3979,-2194`, …).
* **Opening.** Title → intro (Storm/Beast) → deck → jump → 600 m skydive (−13 → −58 m/s, decelerating to a
  landing at y≈5.7 near the square) → `play` → M1 auto-starts. No errors, no stuck phases.
* **Characters.** All five match the spec table exactly (hp/speed/jump/colours/abilities); rigs, costumes,
  portraits and the roster row all render.
* **Abilities (all ten fire and do what the spec says).** Melee 18/22/30 (measured 60→42 on a thug), claws ×1.6
  (→13) plus a 5 dps bleed; regen 60→100 hp in 4 s; dash exactly 25.0 m with knockdowns; slow-mo `timeScale`
  0.25 for 3 s then eased 0.65→1.0; TK grabs a prop *or* an enemy, holds it 2.5 m out / 1.5 m up at 10 dps and
  throws for +20; optic beam 45 dps killed a 60 hp thug in <2 s at 12 m; sweep's 60 damage killed three thugs at
  once; diamond held 110 hp flat under three attacking thugs for 6 s (then 110→86→14 hp in the six after it lapsed);
  psychic turned 3 thugs `controlled` and they cut each other to 36/44 hp.
* **Enemies.** Thugs chase/attack/stagger; drones hover and shoot (12 damage to the player in 1.6 s); the
  Sentinel spawns at 900 hp, 9-part purple mech, beams the player. Dead enemies fade and are culled.
* **Missions.** M1 completes on reaching the ASUMH POI, chains to M2, dean talk → 4-thug defend wave. Driven
  directly, M3–M6 all start, gate correctly on Quicksilver/Jean and complete. 25 Cerebro cores place and pick up.
* **HUD / audio.** Objective panel, health, cooldown dials, portraits, minimap with markers, dialogue box with
  portrait, off-screen arrow, prompts, pause (sim frozen: 0.00 s advanced over 0.7 s real) and resume all work.
  `AudioContext` reaches `running`, master gain 0.7, music mood switches.

## 2. Bugs fixed (10, one line each)

1. `src/abilities.js` — held abilities used the aim snapshot from the moment they fired; now `lookDir()` asks the
   controller for the live aim, so the optic beam and telekinesis follow the camera (verified: 60→18 hp after
   turning onto a target mid-beam; a held thug swung 5 m across when the camera turned).
2. `src/vfx.js` — the beam mesh was drawn once as a fixed 60 m ray from the cast position; now it tracks
   `state.beam` each frame, and the diamond shimmer follows the player instead of staying where it was cast.
3. `src/missions.js` + `src/main.js` — collectibles were double-booked (main.js had its own list and counter), so
   one core counted twice, markers never cleared and the E prompt at a POI shadowed the NPC standing on it; the
   mission manager now owns the list via a new `collect()` used by both paths.
4. `src/missions.js` — `nearInteractable()` let the side-quest entry win the tie against the story `talk`
   objective at the same spot, which made **M2 uncompletable**; the objective now wins ties.
5. `src/main.js` — `hud.onSelect` was never wired, so the portrait row / character wheel did nothing.
6. `src/player/controller.js` — Jean's `hover` ability (Q) only emitted an event; it now engages hovering
   (verified −1.09 m/s fall, meter draining).
7. `src/ui/hud.js` — health/roster/minimap were hidden during the `deck` and `skydive` phases; now shown.
8. `src/missions.js` — mission dialogue ignored `dialog_advance`, so E could not skip ~20 s of frozen dialogue.
9. `src/main.js` — the `phase:play` hook restarted M1 in the gap between a mission's outro and the next mission.
10. `src/world/city.js` — OSM tags 1702 of 1720 buildings as plain `building=yes`, which arrives as `kind:house`;
    downtown therefore rendered as vinyl-sided cottages. Buildings on the square are now brick storefronts with
    flat roofs at ≥7.5 m — the single biggest visual win in this pass: the square now reads as a
    courthouse plaza ringed by storefronts instead of a cul-de-sac.

`npm test` 207/207 pass and `npm run build` succeeds after the fixes; `scripts/e2e.mjs` re-ran on the final
bundle end to end (title → intro → deck → skydive → landing → combat → campus) with zero page errors, zero
console errors, no loop error and 58 draw calls in combat.

## 3. Open bugs, worst first

1. **Jump height is 0.57 m** (gravity 22 m/s² vs a 5 m/s impulse). Repro: press Space on flat ground, peak
   y = +0.57. You cannot mount a kerb-height ledge, and 10 of the 25 cores sit on rooftops. `test/controller.test.js`
   pins `applyGravity(0,0.5) === -11`, so fixing this means changing the test too — left alone deliberately.
2. **Camera gets swallowed by geometry, and `teleport()` does not snap it.** Repro: stand next to any building —
   the pull-in puts the camera inside the wall and half the screen becomes a flat facade. On the carrier the
   camera is still catching up from the last position, so it sits below the deck; the deck is a single-sided
   `PlaneGeometry`, so it renders as nothing and the hero appears to float in empty sky (see `03-deck.png`).
3. **Three thugs kill a hero in ~4.5 s** (8 damage × ~1.2 s cadence each ≈ 24 dps vs 110 hp) and there are no
   i-frames, no dodge and no block. Repro: spawn 3 thugs on Emma, wait — 110 → 14 hp in 3 s once diamond lapses.
4. **The ASUMH campus does not read as a campus, let alone the X-Mansion**: four synthetic slabs, a lawn ring and
   a 3 m "X" sign in an empty field. It is the story's home base and it looks like an office park.
5. **Optic blast is a toggle, not a hold.** The controller never calls `releaseAbility`, so the beam runs its full
   5 s or until you press K again; the spec says hold-to-fire.
6. **Drones are unhittable by half the roster.** They hover 3–6 m up; Wolverine/Emma have no ranged attack and
   melee's vertical reach is 2.5 m, so M3 and three side quests are Cyclops/Jean-only in practice.
7. **2–3 of 40 physics props spawn inside buildings** (roof 10.4 m over ground 5.4 m) — unreachable, but still
   TK-targetable through the wall.
8. **Mission dialogue freezes the player** (phase `dialog` early-returns the controller) for every line; skippable
   now, but a cutscene-per-objective still stops the game dead.
9. **`state.enemies = enemies.all()` allocates a new array every frame** — against the spec's zero-allocation rule.
10. **`hud.hideTitle?.()` in main.js does not exist**; the title only hides because `_startFromTitle` hides it, so
    calling `window.xmen.startGame()` programmatically leaves the title overlay up.

## 4. Ten improvements for the next build, ranked

| # | Improvement | File | Size |
|---|---|---|---|
| 1 | Re-fetch OSM keeping `amenity`/`shop`/`building` tags and classify properly (cinema, diner, motel, school); today 99 % of buildings are `house` at 5 m, so the strip and the school look residential | `scripts/fetch-osm.mjs`, `src/data/city.json` | medium |
| 2 | Build the X-Mansion: an authored campus quad — gabled stone hall, clock tower, walled lawn, gates, hedges — on the `asumh` POI | `src/world/city.js` | medium |
| 3 | Traversal pass: ~1.2 m jump, wall-run/mantle for Wolverine, real flight for Jean, Quicksilver run-up-walls; then the rooftop cores make sense | `src/player/controller.js` | small |
| 4 | Camera: sphere-cast the pivot→camera segment, fade the occluder, snap on `teleport()`/phase change, and make the deck double-sided so it is never invisible from below | `src/player/controller.js` | medium |
| 5 | Combat feel: hit-stop, hit flash, damage numbers, enemy health pips, auto-face the nearest target on attack, i-frames after being hit | `src/combat.js`, `src/enemies.js` | medium |
| 6 | Hold-to-fire and hold-to-TK on the real key/mouse release path (`releaseAbility`), plus a reticle that shows the beam target | `src/player/controller.js` | small |
| 7 | Populate the town: walking civilians, moving cars on the road spline, birds, lit shop windows at dusk — right now Mountain Home is empty | `src/world/city.js`, `src/entities/characters.js` | medium |
| 8 | LEGO-style co-op puzzles: doors only Emma's diamond can smash, TK-only platforms, panels only Cyclops can burn — the character wheel currently has no gameplay reason to exist | `src/missions.js` | large |
| 9 | Destructible scenery + stud-like reward shower (props everywhere, bins, benches, mailboxes that burst) | `src/combat.js` | medium |
| 10 | Mission staging: NPC actors that walk and gesture, objective markers with distance, and a 5 s skydive instead of 40 s of free-fall | `src/missions.js`, `src/player/controller.js` | medium |

## 5. How close is this to LEGO Marvel Super Heroes?

Honestly: it is a solid technical skeleton and not yet that game. What LEGO Marvel sells is a dense, reactive,
funny playground — every bench explodes into studs, civilians react, five heroes each open a different door, and
the camera and combat are so forgiving that a seven-year-old can play it. What we have is a faithful model of Mountain
Home — 7 × 6.6 km of real OSM roads, 1720 footprints, every POI in the right place — five characters whose ten
powers all work and feel distinct (slow-mo, diamond, a real telekinetic grab-and-throw, a sweeping optic beam),
a six-mission spine with warm Ozark side characters, a working HUD and procedural audio — rendered in 50–70 draw calls. The gap is density and
generosity: the town is empty of people and traffic, almost nothing is destructible or collectible outside the 25
cores, the heroes can barely jump, three goons can kill you in five seconds, missions resolve by walking into a
radius rather than by doing something, and character switching is a stat change instead of a key that unlocks
the world. Fix traversal, the camera, combat feedback and give each hero one thing only they can do to the world,
and this goes from "an impressive tech demo of my home town" to something that actually plays like the reference.
