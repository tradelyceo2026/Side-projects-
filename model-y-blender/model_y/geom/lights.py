"""Head and tail lamps, conformed to the body shell.

Each lens is built by querying the body cross-section for the surface point at a
given (x, z) and pushing it out by a couple of millimetres, so the lamps follow
the real surface curvature instead of floating as flat decals.
"""

from __future__ import annotations

from .body import surface_point
from .mesh import Mesh, grid_patch

OFFSET = 0.005


def _lens(name: str, side: int, xs: list[float], z_lo: float, z_hi: float,
          material: str, rows: int = 4) -> Mesh:
    m = Mesh(name)
    grid = []
    for x in xs:
        col = []
        for r in range(rows):
            z = z_lo + (z_hi - z_lo) * r / (rows - 1)
            col.append(surface_point(x, z, side, offset=OFFSET))
        grid.append(col if side > 0 else list(reversed(col)))
    grid_patch(m, grid, material)
    return m


def build_lights() -> list[Mesh]:
    meshes: list[Mesh] = []
    for side, tag in ((1, "L"), (-1, "R")):
        # headlamp: wraps from the bonnet shut line around onto the front fender
        meshes.append(_lens(f"Headlight_{tag}", side,
                            [2.318, 2.288, 2.245, 2.192, 2.132, 2.068, 2.005],
                            0.815, 0.900, "Light_Head", rows=3))
        # tail lamp: the outboard quarter-panel unit
        meshes.append(_lens(f"Taillight_{tag}", side,
                            [-2.120, -2.180, -2.250, -2.320, -2.375],
                            1.020, 1.120, "Light_Tail", rows=3))
        # reflector strip low in the rear bumper
        meshes.append(_lens(f"Reflector_{tag}", side,
                            [-2.300, -2.355, -2.395],
                            0.430, 0.470, "Light_Tail", rows=2))
    # third brake light / tailgate light bar
    bar = Mesh("Brakelight_Bar")
    rows = []
    for i in range(13):
        y = (i / 12 * 2 - 1) * 0.60
        rows.append([(-2.080, y, 1.318), (-2.105, y, 1.330)])
    grid_patch(bar, rows, "Light_Tail")
    meshes.append(bar)
    return meshes
