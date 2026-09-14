"""Tesla Model Y 2023 Performance -- a procedural Blender add-on.

Install this folder as an add-on (or run ``build.py`` headless) and you get the
car generated from its published specifications, a working drivetrain
simulation, a live 15" touchscreen rendered inside Blender, and Grok wired to
the car's controls through xAI function calling -- with an offline intent
engine standing in when there is no API key.

The package is import-safe without Blender: the ``bpy``-free half (specs,
geometry, vehicle_sim, grok, ui) can be imported and tested in a plain Python
interpreter, which is what ``tests/`` does.
"""

from __future__ import annotations

bl_info = {
    "name": "Tesla Model Y 2023 Performance",
    "author": "Side projects",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > Model Y",
    "description": "Procedural Model Y Performance with a working touchscreen "
                   "and Grok assistant",
    "category": "Add Mesh",
}

try:  # pragma: no cover - exercised only inside Blender
    import bpy
except ModuleNotFoundError:  # importable for tests and tooling
    bpy = None  # type: ignore[assignment]

from . import grok, specs, vehicle_sim  # noqa: F401  (public, bpy-free API)

if bpy is not None:
    from bpy.app.handlers import persistent

    from . import builder, materials, ops, props, rig, runtime, screen_driver, ui_panel

    class ModelYPreferences(bpy.types.AddonPreferences):
        bl_idname = __package__ or "model_y"

        api_key: bpy.props.StringProperty(
            name="xAI API Key", subtype="PASSWORD", default="",
            description="Used for live Grok. Falls back to $XAI_API_KEY, then offline",
        )
        model: bpy.props.StringProperty(name="Model", default=grok.DEFAULT_MODEL)

        def draw(self, context):
            col = self.layout.column()
            col.prop(self, "api_key")
            col.prop(self, "model")
            col.label(text="Without a key the car answers from its own offline "
                           "intent engine.")

    def _prefs():
        try:
            return bpy.context.preferences.addons[ModelYPreferences.bl_idname].preferences
        except (KeyError, AttributeError):
            return None

    @persistent
    def _on_load(_dummy):
        prefs = _prefs()
        if prefs is not None:
            runtime.configure(prefs.api_key, prefs.model, True)
        if builder.is_built():
            screen_driver.refresh_screen(force=True)

    @persistent
    def _on_frame(scene):
        """Replay a baked drive so the touchscreen animates when rendering."""
        snapshot = runtime.BAKED.get(scene.frame_current)
        if snapshot is None:
            return
        runtime.STATE.__dict__.update(snapshot.__dict__)
        screen_driver.refresh_screen(scene.model_y.screen_page, force=True)

    def register() -> None:
        bpy.utils.register_class(ModelYPreferences)
        props.register()
        ops.register()
        ui_panel.register()
        prefs = _prefs()
        if prefs is not None:
            runtime.configure(prefs.api_key, prefs.model, True)
        if _on_load not in bpy.app.handlers.load_post:
            bpy.app.handlers.load_post.append(_on_load)
        if _on_frame not in bpy.app.handlers.frame_change_post:
            bpy.app.handlers.frame_change_post.append(_on_frame)

    def unregister() -> None:
        if _on_frame in bpy.app.handlers.frame_change_post:
            bpy.app.handlers.frame_change_post.remove(_on_frame)
        if _on_load in bpy.app.handlers.load_post:
            bpy.app.handlers.load_post.remove(_on_load)
        ui_panel.unregister()
        ops.unregister()
        props.unregister()
        bpy.utils.unregister_class(ModelYPreferences)

else:  # pragma: no cover - plain Python import path

    def register() -> None:
        raise RuntimeError("register() needs Blender; import model_y.specs etc. instead")

    def unregister() -> None:
        register()
