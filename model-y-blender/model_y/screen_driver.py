"""Paint the touchscreen UI into the Blender image that lights the 15" display.

The UI is rasterised in pure Python (``model_y/ui``) and pushed into the image
datablock with ``foreach_set``, which is the fast path -- a 1024x640 redraw and
upload lands in the low hundreds of milliseconds, so the screen can update live
while the car drives in the viewport.
"""

from __future__ import annotations

import bpy

from . import runtime
from .materials import SCREEN_IMAGE_NAME, screen_material
from .ui.screen import render_screen

_LAST_SIGNATURE: tuple = ()


def screen_image() -> bpy.types.Image:
    image = bpy.data.images.get(SCREEN_IMAGE_NAME)
    if image is None:
        _, image = screen_material()
    return image


def _signature(page: str) -> tuple:
    """Cheap change detector so idle redraws cost nothing."""
    s = runtime.STATE
    a = runtime._ASSISTANT
    return (
        page, round(s.speed_ms, 1), round(s.soc, 4), s.gear, s.hvac_on,
        s.hvac_setpoint_c, round(s.cabin_temp_c, 1), s.fan_speed, s.locked,
        s.frunk_open, s.trunk_open, tuple(s.doors_open), s.charging,
        round(s.charge_power_w), s.headlights, s.brake_lights, s.paint,
        s.media_track, s.media_playing, s.volume, s.navigation_destination,
        round(s.navigation_distance_m), s.autopilot, s.drive_mode,
        s.seat_heater_left, s.seat_heater_right, s.clock_minutes,
        s.sentry_mode, round(s.odometer_m), len(a.transcript) if a else 0,
        a.transcript[-1][1] if (a and a.transcript) else "",
    )


def refresh_screen(page: str = "auto", force: bool = False) -> bool:
    """Re-render the UI into the image.  Returns True if pixels were written."""
    global _LAST_SIGNATURE
    sig = _signature(page)
    if sig == _LAST_SIGNATURE and not force:
        return False
    _LAST_SIGNATURE = sig

    image = screen_image()
    width, height = image.size[0] or 1024, image.size[1] or 640
    canvas = render_screen(runtime.STATE, runtime._ASSISTANT, width, height, page)
    pixels = canvas.to_blender_pixels()
    try:
        image.pixels.foreach_set(pixels)
    except AttributeError:                    # very old builds
        image.pixels[:] = pixels
    image.update()
    if image.preview is not None:
        image.preview.reload() if hasattr(image.preview, "reload") else None
    return True


def save_screen_png(path: str, page: str = "auto") -> str:
    """Write the current screen out as a PNG (handy for documentation)."""
    from .ui.screen import render_screen as _render

    canvas = _render(runtime.STATE, runtime._ASSISTANT, 1024, 640, page)
    canvas.to_png(path)
    return path
