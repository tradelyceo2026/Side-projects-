"""Operators: build the car, drive it, talk to Grok, bake an animation."""

from __future__ import annotations

import os

import bpy
from bpy.props import FloatProperty, StringProperty

from copy import deepcopy

from . import builder, props as props_mod, rig, runtime
from .screen_driver import refresh_screen, save_screen_png
from .specs import MPH, summary


class MY_OT_build(bpy.types.Operator):
    bl_idname = "model_y.build"
    bl_label = "Build Model Y"
    bl_description = "Generate the 2023 Model Y Performance from its published specs"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        p = context.scene.model_y
        builder.build_scene(paint=p.paint, interior=p.include_interior,
                            studio=p.include_studio)
        rig.RIG.reset()
        rig.update(runtime.STATE, 0.0)
        refresh_screen(p.screen_page, force=True)
        self.report({"INFO"}, "Model Y built: " + summary().splitlines()[1].strip())
        return {"FINISHED"}


class MY_OT_reset(bpy.types.Operator):
    bl_idname = "model_y.reset"
    bl_label = "Reset Car State"
    bl_description = "Park it, refill the battery, close everything up"

    def execute(self, context):
        runtime.reset_car()
        rig.RIG.reset()
        props_mod.sync_from_state(context)
        rig.update(runtime.STATE, 0.0)
        refresh_screen(context.scene.model_y.screen_page, force=True)
        return {"FINISHED"}


class MY_OT_drive(bpy.types.Operator):
    """Modal driving loop: steps the physics and repaints the screen live."""

    bl_idname = "model_y.drive"
    bl_label = "Drive"
    bl_description = "Run the drivetrain simulation live in the viewport"

    _timer = None
    _running = False

    @classmethod
    def poll(cls, context):
        return builder.is_built()

    def invoke(self, context, event):
        if MY_OT_drive._running:              # second click stops it
            MY_OT_drive._running = False
            return {"CANCELLED"}
        wm = context.window_manager
        self._timer = wm.event_timer_add(1.0 / 30.0, window=context.window)
        wm.modal_handler_add(self)
        MY_OT_drive._running = True
        self._objects = builder.car_objects()
        self._accum = 0.0
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if not MY_OT_drive._running or event.type in {"ESC"}:
            return self.cancel(context)
        if event.type != "TIMER":
            return {"PASS_THROUGH"}

        from .vehicle_sim import step

        p = context.scene.model_y
        st = runtime.STATE
        dt = (1.0 / 30.0) * p.time_scale
        throttle, brake = p.throttle, p.brake
        if p.autopilot_hold and st.autopilot and st.gear == "D":
            error = st.autopilot_set_speed_ms - st.speed_ms
            throttle = max(0.0, min(1.0, error * 0.25))
            brake = max(0.0, min(1.0, -error * 0.10))
        step(st, dt, throttle=throttle, brake=brake)
        st.clock_minutes = (st.clock_minutes + dt / 60.0) % (24 * 60)

        rig.update(st, dt, self._objects)
        self._accum += dt
        if p.live_screen and self._accum > 0.2:
            self._accum = 0.0
            refresh_screen(p.screen_page)
            props_mod.sync_from_state(context)
        for area in context.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()
        return {"RUNNING_MODAL"}

    def cancel(self, context):
        MY_OT_drive._running = False
        if self._timer is not None:
            context.window_manager.event_timer_remove(self._timer)
            self._timer = None
        props_mod.sync_from_state(context)
        refresh_screen(context.scene.model_y.screen_page, force=True)
        return {"CANCELLED"}


class MY_OT_launch(bpy.types.Operator):
    """Full-throttle run to 60 mph, so you can watch the 3.5 s claim happen."""

    bl_idname = "model_y.launch"
    bl_label = "Launch to 60 mph"
    bl_description = "Simulate a standing start and report the time to 60 mph"

    def execute(self, context):
        from .vehicle_sim import simulate_acceleration, step

        st = runtime.STATE
        st.gear = "D"
        st.speed_ms = 0.0
        st.trip_m = 0.0
        objs = builder.car_objects()
        dt = 1.0 / 60.0
        elapsed = 0.0
        while st.speed_ms < 60 * MPH and elapsed < 20:
            step(st, dt, throttle=1.0)
            rig.update(st, dt, objs)
            elapsed += dt
        measured = simulate_acceleration()
        props_mod.sync_from_state(context)
        refresh_screen(context.scene.model_y.screen_page, force=True)
        self.report({"INFO"}, f"0-60 mph in {measured:.2f} s (published 3.5 s)")
        return {"FINISHED"}


