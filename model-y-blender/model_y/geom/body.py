"""Procedural Model Y body shell.

The body is a single lofted surface.  Its silhouette is driven by keyed curves
in vehicle X (roofline, lower edge, half-width, beltline, greenhouse width) that
are pinned to the published dimensions, so the finished mesh measures
4751 x 1920 x 1623 mm over a 2890 mm wheelbase by construction rather than by
eyeballing.

Wheel arches are cut analytically: the lower edge of each cross-section is
clipped up to the arch circle around the axle instead of being booleaned out
afterwards, which keeps the topology quad-only and the normals clean.

Materials are assigned per face from the surface position (paint, glass,
black cladding, pillar trim), so the greenhouse is part of the same continuous
shell -- which is also how the real car reads: an almost unbroken glass canopy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..specs import SPEC
from .mesh import Mesh, catmull_rom, sample_keyed

D = SPEC.dims
W = SPEC.wheels

NOSE = D.nose_x
TAIL = D.tail_x
FRONT_AXLE = D.front_axle_x
REAR_AXLE = D.rear_axle_x
HALF_W = D.half_width
ROOF = D.height

# Arch geometry: the opening clears the 711.9 mm tyre by ~45 mm all round.
ARCH_RADIUS = W.radius + 0.045
AXLE_Z = W.rolling_radius + (W.radius - W.rolling_radius)  # unloaded centre height
ARCH_INNER_Y = 0.58   # arch cut starts fading in here
ARCH_OUTER_Y = 0.74   # ... and is fully cut out here

# ---------------------------------------------------------------------------
# silhouette curves, all keyed in metres against vehicle X
# ---------------------------------------------------------------------------

ROOFLINE = [
    (TAIL, 0.980),        # bottom of the tailgate
    (-2.360, 1.090),
    (-2.300, 1.190),
    (-2.130, 1.315),      # spoiler lip / top of tailgate
    (-1.980, 1.372),
    (-1.560, 1.474),      # rear glass shoulder
    (-1.100, 1.566),
    (-0.550, 1.614),
    (0.150, ROOF),        # roof peak, 1623 mm
    (0.520, 1.605),
    (0.900, 1.470),       # windscreen header
    (1.060, 1.180),       # cowl
    (1.180, 1.108),
    (1.450, 1.062),       # over the front axle
    (1.900, 1.012),       # bonnet crown
    (2.150, 0.975),
    (2.290, 0.928),
    (NOSE, 0.862),        # blunt nose crown
]

LOWER_EDGE = [
    (TAIL, 0.300),        # rear fascia, near-vertical
    (-2.360, 0.255),
    (-2.290, 0.240),
    (-2.080, 0.235),      # rear bumper lower
    (-1.850, 0.206),
    (-1.300, 0.176),
    (0.000, 0.1676),      # 167.6 mm published ground clearance
    (1.300, 0.176),
    (1.850, 0.212),
    (2.120, 0.240),
    (2.280, 0.220),
    (NOSE, 0.245),        # front fascia runs low, near-vertical
]

HALF_WIDTH = [
    (TAIL, 0.760),
    (-2.360, 0.800),
    (-2.290, 0.830),
    (-2.080, 0.888),
    (-1.700, 0.918),
    (-1.150, 0.950),
    (-0.300, HALF_W),     # widest point, 960.1 mm half-width
    (0.500, 0.956),
    (1.150, 0.940),
    (1.700, 0.902),
    (2.060, 0.895),
    (2.240, 0.858),
    (2.320, 0.802),
    (NOSE, 0.720),
]

BELTLINE = [                # bottom of the side glass
    (TAIL, 0.980),
    (-2.130, 1.230),
    (-1.900, 1.175),
    (-1.560, 1.142),
    (-0.900, 1.100),
    (-0.200, 1.074),
    (0.500, 1.058),
    (0.900, 1.075),
    (1.060, 1.140),
    (1.180, 1.108),
    (NOSE, 0.620),
]

GREENHOUSE_HALF_WIDTH = [   # half width at the top of the glass
    (TAIL, 0.700),
    (-2.130, 0.620),
    (-1.700, 0.640),
    (-1.100, 0.690),
    (-0.300, 0.712),
    (0.300, 0.700),
    (0.700, 0.660),
    (0.980, 0.600),
    (1.100, 0.500),
    (NOSE, 0.560),
]

SHOULDER_Z = [              # height at which the section reaches max width
    (TAIL, 0.760),
    (-1.600, 0.800),
    (-0.300, 0.820),
    (1.000, 0.810),
    (1.900, 0.760),
    (NOSE, 0.700),
]

# Where the glass canopy starts and ends along X.
WINDSCREEN_BASE_X = 1.055
REAR_GLASS_BASE_X = -2.125

SECTION_SAMPLES = 26        # points per half-section after Catmull-Rom sampling


@dataclass(frozen=True)
class Station:
    """The silhouette parameters at one X position."""

    x: float
    z_low: float
    z_top: float
    half_width: float
    z_belt: float
    w_roof: float
    z_shoulder: float

    @classmethod
    def at(cls, x: float) -> "Station":
        z_top = sample_keyed(ROOFLINE, x)
        z_low = min(sample_keyed(LOWER_EDGE, x), z_top - 0.05)
        hw = sample_keyed(HALF_WIDTH, x)
        z_belt = min(sample_keyed(BELTLINE, x), z_top - 0.02)
        w_roof = min(sample_keyed(GREENHOUSE_HALF_WIDTH, x), hw)
        z_sh = min(max(sample_keyed(SHOULDER_Z, x), z_low + 0.04), z_belt - 0.02)
        return cls(x, z_low, z_top, hw, z_belt, w_roof, z_sh)

    def is_greenhouse(self) -> bool:
        return REAR_GLASS_BASE_X <= self.x <= WINDSCREEN_BASE_X


def arch_clearance(x: float, y: float) -> float:
    """Height the body must stay above at ``(x, y)`` to clear a wheel arch."""
    best = 0.0
    for axle in (FRONT_AXLE, REAR_AXLE):
        dx = x - axle
        if abs(dx) >= ARCH_RADIUS:
            continue
        z = AXLE_Z + math.sqrt(max(ARCH_RADIUS ** 2 - dx * dx, 0.0))
        best = max(best, z)
    if best <= 0.0:
        return 0.0
    ay = abs(y)
    if ay <= ARCH_INNER_Y:
        return 0.0
    t = min(1.0, (ay - ARCH_INNER_Y) / (ARCH_OUTER_Y - ARCH_INNER_Y))
    return best * (t * t * (3.0 - 2.0 * t))


def half_section(st: Station) -> list[tuple[float, float]]:
    """Control-point outline of the right half of a cross-section, (y, z)."""
    hw = st.half_width
    pts = [
        (0.0, st.z_low),
        (hw * 0.62, st.z_low + 0.004),
        (hw * 0.93, max(st.z_low + 0.10, st.z_shoulder - 0.20)),
        (hw, st.z_shoulder),
        (max(st.w_roof, hw * 0.90), st.z_belt),
    ]
    # The point count is fixed so every ring in the loft bridges 1:1; on the
    # bonnet and tailgate the two glass points simply collapse onto the crown.
    if st.z_top > st.z_belt + 0.10:          # a real greenhouse above the belt
        pts.append((st.w_roof * 0.985, st.z_belt + (st.z_top - st.z_belt) * 0.45))
        pts.append((st.w_roof * 0.80, st.z_top - 0.030))
    else:                                     # bonnet / tailgate: roll straight over
        w = min(st.w_roof, hw)
        pts.append((w * 0.96, st.z_belt + (st.z_top - st.z_belt) * 0.5))
        pts.append((w * 0.72, st.z_top - 0.018))
    pts.append((0.0, st.z_top))
    return pts


def section_ring(st: Station, samples: int = SECTION_SAMPLES) -> list[tuple[float, float, float]]:
    """Closed cross-section as a vertex ring, arch-clipped, in world space."""
    half = catmull_rom(half_section(st), samples)
    clipped: list[tuple[float, float]] = []
    for y, z in half:
        # the spline may overshoot its control points; the published silhouette
        # is the hard limit, so clamp back onto it before the arch cut
        y = min(max(y, 0.0), st.half_width)
        z = min(max(z, st.z_low), st.z_top)
        z = max(z, arch_clearance(st.x, y))
        clipped.append((y, z))
    ring = [(st.x, y, z) for y, z in clipped]
    # mirror back down the left side, skipping the shared centreline points
    for y, z in reversed(clipped[1:-1]):
        ring.append((st.x, -y, z))
    return ring


def station_positions() -> list[float]:
    """X positions for the loft, refined around the arches and the screen line."""
    xs: list[float] = []
    base = 46
    for i in range(base + 1):
        xs.append(NOSE + (TAIL - NOSE) * i / base)
    for axle in (FRONT_AXLE, REAR_AXLE):
        for k in range(-5, 6):
            xs.append(axle + ARCH_RADIUS * k / 5.0 * 0.995)
    xs.extend([WINDSCREEN_BASE_X + 0.02, WINDSCREEN_BASE_X - 0.02,
               REAR_GLASS_BASE_X + 0.02, REAR_GLASS_BASE_X - 0.02,
               NOSE - 0.02, TAIL + 0.02])
    clamped = {round(min(max(x, TAIL), NOSE), 5) for x in xs}
    clamped |= {round(NOSE, 5), round(TAIL, 5)}
    return sorted(clamped, reverse=True)


# ---------------------------------------------------------------------------
# material classification
# ---------------------------------------------------------------------------

PILLAR_BANDS = [(0.86, 1.02), (-0.34, -0.16), (-1.42, -1.20)]  # A, B, C pillars in X

# Panels that are separate objects with their own hinge, so they can open.
FRUNK_LID_X = (1.190, 2.235)
TAILGATE_X = (-2.395, -1.620)


def panel_of(x: float, y: float, z: float) -> str | None:
    """Which openable panel a face belongs to, if any."""
    st = Station.at(x)
    if FRUNK_LID_X[0] <= x <= FRUNK_LID_X[1]:
        if z > st.z_top - 0.075 and abs(y) < st.half_width * 0.80:
            return "Frunk_Lid"
    if TAILGATE_X[0] <= x <= TAILGATE_X[1]:
        # the whole hatch: rear glass, spoiler line and the panel below it
        if z > 0.86 and abs(y) < st.half_width * 0.93:
            return "Tailgate"
    return None


def classify(x: float, y: float, z: float) -> str:
    """Pick a material for a face from where its centre sits on the shell."""
    st = Station.at(x)
    ay = abs(y)
    # black lower cladding and arch lips
    if z < 0.255 or arch_clearance(x, y) > 0.0 and z < AXLE_Z + ARCH_RADIUS + 0.02 and _near_arch(x, y, z):
        return "Trim_Black"
    if x > 2.02 and z < 0.52:
        return "Trim_Black"          # lower front fascia
    if x < -2.02 and z < 0.52:
        return "Trim_Black"          # rear diffuser area
    if st.is_greenhouse() and z > st.z_belt + 0.012:
        for x0, x1 in PILLAR_BANDS:
            if x0 <= x <= x1 and ay > st.w_roof * 0.66:
                return "Trim_Black"
        return "Glass"
    return "Paint"


def _near_arch(x: float, y: float, z: float) -> bool:
    for axle in (FRONT_AXLE, REAR_AXLE):
        dx = x - axle
        dz = z - AXLE_Z
        r = math.hypot(dx, dz)
        if abs(r - ARCH_RADIUS) < 0.055 and abs(y) > ARCH_INNER_Y:
            return True
    return False


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------


def build_body() -> dict[str, Mesh]:
    """The shell, plus the frunk lid and tailgate as separate openable panels."""
    meshes = {"ModelY_Body": Mesh("ModelY_Body"),
              "Frunk_Lid": Mesh("Frunk_Lid"),
              "Tailgate": Mesh("Tailgate")}
    xs = station_positions()
    ring_pts = [section_ring(Station.at(x)) for x in xs]
    # every panel object shares the shell's vertex positions, so the shut lines
    # line up exactly; each mesh just keeps the vertices its own faces use
    index_maps: dict[str, dict[tuple[int, int], int]] = {k: {} for k in meshes}

    def vert(mesh_key: str, ring: int, i: int) -> int:
        cache = index_maps[mesh_key]
        key = (ring, i)
        if key not in cache:
            cache[key] = meshes[mesh_key].add_vert(ring_pts[ring][i])
        return cache[key]

    n = len(ring_pts[0])
    for r in range(len(ring_pts) - 1):
        p0, p1 = ring_pts[r], ring_pts[r + 1]
        for i in range(n):
            j = (i + 1) % n
            cx = (p0[i][0] + p1[i][0]) * 0.5
            cy = (p0[i][1] + p0[j][1] + p1[i][1] + p1[j][1]) * 0.25
            cz = (p0[i][2] + p0[j][2] + p1[i][2] + p1[j][2]) * 0.25
            target = panel_of(cx, cy, cz) or "ModelY_Body"
            meshes[target].add_face(
                [vert(target, r, i), vert(target, r, j),
                 vert(target, r + 1, j), vert(target, r + 1, i)],
                classify(cx, cy, cz))

    body = meshes["ModelY_Body"]
    nose = [vert("ModelY_Body", 0, i) for i in range(n)]
    tail = [vert("ModelY_Body", len(ring_pts) - 1, i) for i in range(n)]
    body.add_face(list(reversed(nose)), "Trim_Black")
    body.add_face(tail, "Trim_Black")
    body.merge(_underbody())
    return meshes


def panel_hinges() -> dict[str, tuple[float, float, float]]:
    """Hinge pivot for each openable panel, in world space."""
    return {
        # the bonnet is rear-hinged at the cowl, the tailgate at the roof
        "Frunk_Lid": (FRUNK_LID_X[0], 0.0, sample_keyed(ROOFLINE, FRUNK_LID_X[0])),
        "Tailgate": (TAILGATE_X[1], 0.0, sample_keyed(ROOFLINE, TAILGATE_X[1]) + 0.02),
    }


def _underbody() -> Mesh:
    """Flat battery-pack floor so the shell is closed when you look underneath."""
    m = Mesh("Underbody")
    x0, x1 = -1.95, 1.95
    y = 0.80
    z = 0.1676
    steps = 12
    rows = []
    for i in range(steps + 1):
        x = x0 + (x1 - x0) * i / steps
        w = y * (1.0 - 0.25 * max(0.0, (abs(x) - 1.4) / 0.6) ** 2)
        rows.append([(x, -w, z), (x, -w * 0.5, z), (x, w * 0.5, z), (x, w, z)])
    from .mesh import grid_patch
    grid_patch(m, rows, "Trim_Black")
    return m


# ---------------------------------------------------------------------------
# appendages
# ---------------------------------------------------------------------------


def surface_point(x: float, z: float, side: int, offset: float = 0.0) -> tuple[float, float, float]:
    """Point on the shell at height ``z`` for the given X, on ``side`` (+1 = left).

    Used to conform lamps and mirror stalks to the actual body surface rather
    than guessing coordinates that end up floating in space.
    """
    ring = section_ring(Station.at(x), samples=44)
    best = None
    for _, y, zz in ring:
        if (y >= 0) != (side > 0):
            continue
        d = abs(zz - z)
        if best is None or d < best[0]:
            best = (d, y, zz)
    if best is None:
        return (x, 0.0, z)
    _, y, zz = best
    return (x, y + side * offset, zz)


def build_mirrors() -> Mesh:
    """Both door mirrors; the pair sets the 2128.5 mm mirrors-out width."""
    m = Mesh("Mirrors")
    half_target = D.width_mirrors / 2.0
    base_x, base_z = 0.995, 1.120
    shell_len, shell_h, shell_depth = 0.185, 0.090, 0.110
    for side in (1, -1):
        root = surface_point(base_x, base_z, side, offset=-0.004)
        # the outermost point of the housing is what sets the published
        # mirrors-extended width, so place the shell centre back by its own reach
        shell_y = side * (half_target - shell_len * 0.34)
        # swept stalk: an oval section marching out from the sail panel
        sections = []
        steps = 6
        for i in range(steps + 1):
            t = i / steps
            y = root[1] + (shell_y - root[1]) * t
            x = base_x + 0.010 * t - 0.030 * t * t
            z = base_z + 0.030 * t
            rx = 0.052 - 0.014 * t
            rz = 0.030 + 0.012 * t
            sections.append([
                (x + rx * math.cos(a), y, z + rz * math.sin(a))
                for a in [2 * math.pi * k / 10 for k in range(10)]
            ])
        from .mesh import loft
        loft(m, sections if side > 0 else [list(reversed(sec)) for sec in sections],
             "Trim_Black", closed_sections=True, cap_first=True)
        _mirror_shell(m, base_x - 0.020, shell_y, base_z + 0.030, side,
                      shell_len, shell_h, shell_depth)
    return m


def _mirror_shell(m: Mesh, cx: float, cy: float, cz: float, side: int,
                  length: float, height: float, depth: float) -> None:
    """Housing plus the glass face, aligned across the car (long axis in Y)."""
    from .mesh import loft
    seg = 12
    back, front = [], []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        back.append((cx + depth * 0.60 * math.cos(a), cy + length * 0.34,
                     cz + height * 0.62 * math.sin(a)))
        front.append((cx + depth * 0.52 * math.cos(a) - 0.014, cy - length * 0.34,
                      cz + height * 0.52 * math.sin(a)))
    rings = [back, front] if side > 0 else [[*reversed(front)], [*reversed(back)]]
    loft(m, rings, "Paint", closed_sections=True, cap_first=True)
    glass = [(cx + depth * 0.46 * math.cos(2 * math.pi * i / seg) - 0.020,
              cy - length * 0.36,
              cz + height * 0.46 * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
    gi = m.add_verts(glass)
    m.add_face(gi if side > 0 else list(reversed(gi)), "Mirror_Glass")


def build_spoiler() -> Mesh:
    """Carbon-fibre-effect lip spoiler, standard on the Performance."""
    m = Mesh("Spoiler")
    x_root, x_tip = -2.055, -2.185
    rows = []
    for i in range(13):
        t = i / 12
        y = (t * 2 - 1) * 0.72
        droop = 0.020 * (1 - (abs(y) / 0.72) ** 2)
        rows.append([
            (x_root, y, sample_keyed(ROOFLINE, x_root) + 0.004),
            (x_root - 0.05, y, sample_keyed(ROOFLINE, x_root) + 0.020 + droop),
            (x_tip, y, sample_keyed(ROOFLINE, x_tip) + 0.038 + droop),
        ])
    from .mesh import grid_patch
    cols = [[r[i] for r in rows] for i in range(3)]
    grid_patch(m, cols, "Carbon")
    return m
