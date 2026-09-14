"""The N-panel: build controls, the car's own controls, and the Grok console."""

from __future__ import annotations

import bpy

from . import builder, runtime
from .ops import MY_OT_drive
from .specs import MILE, MPH, SPEC

CATEGORY = "Model Y"

SUGGESTIONS = [
    "Set the cabin to 20 degrees",
    "Open the frunk",
    "Navigate to the airport",
    "Charge to 80 percent",
    "Paint it Midnight Silver Metallic",
    "How quick is this thing?",
]


class ModelYPanel(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = CATEGORY


class MY_PT_build(ModelYPanel):
    bl_idname = "MY_PT_build"
    bl_label = "Vehicle"

    def draw(self, context):
        layout = self.layout
        p = context.scene.model_y
        col = layout.column(align=True)
        col.prop(p, "paint")
        row = col.row(align=True)
        row.prop(p, "include_interior", toggle=True)
        row.prop(p, "include_studio", toggle=True)
        col.separator()
        col.operator("model_y.build", icon="AUTO")
        if not builder.is_built():
            col.label(text="Not built yet", icon="INFO")
            return
        col.operator("model_y.reset", icon="LOOP_BACK")

        box = layout.box()
        box.label(text=f"{SPEC.model_year} {SPEC.name}")
        d = SPEC.dims
        box.label(text=f"{d.length * 1000:.0f} x {d.width_body * 1000:.0f} x "
                       f"{d.height * 1000:.0f} mm")
        box.label(text=f"{SPEC.powertrain.peak_power_w / 1000:.0f} kW • "
                       f"{SPEC.perf.zero_to_sixty_s} s 0-60 • "
                       f"{SPEC.perf.epa_range_m / MILE:.0f} mi")


class MY_PT_drive(ModelYPanel):
    bl_idname = "MY_PT_drive"
    bl_label = "Drive"
    bl_parent_id = "MY_PT_build"

    def draw(self, context):
        layout = self.layout
        p = context.scene.model_y
        st = runtime.STATE

        row = layout.row(align=True)
        row.prop(p, "gear", expand=True)
        layout.prop(p, "drive_mode", expand=True)

        col = layout.column(align=True)
        col.prop(p, "throttle", slider=True)
        col.prop(p, "brake", slider=True)
        col.prop(p, "steering", slider=True)
        col.prop(p, "time_scale")

        row = layout.row(align=True)
        label = "Stop" if MY_OT_drive._running else "Drive"
        row.operator("model_y.drive", text=label,
                     icon="PAUSE" if label == "Stop" else "PLAY")
        row.operator("model_y.launch", icon="CON_FOLLOWPATH")

        box = layout.box()
        box.label(text=f"{st.speed_mph:5.1f} mph   {st.gear}", icon="AUTO")
        box.label(text=f"{st.soc * 100:.0f}%   {st.range_m() / MILE:.0f} mi range",
                  icon="RIGHTARROW")
        power = st.battery_power_w / 1000.0
        box.label(text=f"{power:+.1f} kW   {st.motor_rpm():.0f} motor rpm")
        if st.autopilot:
            box.label(text=f"Autopilot {st.autopilot_set_speed_ms / MPH:.0f} mph",
                      icon="CON_TRACKTO")
            box.prop(p, "autopilot_hold")


class MY_PT_cabin(ModelYPanel):
    bl_idname = "MY_PT_cabin"
    bl_label = "Cabin & Body"
    bl_parent_id = "MY_PT_build"

    def draw(self, context):
        layout = self.layout
        p = context.scene.model_y
        st = runtime.STATE

        row = layout.row(align=True)
        row.prop(p, "hvac_on", toggle=True, icon="OUTLINER_OB_FORCE_FIELD")
        row.prop(p, "fan_speed")
        layout.prop(p, "hvac_setpoint", slider=True)
        layout.label(text=f"Cabin {st.cabin_temp_c:.1f} °C  •  outside "
                          f"{st.outside_temp_c:.0f} °C")

        grid = layout.grid_flow(row_major=True, columns=2, align=True)
        grid.prop(p, "locked", toggle=True, icon="LOCKED")
        grid.prop(p, "headlights", toggle=True, icon="LIGHT")
        grid.prop(p, "frunk_open", toggle=True, icon="TRIA_UP")
        grid.prop(p, "trunk_open", toggle=True, icon="TRIA_UP")
        grid.prop(p, "charge_port_open", toggle=True, icon="PLUGIN")
        grid.prop(p, "sentry_mode", toggle=True, icon="HIDE_OFF")

        box = layout.box()
        box.prop(p, "battery_percent", slider=True)
        row = box.row(align=True)
        row.prop(p, "charging", toggle=True, icon="PLUGIN")
        row.prop(p, "charge_limit")
        if st.charging:
            box.label(text=f"{st.charge_power_w / 1000:.0f} kW "
                           f"(V3 taper at {st.soc * 100:.0f}%)")


class MY_PT_grok(ModelYPanel):
    bl_idname = "MY_PT_grok"
    bl_label = "Grok"

    def draw(self, context):
        layout = self.layout
        p = context.scene.model_y
        assistant = runtime.assistant()
        live = assistant.mode == "grok"

        header = layout.row()
        header.label(text="Live (xAI API)" if live else "Offline intent engine",
                     icon="WORLD" if live else "CONSOLE")

        row = layout.row(align=True)
        row.prop(p, "prompt", text="")
        row.operator("model_y.ask_grok", text="", icon="PLAY")

        col = layout.column(align=True)
        for hint in SUGGESTIONS:
            op = col.operator("model_y.ask_grok", text=hint, icon="DOT")
            op.prompt = hint

        if assistant.transcript:
            box = layout.box()
            for role, text in assistant.transcript[-6:]:
                icon = "USER" if role == "user" else "LIGHT_SUN"
                for i, line in enumerate(_wrap(text, 38)):
                    box.label(text=line, icon=icon if i == 0 else "BLANK1")
            layout.operator("model_y.clear_chat", icon="TRASH")
        if p.last_error:
            layout.label(text=p.last_error[:60], icon="ERROR")


class MY_PT_grok_setup(ModelYPanel):
    bl_idname = "MY_PT_grok_setup"
    bl_label = "Connection"
    bl_parent_id = "MY_PT_grok"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        p = context.scene.model_y
        layout.prop(p, "api_key")
        layout.prop(p, "grok_model")
        layout.prop(p, "allow_network")
        layout.label(text="Or set XAI_API_KEY before launching Blender")
        if runtime.LAST_ERROR:
            layout.label(text=runtime.LAST_ERROR[:60], icon="ERROR")


class MY_PT_screen(ModelYPanel):
    bl_idname = "MY_PT_screen"
    bl_label = "Touchscreen"

    def draw(self, context):
        layout = self.layout
        p = context.scene.model_y
        layout.prop(p, "screen_page", expand=True)
        layout.prop(p, "live_screen")
        layout.operator("model_y.save_screen", icon="IMAGE_DATA")

        box = layout.box()
        box.label(text="Animation")
        box.prop(p, "bake_seconds")
        box.prop(p, "bake_start_frame")
        box.operator("model_y.bake_drive", icon="KEYFRAME")


def _wrap(text: str, width: int) -> list[str]:
    from .ui.raster import wrap_text
    return wrap_text(text, width) or [""]


CLASSES = (MY_PT_build, MY_PT_drive, MY_PT_cabin, MY_PT_grok, MY_PT_grok_setup,
           MY_PT_screen)


def register() -> None:
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
