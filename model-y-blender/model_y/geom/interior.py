"""Cabin: floor, dash, the 15-inch centre screen, steering wheel, console, seats.

The screen is the part that matters downstream -- it is emitted as its own mesh
with explicit UVs so the add-on can paint a live Blender image onto it (see
``model_y/screen_ui.py``).  Its size comes from the published 15.0 in diagonal
at 16:10, i.e. 323 x 202 mm of active area.
"""

from __future__ import annotations

import math

from ..specs import SPEC
from .mesh import Mesh, box, cylinder, grid_patch, loft, revolve

D = SPEC.dims
I = SPEC.interior

FLOOR_Z = 0.300          # cabin floor, sitting on top of the battery pack
DASH_TOP_Z = 1.075
DASH_X = 0.920
SCREEN_X = 0.760
SCREEN_CENTER_Z = 1.000
SCREEN_TILT = math.radians(6.0)   # slight rearward lean
DRIVER_Y = 0.365                  # left-hand drive: +Y is the left of the car


def screen_size() -> tuple[float, float]:
    diag = I.center_screen_diagonal_in * 0.0254
    a = I.center_screen_aspect
    h = diag / math.sqrt(1.0 + a * a)
    return a * h, h


def build_screen() -> Mesh:
    """The 15" centre display as a single UV'd quad (plus a black bezel)."""
    m = Mesh("Center_Screen")
    w, h = screen_size()
    hw, hh = w / 2.0, h / 2.0
    ct, st = math.cos(SCREEN_TILT), math.sin(SCREEN_TILT)

    def p(u: float, v: float, out: float = 0.0) -> tuple[float, float, float]:
        # u across (+Y), v up the panel; the panel leans back by SCREEN_TILT
        return (SCREEN_X - v * st - out * ct, u, SCREEN_CENTER_Z + v * ct - out * st)

    bez = 0.012
    quad = [p(-hw, -hh), p(hw, -hh), p(hw, hh), p(-hw, hh)]
    idx = m.add_verts(quad)
    # U runs right-to-left across the panel: the face the driver sees is the
    # -X side, so mapping U along +Y directly would mirror the whole UI
    m.add_face(idx, "Screen", uvs=[(1.0, 0.0), (0.0, 0.0), (0.0, 1.0), (1.0, 1.0)])
    # the surround sits *behind* the glass (negative offset is away from the
    # driver); in front of it, it would hide the display completely
    bezel = [p(-hw - bez, -hh - bez, -0.006), p(hw + bez, -hh - bez, -0.006),
             p(hw + bez, hh + bez, -0.006), p(-hw - bez, hh + bez, -0.006)]
    bi = m.add_verts(bezel)
    loft(m, [bezel, quad], "Trim_Gloss", closed_sections=True)
    m.add_face(list(reversed(bi)), "Trim_Gloss")
    # stalk mount back to the dash
    box(m, (SCREEN_X + 0.055, 0.0, SCREEN_CENTER_Z - 0.010), (0.090, 0.090, 0.090),
        "Trim_Gloss")
    m.shade_smooth = False
    return m


def build_dash() -> Mesh:
    m = Mesh("Dashboard")
    # wood-effect trim band spanning the cabin, the Model Y's one styling line
    rows = []
    for i in range(21):
        t = i / 20
        y = (t * 2 - 1) * 0.76
        taper = 1.0 - 0.35 * (abs(y) / 0.76) ** 2
        x_front = DASH_X + 0.12 * (1 - taper)
        rows.append([
            (x_front + 0.02, y, DASH_TOP_Z - 0.26),
            (x_front, y, DASH_TOP_Z - 0.10),
            (x_front - 0.055, y, DASH_TOP_Z - 0.020),
            (x_front - 0.30, y, DASH_TOP_Z + 0.010),
        ])
    cols = [[r[i] for r in rows] for i in range(4)]
    grid_patch(m, cols, "Dash_Trim")
    # lower dash / footwell closeout
    box(m, (DASH_X - 0.02, 0.0, FLOOR_Z + 0.16), (0.16, 1.45, 0.32), "Interior_Dark")
    return m


