"""The 15-inch centre display, drawn pixel by pixel from live car state.

Layout follows the real car's: persistent car card and battery on the left, map
in the middle, climate and media along the bottom bar, status across the top.
The Grok panel slides over the map when there is a conversation to show.

The top-down car on screen is drawn from the *same* half-width curve the 3D
body is lofted from, so the icon and the model cannot drift apart.
"""

from __future__ import annotations

import math

from ..geom.body import HALF_WIDTH, NOSE, TAIL
from ..geom.mesh import sample_keyed
from ..specs import MILE, MPH, PAINT_COLORS
from ..vehicle_sim import CarState
from .raster import Canvas, rgb, wrap_text

BG = rgb("#0c0d10")
PANEL = rgb("#16181d")
PANEL_HI = rgb("#1e2128")
LINE = rgb("#2b2f38")
TEXT = rgb("#e8eaee")
TEXT_DIM = rgb("#8b9098")
ACCENT = rgb("#3e9dff")
GREEN = rgb("#38d17a")
AMBER = rgb("#ffb020")
RED = rgb("#ff4d4d")
GROK_ACCENT = rgb("#8e7bff")
ROAD = rgb("#242830")


def render_screen(state: CarState, assistant=None, width: int = 1024, height: int = 640,
                  page: str = "auto") -> Canvas:
    """Rasterise the whole UI.  ``page`` is "home", "grok" or "auto"."""
    c = Canvas(width, height, BG)
    if page == "auto":
        page = "grok" if (assistant and assistant.transcript) else "home"

    pad = 12
    top_h = 34
    bottom_h = 84
    left_w = int(width * 0.34)
    body_y = top_h + pad
    body_h = height - top_h - bottom_h - pad * 2

    _status_bar(c, state, assistant, width, top_h)
    _car_card(c, state, pad, body_y, left_w - pad, body_h)
    map_x = left_w + pad
    map_w = width - left_w - pad * 2
    if page == "grok":
        _grok_panel(c, state, assistant, map_x, body_y, map_w, body_h)
    else:
        _map_panel(c, state, map_x, body_y, map_w, body_h)
    _bottom_bar(c, state, 0, height - bottom_h, width, bottom_h)
    return c


# ---------------------------------------------------------------------------


def _status_bar(c: Canvas, state: CarState, assistant, w: int, h: int) -> None:
    c.rect(0, 0, w, h, PANEL)
    c.rect(0, h - 1, w, 1, LINE)
    hours, minutes = divmod(int(state.clock_minutes) % (24 * 60), 60)
    suffix = "AM" if hours < 12 else "PM"
    hour12 = hours % 12 or 12
    c.text(14, 10, f"{hour12}:{minutes:02d} {suffix}", TEXT, 2)
    c.text(120, 10, f"{state.outside_temp_c:.0f}°C OUTSIDE", TEXT_DIM, 2)

    label = "LOCKED" if state.locked else "UNLOCKED"
    c.text(300, 10, label, GREEN if state.locked else AMBER, 2)
    if state.sentry_mode:
        c.text(400, 10, "SENTRY", RED, 2)

    # Grok badge, right aligned: live when a key is configured, offline otherwise
    mode = assistant.mode if assistant else "offline"
    live = mode == "grok"
    badge = "GROK LIVE" if live else "GROK OFFLINE"
    bw = len(badge) * 12 + 22
    c.rounded_rect(w - bw - 12, 6, bw, h - 12, 8, GROK_ACCENT if live else PANEL_HI)
    c.text(w - bw - 1, 10, badge, BG if live else TEXT_DIM, 2)
    odo = f"{state.odometer_m / MILE:,.0f} MI"
    c.text_right(w - bw - 26, 10, odo, TEXT_DIM, 2)


def _car_card(c: Canvas, state: CarState, x: float, y: float, w: float, h: float) -> None:
    c.rounded_rect(x, y, w, h, 14, PANEL)

    # gear selector column, P R N D, the active one highlighted
    gears = "PRND"
    gx = x + 18
    for i, g in enumerate(gears):
        gy = y + 16 + i * 30
        active = state.gear == g
        if active:
            c.rounded_rect(gx - 6, gy - 5, 28, 28, 6, PANEL_HI)
        c.text(gx, gy, g, TEXT if active else TEXT_DIM, 3 if active else 2)

    # speed
    c.text_centered(x + w * 0.62, y + 14, f"{state.speed_mph:.0f}", TEXT, 7)
    c.text_centered(x + w * 0.62, y + 66, "MPH", TEXT_DIM, 2)
    if state.autopilot:
        c.text_centered(x + w * 0.62, y + 88, "AUTOPILOT", ACCENT, 2)

    _top_down_car(c, state, x + 14, y + 112, w - 28, h - 200)
    _battery(c, state, x + 16, y + h - 74, w - 32)


