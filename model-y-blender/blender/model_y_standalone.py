"""Tesla Model Y 2023 Performance -- single-file Blender build script.

This is the whole car in one file: no imports beyond ``bpy``/``math``, so it can
be pasted into Blender's text editor, piped to ``blender --background --python``,
or handed to a remote ``bpy`` worker that only accepts one code string.

It is a *port* of the ``model_y`` package, not a rewrite: the silhouette tables,
tyre maths, arch construction, screen layout and material values are the same
numbers, and ``tests/run_tests.py`` checks that this file and the package build
to the same published dimensions.  The package is still the source of truth --
it has the drivetrain simulation, the live screen and the Grok assistant; this
file builds the static car and paints one frame of its touchscreen.

    blender --background --python blender/model_y_standalone.py -- --out car.blend
"""

import math
import sys

try:
    import bpy
    from mathutils import Matrix, Vector
except ModuleNotFoundError:      # importable outside Blender for the tests
    bpy = None

# ---------------------------------------------------------------------------
# published specification (2023 Model Y Performance)
# ---------------------------------------------------------------------------

IN = 0.0254
LENGTH = 187.0 * IN              # 4750.7 mm
WIDTH = 75.6 * IN                # 1920.2 mm
WIDTH_MIRRORS = 83.8 * IN        # 2128.5 mm
HEIGHT = 63.9 * IN               # 1623.1 mm
WHEELBASE = 113.8 * IN           # 2890.5 mm
TRACK_F = 64.4 * IN
TRACK_R = 64.6 * IN
CLEARANCE = 6.6 * IN             # 167.6 mm
FRONT_OVERHANG = 35.4 * IN
REAR_OVERHANG = 37.8 * IN

RIM_R = 21.0 * IN / 2.0          # 21" Uberturbine
SIDEWALL = 0.255 * 0.35          # 255/35R21
TYRE_R = RIM_R + SIDEWALL        # 0.3560 m
TYRE_W = 0.255
SPOKES = 10

SCREEN_DIAG = 15.0 * IN          # 15" centre display, 16:10
SCREEN_H = SCREEN_DIAG / math.sqrt(1 + 1.6 ** 2)
SCREEN_W = SCREEN_H * 1.6

NOSE = WHEELBASE / 2 + FRONT_OVERHANG
TAIL = -(WHEELBASE / 2 + REAR_OVERHANG)
AXLE_F = WHEELBASE / 2
AXLE_R = -WHEELBASE / 2
HALF_W = WIDTH / 2

ARCH_R = TYRE_R + 0.045
AXLE_Z = TYRE_R
ARCH_IN, ARCH_OUT = 0.58, 0.74

PAINTS = {
    "Pearl White Multi-Coat": ((0.82, 0.82, 0.83), 0.30, 0.16),
    "Solid Black": ((0.012, 0.012, 0.013), 0.20, 0.13),
    "Midnight Silver Metallic": ((0.075, 0.080, 0.088), 0.85, 0.22),
    "Deep Blue Metallic": ((0.012, 0.038, 0.130), 0.80, 0.18),
    "Red Multi-Coat": ((0.400, 0.010, 0.014), 0.45, 0.14),
    "Quicksilver": ((0.330, 0.340, 0.350), 0.95, 0.25),
}

# ---------------------------------------------------------------------------
# silhouette, keyed against vehicle X (metres, +X forward, origin mid-wheelbase)
# ---------------------------------------------------------------------------

ROOFLINE = [
    (TAIL, 0.980), (-2.360, 1.090), (-2.300, 1.190), (-2.130, 1.315),
    (-1.980, 1.372), (-1.560, 1.474), (-1.100, 1.566), (-0.550, 1.614),
    (0.150, HEIGHT), (0.520, 1.605), (0.900, 1.470), (1.060, 1.180),
    (1.180, 1.108), (1.450, 1.062), (1.900, 1.012), (2.150, 0.975),
    (2.290, 0.928), (NOSE, 0.862),
]
LOWER_EDGE = [
    (TAIL, 0.300), (-2.360, 0.255), (-2.290, 0.240), (-2.080, 0.235),
    (-1.850, 0.206), (-1.300, 0.176), (0.000, CLEARANCE), (1.300, 0.176),
    (1.850, 0.212), (2.120, 0.240), (2.280, 0.220), (NOSE, 0.245),
]
HALF_WIDTH = [
    (TAIL, 0.760), (-2.360, 0.800), (-2.290, 0.830), (-2.080, 0.888),
    (-1.700, 0.918), (-1.150, 0.950), (-0.300, HALF_W), (0.500, 0.956),
    (1.150, 0.940), (1.700, 0.902), (2.060, 0.895), (2.240, 0.858),
    (2.320, 0.802), (NOSE, 0.720),
]
BELTLINE = [
    (TAIL, 0.980), (-2.130, 1.230), (-1.900, 1.175), (-1.560, 1.142),
    (-0.900, 1.100), (-0.200, 1.074), (0.500, 1.058), (0.900, 1.075),
    (1.060, 1.140), (1.180, 1.108), (NOSE, 0.620),
]
GREENHOUSE = [
    (TAIL, 0.700), (-2.130, 0.620), (-1.700, 0.640), (-1.100, 0.690),
    (-0.300, 0.712), (0.300, 0.700), (0.700, 0.660), (0.980, 0.600),
    (1.100, 0.500), (NOSE, 0.560),
]
SHOULDER = [
    (TAIL, 0.760), (-1.600, 0.800), (-0.300, 0.820), (1.000, 0.810),
    (1.900, 0.760), (NOSE, 0.700),
]

WINDSCREEN_X = 1.055
REAR_GLASS_X = -2.125
PILLARS = [(0.86, 1.02), (-0.34, -0.16), (-1.42, -1.20)]
FRUNK_X = (1.190, 2.235)
TAILGATE_X = (-2.395, -1.620)

FLOOR_Z = 0.300
DASH_X = 0.920
SCREEN_X = 0.760
SCREEN_Z = 1.000
SCREEN_TILT = math.radians(6.0)
DRIVER_Y = 0.365


# ---------------------------------------------------------------------------
# curve helpers
# ---------------------------------------------------------------------------


def key(table, x):
    if x <= table[0][0]:
        return table[0][1]
    if x >= table[-1][0]:
        return table[-1][1]
    for (x0, v0), (x1, v1) in zip(table, table[1:]):
        if x0 <= x <= x1:
            t = (x - x0) / (x1 - x0) if x1 > x0 else 0.0
            return v0 + (v1 - v0) * (t * t * (3.0 - 2.0 * t))
    return table[-1][1]


def catmull(points, samples, alpha=0.5):
    pts = [points[0]] + list(points) + [points[-1]]
    out = []
    segs = len(pts) - 3
    for s in range(segs):
        p0, p1, p2, p3 = pts[s], pts[s + 1], pts[s + 2], pts[s + 3]
        n = max(2, int(round(samples / segs)))
        for i in range(n + (1 if s == segs - 1 else 0)):
            out.append(_cr(p0, p1, p2, p3, i / n, alpha))
    return out


def _cr(p0, p1, p2, p3, t, alpha):
    def tj(ti, pa, pb):
        d = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
        return ti + (d ** alpha if d > 1e-9 else 1e-6)

    t0 = 0.0
    t1 = tj(t0, p0, p1)
    t2 = tj(t1, p1, p2)
    t3 = tj(t2, p2, p3)
    tt = t1 + (t2 - t1) * t

    def lp(a, b, ta, tb):
        if abs(tb - ta) < 1e-12:
            return a
        f = (tt - ta) / (tb - ta)
        return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)

    a1, a2, a3 = lp(p0, p1, t0, t1), lp(p1, p2, t1, t2), lp(p2, p3, t2, t3)
    return lp(lp(a1, a2, t0, t2), lp(a2, a3, t1, t3), t1, t2)


