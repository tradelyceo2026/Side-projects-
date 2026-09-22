# Flight model

`src/fdm/aircraft.js`, with the airplane's numbers in `src/fdm/c172.js`.

## Frames

- **World:** metres from the KBPK reference point, +x east, +y up, +z south. The projection is a local
  equirectangular one (`x = (lon - lon0) cos(lat0) 111,320`, `z = -(lat - lat0) 110,540`), accurate to well under a
  metre per kilometre across the 65 km map.
- **Model:** +x right wing, +y up, -z nose, origin at the centre of gravity. The renderer uses the same frame.
- **Body axes for aerodynamics:** x forward, y right, z down, so `u = -v_model.z`, `v = v_model.x`, `w = -v_model.y`,
  and `p = -ω.z`, `q = ω.x`, `r = -ω.y`.

## Aerodynamics

With `α = atan2(w, u)`, `β = asin(v / V)` and the non-dimensional rates `p̂ = p b / 2V`, `q̂ = q c / 2V`, `r̂ = r b / 2V`:

```
CL = CL(α; flaps) + CLq q̂ + CLα̇ α̇ĉ + CLδe δe · η_t
CD = CD0 + ΔCD(flaps) + K · φ_ge · CL² + 1.2 · s · sin²α + 0.2 β²
CY = CYβ β + CYp p̂ + CYr r̂ - CYδr δr · η_t
Cl = Clβ β + Clp (1 - 1.3 s) p̂ + Clr r̂ + Clδa δa - Clδr δr · η_t + stall asymmetry
Cm = Cm0 + ΔCm(flaps) + Cmα α + Cmq q̂ + Cmα̇ α̇ĉ + Cmδe δe · η_t - 0.5 s (α - α_stall)
Cn = Cnβ β + Cnp p̂ + Cnr r̂ + Cnδa δa - Cnδr δr · η_t
```

- `CL(α)` is linear with slope 4.41 per radian, rounds over the last 3.4° to CLmax (1.48 clean, 1.82 with 30° of
  flap), then loses 30% and blends toward a flat plate, `1.05 sin 2α`.
- `s` is a smoothstep "stalled" fraction around the stall angle. Once stalled, roll damping collapses, the drag of a
  flat plate appears, the nose drops, and a small asymmetry drops a wing toward the sideslip. Hold it in and it
  spins.
- `K = 1 / (π AR e)` with AR 7.36 and e 0.75. `φ_ge = (16h/b)² / (1 + (16h/b)²)` is ground effect on induced drag,
  which gives the float in the flare.
- `η_t = q_tail / q∞`, where `q_tail = q∞ + 0.25 T / A_disc` is the tail's dynamic pressure including prop wash.
  That is why the rudder and elevator work at 20 knots on the takeoff roll.
- The derivatives are Roskam's for the C172 in cruise. Roskam takes a positive rudder deflection as trailing edge
  left; here a positive rudder input is right pedal, hence the sign changes on the δr terms.

## Propeller and engine

```
J = u / (n D)          D = 1.905 m (75 in)
T = Ct(J) ρ n² D⁴      Ct = 0.11 - 0.0755 J
Q = Cp(J) ρ n² D⁵ / 2π Cp = 0.0612 - 0.0183 J²
Q_engine = Q_rated · (1.132 σ - 0.132) · (0.12 + 0.88 throttle)
I_prop dω/dt = Q_engine - Q_prop - Q_friction(rpm)
```

The two coefficient lines were fitted to two points from the POH: static RPM at full throttle (2,300-2,420), and
122 KTAS at 8,000 ft with the throttle open. Everything else, including the Vy climb rate and the fuel flow, follows
from them. The engine quits below about 350 RPM, and a stopped prop becomes drag.

## Ground

Each gear leg is a spring and damper along the terrain normal (mains 68 kN/m, nose 62 kN/m). The tyre's lateral
force comes from its slip angle and saturates near 8°. Rolling resistance is μ 0.025 and braking μ 0.55. Nosewheel
steering is ±10° at taxi speed, divided by `1 + (V/9)²` as speed builds, so the rudder takes over. The gear fails
when a main leg sees more than 30 kN (about 3 g of the whole airplane on one leg). The propeller, wingtips, tail
tie-down and belly are hard points. The tail may scrape below 1.5 m/s, and anything else is a crash. Touching the
water surface is a ditching.

## Integration

The integrator is semi-implicit Euler at 240 Hz. It updates velocity from force, then position; angular velocity
from Euler's equations with the principal inertias; and the quaternion from the angular velocity. The step is fixed,
so the browser and Node give the same result for the same inputs.

## Verification (`npm test`)

| Test | Result |
|---|---|
| ISA density at 10,000 ft | 0.9046 kg/m³ |
| Static RPM | 2,354 |
| 8,000 ft full-throttle cruise | 121.9 KTAS, 2,526 RPM, 9.9 gal/h |
| Vy climb near sea level | about 700 ft/min |
| Stall, max gross, clean / flaps 30 | 51 / 47 KIAS |
| Hands-off stability | no divergence in 60 s |
| Hard landing at 5 m/s | gear fails; at 0.8 m/s it does not |
| Ground roll with a simple rudder controller | lifts off inside 1,500 ft within 5 m of the centreline |
| Full circuit, calm and in an 11 kt crosswind | lands within 8 m of the centreline at under 400 ft/min |
