"""Published specifications for the 2023 Tesla Model Y Performance.

Every number here is sourced from public material (Tesla's own spec pages and
owner's manual, EPA certification data, and the major buff-book instrumented
tests).  Anything Tesla does not publish is marked ``ESTIMATED`` in
:data:`SOURCES` so the model never pretends to a precision it does not have.

The module is deliberately free of ``bpy`` imports: it is the single source of
truth for the mesh builder, the drivetrain simulation and the touchscreen UI,
and it has to be importable by the test-suite in a plain Python interpreter.

Units: SI internally (metres, kilograms, seconds, watts, joules).  Imperial
values are kept alongside only where the published figure is imperial.
"""

from __future__ import annotations

from dataclasses import dataclass, field

IN = 0.0254  # inch -> metre
MPH = 0.44704  # mile/hour -> metre/second
LB = 0.45359237  # pound -> kilogram
MILE = 1609.344  # mile -> metre


# ---------------------------------------------------------------------------
# Dimensions
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Dimensions:
    """Exterior dimensions, metres unless stated."""

    length: float = 187.0 * IN            # 4750.7 mm
    width_body: float = 75.6 * IN         # 1920.2 mm, mirrors folded
    width_mirrors: float = 83.8 * IN      # 2128.5 mm, mirrors extended
    height: float = 63.9 * IN             # 1623.1 mm, at curb
    wheelbase: float = 113.8 * IN         # 2890.5 mm
    track_front: float = 64.4 * IN        # 1635.8 mm
    track_rear: float = 64.6 * IN         # 1640.8 mm
    ground_clearance: float = 6.6 * IN    # 167.6 mm
    front_overhang: float = 35.4 * IN     # derived: (L - WB) split 49/51
    rear_overhang: float = 37.8 * IN
    roof_glass_length: float = 68.0 * IN  # tailgate glass + roof glass run
    drag_coefficient: float = 0.23
    frontal_area: float = 2.4             # m^2, ESTIMATED from width x height x 0.78

    @property
    def half_width(self) -> float:
        return self.width_body / 2.0

    @property
    def front_axle_x(self) -> float:
        """X of the front axle with the origin at the centre of the wheelbase."""
        return self.wheelbase / 2.0

    @property
    def rear_axle_x(self) -> float:
        return -self.wheelbase / 2.0

    @property
    def nose_x(self) -> float:
        return self.front_axle_x + self.front_overhang

    @property
    def tail_x(self) -> float:
        return self.rear_axle_x - self.rear_overhang


@dataclass(frozen=True)
class Wheels:
    """21" Überturbine wheel with the 255/35R21 Pirelli P Zero it ships on."""

    rim_diameter_in: float = 21.0
    tire_width_mm: float = 255.0
    aspect_ratio: float = 0.35
    spokes: int = 10          # Überturbine face: 10 twisted turbine blades
    lug_bolts: int = 5

    @property
    def rim_radius(self) -> float:
        return self.rim_diameter_in * IN / 2.0

    @property
    def sidewall(self) -> float:
        return self.tire_width_mm / 1000.0 * self.aspect_ratio

    @property
    def radius(self) -> float:
        """Unloaded radius, 0.3560 m for 255/35R21."""
        return self.rim_radius + self.sidewall

    @property
    def rolling_radius(self) -> float:
        """Loaded / dynamic radius: ~3% squash under a 2 t crossover."""
        return self.radius * 0.97

    @property
    def width(self) -> float:
        return self.tire_width_mm / 1000.0

    @property
    def circumference(self) -> float:
        return 2.0 * 3.141592653589793 * self.rolling_radius


@dataclass(frozen=True)
class Powertrain:
    """Dual motor all-wheel drive: rear permanent-magnet, front induction."""

    peak_power_w: float = 456 * 745.6997          # 340.0 kW, 456 hp combined
    peak_torque_nm: float = 660.0                 # ESTIMATED at the axles
    front_power_share: float = 0.38               # ESTIMATED torque split
    gear_ratio: float = 9.0                       # single-speed reduction
    drivetrain_efficiency: float = 0.92
    regen_power_w: float = 70_000.0               # ~70 kW peak regen
    motor_rpm_max: float = 18_000.0
    base_speed_ms: float = 32.0                   # constant-torque -> constant-power knee


@dataclass(frozen=True)
class Battery:
    """2170-cell pack, ~75 kWh usable."""

    usable_kwh: float = 75.0
    nominal_voltage: float = 355.0
    max_dc_charge_kw: float = 250.0               # V3 Supercharger peak
    max_ac_charge_kw: float = 11.5                # onboard charger
    mass: float = 771 * LB                        # ESTIMATED pack mass

    @property
    def usable_joules(self) -> float:
        return self.usable_kwh * 3.6e6


