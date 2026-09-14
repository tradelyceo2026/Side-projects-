"""The car's computer: state, longitudinal dynamics, battery and charging.

This is the model everything else talks to -- the touchscreen renders it, the
Blender rig is driven by it, and Grok's tool calls mutate it.  It is plain
Python so the physics can be validated in CI against the published numbers
(``tests/test_vehicle_sim.py`` checks 0-60 mph, top speed, steady-state
consumption and Supercharger taper).

Model, per integration step:

    F_drive   = min(traction limit, wheel-force limit, P_peak / v)
    F_drag    = 0.5 * rho * Cd * A * v^2
    F_roll    = Crr * m * g
    a         = (F_drive - F_drag - F_roll - F_brake) / m_eff

Battery draw is drive power over the drivetrain efficiency plus HVAC and
accessory loads; regenerative braking returns energy at ~70 kW until it tapers
out below walking pace.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .specs import MILE, MPH, SPEC

G = 9.80665
AIR_DENSITY = 1.225
CRR = 0.0105               # low-rolling-resistance 21" P Zero on asphalt
TIRE_MU = 1.02             # peak longitudinal grip, warm, dry
ROTATIONAL_INERTIA = 1.035  # effective-mass factor for wheels + rotors
ACCESSORY_W = 320.0        # computer, pumps, lights
HVAC_MAX_W = 4200.0        # heat pump flat out
REGEN_CUTOFF_MS = 1.4      # regen fades out below this speed

GEARS = ("P", "R", "N", "D")
DRIVE_MODES = ("Chill", "Standard")


@dataclass
class CarState:
    """Everything the touchscreen, the rig and Grok can read or change."""

    # motion
    gear: str = "P"
    speed_ms: float = 0.0
    accel_ms2: float = 0.0
    steering_deg: float = 0.0          # road-wheel angle, +left
    odometer_m: float = 12_874.0 * MILE          # a used-car-ish starting odometer
    trip_m: float = 0.0

    # energy
    soc: float = 0.72                  # state of charge, 0..1
    battery_power_w: float = 0.0       # +discharge, -regen/charge
    charging: bool = False
    charge_power_w: float = 0.0
    charge_limit: float = 0.90
    consumption_wh_per_km: float = 0.0

    # cabin
    hvac_on: bool = True
    cabin_temp_c: float = 21.0
    hvac_setpoint_c: float = 21.0
    outside_temp_c: float = 14.0
    fan_speed: int = 3
    seat_heater_left: int = 0
    seat_heater_right: int = 0
    defrost: bool = False

    # body
    locked: bool = True
    frunk_open: bool = False
    trunk_open: bool = False
    doors_open: list[bool] = field(default_factory=lambda: [False] * 4)
    charge_port_open: bool = False
    headlights: bool = False
    brake_lights: bool = False
    turn_signal: str = ""              # "", "left", "right"
    paint: str = "Deep Blue Metallic"

    # driver assist / misc
    drive_mode: str = "Standard"
    regen_strong: bool = True
    autopilot: bool = False
    autopilot_set_speed_ms: float = 70 * MPH
    sentry_mode: bool = False
    media_track: str = "Nightcall - Kavinsky"
    media_playing: bool = True
    volume: int = 6
    navigation_destination: str = ""
    navigation_distance_m: float = 0.0
    clock_minutes: int = 9 * 60 + 41

    # -- derived ------------------------------------------------------
    @property
    def speed_mph(self) -> float:
        return self.speed_ms / MPH

    @property
    def energy_wh(self) -> float:
        return self.soc * SPEC.battery.usable_kwh * 1000.0

    @property
    def rated_range_m(self) -> float:
        return self.soc * SPEC.perf.epa_range_m

    def range_m(self) -> float:
        """Range on the rated EPA rate, derated for HVAC and cold."""
        derate = 1.0
        if self.hvac_on:
            derate -= 0.06
        if self.outside_temp_c < 5:
            derate -= 0.12
        if self.drive_mode == "Chill":
            derate += 0.03
        return self.rated_range_m * max(0.55, derate)

    def wheel_rpm(self) -> float:
        return self.speed_ms / SPEC.wheels.circumference * 60.0

    def motor_rpm(self) -> float:
        return self.wheel_rpm() * SPEC.powertrain.gear_ratio

    def snapshot(self) -> dict[str, object]:
        """A compact dict for Grok's context and for the UI."""
        return {
            "gear": self.gear,
            "speed_mph": round(self.speed_mph, 1),
            "battery_percent": round(self.soc * 100),
            "range_miles": round(self.range_m() / MILE),
            "charging": self.charging,
            "charge_kw": round(self.charge_power_w / 1000, 1),
            "cabin_temp_c": round(self.cabin_temp_c, 1),
            "hvac_setpoint_c": self.hvac_setpoint_c,
            "hvac_on": self.hvac_on,
            "outside_temp_c": self.outside_temp_c,
            "locked": self.locked,
            "frunk_open": self.frunk_open,
            "trunk_open": self.trunk_open,
            "autopilot": self.autopilot,
            "drive_mode": self.drive_mode,
            "media": self.media_track,
            "media_playing": self.media_playing,
            "volume": self.volume,
            "paint": self.paint,
            "destination": self.navigation_destination or None,
            "odometer_miles": round(self.odometer_m / MILE),
        }