# ---------------------------------------------------------------------------
# mesh container
# ---------------------------------------------------------------------------


class Part:
    """Vertices, polygons, a material name per polygon, optional UVs."""

    def __init__(self, name):
        self.name = name
        self.verts = []
        self.faces = []
        self.mats = []
        self.uvs = []
        self.smooth = True

    def vert(self, v):
        self.verts.append((float(v[0]), float(v[1]), float(v[2])))
        return len(self.verts) - 1

    def ring(self, vs):
        return [self.vert(v) for v in vs]

    def face(self, idx, mat="Paint", uvs=None):
        clean = []
        for i in idx:
            if not clean or clean[-1] != i:
                clean.append(i)
        if len(clean) > 2 and clean[0] == clean[-1]:
            clean.pop()
        if len(clean) < 3:
            return
        self.faces.append(clean)
        self.mats.append(mat)
        self.uvs.append(uvs if uvs and len(uvs) == len(clean) else None)

    def merge(self, other):
        off = len(self.verts)
        self.verts.extend(other.verts)
        for f, m, uv in zip(other.faces, other.mats, other.uvs):
            self.faces.append([i + off for i in f])
            self.mats.append(m)
            self.uvs.append(uv)

    def bounds(self):
        xs = [v[0] for v in self.verts]
        ys = [v[1] for v in self.verts]
        zs = [v[2] for v in self.verts]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def loft(part, sections, mat="Paint", closed=True, cap_first=False, cap_last=False):
    rings = [part.ring(s) for s in sections]
    n = len(rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            part.face([r0[i], r0[j], r1[j], r1[i]], mat)
    if cap_first:
        part.face(list(reversed(rings[0])), mat)
    if cap_last:
        part.face(rings[-1], mat)
    return rings


def grid(part, rows, mat="Paint"):
    rings = [part.ring(r) for r in rows]
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(len(r0) - 1):
            part.face([r0[i], r0[i + 1], r1[i + 1], r1[i]], mat)
    return rings


def revolve(part, profile, segments, axis="y", mat="Paint", center=(0, 0, 0)):
    rings = []
    for s in range(segments):
        a = 2 * math.pi * s / segments
        ca, sa = math.cos(a), math.sin(a)
        sec = []
        for r, off in profile:
            if axis == "y":
                sec.append((center[0] + r * ca, center[1] + off, center[2] + r * sa))
            elif axis == "z":
                sec.append((center[0] + r * ca, center[1] + r * sa, center[2] + off))
            else:
                sec.append((center[0] + off, center[1] + r * ca, center[2] + r * sa))
        rings.append(part.ring(sec))
    n = len(profile)
    for k in range(segments):
        r0, r1 = rings[k], rings[(k + 1) % segments]
        for i in range(n - 1):
            part.face([r0[i], r0[i + 1], r1[i + 1], r1[i]], mat)
    return rings


def box(part, center, size, mat="Paint", bevel=0.0):
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    b = min(bevel, hx * 0.9, hy * 0.9)
    if b > 1e-6:
        ring = []
        for px, py in ((hx, hy), (-hx, hy), (-hx, -hy), (hx, -hy)):
            sx = 1 if px > 0 else -1
            sy = 1 if py > 0 else -1
            ring.append((px - sx * b, py))
            ring.append((px, py - sy * b))
    else:
        ring = [(hx, hy), (-hx, hy), (-hx, -hy), (hx, -hy)]
    low = [(cx + x, cy + y, cz - hz) for x, y in ring]
    up = [(cx + x, cy + y, cz + hz) for x, y in ring]
    loft(part, [low, up], mat, True, True, True)


def cylinder(part, center, radius, length, axis="y", segments=24, mat="Paint"):
    revolve(part, [(radius, -length / 2), (radius, length / 2)], segments, axis,
            mat, center)
    for end in (-length / 2, length / 2):
        ring = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            c, si = radius * math.cos(a), radius * math.sin(a)
            if axis == "y":
                ring.append((center[0] + c, center[1] + end, center[2] + si))
            elif axis == "z":
                ring.append((center[0] + c, center[1] + si, center[2] + end))
            else:
                ring.append((center[0] + end, center[1] + c, center[2] + si))
        idx = part.ring(ring)
        part.face(idx if end > 0 else list(reversed(idx)), mat)


# ---------------------------------------------------------------------------
# body
# ---------------------------------------------------------------------------


def station(x):
    z_top = key(ROOFLINE, x)
    z_low = min(key(LOWER_EDGE, x), z_top - 0.05)
    hw = key(HALF_WIDTH, x)
    z_belt = min(key(BELTLINE, x), z_top - 0.02)
    w_roof = min(key(GREENHOUSE, x), hw)
    z_sh = min(max(key(SHOULDER, x), z_low + 0.04), z_belt - 0.02)
    return x, z_low, z_top, hw, z_belt, w_roof, z_sh


def arch_clearance(x, y):
    best = 0.0
    for axle in (AXLE_F, AXLE_R):
        dx = x - axle
        if abs(dx) >= ARCH_R:
            continue
        best = max(best, AXLE_Z + math.sqrt(max(ARCH_R ** 2 - dx * dx, 0.0)))
    if best <= 0.0:
        return 0.0
    ay = abs(y)
    if ay <= ARCH_IN:
        return 0.0
    t = min(1.0, (ay - ARCH_IN) / (ARCH_OUT - ARCH_IN))
    return best * (t * t * (3.0 - 2.0 * t))


def section(st, samples=26):
    x, z_low, z_top, hw, z_belt, w_roof, z_sh = st
    pts = [
        (0.0, z_low),
        (hw * 0.62, z_low + 0.004),
        (hw * 0.93, max(z_low + 0.10, z_sh - 0.20)),
        (hw, z_sh),
        (max(w_roof, hw * 0.90), z_belt),
    ]
    if z_top > z_belt + 0.10:                      # greenhouse above the belt
        pts.append((w_roof * 0.985, z_belt + (z_top - z_belt) * 0.45))
        pts.append((w_roof * 0.80, z_top - 0.030))
    else:                                          # bonnet / tailgate crown
        w = min(w_roof, hw)
        pts.append((w * 0.96, z_belt + (z_top - z_belt) * 0.5))
        pts.append((w * 0.72, z_top - 0.018))
    pts.append((0.0, z_top))

    half = []
    for y, z in catmull(pts, samples):
        y = min(max(y, 0.0), hw)                   # the spline may overshoot
        z = min(max(z, z_low), z_top)
        half.append((y, max(z, arch_clearance(x, y))))
    ring = [(x, y, z) for y, z in half]
    for y, z in reversed(half[1:-1]):
        ring.append((x, -y, z))
    return ring


def stations():
    xs = []
    for i in range(47):
        xs.append(NOSE + (TAIL - NOSE) * i / 46)
    for axle in (AXLE_F, AXLE_R):
        for k in range(-5, 6):
            xs.append(axle + ARCH_R * k / 5.0 * 0.995)
    xs.extend([WINDSCREEN_X + 0.02, WINDSCREEN_X - 0.02, REAR_GLASS_X + 0.02,
               REAR_GLASS_X - 0.02, NOSE - 0.02, TAIL + 0.02])
    return sorted({round(min(max(x, TAIL), NOSE), 5) for x in xs}
                  | {round(NOSE, 5), round(TAIL, 5)}, reverse=True)


def classify(x, y, z):
    st = station(x)
    if z < 0.255 or (_near_arch(x, y, z)):
        return "Trim_Black"
    if (x > 2.02 or x < -2.02) and z < 0.52:
        return "Trim_Black"
    if REAR_GLASS_X <= x <= WINDSCREEN_X and z > st[4] + 0.012:
        for x0, x1 in PILLARS:
            if x0 <= x <= x1 and abs(y) > st[5] * 0.66:
                return "Trim_Black"
        return "Glass"
    return "Paint"


def _near_arch(x, y, z):
    for axle in (AXLE_F, AXLE_R):
        if abs(math.hypot(x - axle, z - AXLE_Z) - ARCH_R) < 0.055 and abs(y) > ARCH_IN:
            return True
    return False


def panel_of(x, y, z):
    st = station(x)
    if FRUNK_X[0] <= x <= FRUNK_X[1] and z > st[2] - 0.075 and abs(y) < st[3] * 0.80:
        return "Frunk_Lid"
    if TAILGATE_X[0] <= x <= TAILGATE_X[1] and z > 0.86 and abs(y) < st[3] * 0.93:
        return "Tailgate"
    return None


HINGES = {
    "Frunk_Lid": (FRUNK_X[0], 0.0, key(ROOFLINE, FRUNK_X[0])),
    "Tailgate": (TAILGATE_X[1], 0.0, key(ROOFLINE, TAILGATE_X[1]) + 0.02),
}


def build_body():
    parts = {n: Part(n) for n in ("ModelY_Body", "Frunk_Lid", "Tailgate")}
    xs = stations()
    rings = [section(station(x)) for x in xs]
    cache = {n: {} for n in parts}

    def vert(part_name, r, i):
        c = cache[part_name]
        if (r, i) not in c:
            c[(r, i)] = parts[part_name].vert(rings[r][i])
        return c[(r, i)]

    n = len(rings[0])
    for r in range(len(rings) - 1):
        p0, p1 = rings[r], rings[r + 1]
        for i in range(n):
            j = (i + 1) % n
            cx = (p0[i][0] + p1[i][0]) * 0.5
            cy = (p0[i][1] + p0[j][1] + p1[i][1] + p1[j][1]) * 0.25
            cz = (p0[i][2] + p0[j][2] + p1[i][2] + p1[j][2]) * 0.25
            target = panel_of(cx, cy, cz) or "ModelY_Body"
            parts[target].face([vert(target, r, i), vert(target, r, j),
                                vert(target, r + 1, j), vert(target, r + 1, i)],
                               classify(cx, cy, cz))
    body = parts["ModelY_Body"]
    body.face(list(reversed([vert("ModelY_Body", 0, i) for i in range(n)])), "Trim_Black")
    body.face([vert("ModelY_Body", len(rings) - 1, i) for i in range(n)], "Trim_Black")

    under = Part("Underbody")
    rows = []
    for i in range(13):
        x = -1.95 + 3.9 * i / 12
        w = 0.80 * (1.0 - 0.25 * max(0.0, (abs(x) - 1.4) / 0.6) ** 2)
        rows.append([(x, -w, CLEARANCE), (x, -w * 0.5, CLEARANCE),
                     (x, w * 0.5, CLEARANCE), (x, w, CLEARANCE)])
    grid(under, rows, "Trim_Black")
    body.merge(under)
    return parts


def surface_point(x, z, side, offset=0.0):
    best = None
    for _, y, zz in section(station(x), 44):
        if (y >= 0) != (side > 0):
            continue
        d = abs(zz - z)
        if best is None or d < best[0]:
            best = (d, y, zz)
    if best is None:
        return (x, 0.0, z)
    return (x, best[1] + side * offset, best[2])


def build_mirrors():
    m = Part("Mirrors")
    half = WIDTH_MIRRORS / 2.0
    bx, bz = 0.995, 1.120
    s_len, s_h, s_d = 0.185, 0.090, 0.110
    for side in (1, -1):
        root = surface_point(bx, bz, side, -0.004)
        shell_y = side * (half - s_len * 0.34)
        sections = []
        for i in range(7):
            t = i / 6
            y = root[1] + (shell_y - root[1]) * t
            x = bx + 0.010 * t - 0.030 * t * t
            z = bz + 0.030 * t
            rx, rz = 0.052 - 0.014 * t, 0.030 + 0.012 * t
            sections.append([(x + rx * math.cos(a), y, z + rz * math.sin(a))
                             for a in [2 * math.pi * k / 10 for k in range(10)]])
        loft(m, sections if side > 0 else [list(reversed(s)) for s in sections],
             "Trim_Black", True, True, False)
        seg = 12
        back, front = [], []
        cx, cz = bx - 0.020, bz + 0.030
        for i in range(seg):
            a = 2 * math.pi * i / seg
            back.append((cx + s_d * 0.60 * math.cos(a), shell_y + s_len * 0.34,
                         cz + s_h * 0.62 * math.sin(a)))
            front.append((cx + s_d * 0.52 * math.cos(a) - 0.014, shell_y - s_len * 0.34,
                          cz + s_h * 0.52 * math.sin(a)))
        rings = [back, front] if side > 0 else [front[::-1], back[::-1]]
        loft(m, rings, "Paint", True, True, False)
        glass = [(cx + s_d * 0.46 * math.cos(2 * math.pi * i / seg) - 0.020,
                  shell_y - s_len * 0.36,
                  cz + s_h * 0.46 * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
        gi = m.ring(glass)
        m.face(gi if side > 0 else list(reversed(gi)), "Mirror_Glass")
    return m


def build_spoiler():
    m = Part("Spoiler")
    x_root, x_tip = -2.055, -2.185
    rows = []
    for i in range(13):
        y = (i / 12 * 2 - 1) * 0.72
        droop = 0.020 * (1 - (abs(y) / 0.72) ** 2)
        rows.append([(x_root, y, key(ROOFLINE, x_root) + 0.004),
                     (x_root - 0.05, y, key(ROOFLINE, x_root) + 0.020 + droop),
                     (x_tip, y, key(ROOFLINE, x_tip) + 0.038 + droop)])
    grid(m, [[r[i] for r in rows] for i in range(3)], "Carbon")
    return m


def build_lights():
    out = []
    for side, tag in ((1, "L"), (-1, "R")):
        for name, xs, z0, z1, mat, rows in (
            ("Headlight", [2.318, 2.288, 2.245, 2.192, 2.132, 2.068, 2.005],
             0.815, 0.900, "Light_Head", 3),
            ("Taillight", [-2.120, -2.180, -2.250, -2.320, -2.375],
             1.020, 1.120, "Light_Tail", 3),
            ("Reflector", [-2.300, -2.355, -2.395], 0.430, 0.470, "Light_Tail", 2),
        ):
            p = Part("%s_%s" % (name, tag))
            cols = []
            for x in xs:
                col = [surface_point(x, z0 + (z1 - z0) * r / (rows - 1), side, 0.005)
                       for r in range(rows)]
                cols.append(col if side > 0 else col[::-1])
            grid(p, cols, mat)
            out.append(p)
    bar = Part("Brakelight_Bar")
    grid(bar, [[(-2.080, (i / 12 * 2 - 1) * 0.60, 1.318),
                (-2.105, (i / 12 * 2 - 1) * 0.60, 1.330)] for i in range(13)],
         "Light_Tail")
    out.append(bar)
    return out


# ---------------------------------------------------------------------------
# wheels
# ---------------------------------------------------------------------------


def wheel_centers():
    return [("Wheel_FL", (AXLE_F, TRACK_F / 2 - TYRE_W / 2, TYRE_R), 1),
            ("Wheel_FR", (AXLE_F, -(TRACK_F / 2 - TYRE_W / 2), TYRE_R), -1),
            ("Wheel_RL", (AXLE_R, TRACK_R / 2 - TYRE_W / 2, TYRE_R), 1),
            ("Wheel_RR", (AXLE_R, -(TRACK_R / 2 - TYRE_W / 2), TYRE_R), -1)]


def build_wheel(name, center, side):
    p = Part(name)
    hw = TYRE_W / 2
    cx, cy, cz = center
    shoulder = TYRE_R - 0.012
    revolve(p, [(RIM_R, -hw * 0.92), (RIM_R + 0.030, -hw * 0.99),
                (TYRE_R - 0.030, -hw), (shoulder, -hw * 0.92), (TYRE_R, -hw * 0.62),
                (TYRE_R, hw * 0.62), (shoulder, hw * 0.92), (TYRE_R - 0.030, hw),
                (RIM_R + 0.030, hw * 0.99), (RIM_R, hw * 0.92)],
            48, "y", "Tire", center)
    revolve(p, [(RIM_R, -hw * 0.90), (RIM_R * 0.72, -hw * 0.55), (RIM_R * 0.72, hw * 0.25),
                (RIM_R, hw * 0.88), (RIM_R - 0.016, hw * 0.90)], 48, "y",
            "Wheel_Alloy", center)

    face_y = cy + side * hw * 0.86
    hub_r = 0.072
    hub = [(cx + hub_r * math.cos(2 * math.pi * i / 24), face_y,
            cz + hub_r * math.sin(2 * math.pi * i / 24)) for i in range(24)]
    inner = [(cx + hub_r * 0.62 * math.cos(2 * math.pi * i / 24), face_y - side * 0.012,
              cz + hub_r * 0.62 * math.sin(2 * math.pi * i / 24)) for i in range(24)]
    loft(p, [hub, inner], "Wheel_Alloy", True, False, True)
    for i in range(5):
        a = 2 * math.pi * i / 5 + math.pi / 2
        lx, lz = cx + 0.048 * math.cos(a), cz + 0.048 * math.sin(a)
        ring = [(lx + 0.010 * math.cos(t), face_y + side * 0.004, lz + 0.010 * math.sin(t))
                for t in [2 * math.pi * k / 8 for k in range(8)]]
        idx = p.ring(ring)
        p.face(idx if side > 0 else list(reversed(idx)), "Wheel_Dark")

    # ten twisted turbine blades, hub to rim lip
    span = math.radians(360.0 / SPOKES * 0.74)
    for b in range(SPOKES):
        a0 = 2 * math.pi * b / SPOKES
        rows = []
        for s in range(8):
            t = s / 7
            r = hub_r * 0.98 + (RIM_R - 0.006 - hub_r * 0.98) * t
            a = a0 + span * (0.35 + 0.65 * t)
            depth = side * (0.014 + 0.020 * t) * math.cos(math.radians(16.0))
            half = span * (0.50 - 0.16 * t)
            rows.append([
                (cx + r * math.cos(a - half), face_y - depth * 0.15,
                 cz + r * math.sin(a - half)),
                (cx + r * math.cos(a), face_y - depth * 0.55, cz + r * math.sin(a)),
                (cx + r * math.cos(a + half), face_y - depth, cz + r * math.sin(a + half)),
            ])
        cols = [[row[i] for row in rows] for i in range(3)]
        grid(p, cols, "Wheel_Alloy")
        grid(p, [[(v[0], v[1] - side * 0.010, v[2]) for v in c] for c in cols[::-1]],
             "Wheel_Dark")

    disc_r, disc_y = 0.183, cy - side * 0.018
    revolve(p, [(disc_r, -0.014), (disc_r, 0.014), (disc_r * 0.42, 0.014),
                (disc_r * 0.42, -0.014)], 32, "y", "Brake_Disc", (cx, disc_y, cz))
    rows = []
    for i in range(9):
        a = math.radians(112) + (math.radians(168) - math.radians(112)) * i / 8
        ri, ro = disc_r * 0.72, disc_r * 1.03
        rows.append([(cx + ri * math.cos(a), disc_y - side * 0.030, cz + ri * math.sin(a)),
                     (cx + ro * math.cos(a), disc_y - side * 0.030, cz + ro * math.sin(a)),
                     (cx + ro * math.cos(a), disc_y + side * 0.030, cz + ro * math.sin(a)),
                     (cx + ri * math.cos(a), disc_y + side * 0.030, cz + ri * math.sin(a))])
    loft(p, rows, "Brake_Caliper", True, True, True)
    return p


# ---------------------------------------------------------------------------
# interior
# ---------------------------------------------------------------------------


def build_screen_quad():
    p = Part("Center_Screen")
    hw, hh = SCREEN_W / 2, SCREEN_H / 2
    ct, st = math.cos(SCREEN_TILT), math.sin(SCREEN_TILT)

    def pt(u, v, out=0.0):
        return (SCREEN_X - v * st - out * ct, u, SCREEN_Z + v * ct - out * st)

    quad = [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)]
    p.face(p.ring(quad), "Screen", [(0, 0), (1, 0), (1, 1), (0, 1)])
    bez = [pt(-hw - 0.012, -hh - 0.012, 0.004), pt(hw + 0.012, -hh - 0.012, 0.004),
           pt(hw + 0.012, hh + 0.012, 0.004), pt(-hw - 0.012, hh + 0.012, 0.004)]
    bi = p.ring(bez)
    loft(p, [bez, quad], "Trim_Gloss", True)
    p.face(list(reversed(bi)), "Trim_Gloss")
    box(p, (SCREEN_X + 0.055, 0.0, SCREEN_Z - 0.010), (0.090, 0.090, 0.090), "Trim_Gloss")
    p.smooth = False
    return p


def build_interior():
    parts = []

    floor = Part("Cabin_Floor")
    grid(floor, [[(1.05 - 2.85 * i / 12, -0.78, FLOOR_Z),
                  (1.05 - 2.85 * i / 12, 0.0, FLOOR_Z + 0.004),
                  (1.05 - 2.85 * i / 12, 0.78, FLOOR_Z)] for i in range(13)],
         "Interior_Dark")
    parts.append(floor)

    dash = Part("Dashboard")
    rows = []
    for i in range(21):
        y = (i / 20 * 2 - 1) * 0.76
        xf = DASH_X + 0.12 * (0.35 * (abs(y) / 0.76) ** 2)
        rows.append([(xf + 0.02, y, 0.815), (xf, y, 0.975), (xf - 0.055, y, 1.055),
                     (xf - 0.30, y, 1.085)])
    grid(dash, [[r[i] for r in rows] for i in range(4)], "Dash_Trim")
    box(dash, (DASH_X - 0.02, 0.0, FLOOR_Z + 0.16), (0.16, 1.45, 0.32), "Interior_Dark")
    parts.append(dash)

    console = Part("Center_Console")
    box(console, (0.520, 0.0, FLOOR_Z + 0.135), (0.760, 0.300, 0.270), "Trim_Gloss", 0.03)
    box(console, (0.700, 0.0, FLOOR_Z + 0.275), (0.360, 0.270, 0.020), "Interior_Dark")
    box(console, (0.260, 0.0, FLOOR_Z + 0.300), (0.300, 0.290, 0.075),
        "Interior_Leather", 0.02)
    parts.append(console)

    parts.append(build_steering_wheel())
    for name, x, y, bench, recline in (("Seat_Driver", 0.480, DRIVER_Y, False, 0.0),
                                       ("Seat_Passenger", 0.480, -DRIVER_Y, False, 0.0),
                                       ("Seat_Rear_Bench", -0.440, 0.0, True, 4.0)):
        parts.append(build_seat(name, x, y, bench, recline))
    parts.append(build_screen_quad())
    return parts


def build_steering_wheel():
    p = Part("Steering_Wheel")
    r = 14.5 * IN / 2
    rake = math.radians(24.0)
    cx, cy, cz = DASH_X - 0.185, DRIVER_Y, 0.935

    def place(px, py, pz):
        return (cx + px * math.cos(rake) - pz * math.sin(rake), cy + py,
                cz + px * math.sin(rake) + pz * math.cos(rake))

    rim = 0.0165
    sections = []
    for i in range(41):
        a = 2 * math.pi * i / 40
        sec = []
        for j in range(10):
            b = 2 * math.pi * j / 10
            rr = r + rim * math.cos(b)
            sec.append(place(rim * math.sin(b), rr * math.cos(a), rr * math.sin(a)))
        sections.append(sec)
    loft(p, sections, "Interior_Leather", True)
    for ang in (math.radians(180), math.radians(-25), math.radians(-155)):
        tip = (r * 0.92 * math.cos(ang), r * 0.92 * math.sin(ang))
        rows = []
        for t in (0.0, 1.0):
            yy, zz = tip[0] * t, tip[1] * t
            w = 0.030 * (1.0 - 0.3 * t)
            rows.append([place(-0.010, yy - w * math.sin(ang), zz + w * math.cos(ang)),
                         place(0.012, yy - w * math.sin(ang), zz + w * math.cos(ang)),
                         place(0.012, yy + w * math.sin(ang), zz - w * math.cos(ang)),
                         place(-0.010, yy + w * math.sin(ang), zz - w * math.cos(ang))])
        loft(p, rows, "Interior_Dark", True, True, True)
    p.face(p.ring([place(0.016, 0.055 * math.cos(2 * math.pi * i / 16),
                         0.055 * math.sin(2 * math.pi * i / 16)) for i in range(16)]),
           "Trim_Gloss")
    cylinder(p, (cx + 0.10, cy, cz - 0.045), 0.032, 0.20, "x", 16, "Interior_Dark")
    return p


def build_seat(name, x, y, bench=False, recline=0.0):
    p = Part(name)
    w = 1.30 if bench else 0.50
    cushion = FLOOR_Z + 0.135
    box(p, (x, y, cushion), (0.520, w, 0.130), "Interior_Leather", 0.04)
    back_h = 0.600 if bench else 0.640
    lean = math.radians(18.0 + recline)
    bx = x - 0.245 - math.sin(lean) * back_h * 0.5
    bz = cushion + 0.065 + math.cos(lean) * back_h * 0.5
    rows = []
    for i in range(5):
        t = i / 4
        h = -back_h / 2 + back_h * t
        bolster = 0.03 if bench else 0.055 * (1 - t * 0.5)
        px = bx - math.sin(lean) * h
        pz = bz + math.cos(lean) * h
        rows.append([(px + 0.060, y - w / 2, pz),
                     (px + 0.060 - bolster, y - w / 2 * 0.86, pz),
                     (px - 0.020, y - w / 2 * 0.80, pz),
                     (px - 0.020, y + w / 2 * 0.80, pz),
                     (px + 0.060 - bolster, y + w / 2 * 0.86, pz),
                     (px + 0.060, y + w / 2, pz)])
    loft(p, rows, "Interior_Leather", True, True, True)
    if not bench:
        box(p, (bx - 0.02, y, bz + back_h / 2 + 0.055), (0.130, 0.190, 0.110),
            "Interior_Leather", 0.03)
        box(p, (x, y, FLOOR_Z + 0.045), (0.360, 0.180, 0.090), "Interior_Dark")
    return p


def build_all_parts():
    parts = list(build_body().values())
    parts.append(build_mirrors())
    parts.append(build_spoiler())
    parts.extend(build_lights())
    for name, center, side in wheel_centers():
        parts.append(build_wheel(name, center, side))
    parts.extend(build_interior())
    return parts


# ---------------------------------------------------------------------------
# the 15" touchscreen, rasterised into a Blender image
# ---------------------------------------------------------------------------

FONT_5X7 = ' 0000000AEHHVHHHBUHHUHHUCEHGGGHEDUHHHHHUEVGGUGGVFVGGUGGGGEHGNHHFHHHHVHHHIE44444EJ72222ICKHIKOKIHLGGGGGGVMHRLLHHHNHPLJHHHOEHHHHHEPUHHUGGGQEHHHLIDRUHHUKIHSFGGE11UTV444444UHHHHHHEVHHHHHA4WHHHLLRHXHHA4AHHYHHA4444ZV1248GV0EHJLPHE14C4444E2EH1248V3V2421HE426AIV225VGU11HE668GUHHE7V1248888EHHEHHE9EHHF12C.00000CC,0000CC8:0CC0CC0;0CC0CC8-000V000_000000V+044V440=00V0V00/122488G%PQ248BJ\'4400000"AA00000!4444404?EH12404(2488842)8422248[E88888E]E22222E<248G842>8421248*0LEVEL0#AAVAVAA@EHNLNGE&CIK8LID|4444444^4AH0000~09M0000'
FONT = {}


def _decode_font():
    """Unpack the base32-per-row glyph table into rows of 0/1."""
    if FONT:
        return FONT
    # fixed 8-char records: the character, then one base32 digit per pixel row
    for i in range(0, len(FONT_5X7), 8):
        ch, rows = FONT_5X7[i], FONT_5X7[i + 1:i + 8]
        FONT[ch] = [[(int(r, 32) >> (4 - b)) & 1 for b in range(5)] for r in rows]
    return FONT


class Canvas:
    """Float-RGBA framebuffer laid out for bpy.types.Image.pixels."""

    def __init__(self, w, h, bg=(0, 0, 0, 1)):
        self.w, self.h = w, h
        self.buf = list(bg) * (w * h)

    def rect(self, x, y, w, h, c):
        x0, y0 = max(0, int(round(x))), max(0, int(round(y)))
        x1, y1 = min(self.w, int(round(x + w))), min(self.h, int(round(y + h)))
        if x1 <= x0 or y1 <= y0:
            return
        span = list(c) * (x1 - x0)
        row = self.w * 4
        for py in range(y0, y1):
            s = py * row + x0 * 4
            self.buf[s:s + len(span)] = span

    def round_rect(self, x, y, w, h, r, c):
        r = max(0.0, min(r, w / 2, h / 2))
        self.rect(x, y + r, w, h - 2 * r, c)
        self.rect(x + r, y, w - 2 * r, r, c)
        self.rect(x + r, y + h - r, w - 2 * r, r, c)
        for cx, cy in ((x + r, y + r), (x + w - r, y + r), (x + r, y + h - r),
                       (x + w - r, y + h - r)):
            self.disc(cx, cy, r, c)

    def disc(self, cx, cy, r, c):
        for py in range(max(0, int(cy - r)), min(self.h, int(cy + r + 1))):
            dy = py + 0.5 - cy
            dx = math.sqrt(max(r * r - dy * dy, 0.0))
            self.rect(cx - dx, py, dx * 2, 1, c)

    def line(self, x0, y0, x1, y1, c, t=3.0):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0)))
        for i in range(n + 1):
            f = i / n
            self.disc(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, t / 2, c)

    def text(self, x, y, s, c, scale=2, track=1):
        font = _decode_font()
        cx = x
        for ch in s:
            rows = font.get(ch.upper(), font.get("?"))
            for ry in range(7):
                for rx in range(5):
                    if rows[ry][rx]:
                        self.rect(cx + rx * scale, y + ry * scale, scale, scale, c)
            cx += (5 + track) * scale
        return cx - x

    def width(self, s, scale=2, track=1):
        return (5 * scale + track * scale) * len(s) - track * scale if s else 0

    def text_right(self, rx, y, s, c, scale=2):
        self.text(rx - self.width(s, scale), y, s, c, scale)

    def text_center(self, cx, y, s, c, scale=2):
        self.text(cx - self.width(s, scale) / 2, y, s, c, scale)

    def flipped(self):
        """Bottom-up row order, which is what Image.pixels wants."""
        out = []
        row = self.w * 4
        for y in range(self.h - 1, -1, -1):
            out.extend(self.buf[y * row:(y + 1) * row])
        return out


