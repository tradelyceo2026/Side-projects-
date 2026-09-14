"""A minimal float-RGBA software rasteriser.

The output buffer is laid out exactly the way ``bpy.types.Image.pixels`` wants
it (flat RGBA floats, first row at the bottom), so painting the car's
touchscreen is a straight assignment with no image libraries involved.
Drawing coordinates are top-left origin, which is how the UI code thinks.
"""

from __future__ import annotations

import math

from .font5x7 import HEIGHT as GH, WIDTH as GW, glyph, text_width

RGBA = tuple[float, float, float, float]


def rgb(hex_code: str, alpha: float = 1.0) -> RGBA:
    """``"#1b1d22"`` -> linear-ish float RGBA (sRGB values are gamma-decoded)."""
    h = hex_code.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (_srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b), alpha)


def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


class Canvas:
    def __init__(self, width: int, height: int, background: RGBA = (0, 0, 0, 1)):
        self.width = width
        self.height = height
        self.buf = [0.0] * (width * height * 4)
        self.clear(background)

    # -- primitives ---------------------------------------------------
    def clear(self, color: RGBA) -> None:
        r, g, b, a = color
        self.buf[:] = [r, g, b, a] * (self.width * self.height)

    def blend(self, x: int, y: int, color: RGBA, coverage: float = 1.0) -> None:
        if x < 0 or y < 0 or x >= self.width or y >= self.height:
            return
        a = color[3] * coverage
        if a <= 0.0:
            return
        i = (y * self.width + x) * 4
        inv = 1.0 - a
        self.buf[i] = self.buf[i] * inv + color[0] * a
        self.buf[i + 1] = self.buf[i + 1] * inv + color[1] * a
        self.buf[i + 2] = self.buf[i + 2] * inv + color[2] * a
        self.buf[i + 3] = min(1.0, self.buf[i + 3] * inv + a)

    def rect(self, x: float, y: float, w: float, h: float, color: RGBA) -> None:
        x0, y0 = int(round(x)), int(round(y))
        x1, y1 = int(round(x + w)), int(round(y + h))
        x0, x1 = max(0, x0), min(self.width, x1)
        y0, y1 = max(0, y0), min(self.height, y1)
        if x1 <= x0 or y1 <= y0:
            return
        if color[3] >= 0.999:
            # opaque fast path: write whole rows with a slice assignment, which
            # is what keeps a full screen redraw inside a few hundred ms
            span = list(color) * (x1 - x0)
            row = self.width * 4
            for py in range(y0, y1):
                start = py * row + x0 * 4
                self.buf[start:start + len(span)] = span
            return
        for py in range(y0, y1):
            for px in range(x0, x1):
                self.blend(px, py, color)

    def rounded_rect(self, x: float, y: float, w: float, h: float, radius: float,
                     color: RGBA) -> None:
        """Rounded rectangle: fast rects for the body, per-pixel only at corners."""
        r = max(0.0, min(radius, w / 2, h / 2))
        if r < 0.5:
            self.rect(x, y, w, h, color)
            return
        # middle band and the two flanks
        self.rect(x, y + r, w, h - 2 * r, color)
        self.rect(x + r, y, w - 2 * r, r, color)
        self.rect(x + r, y + h - r, w - 2 * r, r, color)
        for cx, cy, sx, sy in ((x + r, y + r, -1, -1), (x + w - r, y + r, 1, -1),
                               (x + r, y + h - r, -1, 1), (x + w - r, y + h - r, 1, 1)):
            x0 = int(math.floor(cx if sx > 0 else cx - r))
            y0 = int(math.floor(cy if sy > 0 else cy - r))
            for py in range(max(0, y0), min(self.height, y0 + int(math.ceil(r)) + 1)):
                for px in range(max(0, x0), min(self.width, x0 + int(math.ceil(r)) + 1)):
                    d = math.hypot(px + 0.5 - cx, py + 0.5 - cy)
                    cov = min(1.0, max(0.0, r + 0.5 - d))
                    if cov > 0:
                        self.blend(px, py, color, cov)

    def circle(self, cx: float, cy: float, r: float, color: RGBA,
               thickness: float = 0.0) -> None:
        for py in range(max(0, int(cy - r - 1)), min(self.height, int(cy + r + 2))):
            for px in range(max(0, int(cx - r - 1)), min(self.width, int(cx + r + 2))):
                d = math.hypot(px + 0.5 - cx, py + 0.5 - cy)
                if thickness <= 0:
                    cov = min(1.0, max(0.0, r + 0.5 - d))
                else:
                    cov = min(1.0, max(0.0, min(r + 0.5 - d, d - (r - thickness) + 0.5)))
                if cov > 0:
                    self.blend(px, py, color, cov)

    def arc(self, cx: float, cy: float, r: float, a0: float, a1: float,
            thickness: float, color: RGBA) -> None:
        """Angles in radians, measured clockwise from 12 o'clock."""
        steps = max(8, int(abs(a1 - a0) * r))
        for i in range(steps + 1):
            a = a0 + (a1 - a0) * i / steps
            px = cx + r * math.sin(a)
            py = cy - r * math.cos(a)
            self.circle(px, py, thickness / 2, color)

    def line(self, x0: float, y0: float, x1: float, y1: float, color: RGBA,
             thickness: float = 1.0) -> None:
        dist = math.hypot(x1 - x0, y1 - y0)
        steps = max(1, int(dist))
        for i in range(steps + 1):
            t = i / steps
            self.circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thickness / 2, color)

    def vgradient(self, x: float, y: float, w: float, h: float, top: RGBA,
                  bottom: RGBA) -> None:
        for py in range(max(0, int(y)), min(self.height, int(y + h))):
            t = (py - y) / max(1.0, h)
            col = tuple(top[k] + (bottom[k] - top[k]) * t for k in range(4))
            self.rect(x, py, w, 1, col)  # type: ignore[arg-type]

    # -- text ---------------------------------------------------------
    def text(self, x: float, y: float, s: str, color: RGBA, scale: int = 2,
             tracking: int = 1) -> float:
        """Draw ``s`` with its top-left at (x, y); returns the advance width."""
        cx = x
        for ch in s:
            rows = glyph(ch)
            for ry in range(GH):
                row = rows[ry]
                for rx in range(GW):
                    if row[rx]:
                        self.rect(cx + rx * scale, y + ry * scale, scale, scale, color)
            cx += (GW + tracking) * scale
        return text_width(s, scale, tracking)

    def text_centered(self, cx: float, y: float, s: str, color: RGBA, scale: int = 2,
                      tracking: int = 1) -> None:
        self.text(cx - text_width(s, scale, tracking) / 2, y, s, color, scale, tracking)

    def text_right(self, rx: float, y: float, s: str, color: RGBA, scale: int = 2,
                   tracking: int = 1) -> None:
        self.text(rx - text_width(s, scale, tracking), y, s, color, scale, tracking)

    # -- output -------------------------------------------------------
    def to_blender_pixels(self) -> list[float]:
        """Flip to bottom-up row order for ``Image.pixels``."""
        out: list[float] = []
        row = self.width * 4
        for y in range(self.height - 1, -1, -1):
            out.extend(self.buf[y * row:(y + 1) * row])
        return out

    def to_png(self, path: str) -> None:
        """Debug/CI helper: write the canvas out as an 8-bit sRGB PNG."""
        import struct
        import zlib

        raw = bytearray()
        for y in range(self.height):
            raw.append(0)
            for x in range(self.width):
                i = (y * self.width + x) * 4
                for k in range(3):
                    v = self.buf[i + k]
                    v = 1.055 * (v ** (1 / 2.4)) - 0.055 if v > 0.0031308 else v * 12.92
                    raw.append(max(0, min(255, int(v * 255 + 0.5))))

        def chunk(tag: bytes, data: bytes) -> bytes:
            return (struct.pack(">I", len(data)) + tag + data
                    + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

        with open(path, "wb") as fh:
            fh.write(b"\x89PNG\r\n\x1a\n")
            fh.write(chunk(b"IHDR", struct.pack(">IIBBBBB", self.width, self.height,
                                                8, 2, 0, 0, 0)))
            fh.write(chunk(b"IDAT", zlib.compress(bytes(raw), 6)))
            fh.write(chunk(b"IEND", b""))


def wrap_text(s: str, max_chars: int) -> list[str]:
    """Greedy word wrap for the chat column."""
    words = s.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        while len(w) > max_chars:                 # hard-break very long tokens
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(w[:max_chars])
            w = w[max_chars:]
        if not cur:
            cur = w
        elif len(cur) + 1 + len(w) <= max_chars:
            cur += " " + w
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines
