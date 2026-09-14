"""Headless entry point: build the car and save a .blend.

    blender --background --python build.py -- --out model_y.blend
    blender --background --python build.py -- --paint "Red Multi-Coat" --no-interior
    blender --background --python build.py -- --render hero.png

Run it from the repository root (or anywhere -- the script adds its own folder to
``sys.path``).  Without Blender it still works as a spec/simulation check:

    python3 build.py --self-test
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import bpy
except ModuleNotFoundError:
    bpy = None


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Build the 2023 Model Y Performance")
    ap.add_argument("--out", default="", help="save the .blend here")
    ap.add_argument("--paint", default="Deep Blue Metallic")
    ap.add_argument("--no-interior", action="store_true")
    ap.add_argument("--no-studio", action="store_true")
    ap.add_argument("--render", default="", help="render a still to this path")
    ap.add_argument("--screen", default="", help="write the touchscreen to a PNG")
    ap.add_argument("--ask", default="", help="ask Grok something before saving")
    ap.add_argument("--self-test", action="store_true",
                    help="print the spec sheet and the simulated performance")
    return ap.parse_args(argv)


def self_test() -> int:
    from model_y import specs, vehicle_sim as sim

    print(specs.summary())
    print()
    print(f"  simulated 0-60    {sim.simulate_acceleration():.2f} s")
    print(f"  simulated 0-100   {sim.simulate_acceleration(target_mph=62.137):.2f} s")
    print(f"  70 mph consumption {sim.simulate_steady_consumption(70.0):.0f} Wh/mi")
    print(f"  10-80% supercharge {sim.charge_time_estimate_s(sim.CarState(soc=0.1), 0.8) / 60:.0f} min")
    return 0


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parse_args(argv)

    if args.self_test or bpy is None:
        if bpy is None and not args.self_test:
            print("bpy not found: run this through Blender, or pass --self-test")
        return self_test()

    from model_y import builder, rig, runtime, screen_driver

    objects = builder.build_scene(paint=args.paint, interior=not args.no_interior,
                                  studio=not args.no_studio)
    if args.ask:
        turn = runtime.assistant().ask(args.ask)
        print(f"[{turn.source}] {turn.reply}")
        for name, params in turn.tool_calls:
            print(f"   -> {name}({params})")
    rig.RIG.reset()
    rig.update(runtime.STATE, 0.0, objects)
    screen_driver.refresh_screen(force=True)

    body = objects["ModelY_Body"]
    print("Model Y built: %d objects, body %.1f x %.1f mm"
          % (len(objects), body.dimensions[0] * 1000, body.dimensions[1] * 1000))

    if args.screen:
        print("screen ->", screen_driver.save_screen_png(args.screen))
    if args.render:
        bpy.context.scene.render.filepath = os.path.abspath(args.render)
        bpy.ops.render.render(write_still=True)
        print("render ->", args.render)
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
        print("saved ->", args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
