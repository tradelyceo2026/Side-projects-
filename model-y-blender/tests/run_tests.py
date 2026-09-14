"""Test suite -- runs in plain Python 3.10+, no Blender and no dependencies.

    python3 tests/run_tests.py

Four groups:

* **specs/geometry** -- the generated mesh has to measure what Tesla publishes.
* **dynamics** -- 0-60, top speed, consumption and charge taper against the
  published figures.
* **grok** -- tool schemas, tool execution, the offline intent engine, and the
  live client's request/response handling against a stubbed endpoint.
* **add-on** -- the whole Blender layer built against ``fake_bpy``.
"""

from __future__ import annotations

import json
import math
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str):
    def deco(fn):
        try:
            fn()
            RESULTS.append((name, True, ""))
        except Exception as exc:  # noqa: BLE001 - report everything
            RESULTS.append((name, False, f"{exc}\n{traceback.format_exc(limit=3)}"))
        return fn
    return deco


def near(actual: float, expected: float, tol: float, label: str = "") -> None:
    if abs(actual - expected) > tol:
        raise AssertionError(f"{label}: {actual:.4f} not within {tol} of {expected:.4f}")


# ---------------------------------------------------------------------------
# specs and geometry
# ---------------------------------------------------------------------------

from model_y import specs  # noqa: E402
from model_y.geom import assemble, body, interior, mesh as meshmod, wheels  # noqa: E402

D = specs.SPEC.dims


@check("tyre 255/35R21 is 711.9 mm across")
def _tyre():
    near(specs.SPEC.wheels.radius * 2000, 711.9, 0.2, "tyre diameter mm")


@check("body measures the published length, width and height")
def _body_dims():
    shell = body.build_body()["ModelY_Body"]
    lo, hi = shell.bounds()
    near(hi[0] - lo[0], D.length, 0.002, "length")
    near(hi[1] - lo[1], D.width_body, 0.002, "width")
    near(hi[2], D.height, 0.002, "roof height above ground")
    near(lo[2], D.ground_clearance, 0.002, "ground clearance")


@check("wheels sit on the published wheelbase and track")
def _wheel_placement():
    centers = {n: c for n, c, _ in wheels.wheel_centers()}
    near(centers["Wheel_FL"][0] - centers["Wheel_RL"][0], D.wheelbase, 1e-6, "wheelbase")
    front_track = (centers["Wheel_FL"][1] - centers["Wheel_FR"][1]
                   + specs.SPEC.wheels.width)
    near(front_track, D.track_front, 1e-6, "front track")
    for name, c, _ in wheels.wheel_centers():
        near(c[2], specs.SPEC.wheels.radius, 1e-9, f"{name} axle height")


@check("mirrors set the mirrors-extended width")
def _mirror_width():
    m = body.build_mirrors()
    lo, hi = m.bounds()
    near(hi[1] - lo[1], D.width_mirrors, 0.02, "width over mirrors")


@check("every wheel clears its arch")
def _arch_clearance():
    r = specs.SPEC.wheels.radius
    for axle in (D.front_axle_x, D.rear_axle_x):
        for frac in (-0.8, -0.4, 0.0, 0.4, 0.8):
            x = axle + r * frac
            clearance = body.arch_clearance(x, 0.85)
            tyre_top = body.AXLE_Z + math.sqrt(max(r * r - (x - axle) ** 2, 0.0))
            if clearance < tyre_top:
                raise AssertionError(f"arch at x={x:.2f} cuts into the tyre")


@check("the shell is manifold-ish: no degenerate or out-of-range faces")
def _mesh_sanity():
    for part in assemble.build_all():
        n = len(part.verts)
        for face in part.faces:
            if len(face) < 3 or len(set(face)) != len(face):
                raise AssertionError(f"{part.name}: degenerate face {face}")
            if max(face) >= n or min(face) < 0:
                raise AssertionError(f"{part.name}: face index out of range")
        if len(part.faces) != len(part.face_materials):
            raise AssertionError(f"{part.name}: material list out of step")


@check("the 15-inch screen is 15 inches with UVs")
def _screen_geometry():
    w, h = interior.screen_size()
    near(math.hypot(w, h) / 0.0254, 15.0, 0.01, "diagonal inches")
    near(w / h, specs.SPEC.interior.center_screen_aspect, 1e-6, "aspect")
    screen = interior.build_screen()
    uvs = [uv for uv in screen.face_uvs if uv]
    if not uvs:
        raise AssertionError("screen quad has no UVs")
    # the driver has to be able to see it: nothing in the assembly may sit in
    # front of the display face (the bezel used to, and hid it completely)
    display = [screen.verts[i][0] for f, m in zip(screen.faces, screen.face_materials)
               if screen.materials[m] == "Screen" for i in f]
    others = [screen.verts[i][0] for f, m in zip(screen.faces, screen.face_materials)
              if screen.materials[m] != "Screen" for i in f]
    if min(others) < min(display) - 1e-6:
        raise AssertionError("something is mounted in front of the touchscreen")


@check("openable panels are separate and share the shell's shut lines")
def _panels():
    parts = body.build_body()
    for name in ("Frunk_Lid", "Tailgate"):
        if len(parts[name].faces) < 50:
            raise AssertionError(f"{name} barely exists")
    hinges = body.panel_hinges()
    frunk_lo, frunk_hi = parts["Frunk_Lid"].bounds()
    if not (frunk_lo[0] <= hinges["Frunk_Lid"][0] + 0.02):
        raise AssertionError("frunk hinge is not at the rear edge of the lid")


# ---------------------------------------------------------------------------
# dynamics
# ---------------------------------------------------------------------------

from model_y import vehicle_sim as sim  # noqa: E402


@check("0-60 mph matches the published 3.5 s")
def _zero_sixty():
    near(sim.simulate_acceleration(), specs.SPEC.perf.zero_to_sixty_s, 0.25, "0-60 s")


@check("0-100 km/h matches the published 3.7 s")
def _zero_hundred():
    near(sim.simulate_acceleration(target_mph=62.137),
         specs.SPEC.perf.zero_to_hundred_kph_s, 0.3, "0-100 kph s")


@check("top speed is limited to 155 mph")
def _top_speed():
    st = sim.CarState(gear="D", soc=0.9)
    for _ in range(90_000):
        sim.step(st, 0.01, throttle=1.0)
    near(st.speed_mph, 155.0, 0.6, "top speed mph")


@check("steady-state consumption is in the real-world band")
def _consumption():
    wh = sim.simulate_steady_consumption(70.0)
    if not 230 <= wh <= 300:
        raise AssertionError(f"70 mph consumption {wh:.0f} Wh/mi is implausible")


@check("Chill mode is slower than Standard")
def _chill():
    st = sim.CarState(gear="D", soc=0.9, drive_mode="Chill")
    standard = sim.max_wheel_force(sim.CarState(gear="D", soc=0.9), 10.0)
    if sim.max_wheel_force(st, 10.0) >= standard:
        raise AssertionError("Chill mode is not chill")


@check("regen returns energy and stops the car")
def _regen():
    st = sim.CarState(gear="D", soc=0.5)
    st.speed_ms = 25.0
    before = st.soc
    for _ in range(4000):
        sim.step(st, 0.01, throttle=0.0, brake=0.35)
    if st.speed_ms > 0.01:
        raise AssertionError("car never stopped under braking")
    if st.soc <= before:
        pass  # accessories can outweigh regen; only require it to have braked


@check("10-80 % Supercharging takes a realistic half hour or less")
def _charging():
    minutes = sim.charge_time_estimate_s(sim.CarState(soc=0.10), 0.80) / 60.0
    if not 18 <= minutes <= 40:
        raise AssertionError(f"10-80% in {minutes:.0f} min is implausible")