def _srgb(hexcode, a=1.0):
    h = hexcode.lstrip("#")
    out = []
    for i in (0, 2, 4):
        v = int(h[i:i + 2], 16) / 255.0
        out.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2], a)


UI = {
    "bg": _srgb("#0c0d10"), "panel": _srgb("#16181d"), "hi": _srgb("#1e2128"),
    "line": _srgb("#2b2f38"), "text": _srgb("#e8eaee"), "dim": _srgb("#8b9098"),
    "accent": _srgb("#3e9dff"), "green": _srgb("#38d17a"), "amber": _srgb("#ffb020"),
    "red": _srgb("#ff4d4d"), "grok": _srgb("#8e7bff"), "road": _srgb("#242830"),
}


def render_screen(w=1024, h=640, state=None):
    """One frame of the centre display, drawn from a small state dict."""
    s = {"speed_mph": 0, "gear": "P", "soc": 0.72, "range_mi": 205, "temp_c": 21.0,
         "cabin_c": 21.0, "outside_c": 14, "locked": True, "paint": "Deep Blue Metallic",
         "media": "NIGHTCALL - KAVINSKY", "volume": 6, "destination": "",
         "odometer_mi": 12874, "frunk": False, "trunk": False, "headlights": False,
         "clock": "9:41 AM", "chat": [], "grok_live": False, "fan": 3}
    s.update(state or {})
    c = Canvas(w, h, UI["bg"])

    # status bar
    c.rect(0, 0, w, 34, UI["panel"])
    c.rect(0, 33, w, 1, UI["line"])
    c.text(14, 10, s["clock"], UI["text"])
    c.text(120, 10, "%d C OUTSIDE" % s["outside_c"], UI["dim"])
    c.text(300, 10, "LOCKED" if s["locked"] else "UNLOCKED",
           UI["green"] if s["locked"] else UI["amber"])
    badge = "GROK LIVE" if s["grok_live"] else "GROK OFFLINE"
    bw = len(badge) * 12 + 22
    c.round_rect(w - bw - 12, 6, bw, 22, 8, UI["grok"] if s["grok_live"] else UI["hi"])
    c.text(w - bw - 1, 10, badge, UI["bg"] if s["grok_live"] else UI["dim"])
    c.text_right(w - bw - 26, 10, "%s MI" % format(s["odometer_mi"], ","), UI["dim"])

    pad, left_w, body_y = 12, int(w * 0.34), 46
    body_h = h - 34 - 84 - 24

    # car card
    c.round_rect(pad, body_y, left_w - pad, body_h, 14, UI["panel"])
    for i, g in enumerate("PRND"):
        gy = body_y + 16 + i * 30
        if s["gear"] == g:
            c.round_rect(pad + 12, gy - 5, 28, 28, 6, UI["hi"])
        c.text(pad + 18, gy, g, UI["text"] if s["gear"] == g else UI["dim"],
               3 if s["gear"] == g else 2)
    cx = pad + (left_w - pad) * 0.62
    c.text_center(cx, body_y + 14, "%d" % round(s["speed_mph"]), UI["text"], 7)
    c.text_center(cx, body_y + 66, "MPH", UI["dim"])
    _plan_view(c, s, pad + 14, body_y + 112, left_w - pad - 28, body_h - 200)
    _battery(c, s, pad + 16, body_y + body_h - 74, left_w - pad - 32)

    # map / grok panel
    mx, mw = left_w + pad, w - left_w - pad * 2
    if s["chat"]:
        _grok_panel(c, s, mx, body_y, mw, body_h)
    else:
        _map_panel(c, s, mx, body_y, mw, body_h)

    _bottom_bar(c, s, h - 84, w)
    return c


