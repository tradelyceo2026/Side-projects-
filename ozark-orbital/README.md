# Ozark Orbital

A real-physics rocket and orbital-mechanics game that runs in one HTML file.
Launch a Falcon-class rocket from an Ozark spaceport, reach orbit, and fly to the Moon.

- **Play:** open `dist/ozark-orbital.html` in any browser (double-click it, no server needed).
- **Verify:** `npm test` runs 12 tests, including a headless flight that takes the rocket from the pad to lunar orbit.
- **Zero dependencies.** Plain JavaScript modules, a `<canvas>`, and Node's built-in test runner.

## What it does

| | |
|---|---|
| Gravity | Inverse-square, patched conics: Earth's sphere of influence hands off to the Moon's at 66,100 km. |
| Atmosphere | Exponential density model (8.5 km scale height) with quadratic drag relative to the rotating air. |
| Rocket | Three stages with sea-level and vacuum thrust, pressure-corrected Isp, mass flow, and staging. |
| Integration | RK4 while burning or in the atmosphere; exact Kepler propagation (universal variables) while coasting, so time warp up to 100,000× is loss-free. |
| Guidance | SAS modes (up, prograde, retrograde), and three autopilot programs: ASCENT, TLI (trans-lunar injection), LOI (lunar orbit insertion). |
| Display | Live orbit prediction with apoapsis/periapsis markers, lunar encounter preview, Moon phase angle vs. ideal transfer angle, Δv remaining, max-Q. |
| Missions | Kármán line, Earth orbit, circular orbit, Moon flyby, lunar orbit. Progress saved in the browser. |

Every number on the HUD comes from the same equations a mission planner would use.
The vehicle is a public-domain approximation of a Falcon 9 with a storable-propellant kick stage:
about 523 t at liftoff, 17.1 km/s of ideal Δv.

## A verified flight

`npm run headless` flies the whole mission in Node with the same autopilot code the browser uses:

| MET | Event |
|---|---|
| T+0 | Liftoff, 1.48 thrust-to-weight |
| T+13 s | Gravity turn begins |
| T+2:27 | Booster depleted, stage separation at ~80 km |
| T+6:58 | MECO, apoapsis 200 km |
| T+19:46 | Circularization burn, 88 m/s |
| T+19:49 | Parking orbit 197 × 200 km |
| T+1h 36m | TLI burn, Δv 3,133 m/s, when the Moon leads by 114.7° |
| T+3d 23h | Enter the Moon's sphere of influence |
| T+4d 17h | Lunar orbit insertion, Δv 779 m/s |
| T+4d 17h | Lunar orbit 244 × 323 km, 4.1 km/s of Δv still in the tank |

## Controls

| Key | Action |
|---|---|
| Space | Launch / stage |
| Z / X | Full throttle / cut |
| Shift / Ctrl | Throttle up / down |
| ← → | Rotate (manual attitude) |
| 1 2 3 4 | SAS: manual · up · prograde · retrograde |
| , . | Time warp down / up (caps at 10× while burning or in the atmosphere) |
| A | Autopilot for the current phase |
| Esc | Autopilot off |
| M / F | Map view / follow view |
| + − / wheel | Zoom |
| P | Pause |

Everything is also on the on-screen buttons, so it works on a phone.

## Project layout

```
ozark-orbital/
  index.html          dev page (loads src/ as ES modules; serve with `npm run serve`)
  src/physics.js      constants, atmosphere, Kepler propagation, orbital elements, RK4
  src/vehicle.js      stage definitions, mass, thrust, Δv
  src/sim.js          world step: powered flight, on-rails coasting, SOI handoff, ground contact
  src/autopilot.js    ASCENT / TLI / LOI programs, transfer-window and encounter prediction
  src/render.js       canvas renderer, camera, navball
  src/missions.js     mission goals and progress
  src/game.js         loop, input, HUD
  test/               node --test suites (physics + full mission)
  scripts/build.mjs   bundles everything into dist/ozark-orbital.html
  scripts/headless.mjs flies a mission in the terminal and prints telemetry
  docs/PHYSICS.md     the equations, with the choices explained
```

## Roadmap (what it will do)

1. **Return trip.** Trans-Earth injection autopilot and an aerobraking re-entry with heating limits, so a mission can end with a splashdown.
2. **Maneuver nodes.** Drag a burn on the map, see the resulting orbit before you commit.
3. **Vehicle editor.** Build your own stack from a parts list; the Δv readout updates live. Compare a Saturn V, a Starship, and a small-sat launcher.
4. **Landing.** Powered lunar descent with a hover-slam, plus booster fly-back to the Ozark pad.
5. **3D.** The physics core is already frame-agnostic; a Three.js front end with the same sim would give a full 3D orbit view.
6. **Leaderboards.** Least Δv, fastest to orbit, closest lunar flyby.

## Develop

```
npm test           # physics + mission tests
npm run headless   # watch a full mission in the terminal
npm run build      # rebuild dist/ozark-orbital.html
npm run serve      # dev server for index.html (http://localhost:8080)
```

MIT licensed.