def _top_down_car(c: Canvas, state: CarState, x: float, y: float, w: float,
                  h: float) -> None:
    """Plan view built from the body half-width curve, with live closures."""
    scale = min(w / 2.2, h / (NOSE - TAIL))
    cx = x + w / 2
    top = y + (h - (NOSE - TAIL) * scale) / 2
    paint = PAINT_COLORS.get(state.paint, {}).get("rgb", (0.1, 0.1, 0.12))
    body_col = (paint[0], paint[1], paint[2], 1.0)  # type: ignore[index]

    steps = 46
    prev = None
    for i in range(steps + 1):
        t = i / steps
        vx = NOSE - (NOSE - TAIL) * t
        hw = sample_keyed(HALF_WIDTH, vx) * scale
        py = top + (NOSE - vx) * scale
        if prev is not None:
            c.rect(cx - hw, py - 1, hw * 2, 2 + (py - prev), body_col)
        prev = py

    # glass canopy (windscreen base back to the tailgate glass)
    g_top = top + (NOSE - 1.02) * scale
    g_bot = top + (NOSE + 1.92) * scale
    c.rounded_rect(cx - 0.60 * scale, g_top, 1.20 * scale, g_bot - g_top, 9,
                   rgb("#11151c", 0.82))

    # open closures glow amber, exactly as they do on the real car's card
    if state.frunk_open:
        c.rounded_rect(cx - 0.55 * scale, top + 0.10 * scale, 1.10 * scale,
                       0.80 * scale, 8, AMBER)
    if state.trunk_open:
        c.rounded_rect(cx - 0.62 * scale, top + (NOSE + 1.45) * scale, 1.24 * scale,
                       0.70 * scale, 8, AMBER)
    for i, open_ in enumerate(state.doors_open):
        if not open_:
            continue
        side = -1 if i % 2 == 0 else 1
        row = 0 if i < 2 else 1
        c.rounded_rect(cx + side * 0.70 * scale - (0.16 * scale if side > 0 else 0),
                       top + (NOSE - 0.55 + row * 1.10) * scale,
                       0.16 * scale, 0.95 * scale, 5, AMBER)
    if state.charge_port_open:
        c.circle(cx - 0.80 * scale, top + (NOSE + 1.30) * scale, 6, ACCENT)

    if state.headlights:
        for side in (-1, 1):
            c.circle(cx + side * 0.42 * scale, top + 0.06 * scale, 7, rgb("#fff6d8"))
    if state.brake_lights:
        c.rect(cx - 0.55 * scale, top + (NOSE - TAIL - 0.10) * scale,
               1.10 * scale, 6, RED)
    if state.turn_signal in ("left", "right"):
        sx = cx + (0.85 * scale if state.turn_signal == "left" else -0.85 * scale)
        c.circle(sx, top + (NOSE - TAIL) * scale * 0.5, 8, AMBER)


def _battery(c: Canvas, state: CarState, x: float, y: float, w: float) -> None:
    pct = state.soc
    col = GREEN if pct > 0.25 else (AMBER if pct > 0.12 else RED)
    if state.charging:
        col = ACCENT
    bar_h = 22
    c.rounded_rect(x, y, w - 14, bar_h, 5, PANEL_HI)
    c.rounded_rect(x + 2, y + 2, max(4.0, (w - 18) * pct), bar_h - 4, 4, col)
    c.rounded_rect(x + w - 12, y + 6, 6, bar_h - 12, 2, PANEL_HI)  # terminal nub
    c.text(x, y + bar_h + 10, f"{pct * 100:.0f}%", TEXT, 3)
    miles = state.range_m() / MILE
    c.text_right(x + w - 14, y + bar_h + 12, f"{miles:.0f} MI", TEXT_DIM, 2)
    if state.charging:
        c.text(x, y - 18, f"CHARGING {state.charge_power_w / 1000:.0f} KW", ACCENT, 2)
    elif abs(state.battery_power_w) > 500:
        flow = state.battery_power_w / 1000.0
        c.text(x, y - 18, (f"{flow:+.0f} KW"), TEXT_DIM, 2)


def _map_panel(c: Canvas, state: CarState, x: float, y: float, w: float,
               h: float) -> None:
    c.rounded_rect(x, y, w, h, 14, PANEL)
    # abstract street grid: enough to read as a map without pretending to be one
    for i in range(1, 7):
        c.rect(x + w * i / 7, y + 8, 3, h - 16, ROAD)
    for j in range(1, 5):
        c.rect(x + 8, y + h * j / 5, w - 16, 3, ROAD)
    # route
    px, py = x + w * 0.28, y + h - 40
    pts = [(px, py), (px, y + h * 0.55), (x + w * 0.58, y + h * 0.55),
           (x + w * 0.58, y + h * 0.22), (x + w * 0.85, y + h * 0.22)]
    if state.navigation_destination:
        for a, b in zip(pts, pts[1:]):
            c.line(a[0], a[1], b[0], b[1], ACCENT, 6)
        c.circle(pts[-1][0], pts[-1][1], 9, RED)
    c.circle(px, py, 10, ACCENT)
    c.circle(px, py, 4, TEXT)

    if state.navigation_destination:
        card_h = 56
        c.rounded_rect(x + 12, y + 12, w - 24, card_h, 10, PANEL_HI)
        c.text(x + 26, y + 22, state.navigation_destination.upper()[:28], TEXT, 2)
        miles = state.navigation_distance_m / MILE
        eta = miles / max(18.0, state.speed_mph if state.speed_mph > 5 else 28.0) * 60
        c.text(x + 26, y + 44, f"{miles:.1f} MI  •  {eta:.0f} MIN", TEXT_DIM, 2)
    else:
        c.text_centered(x + w / 2, y + 18, "NO DESTINATION SET", TEXT_DIM, 2)
        c.text_centered(x + w / 2, y + 40, "ASK GROK TO NAVIGATE", TEXT_DIM, 2)