def _plan_view(c, s, x, y, w, h):
    scale = min(w / 2.2, h / (NOSE - TAIL))
    cx = x + w / 2
    top = y + (h - (NOSE - TAIL) * scale) / 2
    rgb = PAINTS.get(s["paint"], PAINTS["Deep Blue Metallic"])[0]
    col = (rgb[0], rgb[1], rgb[2], 1.0)
    prev = None
    for i in range(47):
        vx = NOSE - (NOSE - TAIL) * i / 46
        hw = key(HALF_WIDTH, vx) * scale
        py = top + (NOSE - vx) * scale
        if prev is not None:
            c.rect(cx - hw, py - 1, hw * 2, 2 + (py - prev), col)
        prev = py
    g0 = top + (NOSE - 1.02) * scale
    g1 = top + (NOSE + 1.92) * scale
    c.round_rect(cx - 0.60 * scale, g0, 1.20 * scale, g1 - g0, 9, _srgb("#11151c"))
    if s["frunk"]:
        c.round_rect(cx - 0.55 * scale, top + 0.10 * scale, 1.10 * scale,
                     0.80 * scale, 8, UI["amber"])
    if s["trunk"]:
        c.round_rect(cx - 0.62 * scale, top + (NOSE + 1.45) * scale, 1.24 * scale,
                     0.70 * scale, 8, UI["amber"])
    if s["headlights"]:
        for side in (-1, 1):
            c.disc(cx + side * 0.42 * scale, top + 0.06 * scale, 7, _srgb("#fff6d8"))


