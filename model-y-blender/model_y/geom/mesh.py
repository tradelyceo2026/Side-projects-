"""A tiny dependency-free mesh container plus the surface helpers the body,
wheels and interior builders are written in terms of.

Keeping geometry generation in plain Python (rather than straight into ``bmesh``)
buys three things: the shapes can be unit-tested against the published
dimensions, they can be previewed without Blender (``tools/preview.py``), and the
``bpy`` layer shrinks to "hand these vertex and face lists to ``from_pydata``".
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Sequence

Vec3 = tuple[float, float, float]


@dataclass
class Mesh:
    """Vertices, polygons, and a material slot index per polygon."""

    name: str = "mesh"
    verts: list[Vec3] = field(default_factory=list)
    faces: list[list[int]] = field(default_factory=list)
    face_materials: list[int] = field(default_factory=list)
    materials: list[str] = field(default_factory=list)
    # Optional per-face UV loops, parallel to ``faces`` (``None`` where unset).
    face_uvs: list[list[tuple[float, float]] | None] = field(default_factory=list)
    shade_smooth: bool = True
    # Edges that should keep a hard crease when the mesh is shaded smooth
    # (panel gaps, glass frames).  Stored as vertex-index pairs.
    sharp_edges: list[tuple[int, int]] = field(default_factory=list)

    # -- construction -------------------------------------------------
    def material_slot(self, name: str) -> int:
        if name not in self.materials:
            self.materials.append(name)
        return self.materials.index(name)

    def add_vert(self, v: Vec3) -> int:
        self.verts.append((float(v[0]), float(v[1]), float(v[2])))
        return len(self.verts) - 1

    def add_verts(self, vs: Iterable[Vec3]) -> list[int]:
        return [self.add_vert(v) for v in vs]

    def add_face(self, indices: Sequence[int], material: str = "Body",
                 uvs: Sequence[tuple[float, float]] | None = None) -> None:
        idx = [int(i) for i in indices]
        if len(set(idx)) < 3:  # degenerate after a collapse, drop it
            return
        # collapse repeated consecutive indices (poles of a revolve)
        clean: list[int] = []
        for i in idx:
            if not clean or clean[-1] != i:
                clean.append(i)
        if len(clean) > 2 and clean[0] == clean[-1]:
            clean.pop()
        if len(clean) < 3:
            return
        self.faces.append(clean)
        self.face_materials.append(self.material_slot(material))
        self.face_uvs.append([tuple(uv) for uv in uvs] if uvs and len(uvs) == len(clean) else None)

    def merge(self, other: "Mesh") -> None:
        offset = len(self.verts)
        self.verts.extend(other.verts)
        remap = {i: self.material_slot(other.materials[i]) for i in range(len(other.materials))}
        for k, (face, mat) in enumerate(zip(other.faces, other.face_materials)):
            self.faces.append([i + offset for i in face])
            self.face_materials.append(remap[mat])
            self.face_uvs.append(other.face_uvs[k] if k < len(other.face_uvs) else None)
        self.sharp_edges.extend((a + offset, b + offset) for a, b in other.sharp_edges)

    # -- queries ------------------------------------------------------
    def bounds(self) -> tuple[Vec3, Vec3]:
        xs = [v[0] for v in self.verts]
        ys = [v[1] for v in self.verts]
        zs = [v[2] for v in self.verts]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

    def dimensions(self) -> Vec3:
        lo, hi = self.bounds()
        return (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])

    def transformed(self, translate: Vec3 = (0, 0, 0), scale: Vec3 = (1, 1, 1),
                    mirror_y: bool = False) -> "Mesh":
        out = Mesh(self.name, materials=list(self.materials), shade_smooth=self.shade_smooth)
        sy = -scale[1] if mirror_y else scale[1]
        out.verts = [
            (v[0] * scale[0] + translate[0], v[1] * sy + translate[1], v[2] * scale[2] + translate[2])
            for v in self.verts
        ]
        out.faces = [list(reversed(f)) if mirror_y else list(f) for f in self.faces]
        out.face_materials = list(self.face_materials)
        out.face_uvs = list(self.face_uvs)
        out.sharp_edges = list(self.sharp_edges)
        return out

    def stats(self) -> str:
        d = self.dimensions()
        return (f"{self.name}: {len(self.verts)} verts, {len(self.faces)} faces, "
                f"{len(self.materials)} materials, bbox {d[0]:.3f} x {d[1]:.3f} x {d[2]:.3f} m")


# ---------------------------------------------------------------------------
# curve helpers
# ---------------------------------------------------------------------------


def catmull_rom(points: Sequence[tuple[float, float]], samples: int,
                alpha: float = 0.5) -> list[tuple[float, float]]:
    """Centripetal Catmull-Rom through ``points`` (open curve, endpoints kept)."""
    if len(points) < 2:
        return list(points)
    pts = [points[0]] + list(points) + [points[-1]]
    out: list[tuple[float, float]] = []
    segs = len(pts) - 3
    for s in range(segs):
        p0, p1, p2, p3 = pts[s], pts[s + 1], pts[s + 2], pts[s + 3]
        n = max(2, int(round(samples / segs)))
        last = s == segs - 1
        for i in range(n + (1 if last else 0)):
            t = i / n
            out.append(_cr_point(p0, p1, p2, p3, t, alpha))
    return out


def _cr_point(p0, p1, p2, p3, t, alpha):
    def tj(ti, pa, pb):
        d = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
        return ti + (d ** alpha if d > 1e-9 else 1e-6)

    t0 = 0.0
    t1 = tj(t0, p0, p1)
    t2 = tj(t1, p1, p2)
    t3 = tj(t2, p2, p3)
    tt = t1 + (t2 - t1) * t

    def lerp(a, b, ta, tb):
        if abs(tb - ta) < 1e-12:
            return a
        f = (tt - ta) / (tb - ta)
        return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)

    a1 = lerp(p0, p1, t0, t1)
    a2 = lerp(p1, p2, t1, t2)
    a3 = lerp(p2, p3, t2, t3)
    b1 = lerp(a1, a2, t0, t2)
    b2 = lerp(a2, a3, t1, t3)
    return lerp(b1, b2, t1, t2)


def smoothstep(a: float, b: float, t: float) -> float:
    t = min(1.0, max(0.0, t))
    return a + (b - a) * (t * t * (3.0 - 2.0 * t))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def sample_keyed(keys: Sequence[tuple[float, float]], x: float) -> float:
    """Monotone (smoothstep) interpolation through ``(position, value)`` keys."""
    if x <= keys[0][0]:
        return keys[0][1]
    if x >= keys[-1][0]:
        return keys[-1][1]
    for (x0, v0), (x1, v1) in zip(keys, keys[1:]):
        if x0 <= x <= x1:
            t = (x - x0) / (x1 - x0) if x1 > x0 else 0.0
            return smoothstep(v0, v1, t)
    return keys[-1][1]


# ---------------------------------------------------------------------------
# surface builders
# ---------------------------------------------------------------------------


def loft(mesh: Mesh, sections: Sequence[Sequence[Vec3]], material: str = "Body",
         closed_sections: bool = True, cap_first: bool = False,
         cap_last: bool = False) -> list[list[int]]:
    """Bridge equal-length vertex loops into a quad surface.

    Returns the vertex-index rings so callers can attach further detail.
    """
    rings: list[list[int]] = [mesh.add_verts(sec) for sec in sections]
    n = len(rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        count = n if closed_sections else n - 1
        for i in range(count):
            j = (i + 1) % n
            mesh.add_face([r0[i], r0[j], r1[j], r1[i]], material)
    if cap_first:
        mesh.add_face(list(reversed(rings[0])), material)
    if cap_last:
        mesh.add_face(rings[-1], material)
    return rings


def revolve(mesh: Mesh, profile: Sequence[tuple[float, float]], segments: int,
            axis: str = "y", material: str = "Body", center: Vec3 = (0, 0, 0),
            close: bool = True) -> list[list[int]]:
    """Revolve a ``(radius, offset)`` profile around an axis.

    ``axis="y"`` spins in the X-Z plane about the Y axis, which is how a road
    wheel sits in Blender's Z-up world with the car pointing down +X.
    """
    sections: list[list[Vec3]] = []
    for s in range(segments):
        ang = 2.0 * math.pi * s / segments
        ca, sa = math.cos(ang), math.sin(ang)
        sec: list[Vec3] = []
        for radius, offset in profile:
            if axis == "y":
                sec.append((center[0] + radius * ca, center[1] + offset, center[2] + radius * sa))
            elif axis == "z":
                sec.append((center[0] + radius * ca, center[1] + radius * sa, center[2] + offset))
            else:  # x
                sec.append((center[0] + offset, center[1] + radius * ca, center[2] + radius * sa))
        sections.append(sec)
    if close:
        sections.append(sections[0])
    rings = [mesh.add_verts(sec) for sec in sections[:-1]] if close else [mesh.add_verts(s) for s in sections]
    n = len(profile)
    count = len(rings)
    for k in range(count if close else count - 1):
        r0 = rings[k]
        r1 = rings[(k + 1) % count]
        for i in range(n - 1):
            mesh.add_face([r0[i], r0[i + 1], r1[i + 1], r1[i]], material)
    return rings


def grid_patch(mesh: Mesh, rows: Sequence[Sequence[Vec3]], material: str = "Body") -> list[list[int]]:
    """Quad-mesh an open grid of equal-length vertex rows."""
    rings = [mesh.add_verts(r) for r in rows]
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(len(r0) - 1):
            mesh.add_face([r0[i], r0[i + 1], r1[i + 1], r1[i]], material)
    return rings


def box(mesh: Mesh, center: Vec3, size: Vec3, material: str = "Body",
        bevel: float = 0.0) -> None:
    """Axis-aligned box, optionally with chamfered vertical corners."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    b = min(bevel, hx * 0.9, hy * 0.9)
    ring = []
    if b > 1e-6:
        corners = [(hx, hy), (-hx, hy), (-hx, -hy), (hx, -hy)]
        for i, (px, py) in enumerate(corners):
            sx = 1 if px > 0 else -1
            sy = 1 if py > 0 else -1
            ring.append((px - sx * b, py))
            ring.append((px, py - sy * b))
    else:
        ring = [(hx, hy), (-hx, hy), (-hx, -hy), (hx, -hy)]
    lower = [(cx + x, cy + y, cz - hz) for x, y in ring]
    upper = [(cx + x, cy + y, cz + hz) for x, y in ring]
    loft(mesh, [lower, upper], material, closed_sections=True, cap_first=True, cap_last=True)


def cylinder(mesh: Mesh, center: Vec3, radius: float, length: float, axis: str = "y",
             segments: int = 24, material: str = "Body") -> None:
    profile = [(radius, -length / 2), (radius, length / 2)]
    revolve(mesh, profile, segments, axis=axis, material=material, center=center)
    # caps
    for end in (-length / 2, length / 2):
        ring: list[Vec3] = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            if axis == "y":
                ring.append((center[0] + radius * math.cos(a), center[1] + end,
                             center[2] + radius * math.sin(a)))
            elif axis == "z":
                ring.append((center[0] + radius * math.cos(a), center[1] + radius * math.sin(a),
                             center[2] + end))
            else:
                ring.append((center[0] + end, center[1] + radius * math.cos(a),
                             center[2] + radius * math.sin(a)))
        idx = mesh.add_verts(ring)
        mesh.add_face(idx if end > 0 else list(reversed(idx)), material)