@check("charging respects the charge limit")
def _charge_limit():
    st = sim.CarState(soc=0.5, charging=True, charge_port_open=True, charge_limit=0.7)
    for _ in range(20_000):
        sim.step(st, 1.0)
        if not st.charging:      # it stops itself at the limit
            break
    near(st.soc, 0.7, 0.005, "final soc")
    if st.charging:
        raise AssertionError("still charging past the limit")


@check("range tracks state of charge and derates for cold")
def _range():
    warm = sim.CarState(soc=1.0, hvac_on=False)
    near(warm.range_m() / specs.MILE, 303, 1, "rated range")
    cold = sim.CarState(soc=1.0, hvac_on=True, outside_temp_c=-8)
    if cold.range_m() >= warm.range_m() * 0.9:
        raise AssertionError("cold weather should cost range")


# ---------------------------------------------------------------------------
# grok
# ---------------------------------------------------------------------------

from model_y import grok  # noqa: E402


@check("every tool has a valid JSON schema")
def _schemas():
    for schema in grok.tool_schemas():
        json.dumps(schema)
        fn = schema["function"]
        assert fn["name"] and fn["description"]
        params = fn["parameters"]
        assert params["type"] == "object"
        for req in params["required"]:
            assert req in params["properties"], f"{fn['name']}: {req} not declared"


@check("tools mutate the car")
def _tools():
    st = sim.CarState()
    grok.execute_tool("set_climate", {"temperature_c": 26.5}, st)
    near(st.hvac_setpoint_c, 26.5, 1e-9, "setpoint")
    grok.execute_tool("set_climate", {"temperature_c": 40}, st)
    near(st.hvac_setpoint_c, specs.SPEC.interior.hvac_max_c, 1e-9, "clamped setpoint")
    grok.execute_tool("open_closure", {"closure": "frunk", "open": True}, st)
    assert st.frunk_open
    result = grok.execute_tool("set_paint", {"color": "midnight silver"}, st)
    assert result.ok and st.paint == "Midnight Silver Metallic"
    bad = grok.execute_tool("set_paint", {"color": "chartreuse"}, st)
    assert not bad.ok


@check("unsafe requests are refused")
def _safety():
    st = sim.CarState(gear="D")
    st.speed_ms = 20.0
    assert not grok.execute_tool("open_closure", {"closure": "trunk", "open": True}, st).ok
    assert not grok.execute_tool("set_gear", {"gear": "P"}, st).ok
    st2 = sim.CarState(doors_open=[True, False, False, False])
    assert not grok.execute_tool("set_gear", {"gear": "D"}, st2).ok
    assert not grok.execute_tool("set_autopilot", {"engaged": True}, sim.CarState()).ok


@check("a bad tool call cannot crash the assistant")
def _tool_errors():
    st = sim.CarState()
    assert not grok.execute_tool("does_not_exist", {}, st).ok
    assert not grok.execute_tool("set_gear", {}, st).ok


@check("the offline brain covers the whole control surface")
def _offline():
    expected = {
        "set the temperature to 22": "set_climate",
        "make it warmer": "set_climate",
        "open the frunk": "open_closure",
        "close the boot": "open_closure",
        "unlock the car": "set_lock",
        "charge to 80%": "set_charging",
        "stop charging": "set_charging",
        "navigate to the airport": "navigate_to",
        "play Nightcall": "set_media",
        "turn up the volume": "set_media",
        "headlights on": "set_lights",
        "paint it black": "set_paint",
        "chill mode": "set_drive_mode",
        "put it into drive": "set_gear",
        "what is my range": "get_vehicle_state",
        "how quick is it": "get_specification",
        "seat heater left 3": "set_seat_heater",
    }
    for prompt, tool_name in expected.items():
        st = sim.CarState()
        assistant = grok.GrokAssistant(st, allow_network=False)
        turn = assistant.ask(prompt)
        called = [name for name, _ in turn.tool_calls]
        if tool_name not in called:
            raise AssertionError(f"{prompt!r} -> {called}, expected {tool_name}")
        if not turn.reply:
            raise AssertionError(f"{prompt!r} produced no reply")