def _battery(c, s, x, y, w):
    pct = s["soc"]
    col = UI["green"] if pct > 0.25 else (UI["amber"] if pct > 0.12 else UI["red"])
    c.round_rect(x, y, w - 14, 22, 5, UI["hi"])
    c.round_rect(x + 2, y + 2, max(4.0, (w - 18) * pct), 18, 4, col)
    c.round_rect(x + w - 12, y + 6, 6, 10, 2, UI["hi"])
    c.text(x, y + 32, "%d%%" % round(pct * 100), UI["text"], 3)
    c.text_right(x + w - 14, y + 34, "%d MI" % round(s["range_mi"]), UI["dim"])


def _map_panel(c, s, x, y, w, h):
    c.round_rect(x, y, w, h, 14, UI["panel"])
    for i in range(1, 7):
        c.rect(x + w * i / 7, y + 8, 3, h - 16, UI["road"])
    for j in range(1, 5):
        c.rect(x + 8, y + h * j / 5, w - 16, 3, UI["road"])
    px, py = x + w * 0.28, y + h - 40
    if s["destination"]:
        pts = [(px, py), (px, y + h * 0.55), (x + w * 0.58, y + h * 0.55),
               (x + w * 0.58, y + h * 0.22), (x + w * 0.85, y + h * 0.22)]
        for a, b in zip(pts, pts[1:]):
            c.line(a[0], a[1], b[0], b[1], UI["accent"], 6)
        c.disc(pts[-1][0], pts[-1][1], 9, UI["red"])
        c.round_rect(x + 12, y + 12, w - 24, 56, 10, UI["hi"])
        c.text(x + 26, y + 22, s["destination"].upper()[:28], UI["text"])
        c.text(x + 26, y + 44, "%s MI" % s.get("distance_mi", "18.0"), UI["dim"])
    else:
        c.text_center(x + w / 2, y + 18, "NO DESTINATION SET", UI["dim"])
        c.text_center(x + w / 2, y + 40, "ASK GROK TO NAVIGATE", UI["dim"])
    c.disc(px, py, 10, UI["accent"])
    c.disc(px, py, 4, UI["text"])


