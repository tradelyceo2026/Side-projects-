"""Scene properties: the bridge between Blender's UI and the car's state.

Every editable control writes straight into :data:`model_y.runtime.STATE`, and
:func:`sync_from_state` pushes the other way after the simulation or Grok has
changed something.  ``_SYNCING`` stops the two directions chasing each other.
"""

from __future__ import annotations

import bpy
from bpy.props import (BoolProperty, EnumProperty, FloatProperty, IntProperty,
                       PointerProperty, StringProperty)
from bpy.types import PropertyGroup

from . import materials, runtime
from .specs import DEFAULT_PAINT, PAINT_COLORS, SPEC
from .vehicle_sim import DRIVE_MODES, GEARS

_SYNCING = False


def _refresh(context=None) -> None:
    from .screen_driver import refresh_screen
    refresh_screen()


def _push(attr: str, value) -> None:
    if _SYNCING:
        return
    setattr(runtime.STATE, attr, value)
    _refresh()


def _update_paint(self, context) -> None:
    if _SYNCING:
        return
    runtime.STATE.paint = self.paint
    materials.set_paint_color(self.paint)
    _refresh()


def _update_gear(self, context) -> None:
    _push("gear", self.gear)


def _update_steering(self, context) -> None:
    if _SYNCING:
        return
    runtime.STATE.steering_deg = self.steering
    from . import rig
    rig.update(runtime.STATE, 0.0)


def _update_climate(self, context) -> None:
    if _SYNCING:
        return
    st = runtime.STATE
    st.hvac_on = self.hvac_on
    st.hvac_setpoint_c = self.hvac_setpoint
    st.fan_speed = self.fan_speed
    _refresh()


def _update_body(self, context) -> None:
    if _SYNCING:
        return
    st = runtime.STATE
    st.locked = self.locked
    st.frunk_open = self.frunk_open
    st.trunk_open = self.trunk_open
    st.headlights = self.headlights
    st.charge_port_open = self.charge_port_open
    st.sentry_mode = self.sentry_mode
    from . import rig
    rig.update(st, 0.0)
    _refresh()


def _update_charging(self, context) -> None:
    if _SYNCING:
        return
    st = runtime.STATE
    st.charging = self.charging
    st.charge_limit = self.charge_limit / 100.0
    if st.charging:
        st.gear = "P"
        st.charge_port_open = True
    _refresh()


def _update_soc(self, context) -> None:
    _push("soc", self.battery_percent / 100.0)


def _update_drive_mode(self, context) -> None:
    _push("drive_mode", self.drive_mode)


def _update_grok_config(self, context) -> None:
    runtime.configure(self.api_key, self.grok_model, self.allow_network)
    _refresh()