# ---------------------------------------------------------------------------
# dynamics
# ---------------------------------------------------------------------------


def max_wheel_force(state: CarState, speed: float) -> float:
    """Tractive force available at the given speed, N."""
    pt = SPEC.powertrain
    torque_limit = pt.peak_torque_nm * pt.gear_ratio / SPEC.wheels.rolling_radius
    torque_limit *= pt.drivetrain_efficiency
    power_limit = (pt.peak_power_w * pt.drivetrain_efficiency / max(speed, 0.5))
    # dual motor, so effectively the whole car's weight is driven; a little
    # rearward transfer under launch is what lets it hook up at all
    traction_limit = TIRE_MU * SPEC.mass * G * 1.06
    limit = min(torque_limit, power_limit, traction_limit)
    if state.drive_mode == "Chill":
        limit *= 0.55
    if state.soc < 0.10:                       # low-SoC power derate
        limit *= 0.55 + 4.5 * state.soc
    return max(0.0, limit)


def drag_force(speed: float) -> float:
    d = SPEC.dims
    return 0.5 * AIR_DENSITY * d.drag_coefficient * d.frontal_area * speed * speed


def rolling_force(speed: float) -> float:
    if speed < 0.05:
        return 0.0
    return CRR * SPEC.mass * G


def hvac_power(state: CarState) -> float:
    if not state.hvac_on:
        return 0.0
    error = abs(state.cabin_temp_c - state.hvac_setpoint_c)
    outside = abs(state.outside_temp_c - state.hvac_setpoint_c)
    load = min(1.0, 0.18 + error * 0.22 + outside * 0.020)
    return HVAC_MAX_W * load * (0.35 + 0.65 * state.fan_speed / 5.0)


def step(state: CarState, dt: float, throttle: float = 0.0, brake: float = 0.0,
         grade: float = 0.0) -> CarState:
    """Advance the vehicle by ``dt`` seconds. ``throttle``/``brake`` are 0..1."""
    throttle = min(1.0, max(0.0, throttle))
    brake = min(1.0, max(0.0, brake))
    v = state.speed_ms

    if state.charging:
        _charge_step(state, dt)
        state.speed_ms = 0.0
        state.accel_ms2 = 0.0
        return state

    drive_f = 0.0
    regen_f = 0.0
    if state.gear in ("D", "R") and throttle > 0:
        drive_f = max_wheel_force(state, max(v, 0.5)) * throttle
        if v >= SPEC.perf.top_speed_ms:            # 155 mph limiter
            drive_f = 0.0
    lift = state.gear in ("D", "R") and throttle <= 0.01
    if (lift and state.regen_strong) or brake > 0:
        regen_cap = SPEC.powertrain.regen_power_w / max(v, 1.0)
        demand = (0.34 if lift else 0.0) + brake * 1.0
        regen_f = min(regen_cap, TIRE_MU * SPEC.mass * G * demand)
        if v < REGEN_CUTOFF_MS:
            regen_f *= v / REGEN_CUTOFF_MS
    friction_brake_f = 0.0
    if brake > 0:
        total_brake = brake * TIRE_MU * SPEC.mass * G
        friction_brake_f = max(0.0, total_brake - regen_f)

    resist = drag_force(v) + rolling_force(v) + SPEC.mass * G * math.sin(grade)
    net = drive_f - regen_f - friction_brake_f - resist
    a = net / (SPEC.mass * ROTATIONAL_INERTIA)

    new_v = v + a * dt
    if state.gear == "P" or state.gear == "N":
        new_v = 0.0 if state.gear == "P" else max(0.0, v - resist / SPEC.mass * dt)
    new_v = max(0.0, min(new_v, SPEC.perf.top_speed_ms))
    if v > 0 and new_v <= 0.02 and (brake > 0 or lift):
        new_v = 0.0

    distance = (v + new_v) * 0.5 * dt
    state.speed_ms = new_v
    state.accel_ms2 = (new_v - v) / dt if dt > 0 else 0.0
    state.odometer_m += distance
    state.trip_m += distance
    state.brake_lights = brake > 0.02 or (lift and regen_f > 800)

    # energy: traction out, regen in, plus the cabin and the computer
    mech_w = drive_f * max(new_v, 0.0)
    draw = mech_w / SPEC.powertrain.drivetrain_efficiency
    recovered = regen_f * max(new_v, 0.0) * 0.72
    total_w = draw - recovered + ACCESSORY_W + hvac_power(state)
    state.battery_power_w = total_w
    state.soc = min(1.0, max(0.0, state.soc - total_w * dt / (SPEC.battery.usable_joules)))
    if distance > 1e-6:
        wh = total_w * dt / 3600.0
        km = distance / 1000.0
        inst = wh / km
        state.consumption_wh_per_km += (inst - state.consumption_wh_per_km) * min(1.0, dt)

    _cabin_step(state, dt)
    if state.navigation_destination and state.navigation_distance_m > 0:
        state.navigation_distance_m = max(0.0, state.navigation_distance_m - distance)
    return state