class MY_OT_ask_grok(bpy.types.Operator):
    bl_idname = "model_y.ask_grok"
    bl_label = "Send"
    bl_description = "Ask Grok to do something with the car"

    prompt: StringProperty(name="Prompt", default="")

    def execute(self, context):
        p = context.scene.model_y
        text = (self.prompt or p.prompt).strip()
        if not text:
            self.report({"WARNING"}, "Nothing to ask")
            return {"CANCELLED"}
        runtime.configure(p.api_key, p.grok_model, p.allow_network)
        turn = runtime.assistant().ask(text)
        p.last_source = turn.source
        p.last_error = turn.error
        if not self.prompt:
            p.prompt = ""
        props_mod.sync_from_state(context)
        rig.update(runtime.STATE, 0.0)
        refresh_screen("grok" if p.screen_page == "auto" else p.screen_page, force=True)
        if turn.error:
            self.report({"WARNING"}, f"Grok fell back to offline: {turn.error}")
        else:
            self.report({"INFO"}, f"[{turn.source}] {turn.reply[:120]}")
        return {"FINISHED"}


class MY_OT_clear_chat(bpy.types.Operator):
    bl_idname = "model_y.clear_chat"
    bl_label = "Clear Conversation"

    def execute(self, context):
        runtime.assistant().reset()
        refresh_screen(context.scene.model_y.screen_page, force=True)
        return {"FINISHED"}


class MY_OT_bake(bpy.types.Operator):
    """Bake a stretch of driving into keyframes so it can be rendered."""

    bl_idname = "model_y.bake_drive"
    bl_label = "Bake Drive to Keyframes"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from .vehicle_sim import step

        scene = context.scene
        p = scene.model_y
        objs = builder.car_objects()
        if not objs:
            self.report({"ERROR"}, "Build the car first")
            return {"CANCELLED"}
        fps = scene.render.fps / max(1, scene.render.fps_base)
        frames = int(p.bake_seconds * fps)
        dt = 1.0 / fps
        st = runtime.STATE
        rig.RIG.reset()
        runtime.BAKED.clear()
        for i in range(frames + 1):
            frame = p.bake_start_frame + i
            rig.update(st, dt, objs, animate_panels=True)
            rig.keyframe(st, frame, objs)
            runtime.BAKED[frame] = deepcopy(st)
            step(st, dt, throttle=p.throttle, brake=p.brake)
        rig.set_interpolation(objs, "LINEAR")
        scene.frame_start = p.bake_start_frame
        scene.frame_end = p.bake_start_frame + frames
        props_mod.sync_from_state(context)
        self.report({"INFO"}, f"Baked {frames} frames at {fps:.0f} fps")
        return {"FINISHED"}


class MY_OT_photoreal(bpy.types.Operator):
    """Build a photoreal lighting setup and point the camera at the car."""

    bl_idname = "model_y.photoreal"
    bl_label = "Apply Look"
    bl_description = ("Replace the build lights with a studio, sunset or garage "
                      "setup, upgrade the materials and frame a shot")
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from . import studio

        p = context.scene.model_y
        info = studio.apply(preset=p.look, shot=p.shot, samples=p.samples,
                            resolution=(context.scene.render.resolution_x,
                                        context.scene.render.resolution_y))
        refined = studio.refine_body(p.subdiv_levels)
        self.report({"INFO"}, f"{p.look} look on {info['engine']}, "
                              f"{len(refined)} objects refined")
        return {"FINISHED"}


class MY_OT_render_still(bpy.types.Operator):
    """Render the current shot at full quality."""

    bl_idname = "model_y.render_still"
    bl_label = "Render Still"
    bl_options = {"REGISTER"}

    def execute(self, context):
        from . import studio

        p = context.scene.model_y
        studio.camera(p.shot)
        bpy.ops.render.render("INVOKE_DEFAULT", write_still=False)
        return {"FINISHED"}


class MY_OT_save_screen(bpy.types.Operator):
    bl_idname = "model_y.save_screen"
    bl_label = "Save Screen PNG"
    bl_description = "Write the current touchscreen to a PNG next to the .blend"

    filepath: StringProperty(subtype="FILE_PATH", default="")

    def execute(self, context):
        path = self.filepath or os.path.join(
            bpy.path.abspath("//") or os.path.expanduser("~"), "model_y_screen.png")
        save_screen_png(path, context.scene.model_y.screen_page)
        self.report({"INFO"}, f"Wrote {path}")
        return {"FINISHED"}


class MY_OT_set_temperature(bpy.types.Operator):
    bl_idname = "model_y.set_temperature"
    bl_label = "Temperature"

    delta: FloatProperty(default=0.5)

    def execute(self, context):
        p = context.scene.model_y
        p.hvac_setpoint = max(15.0, min(28.0, p.hvac_setpoint + self.delta))
        return {"FINISHED"}


CLASSES = (MY_OT_build, MY_OT_reset, MY_OT_drive, MY_OT_launch, MY_OT_ask_grok,
           MY_OT_clear_chat, MY_OT_bake, MY_OT_photoreal, MY_OT_render_still,
           MY_OT_save_screen, MY_OT_set_temperature)


def register() -> None:
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
