# The physics in Ozark Orbital

Units are SI throughout: metres, seconds, kilograms, radians. The simulation is planar
(the equatorial plane of the Earth–Moon system), inertial, and Earth-centred until the ship
enters the Moon's sphere of influence.

## Bodies

| | Earth | Moon |
|---|---|---|
| μ = GM | 3.986004418 × 10¹⁴ m³/s² | 4.9048695 × 10¹² m³/s² |
| Radius | 6,371 km | 1,737.4 km |
| Rotation | 7.2921 × 10⁻⁵ rad/s | — |
| Orbit | — | circular, 384,400 km |
| Sphere of influence | — | 66,100 km ≈ a · (m/M)^(2/5) |

The Moon's mean motion follows from Kepler's third law around Earth's μ, giving a 27.45-day
period (the real sidereal month is 27.32 days; the difference is the Moon's own mass, ignored here).

## Atmosphere and drag

ρ(h) = 1.225 · exp(−h / 8,500 m), cut off at 140 km. Drag is F = ½ ρ v² C_d A with C_d A = 4.2 m²,
using the velocity relative to the rotating atmosphere. Max-Q reported on the HUD is ½ ρ v²
(the real Falcon 9 sees ~30–35 kPa; the sim's ascent produces ~36 kPa).

## Propulsion

Thrust interpolates between sea-level and vacuum values with ambient pressure:
T(h) = T_vac − (T_vac − T_sl) · p(h)/p₀. Mass flow is constant at T_vac / (Isp_vac · g₀).
Remaining Δv on the HUD is the staged rocket equation, Σ Isp g₀ ln(m₀/m₁), using current propellant.

## Integration

Two regimes, chosen every frame:

- **Powered flight or inside the atmosphere:** classical RK4 on (x, y, vx, vy, m) with sub-steps
  no longer than 0.05 s below 150 km altitude. Time warp is capped at 10×.
- **Coasting in vacuum:** the state is advanced analytically with the universal-variable
  formulation of Kepler's equation (Stumpff functions C(z), S(z); Newton iteration on χ). This is exact
  for any conic, so 100,000× warp costs nothing in accuracy. The test suite checks it against RK4 and
  checks energy and angular-momentum conservation on hyperbolic arcs.

## Orbital elements

From r and v: h = r × v, the eccentricity vector e = ((v² − μ/r) r − (r·v) v)/μ, a = −μ/2ε,
p = h²/μ, r_p = p/(1+e), r_a = p/(1−e). Time to periapsis/apoapsis uses the eccentric anomaly
for ellipses and the hyperbolic anomaly for escape trajectories. The drawn orbit is the conic
sampled in true anomaly, clipped to the SOI radius when hyperbolic.

## Patched conics

When the Earth-frame distance to the Moon drops below the SOI radius the state is re-expressed
relative to the Moon (subtract the Moon's position and velocity) and Moon gravity takes over;
the reverse happens on exit. A test verifies the Earth-frame position is continuous across the handoff.

## Guidance

- **ASCENT:** vertical to 70 m/s, then a pitch program θ(h) = 90° · (1 − e^(−h/32 km)) with a
  vertical-speed correction on the low-thrust upper stage. Engine cut when apoapsis reaches the target,
  coast, then a prograde circularization burn centred on apoapsis (burn time from Δv and current T/m).
- **TLI:** the Hohmann transfer time to the Moon's radius gives the required lead angle
  φ = 180° − n_moon · t_transfer (≈ 114.7° from 200 km). The burn starts early by half its own arc so the
  impulse is centred on the ideal point, and cuts when apoapsis reaches ~404,000 km. A cheap predictor
  propagates the coast on rails and reports closest approach.
- **LOI:** if the predicted periapsis is below 30 km or above 2,000 km, a small burn normal to the velocity
  moves it (the direction is chosen numerically by testing both signs), then a retrograde burn at periapsis
  until the orbit closes and apoapsis is below the target.