def _cabin_step(state: CarState, dt: float) -> None:
    target = state.hvac_setpoint_c if state.hvac_on else state.outside_temp_c
    rate = 0.045 if state.hvac_on else 0.006
    state.cabin_temp_c += (target - state.cabin_temp_c) * min(1.0, rate * dt)


# ---------------------------------------------------------------------------
# charging
# ---------------------------------------------------------------------------


def supercharger_power_w(soc: float) -> float:
    """V3 taper: 250 kW to ~20 %, then a roughly linear roll-off."""
    pts = [(0.00, 190_000), (0.08, 250_000), (0.20, 250_000), (0.35, 175_000),
           (0.50, 120_000), (0.70, 72_000), (0.85, 42_000), (0.95, 20_000),
           (1.00, 7_000)]
    if soc <= pts[0][0]:
        return pts[0][1]
    for (s0, p0), (s1, p1) in zip(pts, pts[1:]):
        if s0 <= soc <= s1:
            t = (soc - s0) / (s1 - s0)
            return p0 + (p1 - p0) * t
    return pts[-1][1]


def _charge_step(state: CarState, dt: float) -> None:
    if state.soc >= state.charge_limit:
        state.charging = False
        state.charge_power_w = 0.0
        return
    p = supercharger_power_w(state.soc) if state.charge_port_open else \
        SPEC.battery.max_ac_charge_kw * 1000.0
    p = min(p, SPEC.battery.max_dc_charge_kw * 1000.0)
    losses = 0.94
    state.charge_power_w = p
    state.battery_power_w = -p
    state.soc = min(state.charge_limit, state.soc + p * losses * dt / SPEC.battery.usable_joules)
    _cabin_step(state, dt)


def charge_time_estimate_s(state: CarState, target_soc: float) -> float:
    """Integrate the taper curve to a target state of charge."""
    soc = state.soc
    t = 0.0
    step_soc = 0.005
    while soc < target_soc:
        p = supercharger_power_w(soc) * 0.94
        t += step_soc * SPEC.battery.usable_joules / p
        soc += step_soc
    return t


# ---------------------------------------------------------------------------
# validation helpers (also used by the tests)
# ---------------------------------------------------------------------------


def simulate_acceleration(target_mph: float = 60.0, dt: float = 0.002,
                          rollout: bool = True) -> float:
    """Seconds to ``target_mph`` from rest, optionally with the 1 ft rollout."""
    st = CarState(gear="D", soc=0.90, hvac_on=False)
    t = 0.0
    rollout_done = not rollout
    start_t = 0.0
    while st.speed_ms < target_mph * MPH and t < 60:
        step(st, dt, throttle=1.0)
        t += dt
        if not rollout_done and st.trip_m >= 0.3048:   # 1 foot
            rollout_done = True
            start_t = t
    return t - start_t


def simulate_steady_consumption(speed_mph: float = 65.0, seconds: float = 600.0,
                                dt: float = 0.05) -> float:
    """Wh/mile holding a steady speed on the flat, HVAC off."""
    st = CarState(gear="D", soc=0.80, hvac_on=False)
    st.speed_ms = speed_mph * MPH
    energy_j = 0.0
    dist = 0.0
    t = 0.0
    while t < seconds:
        v = st.speed_ms
        # hold speed: feed exactly the force the road is taking away
        need = drag_force(v) + rolling_force(v)
        throttle = min(1.0, need / max(1.0, max_wheel_force(st, v)))
        step(st, dt, throttle=throttle)
        energy_j += st.battery_power_w * dt
        dist += st.speed_ms * dt
        t += dt
    wh = energy_j / 3600.0
    miles = dist / MILE
    return wh / miles if miles else 0.0