@dataclass(frozen=True)
class Performance:
    """Manufacturer and instrumented-test figures."""

    zero_to_sixty_s: float = 3.5                  # with 1 ft rollout
    zero_to_hundred_kph_s: float = 3.7
    quarter_mile_s: float = 11.9
    top_speed_ms: float = 155 * MPH               # 69.3 m/s, limited
    epa_range_m: float = 303 * MILE               # 2023 Performance, 21" wheels
    epa_consumption_wh_per_mile: float = 291.0    # 75 kWh / 303 mi with charge loss
    curb_mass: float = 4398 * LB                  # 1994.9 kg
    weight_distribution_front: float = 0.48
    towing_capacity: float = 3500 * LB
    cargo_litres: float = 2158.0                  # 76.2 cu ft, seats folded
    frunk_litres: float = 117.0


@dataclass(frozen=True)
class Interior:
    center_screen_diagonal_in: float = 15.0
    center_screen_aspect: float = 16.0 / 10.0
    seats: int = 5
    steering_wheel_diameter: float = 14.5 * IN
    hvac_min_c: float = 15.0
    hvac_max_c: float = 28.0


@dataclass(frozen=True)
class ModelYPerformance:
    name: str = "Tesla Model Y Performance"
    model_year: int = 2023
    dims: Dimensions = field(default_factory=Dimensions)
    wheels: Wheels = field(default_factory=Wheels)
    powertrain: Powertrain = field(default_factory=Powertrain)
    battery: Battery = field(default_factory=Battery)
    perf: Performance = field(default_factory=Performance)
    interior: Interior = field(default_factory=Interior)

    @property
    def mass(self) -> float:
        return self.perf.curb_mass


SPEC = ModelYPerformance()


# Factory paint options for the 2023 model year, as linear-ish sRGB base colours
# plus the metallic / clearcoat parameters the material builder needs.
PAINT_COLORS: dict[str, dict[str, object]] = {
    "Pearl White Multi-Coat": {"rgb": (0.82, 0.82, 0.83), "metallic": 0.30, "roughness": 0.16},
    "Solid Black": {"rgb": (0.012, 0.012, 0.013), "metallic": 0.20, "roughness": 0.13},
    "Midnight Silver Metallic": {"rgb": (0.075, 0.080, 0.088), "metallic": 0.85, "roughness": 0.22},
    "Deep Blue Metallic": {"rgb": (0.012, 0.038, 0.130), "metallic": 0.80, "roughness": 0.18},
    "Red Multi-Coat": {"rgb": (0.400, 0.010, 0.014), "metallic": 0.45, "roughness": 0.14},
    "Quicksilver": {"rgb": (0.330, 0.340, 0.350), "metallic": 0.95, "roughness": 0.25},
}

DEFAULT_PAINT = "Deep Blue Metallic"


SOURCES: dict[str, str] = {
    "dimensions": "Tesla Model Y spec page / Owner's Manual (2023 MY)",
    "drag_coefficient": "Tesla published Cd 0.23",
    "frontal_area": "ESTIMATED: width x height x 0.78 shape factor",
    "peak_power_w": "456 hp combined, instrumented-test consensus (Tesla does not publish)",
    "peak_torque_nm": "ESTIMATED from 0-60 traction-limited launch and gear ratio",
    "front_power_share": "ESTIMATED dual-motor split",
    "battery.usable_kwh": "~75 kWh usable, teardown consensus (Tesla does not publish)",
    "battery.mass": "ESTIMATED pack mass",
    "epa_range_m": "EPA 303 mi for 2023 Model Y Performance on 21-inch wheels",
    "zero_to_sixty_s": "Tesla: 3.5 s with 1 ft rollout",
    "top_speed_ms": "Tesla: 155 mph electronically limited",
    "curb_mass": "4,398 lb published curb weight",
    "wheels": '21" Uberturbine, 255/35R21 Pirelli P Zero',
    "center_screen": '15.0" 2200x1300 centre touchscreen',
}


def summary() -> str:
    d, p, b = SPEC.dims, SPEC.perf, SPEC.battery
    return "\n".join(
        [
            f"{SPEC.model_year} {SPEC.name}",
            f"  L x W x H       {d.length*1000:.0f} x {d.width_body*1000:.0f} x {d.height*1000:.0f} mm",
            f"  Wheelbase       {d.wheelbase*1000:.0f} mm   Track f/r {d.track_front*1000:.0f}/{d.track_rear*1000:.0f} mm",
            f"  Curb mass       {p.curb_mass:.0f} kg ({p.curb_mass/LB:.0f} lb)",
            f"  Power           {SPEC.powertrain.peak_power_w/1000:.0f} kW (456 hp)",
            f"  Battery         {b.usable_kwh:.0f} kWh usable, {b.max_dc_charge_kw:.0f} kW DC peak",
            f"  0-60 mph        {p.zero_to_sixty_s:.1f} s      Top speed {p.top_speed_ms/MPH:.0f} mph",
            f"  EPA range       {p.epa_range_m/MILE:.0f} mi",
            f"  Wheels          21\" Uberturbine, 255/35R21 (r = {SPEC.wheels.radius*1000:.1f} mm)",
        ]
    )


if __name__ == "__main__":  # pragma: no cover - convenience
    print(summary())
