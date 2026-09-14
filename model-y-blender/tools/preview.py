"""Render orthographic previews of the car without Blender.

A tiny painter's-algorithm rasteriser in pure Python: enough to check the
silhouette, proportions and material zones before the mesh ever reaches
Blender, and enough to keep the project honest in CI where no ``bpy`` exists.

    python3 tools/preview.py --out preview --views side front top hero
"""

from __future__ import annotations

import argparse
import math
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from model_y.geom.assemble import build_all  # noqa: E402

MATERIAL_RGB: dict[str, tuple[float, float, float]] = {
    "Paint": (0.06, 0.12, 0.34),
    "Glass": (0.05, 0.07, 0.10),
    "Mirror_Glass": (0.35, 0.40, 0.46),
    "Trim_Black": (0.05, 0.05, 0.06),
    "Trim_Gloss": (0.09, 0.09, 0.10),
    "Carbon": (0.07, 0.07, 0.08),
    "Tire": (0.035, 0.035, 0.038),
    "Wheel_Alloy": (0.52, 0.53, 0.56),
    "Wheel_Dark": (0.10, 0.10, 0.11),
    "Brake_Disc": (0.30, 0.30, 0.32),
    "Brake_Caliper": (0.55, 0.03, 0.03),
    "Light_Head": (0.85, 0.86, 0.80),
    "Light_Tail": (0.60, 0.05, 0.05),
    "Screen": (0.02, 0.03, 0.05),
    "Dash_Trim": (0.32, 0.24, 0.17),
    "Interior_Dark": (0.09, 0.09, 0.10),
    "Interior_Leather": (0.16, 0.16, 0.17),
}

VIEWS = {
    #            eye direction (from camera toward scene)
    "side":  (0.0, 1.0, 0.0),
    "front": (-1.0, 0.0, 0.0),
    "rear":  (1.0, 0.0, 0.0),
    "top":   (0.0, 0.0, -1.0),
    "hero":  (-0.80, 0.52, -0.30),
}


def write_png(path: str, width: int, height: int, pixels: bytearray) -> None:
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * width * 3:(y + 1) * width * 3])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def basis(direction: tuple[float, float, float]):
    """Right-handed camera basis with world +Z up."""
    fx, fy, fz = direction
    n = math.sqrt(fx * fx + fy * fy + fz * fz)
    f = (fx / n, fy / n, fz / n)
    up = (0.0, 0.0, 1.0)
    if abs(f[2]) > 0.999:
        up = (1.0, 0.0, 0.0)
    r = (f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0])
    rn = math.sqrt(sum(c * c for c in r))
    r = tuple(c / rn for c in r)
    u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0])
    return r, u, f


def render(view: str, width: int = 1100, height: int = 620, margin: float = 0.06,
           interior: bool = True) -> tuple[int, int, bytearray]:
    right, up, fwd = basis(VIEWS[view])
    parts = build_all(interior=interior)

    tris: list[tuple[float, list[tuple[float, float]], tuple[float, float, float]]] = []
    pts2d: list[tuple[float, float]] = []
    for mesh in parts:
        for face, mat_idx in zip(mesh.faces, mesh.face_materials):
            mat = mesh.materials[mat_idx]
            pts = [mesh.verts[i] for i in face]
            proj = [(sum(p[k] * right[k] for k in range(3)),
                     sum(p[k] * up[k] for k in range(3))) for p in pts]
            depth = sum(sum(p[k] * fwd[k] for k in range(3)) for p in pts) / len(pts)
            normal = face_normal(pts)
            shade = shading(normal, fwd)
            base = MATERIAL_RGB.get(mat, (0.5, 0.0, 0.5))
            col = tuple(min(1.0, c * shade) for c in base)
            tris.append((depth, proj, col))
            pts2d.extend(proj)

    minx = min(p[0] for p in pts2d); maxx = max(p[0] for p in pts2d)
    miny = min(p[1] for p in pts2d); maxy = max(p[1] for p in pts2d)
    span_x = (maxx - minx) * (1 + margin * 2)
    span_y = (maxy - miny) * (1 + margin * 2)
    scale = min(width / span_x, height / span_y)
    ox = width / 2 - (minx + maxx) / 2 * scale
    oy = height / 2 + (miny + maxy) / 2 * scale

    px = bytearray(width * height * 3)
    for i in range(width * height):
        t = (i // width) / height
        g = int(255 * (0.13 + 0.11 * (1 - t)))
        px[i * 3] = g; px[i * 3 + 1] = g; px[i * 3 + 2] = int(g * 1.05)

    tris.sort(key=lambda t: -t[0])
    for _, proj, col in tris:
        screen = [(p[0] * scale + ox, oy - p[1] * scale) for p in proj]
        fill_polygon(px, width, height, screen, col)
    return width, height, px


def face_normal(pts) -> tuple[float, float, float]:
    if len(pts) < 3:
        return (0.0, 0.0, 1.0)
    ax, ay, az = pts[0]
    bx, by, bz = pts[1]
    cx, cy, cz = pts[2]
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    ln = math.sqrt(sum(c * c for c in n)) or 1.0
    return tuple(c / ln for c in n)


def shading(normal, fwd) -> float:
    key = (-0.45, 0.62, 0.65)
    ln = math.sqrt(sum(c * c for c in key))
    key = tuple(c / ln for c in key)
    diff = abs(sum(normal[i] * key[i] for i in range(3)))
    facing = abs(sum(normal[i] * fwd[i] for i in range(3)))
    rim = (1.0 - facing) ** 3
    return 0.28 + 0.95 * diff + 0.55 * rim


def fill_polygon(px: bytearray, w: int, h: int, poly, color) -> None:
    ys = [p[1] for p in poly]
    y0 = max(0, int(math.floor(min(ys))))
    y1 = min(h - 1, int(math.ceil(max(ys))))
    if y1 < y0:
        return
    r = int(max(0, min(255, color[0] ** (1 / 2.2) * 255)))
    g = int(max(0, min(255, color[1] ** (1 / 2.2) * 255)))
    b = int(max(0, min(255, color[2] ** (1 / 2.2) * 255)))
    n = len(poly)
    for y in range(y0, y1 + 1):
        yc = y + 0.5
        xs = []
        for i in range(n):
            (xa, ya), (xb, yb) = poly[i], poly[(i + 1) % n]
            if (ya <= yc < yb) or (yb <= yc < ya):
                xs.append(xa + (yc - ya) / (yb - ya) * (xb - xa))
        if not xs:
            continue
        xs.sort()
        for k in range(0, len(xs) - 1, 2):
            xa = max(0, int(math.floor(xs[k])))
            xb = min(w - 1, int(math.ceil(xs[k + 1])))
            base = (y * w + xa) * 3
            for x in range(xa, xb + 1):
                i = (y * w + x) * 3
                px[i] = r; px[i + 1] = g; px[i + 2] = b


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="preview")
    ap.add_argument("--views", nargs="*", default=["side", "front", "top", "hero"])
    ap.add_argument("--width", type=int, default=1100)
    ap.add_argument("--height", type=int, default=620)
    ap.add_argument("--no-interior", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for view in args.views:
        w, h, px = render(view, args.width, args.height, interior=not args.no_interior)
        path = os.path.join(args.out, f"{view}.png")
        write_png(path, w, h, px)
        print("wrote", path)


if __name__ == "__main__":
    main()