class ModelYProperties(PropertyGroup):
    # --- build
    paint: EnumProperty(
        name="Paint",
        items=[(k, k, "") for k in PAINT_COLORS],
        default=DEFAULT_PAINT,
        update=_update_paint,
    )
    include_interior: BoolProperty(name="Interior", default=True)
    include_studio: BoolProperty(name="Studio Lighting", default=True)

    # --- driving
    gear: EnumProperty(name="Gear", items=[(g, g, "") for g in GEARS], default="P",
                       update=_update_gear)
    drive_mode: EnumProperty(name="Mode", items=[(m, m, "") for m in DRIVE_MODES],
                             default="Standard", update=_update_drive_mode)
    throttle: FloatProperty(name="Accelerator", min=0.0, max=1.0, default=0.0,
                            subtype="FACTOR")
    brake: FloatProperty(name="Brake", min=0.0, max=1.0, default=0.0, subtype="FACTOR")
    steering: FloatProperty(name="Steering", min=-40.0, max=40.0, default=0.0,
                            update=_update_steering,
                            description="Road-wheel angle in degrees, positive left")
    time_scale: FloatProperty(name="Time Scale", min=0.1, max=4.0, default=1.0,
                              description="Simulated seconds per real second")
    autopilot_hold: BoolProperty(
        name="Hold Set Speed", default=False,
        description="Let the simulation keep the Autopilot set speed by itself")

    # --- cabin
    hvac_on: BoolProperty(name="Climate", default=True, update=_update_climate)
    hvac_setpoint: FloatProperty(name="Set °C", min=SPEC.interior.hvac_min_c,
                                 max=SPEC.interior.hvac_max_c, default=21.0,
                                 update=_update_climate)
    fan_speed: IntProperty(name="Fan", min=0, max=5, default=3, update=_update_climate)

    # --- body
    locked: BoolProperty(name="Locked", default=True, update=_update_body)
    frunk_open: BoolProperty(name="Frunk", default=False, update=_update_body)
    trunk_open: BoolProperty(name="Tailgate", default=False, update=_update_body)
    headlights: BoolProperty(name="Headlights", default=False, update=_update_body)
    charge_port_open: BoolProperty(name="Charge Port", default=False, update=_update_body)
    sentry_mode: BoolProperty(name="Sentry", default=False, update=_update_body)

    # --- energy
    battery_percent: FloatProperty(name="Battery %", min=0.0, max=100.0, default=72.0,
                                   update=_update_soc)
    charging: BoolProperty(name="Charging", default=False, update=_update_charging)
    charge_limit: FloatProperty(name="Limit %", min=50.0, max=100.0, default=90.0,
                                update=_update_charging)

    # --- grok
    prompt: StringProperty(name="Ask Grok", default="",
                           description="Say what you want the car to do")
    api_key: StringProperty(name="xAI API Key", default="", subtype="PASSWORD",
                            update=_update_grok_config,
                            description="Leave blank to use XAI_API_KEY or to stay offline")
    grok_model: StringProperty(name="Model", default="grok-4",
                               update=_update_grok_config)
    allow_network: BoolProperty(name="Allow Network", default=True,
                                update=_update_grok_config,
                                description="Uncheck to force the offline intent engine")
    last_source: StringProperty(name="Source", default="")
    last_error: StringProperty(name="Error", default="")

    # --- screen
    screen_page: EnumProperty(
        name="Screen",
        items=[("auto", "Auto", "Grok when there is a conversation"),
               ("home", "Home", "Map and car card"),
               ("grok", "Grok", "Conversation")],
        default="auto",
        update=lambda self, ctx: _refresh(),
    )
    live_screen: BoolProperty(name="Live Screen", default=True,
                              description="Repaint the touchscreen as the car changes")

    # --- photoreal
    look: EnumProperty(
        name="Look",
        items=[("studio", "Studio", "Black sweep, big softboxes, advert lighting"),
               ("sunset", "Sunset", "Physical sky low over damp asphalt"),
               ("garage", "Garage", "Dim concrete box, ceiling strips, wet floor")],
        default="studio",
    )
    shot: EnumProperty(
        name="Shot",
        items=[("three_quarter", "3/4 Front", "The classic hero angle"),
               ("front_low", "Front Low", "Low and close on the nose"),
               ("rear_three_quarter", "3/4 Rear", "Shoulder line and tail"),
               ("side", "Side", "Long lens profile, the way a spec shot is taken"),
               ("wheel", "Wheel", "Tight on the Uberturbine and caliper"),
               ("cabin", "Cabin", "Over the dash at the touchscreen")],
        default="three_quarter",
    )
    samples: IntProperty(name="Samples", min=16, max=4096, default=256,
                         description="Cycles samples; EEVEE uses a quarter of this")
    subdiv_levels: IntProperty(name="Subdivision", min=0, max=3, default=2,
                               description="Render-time subdivision on the body")

    # --- baking
    bake_seconds: FloatProperty(name="Seconds", min=0.5, max=120.0, default=6.0)
    bake_start_frame: IntProperty(name="Start Frame", min=0, default=1)


def sync_from_state(context=None) -> None:
    """Mirror the simulation back into the UI without retriggering updates."""
    global _SYNCING
    scene = (context or bpy.context).scene
    props = getattr(scene, "model_y", None)
    if props is None:
        return
    st = runtime.STATE
    _SYNCING = True
    try:
        props.gear = st.gear
        props.drive_mode = st.drive_mode
        props.hvac_on = st.hvac_on
        props.hvac_setpoint = st.hvac_setpoint_c
        props.fan_speed = st.fan_speed
        props.locked = st.locked
        props.frunk_open = st.frunk_open
        props.trunk_open = st.trunk_open
        props.headlights = st.headlights
        props.charge_port_open = st.charge_port_open
        props.sentry_mode = st.sentry_mode
        props.battery_percent = st.soc * 100.0
        props.charging = st.charging
        props.charge_limit = st.charge_limit * 100.0
        if props.paint != st.paint and st.paint in PAINT_COLORS:
            props.paint = st.paint
            materials.set_paint_color(st.paint)
    finally:
        _SYNCING = False


def register() -> None:
    bpy.utils.register_class(ModelYProperties)
    bpy.types.Scene.model_y = PointerProperty(type=ModelYProperties)


def unregister() -> None:
    del bpy.types.Scene.model_y
    bpy.utils.unregister_class(ModelYProperties)