def build_steering_wheel() -> Mesh:
    """Round wheel (the Model Y kept one), 14.5 in across, raked ~24 degrees."""
    m = Mesh("Steering_Wheel")
    r = I.steering_wheel_diameter / 2.0
    rake = math.radians(24.0)
    cx, cy, cz = DASH_X - 0.185, DRIVER_Y, 0.935

    def place(px: float, py: float, pz: float) -> tuple[float, float, float]:
        # rotate about +Y so the wheel leans back, then translate to the column
        return (cx + px * math.cos(rake) - pz * math.sin(rake), cy + py,
                cz + px * math.sin(rake) + pz * math.cos(rake))

    rim_r = 0.0165
    ring_segs, tube_segs = 40, 10
    sections = []
    for i in range(ring_segs + 1):
        a = 2 * math.pi * i / ring_segs
        sec = []
        for j in range(tube_segs):
            b = 2 * math.pi * j / tube_segs
            rr = r + rim_r * math.cos(b)
            sec.append(place(rim_r * math.sin(b), rr * math.cos(a), rr * math.sin(a)))
        sections.append(sec)
    loft(m, sections, "Interior_Leather", closed_sections=True)

    # three spokes + centre boss with the T badge plate
    for ang in (math.radians(180), math.radians(-25), math.radians(205 - 360)):
        tip = (r * 0.92 * math.cos(ang), r * 0.92 * math.sin(ang))
        rows = []
        for t in (0.0, 1.0):
            yy = tip[0] * t
            zz = tip[1] * t
            wdt = 0.030 * (1.0 - 0.3 * t)
            rows.append([
                place(-0.010, yy - wdt * math.sin(ang), zz + wdt * math.cos(ang)),
                place(0.012, yy - wdt * math.sin(ang), zz + wdt * math.cos(ang)),
                place(0.012, yy + wdt * math.sin(ang), zz - wdt * math.cos(ang)),
                place(-0.010, yy + wdt * math.sin(ang), zz - wdt * math.cos(ang)),
            ])
        loft(m, rows, "Interior_Dark", closed_sections=True, cap_first=True, cap_last=True)
    boss = []
    for i in range(16):
        a = 2 * math.pi * i / 16
        boss.append(place(0.016, 0.055 * math.cos(a), 0.055 * math.sin(a)))
    bi = m.add_verts(boss)
    m.add_face(bi, "Trim_Gloss")

    # column
    cylinder(m, (cx + 0.10, cy, cz - 0.045), 0.032, 0.20, axis="x", segments=16,
             material="Interior_Dark")
    return m


def build_console() -> Mesh:
    m = Mesh("Center_Console")
    box(m, (0.520, 0.0, FLOOR_Z + 0.135), (0.760, 0.300, 0.270), "Trim_Gloss", bevel=0.03)
    box(m, (0.700, 0.0, FLOOR_Z + 0.275), (0.360, 0.270, 0.020), "Interior_Dark")  # trays
    box(m, (0.260, 0.0, FLOOR_Z + 0.300), (0.300, 0.290, 0.075), "Interior_Leather",
        bevel=0.02)  # armrest
    return m


def _seat(name: str, x: float, y: float, recline: float = 0.0,
          bench: bool = False) -> Mesh:
    m = Mesh(name)
    w = 1.30 if bench else 0.50
    cushion_z = FLOOR_Z + 0.135
    box(m, (x, y, cushion_z), (0.520, w, 0.130), "Interior_Leather", bevel=0.04)
    back_h = 0.640 if not bench else 0.600
    lean = math.radians(18.0 + recline)
    bx = x - 0.245 - math.sin(lean) * back_h * 0.5
    bz = cushion_z + 0.065 + math.cos(lean) * back_h * 0.5
    rows = []
    for i in range(5):
        t = i / 4
        h = -back_h / 2 + back_h * t
        bolster = 0.055 * (1 - t * 0.5) if not bench else 0.03
        px = bx - math.sin(lean) * h
        pz = bz + math.cos(lean) * h
        rows.append([
            (px + 0.060, -w / 2, pz), (px + 0.060 - bolster, -w / 2 * 0.86, pz),
            (px - 0.020, -w / 2 * 0.80, pz), (px - 0.020, w / 2 * 0.80, pz),
            (px + 0.060 - bolster, w / 2 * 0.86, pz), (px + 0.060, w / 2, pz),
        ])
    loft(m, rows, "Interior_Leather", closed_sections=True, cap_first=True, cap_last=True)
    if not bench:
        box(m, (bx - 0.02, y, bz + back_h / 2 + 0.055), (0.130, 0.190, 0.110),
            "Interior_Leather", bevel=0.03)  # headrest
        box(m, (x, y, FLOOR_Z + 0.045), (0.360, 0.180, 0.090), "Interior_Dark")  # rails
    return m


def build_seats() -> list[Mesh]:
    front_x, rear_x = 0.480, -0.440
    return [
        _seat("Seat_Driver", front_x, DRIVER_Y),
        _seat("Seat_Passenger", front_x, -DRIVER_Y),
        _seat("Seat_Rear_Bench", rear_x, 0.0, recline=4.0, bench=True),
    ]


def build_cabin_floor() -> Mesh:
    m = Mesh("Cabin_Floor")
    rows = []
    for i in range(13):
        x = 1.05 - 2.85 * i / 12
        w = 0.78
        rows.append([(x, -w, FLOOR_Z), (x, 0.0, FLOOR_Z + 0.004), (x, w, FLOOR_Z)])
    grid_patch(m, rows, "Interior_Dark")
    return m


def build_interior() -> list[Mesh]:
    parts = [build_cabin_floor(), build_dash(), build_console(), build_steering_wheel()]
    parts.extend(build_seats())
    parts.append(build_screen())
    return parts