def _grok_panel(c: Canvas, state: CarState, assistant, x: float, y: float,
                w: float, h: float) -> None:
    c.rounded_rect(x, y, w, h, 14, PANEL)
    c.rect(x + 14, y + 34, w - 28, 2, LINE)
    live = bool(assistant) and assistant.mode == "grok"
    c.text(x + 16, y + 12, "GROK", GROK_ACCENT, 3)
    c.text_right(x + w - 16, y + 14,
                 "XAI API" if live else "LOCAL INTENT ENGINE", TEXT_DIM, 2)

    if not assistant or not assistant.transcript:
        hints = ['"SET IT TO 20 DEGREES"', '"OPEN THE FRUNK"',
                 '"NAVIGATE TO THE AIRPORT"', '"HOW QUICK IS THIS THING"',
                 '"CHARGE TO 80 PERCENT"', '"PAINT IT MIDNIGHT SILVER"']
        c.text(x + 18, y + 54, "TRY ASKING", TEXT_DIM, 2)
        for i, hint in enumerate(hints):
            c.text(x + 18, y + 80 + i * 26, hint, TEXT if i % 2 == 0 else TEXT_DIM, 2)
        return

    # newest-last chat log, clipped to the panel height
    scale = 2
    line_h = 20
    max_chars = int((w - 76) / (6 * scale))
    rendered: list[tuple[str, str]] = []
    for role, text in assistant.transcript:
        for line in wrap_text(text.upper(), max_chars):
            rendered.append((role, line))
    avail = int((h - 60) / line_h)
    for i, (role, line) in enumerate(rendered[-avail:]):
        ly = y + 50 + i * line_h
        if role == "user":
            c.text_right(x + w - 20, ly, line, ACCENT, scale)
        else:
            c.rect(x + 18, ly + 2, 3, 12, GROK_ACCENT)
            c.text(x + 30, ly, line, TEXT, scale)


def _bottom_bar(c: Canvas, state: CarState, x: float, y: float, w: float,
                h: float) -> None:
    c.rect(x, y, w, h, PANEL)
    c.rect(x, y, w, 1, LINE)

    # driver temperature
    c.text(24, y + 16, f"{state.hvac_setpoint_c:.1f}", TEXT if state.hvac_on else TEXT_DIM, 4)
    c.text(24 + 116, y + 24, "°C", TEXT_DIM, 2)
    c.text(24, y + 52, f"CABIN {state.cabin_temp_c:.0f}°C", TEXT_DIM, 2)

    # fan bars
    fx = 190
    for i in range(5):
        on = i < state.fan_speed and state.hvac_on
        c.rounded_rect(fx + i * 14, y + 44 - i * 4, 9, 18 + i * 4, 3,
                       ACCENT if on else PANEL_HI)
    c.text(fx, y + 16, "FAN", TEXT_DIM, 2)

    # seat heaters
    sx = 290
    c.text(sx, y + 16, "SEATS", TEXT_DIM, 2)
    for i, level in enumerate((state.seat_heater_left, state.seat_heater_right)):
        for b in range(3):
            c.rounded_rect(sx + i * 46, y + 56 - b * 12, 34, 8, 3,
                           RED if b < level else PANEL_HI)

    # media
    mx = 420
    c.circle(mx + 14, y + h / 2 - 4, 14, PANEL_HI)
    if state.media_playing:
        c.text(mx + 8, y + h / 2 - 11, "▶", TEXT, 2)
    else:
        c.rect(mx + 9, y + h / 2 - 11, 4, 14, TEXT)
        c.rect(mx + 16, y + h / 2 - 11, 4, 14, TEXT)
    track = state.media_track.upper()
    c.text(mx + 42, y + 22, track[:26], TEXT, 2)
    c.text(mx + 42, y + 46, f"VOLUME {state.volume}", TEXT_DIM, 2)

    # drive mode / regen / range on the right
    c.text_right(w - 24, y + 16,
                 f"{state.drive_mode.upper()} • {'STRONG' if state.regen_strong else 'MILD'} REGEN",
                 TEXT_DIM, 2)
    c.text_right(w - 24, y + 44, f"{state.range_m() / MILE:.0f} MI RANGE", TEXT, 2)


def render_to_png(path: str, state: CarState | None = None, assistant=None,
                  width: int = 1024, height: int = 640, page: str = "auto") -> None:
    """Convenience for docs and tests: render straight to a PNG file."""
    render_screen(state or CarState(), assistant, width, height, page).to_png(path)