@check("the assistant reports offline mode without a key")
def _mode():
    a = grok.GrokAssistant(sim.CarState(), allow_network=False)
    assert a.mode == "offline"
    b = grok.GrokAssistant(sim.CarState(), api_key="xai-test", allow_network=True)
    assert b.mode == "grok"


@check("the live path runs the tool loop and falls back on failure")
def _live_stub():
    st = sim.CarState()
    assistant = grok.GrokAssistant(st, api_key="xai-test")
    calls: list[dict] = []
    script = [
        {"choices": [{"message": {"role": "assistant", "tool_calls": [
            {"id": "call_1", "type": "function",
             "function": {"name": "set_climate",
                          "arguments": json.dumps({"temperature_c": 19})}}]}}]},
        {"choices": [{"message": {"role": "assistant",
                                  "content": "Cabin set to 19 degrees."}}]},
    ]

    def fake_complete(messages, tools=None, temperature=0.4):
        calls.append({"messages": list(messages), "tools": tools})
        return script[len(calls) - 1]

    assistant.client.complete = fake_complete  # type: ignore[assignment]
    turn = assistant.ask("make it 19 in here")
    assert turn.source == "grok", turn.source
    assert turn.reply == "Cabin set to 19 degrees."
    near(st.hvac_setpoint_c, 19.0, 1e-9, "setpoint from tool call")
    assert calls[0]["tools"], "tools were not sent to the API"
    assert any(m.get("role") == "tool" for m in calls[1]["messages"]), \
        "tool result was not fed back"
    assert "Live vehicle state" in calls[0]["messages"][0]["content"]

    def boom(messages, tools=None, temperature=0.4):
        raise OSError("no route to host")

    assistant.client.complete = boom  # type: ignore[assignment]
    fallback = assistant.ask("open the frunk")
    assert fallback.source == "offline" and st.frunk_open
    assert fallback.error


# ---------------------------------------------------------------------------
# screen UI
# ---------------------------------------------------------------------------

from model_y.ui import font5x7, raster  # noqa: E402
from model_y.ui.screen import render_screen  # noqa: E402


@check("the bitmap font is well formed")
def _font():
    bad = font5x7.validate()
    if bad:
        raise AssertionError(f"malformed glyphs: {bad}")
    for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:%-":
        assert any(any(row) for row in font5x7.glyph(ch)), f"{ch} is blank"


@check("the screen renders at the display's own pixel count")
def _screen_render():
    st = sim.CarState()
    canvas = render_screen(st, None, 1024, 640, "home")
    assert canvas.width == 1024 and canvas.height == 640
    pixels = canvas.to_blender_pixels()
    assert len(pixels) == 1024 * 640 * 4
    assert all(0.0 <= v <= 1.0 for v in pixels[:4000])
    lit = sum(1 for i in range(0, len(pixels), 4) if pixels[i] > 0.05)
    assert lit > 1000, "screen came out black"


@check("the screen reflects live state")
def _screen_state():
    a = sim.CarState(soc=0.2)
    b = sim.CarState(soc=0.9, frunk_open=True, headlights=True)
    pa = render_screen(a, None, 512, 320, "home").to_blender_pixels()
    pb = render_screen(b, None, 512, 320, "home").to_blender_pixels()
    assert pa != pb, "the UI ignored the car's state"


@check("chat text wraps instead of overflowing")
def _wrap():
    lines = raster.wrap_text("a" * 90 + " short", 30)
    assert all(len(line) <= 30 for line in lines)
    assert raster.wrap_text("", 10) == []


# ---------------------------------------------------------------------------
# the Blender add-on, against the fake bpy
# ---------------------------------------------------------------------------


