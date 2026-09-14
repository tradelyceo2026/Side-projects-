"""Drive the Blender objects from the car's state.

Everything the simulation produces shows up in the viewport here: wheels spin at
the right rate for the speed (711.9 mm tyres, so 1 m of travel is 2.88 rad), the
front knuckles steer with Ackermann geometry off the published 2890 mm
wheelbase, the body squats and dives on its springs, the panels swing on their
hinges, and the lamps light up.
"""

from __future__ import annotations

import math

import bpy

from . import materials
from .builder import car_objects
from .specs import SPEC
from .vehicle_sim import CarState

# suspension feel: how far the body leans per m/s^2 and how much it settles
PITCH_PER_G = math.radians(1.05)
ROLL_PER_G = math.radians(0.9)
RIDE_DROP_AT_TOP_SPEED = 0.012

PANEL_OPEN_ANGLE = {"Frunk_Lid": math.radians(-52.0), "Tailgate": math.radians(62.0)}


class RigState:
    """Continuous values the rig has to remember between updates."""

    def __init__(self) -> None:
        self.wheel_angle = 0.0          # radians of accumulated rotation
        self.panel_open = {"Frunk_Lid": 0.0, "Tailgate": 0.0}
        self.pitch = 0.0
        self.roll = 0.0

    def reset(self) -> None:
        self.__init__()


RIG = RigState()


def ackermann(steer_deg: float) -> tuple[float, float]:
    """Inner/outer road-wheel angles for a given average steer angle."""
    if abs(steer_deg) < 1e-4:
        return 0.0, 0.0
    wb = SPEC.dims.wheelbase
    track = SPEC.dims.track_front
    avg = math.radians(abs(steer_deg))
    radius = wb / math.tan(avg)
    inner = math.atan(wb / max(0.5, radius - track / 2))
    outer = math.atan(wb / (radius + track / 2))
    sign = 1.0 if steer_deg > 0 else -1.0
    return sign * inner, sign * outer


def update(state: CarState, dt: float, objects: dict[str, bpy.types.Object] | None = None,
           animate_panels: bool = True) -> None:
    """Push one frame of car state onto the rig."""
    objs = objects if objects is not None else car_objects()
    if not objs:
        return

    # wheels: rotation is speed / rolling radius, integrated
    RIG.wheel_angle -= state.speed_ms / SPEC.wheels.rolling_radius * dt
    inner, outer = ackermann(state.steering_deg)
    left_steer = inner if state.steering_deg > 0 else outer
    right_steer = outer if state.steering_deg > 0 else inner

    for name in ("Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"):
        wheel = objs.get(name)
        if wheel is not None:
            wheel.rotation_euler[1] = RIG.wheel_angle
        knuckle = objs.get(f"MY_Steer_{name[-2:]}")
        if knuckle is not None:
            knuckle.rotation_euler[2] = (left_steer if name == "Wheel_FL" else
                                         right_steer if name == "Wheel_FR" else 0.0)

    # body: dive under braking, squat under power, settle at speed
    target_pitch = -state.accel_ms2 / 9.80665 * PITCH_PER_G
    RIG.pitch += (target_pitch - RIG.pitch) * min(1.0, dt * 6.0)
    lateral = 0.0
    if state.speed_ms > 1.0 and abs(state.steering_deg) > 0.1:
        radius = SPEC.dims.wheelbase / math.tan(math.radians(abs(state.steering_deg)))
        lateral = state.speed_ms ** 2 / max(radius, 1.0)
        lateral *= 1.0 if state.steering_deg > 0 else -1.0
    target_roll = -lateral / 9.80665 * ROLL_PER_G
    RIG.roll += (target_roll - RIG.roll) * min(1.0, dt * 5.0)

    body_root = objs.get("MY_Body_Root")
    if body_root is not None:
        body_root.rotation_euler[1] = RIG.pitch
        body_root.rotation_euler[0] = RIG.roll
        drop = RIDE_DROP_AT_TOP_SPEED * min(1.0, state.speed_ms / SPEC.perf.top_speed_ms)
        body_root.location[2] = -drop

    # panels ease open and closed rather than snapping
    wanted = {"Frunk_Lid": 1.0 if state.frunk_open else 0.0,
              "Tailgate": 1.0 if state.trunk_open else 0.0}
    for part, target in wanted.items():
        current = RIG.panel_open[part]
        current += (target - current) * (min(1.0, dt * 2.6) if animate_panels else 1.0)
        RIG.panel_open[part] = current
        hinge = objs.get(f"MY_Hinge_{part}")
        if hinge is not None:
            hinge.rotation_euler[1] = PANEL_OPEN_ANGLE[part] * current

    # lamps
    materials.set_light_emission("Light_Head", 9.0 if state.headlights else 0.35)
    materials.set_light_emission("Light_Tail",
                                 12.0 if state.brake_lights else
                                 (3.0 if state.headlights else 0.6))


def keyframe(state: CarState, frame: int,
             objects: dict[str, bpy.types.Object] | None = None) -> None:
    """Record the current rig pose on ``frame`` so a drive can be rendered."""
    objs = objects if objects is not None else car_objects()
    for name in ("Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"):
        obj = objs.get(name)
        if obj is not None:
            obj.keyframe_insert("rotation_euler", frame=frame)
    for name in ("MY_Steer_FL", "MY_Steer_FR", "MY_Hinge_Frunk_Lid",
                 "MY_Hinge_Tailgate"):
        obj = objs.get(name)
        if obj is not None:
            obj.keyframe_insert("rotation_euler", frame=frame)
    body_root = objs.get("MY_Body_Root")
    if body_root is not None:
        body_root.keyframe_insert("rotation_euler", frame=frame)
        body_root.keyframe_insert("location", frame=frame)


def set_interpolation(objects: dict[str, bpy.types.Object] | None = None,
                      mode: str = "LINEAR") -> None:
    """Baked wheel spin must not ease, or the wheels look like they stutter."""
    objs = objects if objects is not None else car_objects()
    for obj in objs.values():
        action = getattr(getattr(obj, "animation_data", None), "action", None)
        if action is None:
            continue
        for fcurve in action.fcurves:
            for kp in fcurve.keyframe_points:
                kp.interpolation = mode