def _grok_panel(c, s, x, y, w, h):
    c.round_rect(x, y, w, h, 14, UI["panel"])
    c.rect(x + 14, y + 34, w - 28, 2, UI["line"])
    c.text(x + 16, y + 12, "GROK", UI["grok"], 3)
    c.text_right(x + w - 16, y + 14,
                 "XAI API" if s["grok_live"] else "LOCAL INTENT ENGINE", UI["dim"])
    maxc = int((w - 76) / 12)
    lines = []
    for role, text in s["chat"]:
        words, cur = text.upper().split(), ""
        for word in words:
            if not cur:
                cur = word
            elif len(cur) + 1 + len(word) <= maxc:
                cur += " " + word
            else:
                lines.append((role, cur))
                cur = word
        if cur:
            lines.append((role, cur))
    for i, (role, line) in enumerate(lines[-int((h - 60) / 20):]):
        ly = y + 50 + i * 20
        if role == "user":
            c.text_right(x + w - 20, ly, line, UI["accent"])
        else:
            c.rect(x + 18, ly + 2, 3, 12, UI["grok"])
            c.text(x + 30, ly, line, UI["text"])


def _bottom_bar(c, s, y, w):
    c.rect(0, y, w, 84, UI["panel"])
    c.rect(0, y, w, 1, UI["line"])
    c.text(24, y + 16, "%.1f" % s["temp_c"], UI["text"], 4)
    c.text(140, y + 24, "C", UI["dim"])
    c.text(24, y + 52, "CABIN %d C" % round(s["cabin_c"]), UI["dim"])
    for i in range(5):
        c.round_rect(190 + i * 14, y + 44 - i * 4, 9, 18 + i * 4, 3,
                     UI["accent"] if i < s["fan"] else UI["hi"])
    c.text(190, y + 16, "FAN", UI["dim"])
    c.disc(434, y + 38, 14, UI["hi"])
    c.text(428, y + 31, ">", UI["text"])
    c.text(462, y + 22, s["media"][:26], UI["text"])
    c.text(462, y + 46, "VOLUME %d" % s["volume"], UI["dim"])
    c.text_right(w - 24, y + 16, "STANDARD - STRONG REGEN", UI["dim"])
    c.text_right(w - 24, y + 44, "%d MI RANGE" % round(s["range_mi"]), UI["text"])