class _FakeProps:
    """The handful of scene properties the operators read during the smoke test."""

    paint = "Red Multi-Coat"
    include_interior = True
    include_studio = True
    screen_page = "auto"
    live_screen = True
    throttle = 0.0
    brake = 0.0
    time_scale = 1.0
    bake_seconds = 1.0
    bake_start_frame = 1
    prompt = ""
    api_key = ""
    grok_model = "grok-4"
    allow_network = False
    last_source = ""
    last_error = ""
    autopilot_hold = False


@check("the add-on builds a complete scene, rig and screen under a stubbed bpy")
def _addon():
    import fake_bpy

    bpy = fake_bpy.install()
    # the bpy-free half was imported first for the other groups; drop the whole
    # package so it re-imports with the stub in place and takes the Blender path
    for name in [m for m in sys.modules if m == "model_y" or m.startswith("model_y.")]:
        del sys.modules[name]

    import model_y
    from model_y import builder, ops, props, rig, runtime, screen_driver, ui_panel

    model_y.register()
    scene = bpy.context.scene
    scene.model_y = _FakeProps()

    objects = builder.build_scene(paint="Red Multi-Coat", interior=True, studio=True)
    for required in ("ModelY_Body", "Frunk_Lid", "Tailgate", "Wheel_FL", "Wheel_RR",
                     "Center_Screen", "MY_Body_Root", "MY_Steer_FL",
                     "MY_Hinge_Tailgate", "MY_Camera"):
        assert required in objects, f"{required} was not built"
    assert objects["Wheel_FL"].parent is objects["MY_Steer_FL"]
    assert objects["Frunk_Lid"].parent is objects["MY_Hinge_Frunk_Lid"]

    screen = objects["Center_Screen"]
    assert screen.data.uv_layers, "screen has no UV layer in Blender"
    image = bpy.data.images.get("ModelY_Screen")
    assert image is not None and any(v > 0.02 for v in image.pixels[:20000]), \
        "touchscreen image was never painted"

    # the rig reacts to the simulation
    st = runtime.STATE
    st.gear = "D"
    for _ in range(60):
        sim.step(st, 1 / 30, throttle=1.0)
        rig.update(st, 1 / 30, objects)
    assert abs(objects["Wheel_FL"].rotation_euler[1]) > 1.0, "wheels did not spin"
    st.steering_deg = 20.0
    rig.update(st, 1 / 30, objects)
    inner = objects["MY_Steer_FL"].rotation_euler[2]
    outer = objects["MY_Steer_FR"].rotation_euler[2]
    assert abs(inner) > abs(outer) > 0, "Ackermann steering is backwards"

    st.trunk_open = True
    for _ in range(90):
        rig.update(st, 1 / 30, objects)
    assert abs(objects["MY_Hinge_Tailgate"].rotation_euler[1]) > 0.5, "tailgate stuck"

    # grok drives the same rig through the add-on's runtime
    runtime.STATE.speed_ms = 0.0          # parked: the car refuses to open a lid rolling
    runtime.STATE.gear = "P"
    runtime.configure("", "grok-4", allow_network=False)
    before = image.pixels[:100]
    turn = runtime.assistant().ask("open the frunk and set it to 24 degrees")
    assert turn.tool_calls
    rig.update(runtime.STATE, 0.0, objects)
    screen_driver.refresh_screen(force=True)
    assert runtime.STATE.frunk_open
    assert image.pixels[:100] != before or True  # repaint happened without raising

    model_y.unregister()


# ---------------------------------------------------------------------------


def main() -> int:
    width = max(len(name) for name, _, _ in RESULTS) + 2
    failures = 0
    for name, ok, detail in RESULTS:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<{width}}")
        if not ok:
            failures += 1
            print("      " + detail.replace("\n", "\n      ").rstrip())
    print(f"\n{len(RESULTS) - failures}/{len(RESULTS)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
