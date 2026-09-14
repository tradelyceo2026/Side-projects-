"""21-inch Uberturbine wheel, 255/35R21 tyre, disc and Performance caliper.

Dimensions come straight from the tyre code: a 255/35R21 is 711.9 mm across,
so the rim sits at 266.7 mm radius with an 89.25 mm sidewall.  The Uberturbine
face is ten twisted turbine blades; each is generated as a swept quad ribbon
between the hub ring and the rim lip with a per-blade pitch angle.
"""

from __future__ import annotations

import math

from ..specs import SPEC
from .mesh import Mesh, loft, revolve

W = SPEC.wheels


def tyre_profile() -> list[tuple[float, float]]:
    """(radius, lateral offset) outline of one tyre, revolved about Y."""
    r_out = W.radius
    r_rim = W.rim_radius
    hw = W.width / 2.0
    shoulder = r_out - 0.012
    return [
        (r_rim, -hw * 0.92),
        (r_rim + 0.030, -hw * 0.99),
        (r_out - 0.030, -hw * 1.00),
        (shoulder, -hw * 0.92),
        (r_out, -hw * 0.62),
        (r_out, hw * 0.62),
        (shoulder, hw * 0.92),
        (r_out - 0.030, hw * 1.00),
        (r_rim + 0.030, hw * 0.99),
        (r_rim, hw * 0.92),
    ]


def build_wheel(center: tuple[float, float, float], side: int,
                name: str = "Wheel") -> Mesh:
    """One complete wheel.  ``side`` is +1 for the left (+Y) wheels."""
    m = Mesh(name)
    hw = W.width / 2.0
    cx, cy, cz = center

    revolve(m, tyre_profile(), 48, axis="y", material="Tire", center=center)

    # rim barrel + outer lip
    rim_profile = [
        (W.rim_radius, -hw * 0.90),
        (W.rim_radius * 0.72, -hw * 0.55),
        (W.rim_radius * 0.72, hw * 0.25),
        (W.rim_radius, hw * 0.88),
        (W.rim_radius - 0.016, hw * 0.90),
    ]
    revolve(m, rim_profile, 48, axis="y", material="Wheel_Alloy", center=center)

    face_y = cy + side * hw * 0.86
    hub_r = 0.072
    # hub face
    hub_ring = []
    for i in range(24):
        a = 2 * math.pi * i / 24
        hub_ring.append((cx + hub_r * math.cos(a), face_y, cz + hub_r * math.sin(a)))
    inner = [(cx + hub_r * 0.62 * math.cos(2 * math.pi * i / 24), face_y - side * 0.012,
              cz + hub_r * 0.62 * math.sin(2 * math.pi * i / 24)) for i in range(24)]
    loft(m, [hub_ring, inner], "Wheel_Alloy", closed_sections=True, cap_last=True)

    # five lug covers
    for i in range(W.lug_bolts):
        a = 2 * math.pi * i / W.lug_bolts + math.pi / 2
        lx = cx + 0.048 * math.cos(a)
        lz = cz + 0.048 * math.sin(a)
        ring = [(lx + 0.010 * math.cos(t), face_y + side * 0.004, lz + 0.010 * math.sin(t))
                for t in [2 * math.pi * k / 8 for k in range(8)]]
        idx = m.add_verts(ring)
        m.add_face(idx if side > 0 else list(reversed(idx)), "Wheel_Dark")

    _turbine_blades(m, cx, cz, face_y, side, hub_r)
    _brakes(m, center, side)
    return m


def _turbine_blades(m: Mesh, cx: float, cz: float, face_y: float, side: int,
                    hub_r: float) -> None:
    """Ten twisted blades sweeping from the hub to the rim lip."""
    r_in = hub_r * 0.98
    r_out = W.rim_radius - 0.006
    blades = W.spokes
    twist = math.radians(16.0)      # blade pitch out of the wheel plane
    span = math.radians(360.0 / blades * 0.74)
    for b in range(blades):
        a0 = 2 * math.pi * b / blades
        rows = []
        steps = 7
        for s in range(steps + 1):
            t = s / steps
            r = r_in + (r_out - r_in) * t
            # the blade sweeps back as it goes out: that is the turbine look
            a = a0 + span * (0.35 + 0.65 * t)
            depth = side * (0.014 + 0.020 * t) * math.cos(twist)
            half = span * (0.50 - 0.16 * t)
            rows.append([
                (cx + r * math.cos(a - half), face_y - depth * 0.15,
                 cz + r * math.sin(a - half)),
                (cx + r * math.cos(a), face_y - depth * 0.55, cz + r * math.sin(a)),
                (cx + r * math.cos(a + half), face_y - depth,
                 cz + r * math.sin(a + half)),
            ])
        cols = [[row[i] for row in rows] for i in range(3)]
        from .mesh import grid_patch
        grid_patch(m, cols, "Wheel_Alloy")
        # thin underside so the blade reads as solid from behind
        back = [[(v[0], v[1] - side * 0.010, v[2]) for v in col] for col in cols]
        grid_patch(m, list(reversed(back)), "Wheel_Dark")


def _brakes(m: Mesh, center: tuple[float, float, float], side: int) -> None:
    cx, cy, cz = center
    disc_r = 0.183          # 355 mm front rotor on the Performance
    disc_y = cy - side * 0.018
    revolve(m, [(disc_r, -0.014), (disc_r, 0.014), (disc_r * 0.42, 0.014),
                (disc_r * 0.42, -0.014)], 32, axis="y",
            material="Brake_Disc", center=(cx, disc_y, cz))
    # red caliper, trailing edge, top-rear of the disc
    a0, a1 = math.radians(112), math.radians(168)
    rows = []
    for i in range(9):
        a = a0 + (a1 - a0) * i / 8
        r_i, r_o = disc_r * 0.72, disc_r * 1.03
        rows.append([
            (cx + r_i * math.cos(a), disc_y - side * 0.030, cz + r_i * math.sin(a)),
            (cx + r_o * math.cos(a), disc_y - side * 0.030, cz + r_o * math.sin(a)),
            (cx + r_o * math.cos(a), disc_y + side * 0.030, cz + r_o * math.sin(a)),
            (cx + r_i * math.cos(a), disc_y + side * 0.030, cz + r_i * math.sin(a)),
        ])
    loft(m, rows, "Brake_Caliper", closed_sections=True, cap_first=True, cap_last=True)


def wheel_centers() -> list[tuple[str, tuple[float, float, float], int]]:
    d = SPEC.dims
    z = W.radius
    return [
        ("Wheel_FL", (d.front_axle_x, d.track_front / 2.0 - W.width / 2.0, z), 1),
        ("Wheel_FR", (d.front_axle_x, -(d.track_front / 2.0 - W.width / 2.0), z), -1),
        ("Wheel_RL", (d.rear_axle_x, d.track_rear / 2.0 - W.width / 2.0, z), 1),
        ("Wheel_RR", (d.rear_axle_x, -(d.track_rear / 2.0 - W.width / 2.0), z), -1),
    ]


def build_wheels() -> list[Mesh]:
    return [build_wheel(c, side, name) for name, c, side in wheel_centers()]