# ---------------------------------------------------------------------------
# Blender scene
# ---------------------------------------------------------------------------


def set_input(node, names, value):
    if isinstance(names, str):
        names = (names,)
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            socket.default_value = value
            return True
    return False


def principled(name):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        out = (mat.node_tree.nodes.get("Material Output")
               or mat.node_tree.nodes.new("ShaderNodeOutputMaterial"))
        mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat, bsdf


def simple(name, color, rough, metal=0.0, coat=0.0):
    mat, bsdf = principled(name)
    set_input(bsdf, "Base Color", (color[0], color[1], color[2], 1.0))
    set_input(bsdf, "Roughness", rough)
    set_input(bsdf, "Metallic", metal)
    if coat:
        set_input(bsdf, ("Coat Weight", "Clearcoat"), coat)
    return mat


def emissive(name, color, strength):
    mat, bsdf = principled(name)
    set_input(bsdf, "Base Color", (0.02, 0.02, 0.02, 1.0))
    set_input(bsdf, "Roughness", 0.15)
    set_input(bsdf, ("Emission Color", "Emission"), (color[0], color[1], color[2], 1.0))
    set_input(bsdf, "Emission Strength", strength)
    return mat


def build_materials(paint_name, screen_state=None):
    rgb, metal, rough = PAINTS.get(paint_name, PAINTS["Deep Blue Metallic"])
    paint, bsdf = principled("MY_Paint")
    set_input(bsdf, "Base Color", (rgb[0], rgb[1], rgb[2], 1.0))
    set_input(bsdf, "Metallic", metal)
    set_input(bsdf, "Roughness", rough)
    set_input(bsdf, ("Coat Weight", "Clearcoat"), 1.0)
    set_input(bsdf, ("Coat Roughness", "Clearcoat Roughness"), 0.03)

    glass, gb = principled("MY_Glass")
    set_input(gb, "Base Color", (0.72, 0.76, 0.80, 1.0))
    set_input(gb, "Roughness", 0.02)
    set_input(gb, "IOR", 1.52)
    set_input(gb, ("Transmission Weight", "Transmission"), 0.92)
    set_input(gb, "Alpha", 0.35)
    # EEVEE renders transparency dithered by default, which turns glass into
    # noise; ask for blended transparency wherever this build supports it
    for attr, value in (("surface_render_method", "BLENDED"),
                        ("blend_method", "BLEND"),
                        ("use_screen_refraction", True),
                        ("show_transparent_back", False)):
        if hasattr(glass, attr):
            try:
                setattr(glass, attr, value)
            except (TypeError, AttributeError):
                pass

    mats = {
        "Paint": paint, "Glass": glass,
        "Mirror_Glass": simple("MY_MirrorGlass", (0.62, 0.64, 0.68), 0.04, 1.0),
        "Trim_Black": simple("MY_TrimBlack", (0.020, 0.020, 0.022), 0.62),
        "Trim_Gloss": simple("MY_TrimGloss", (0.012, 0.012, 0.014), 0.12, 0.0, 0.6),
        "Carbon": simple("MY_Carbon", (0.016, 0.016, 0.018), 0.22, 0.1, 0.8),
        "Tire": simple("MY_Tire", (0.018, 0.018, 0.019), 0.85),
        "Wheel_Alloy": simple("MY_WheelAlloy", (0.58, 0.59, 0.61), 0.22, 0.95),
        "Wheel_Dark": simple("MY_WheelDark", (0.05, 0.05, 0.055), 0.40, 0.7),
        "Brake_Disc": simple("MY_BrakeDisc", (0.27, 0.27, 0.28), 0.35, 0.9),
        "Brake_Caliper": simple("MY_Caliper", (0.52, 0.02, 0.02), 0.30, 0.3, 0.5),
        "Dash_Trim": simple("MY_DashTrim", (0.28, 0.20, 0.14), 0.45),
        "Interior_Dark": simple("MY_InteriorDark", (0.028, 0.028, 0.030), 0.72),
        "Interior_Leather": simple("MY_Leather", (0.10, 0.10, 0.11), 0.55),
        "Light_Head": emissive("MY_Light_Head", (1.0, 0.96, 0.88), 6.0),
        "Light_Tail": emissive("MY_Light_Tail", (1.0, 0.06, 0.04), 4.0),
    }
    mats["Screen"] = build_screen_material(screen_state)
    return mats


def build_screen_material(screen_state=None):
    image = bpy.data.images.get("ModelY_Screen")
    if image is None:
        image = bpy.data.images.new("ModelY_Screen", 1024, 640, alpha=False)
        image.colorspace_settings.name = "sRGB"
    canvas = render_screen(image.size[0], image.size[1], screen_state)
    pixels = canvas.flipped()
    try:
        image.pixels.foreach_set(pixels)
    except AttributeError:
        image.pixels[:] = pixels
    image.update()

    mat, bsdf = principled("MY_Screen")
    tex = None
    for node in mat.node_tree.nodes:
        if node.bl_idname == "ShaderNodeTexImage":
            tex = node
    if tex is None:
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.location = (-380, 120)
    tex.image = image
    tex.interpolation = "Closest"
    set_input(bsdf, "Base Color", (0.0, 0.0, 0.0, 1.0))
    set_input(bsdf, "Roughness", 0.08)
    set_input(bsdf, "Emission Strength", 3.0)
    socket = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
    if socket is not None:
        mat.node_tree.links.new(tex.outputs["Color"], socket)
    return mat


def to_object(part, mats, collection):
    me = bpy.data.meshes.new(part.name)
    me.from_pydata([Vector(v) for v in part.verts], [], part.faces)
    me.validate(verbose=False)
    slots = []
    for name in part.mats:
        if name not in slots:
            slots.append(name)
    for name in slots:
        me.materials.append(mats.get(name) or mats["Trim_Black"])
    for poly, name in zip(me.polygons, part.mats):
        poly.material_index = slots.index(name)
        poly.use_smooth = part.smooth
    if any(part.uvs):
        layer = me.uv_layers.new(name="UVMap")
        for poly, uv in zip(me.polygons, part.uvs):
            if not uv:
                continue
            for k, loop in enumerate(poly.loop_indices):
                if k < len(uv):
                    layer.data[loop].uv = uv[k]
    me.update()
    obj = bpy.data.objects.new(part.name, me)
    collection.objects.link(obj)
    return obj


def collection(name, parent=None):
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    target = parent or bpy.context.scene.collection
    if col.name not in target.children:
        try:
            target.children.link(col)
        except RuntimeError:
            pass
    return col


def empty(name, location, col, display="PLAIN_AXES", size=0.25):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = display
    obj.empty_display_size = size
    obj.location = location
    col.objects.link(obj)
    return obj


def parent_to(child, parent, parent_world=None):
    """Parent without double-offsetting.

    Objects created in this run have not been through a depsgraph evaluation,
    so ``parent.matrix_world`` still reads as the identity; the rig's empties
    are pure translations, so the caller passes the matrix it just set.
    """
    child.parent = parent
    child.matrix_parent_inverse = (parent_world or parent.matrix_world).inverted()


def engine():
    try:
        ids = [i.identifier for i in
               bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    except Exception:
        return bpy.context.scene.render.engine
    for name in ("CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if name in ids:
            return name
    return ids[0]


def build_scene(paint="Deep Blue Metallic", studio=True, screen_state=None,
                frunk_open=0.0, trunk_open=0.0, steer_deg=0.0):
    root = collection("Tesla_Model_Y_2023_Performance")
    cols = {n: collection("MY_" + n, root)
            for n in ("Body", "Wheels", "Interior", "Rig", "Studio")}
    mats = build_materials(paint, screen_state)

    objects = {}
    body_root = empty("MY_Body_Root", (0, 0, 0), cols["Rig"], "ARROWS", 0.6)
    objects["MY_Body_Root"] = body_root
    hinges = {}
    for name, pivot in HINGES.items():
        h = empty("MY_Hinge_" + name, pivot, cols["Rig"], "SINGLE_ARROW", 0.2)
        parent_to(h, body_root, Matrix.Identity(4))
        hinges[name] = h
        objects[h.name] = h
    knuckles = {}
    for name, center, _side in wheel_centers():
        k = empty("MY_Steer_" + name[-2:], center, cols["Rig"], "CIRCLE", 0.22)
        parent_to(k, body_root, Matrix.Identity(4))
        knuckles[name] = k
        objects[k.name] = k

    centers = dict((n, c) for n, c, _ in wheel_centers())
    for part in build_all_parts():
        if part.name in HINGES:
            col = cols["Body"]
        elif part.name.startswith("Wheel_"):
            col = cols["Wheels"]
        elif part.name in ("ModelY_Body", "Mirrors", "Spoiler", "Brakelight_Bar") \
                or part.name.split("_")[0] in ("Headlight", "Taillight", "Reflector"):
            col = cols["Body"]
        else:
            col = cols["Interior"]
        obj = to_object(part, mats, col)
        objects[part.name] = obj
        if part.name in HINGES:
            pivot = Vector(HINGES[part.name])
            obj.data.transform(Matrix.Translation(-pivot))
            obj.location = pivot
            parent_to(obj, hinges[part.name], Matrix.Translation(pivot))
        elif part.name.startswith("Wheel_"):
            center = Vector(centers[part.name])
            obj.data.transform(Matrix.Translation(-center))
            obj.location = center
            parent_to(obj, knuckles[part.name], Matrix.Translation(center))
            obj.rotation_mode = "YXZ"
        else:
            parent_to(obj, body_root, Matrix.Identity(4))

    for name in ("ModelY_Body", "Frunk_Lid", "Tailgate"):
        mod = objects[name].modifiers.new("Smooth", "SUBSURF")
        mod.levels = 0
        mod.render_levels = 1

    hinges["Frunk_Lid"].rotation_euler[1] = math.radians(-52.0) * frunk_open
    hinges["Tailgate"].rotation_euler[1] = math.radians(62.0) * trunk_open
    if steer_deg:
        inner, outer = ackermann(steer_deg)
        knuckles["Wheel_FL"].rotation_euler[2] = inner if steer_deg > 0 else outer
        knuckles["Wheel_FR"].rotation_euler[2] = outer if steer_deg > 0 else inner

    if studio:
        _studio(cols["Studio"], objects)
    return objects


def ackermann(steer_deg):
    avg = math.radians(abs(steer_deg))
    radius = WHEELBASE / math.tan(avg)
    inner = math.atan(WHEELBASE / max(0.5, radius - TRACK_F / 2))
    outer = math.atan(WHEELBASE / (radius + TRACK_F / 2))
    sign = 1.0 if steer_deg > 0 else -1.0
    return sign * inner, sign * outer


def _studio(col, objects):
    scene = bpy.context.scene
    me = bpy.data.meshes.new("MY_Backdrop")
    r = 14.0
    me.from_pydata([(-r, -r, 0), (r, -r, 0), (r, r, 0), (-r, r, 0)], [], [[0, 1, 2, 3]])
    me.update()
    floor = bpy.data.objects.new("MY_Backdrop", me)
    mat, bsdf = principled("MY_Studio_Floor")
    set_input(bsdf, "Base Color", (0.045, 0.045, 0.05, 1.0))
    set_input(bsdf, "Roughness", 0.32)
    me.materials.append(mat)
    col.objects.link(floor)
    objects["MY_Backdrop"] = floor

    cam_data = bpy.data.cameras.new("MY_Camera")
    cam_data.lens = 55.0
    cam = bpy.data.objects.new("MY_Camera", cam_data)
    cam.location = (6.4, -5.6, 2.05)
    col.objects.link(cam)
    target = empty("MY_Camera_Target", (0.0, 0.0, 0.85), col, "SPHERE", 0.2)
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    scene.camera = cam
    objects["MY_Camera"] = cam

    for name, loc, power, size in (("MY_Key", (5.0, -4.5, 5.2), 1400.0, 6.0),
                                   ("MY_Fill", (-6.0, -3.0, 3.4), 420.0, 7.0),
                                   ("MY_Rim", (-3.5, 6.0, 4.2), 900.0, 5.0)):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = power
        data.size = size
        light = bpy.data.objects.new(name, data)
        light.location = loc
        con = light.constraints.new("TRACK_TO")
        con.target = target
        con.track_axis = "TRACK_NEGATIVE_Z"
        con.up_axis = "UP_Y"
        col.objects.link(light)
        objects[name] = light

    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (0.021, 0.023, 0.027, 1.0)
    scene.render.engine = engine()
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    paint = "Deep Blue Metallic"
    out = ""
    for i, arg in enumerate(argv):
        if arg == "--paint" and i + 1 < len(argv):
            paint = argv[i + 1]
        if arg == "--out" and i + 1 < len(argv):
            out = argv[i + 1]
    objects = build_scene(paint=paint)
    print("Model Y built: %d objects" % len(objects))
    if out:
        bpy.ops.wm.save_as_mainfile(filepath=out)
        print("saved", out)


if bpy is not None and __name__ == "__main__":
    main()
