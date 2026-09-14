"""Photoreal render setups: lighting, environment, camera and colour management.

Most of what separates a "3D model" from a car photograph is not the mesh -- it
is what the paint has to reflect, how the light wraps, the focal length, the
depth of field and the tone curve.  This module builds three setups that are
each a complete look:

* ``studio``  -- black sweep, three large softboxes and two reflector cards; the
  classic advert shot where the highlights run the length of the body.
* ``sunset``  -- Blender's physical sky at a low sun angle over rough asphalt,
  with a warm key and a cool sky fill.  Reflections come from the sky itself.
* ``garage``  -- a dim concrete box lit by ceiling strips, wet floor.  Flatters
  the shoulders and puts long vertical highlights down the flanks.

Everything is procedural: no HDRI files, no textures to download.  Cycles is
used when the build has it (it is the one that will convince anybody) and the
setup degrades to EEVEE with raytracing where it does not.
"""

from __future__ import annotations

import math

import bpy

from .materials import _principled, set_input

PRESETS = ("studio", "sunset", "garage")
COLLECTION = "MY_Photoreal"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _collection() -> bpy.types.Collection:
    col = bpy.data.collections.get(COLLECTION)
    if col is None:
        col = bpy.data.collections.new(COLLECTION)
    if col.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(col)
    return col


def clear() -> None:
    """Remove a previously applied setup so presets can be switched freely."""
    col = bpy.data.collections.get(COLLECTION)
    if col is None:
        return
    for obj in list(col.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.collections.remove(col)


def _has_cycles() -> bool:
    try:
        return "CYCLES" in {i.identifier for i in
                            bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    except Exception:
        return False


def _set_enum(node, attr: str, candidates) -> str:
    """Set an enum to the first value this Blender build actually offers.

    Enum identifiers move between releases -- the physical sky was NISHITA in
    4.x and is MULTIPLE_SCATTERING in 5.x -- and assigning a missing one raises.
    """
    if not hasattr(node, attr):
        return ""
    try:
        available = {i.identifier for i in
                     node.bl_rna.properties[attr].enum_items}
    except (KeyError, AttributeError):
        available = set(candidates)
    for value in candidates:
        if value in available:
            setattr(node, attr, value)
            return value
    return ""


def _area_light(name: str, location, rotation, size, energy, color=(1.0, 1.0, 1.0),
                shape: str = "RECTANGLE", size_y: float | None = None):
    data = bpy.data.lights.new(name, "AREA")
    data.shape = shape if hasattr(data, "shape") else data.shape
    data.size = size
    if size_y is not None and hasattr(data, "size_y"):
        data.size_y = size_y
    data.energy = energy
    data.color = color
    if hasattr(data, "use_shadow"):
        data.use_shadow = True
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    obj.rotation_euler = rotation
    _collection().objects.link(obj)
    return obj


def _emissive_plane(name: str, location, rotation, size, strength, color=(1, 1, 1)):
    """A visible light source -- paint needs something to actually reflect."""
    me = bpy.data.meshes.new(name)
    hx, hy = size[0] / 2, size[1] / 2
    me.from_pydata([(-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0)], [],
                   [[0, 1, 2, 3]])
    me.update()
    mat, bsdf = _principled("MY_Softbox_" + name)
    set_input(bsdf, "Base Color", (0.0, 0.0, 0.0, 1.0))
    set_input(bsdf, ("Emission Color", "Emission"), (color[0], color[1], color[2], 1.0))
    set_input(bsdf, "Emission Strength", strength)
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    obj.location = location
    obj.rotation_euler = rotation
    _collection().objects.link(obj)
    return obj


# ---------------------------------------------------------------------------
# ground
# ---------------------------------------------------------------------------


def _ground(kind: str) -> bpy.types.Object:
    """A big plane with a procedural surface: sweep, asphalt or concrete."""
    me = bpy.data.meshes.new("MY_Ground")
    r = 60.0
    me.from_pydata([(-r, -r, 0), (r, -r, 0), (r, r, 0), (-r, r, 0)], [], [[0, 1, 2, 3]])
    me.update()
    obj = bpy.data.objects.new("MY_Ground", me)
    _collection().objects.link(obj)

    mat, bsdf = _principled("MY_Ground_" + kind)
    tree = mat.node_tree
    nodes, links = tree.nodes, tree.links

    if kind == "studio":
        set_input(bsdf, "Base Color", (0.020, 0.020, 0.022, 1.0))
        set_input(bsdf, "Roughness", 0.22)
        set_input(bsdf, ("Coat Weight", "Clearcoat"), 0.4)
        me.materials.append(mat)
        return obj

    # asphalt / concrete: noise into both roughness and a bump, so the ground
    # breaks up the reflections instead of acting like a mirror
    coord = nodes.new("ShaderNodeTexCoord")
    coord.location = (-980, -60)
    noise = nodes.new("ShaderNodeTexNoise")
    noise.location = (-780, -60)
    noise.inputs["Scale"].default_value = 180.0 if kind == "asphalt" else 60.0
    if "Detail" in noise.inputs:
        noise.inputs["Detail"].default_value = 8.0
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.location = (-560, -60)
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[1].position = 0.75
    bump = nodes.new("ShaderNodeBump")
    bump.location = (-330, -220)
    bump.inputs["Strength"].default_value = 0.22 if kind == "asphalt" else 0.10
    links.new(coord.outputs["Object"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    if "Normal" in bsdf.inputs:
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Roughness"])

    if kind == "asphalt":
        set_input(bsdf, "Base Color", (0.015, 0.015, 0.016, 1.0))
        # a damp road doubles the amount of car you see: reflections carry it
        set_input(bsdf, ("Coat Weight", "Clearcoat"), 0.65)
        set_input(bsdf, ("Coat Roughness", "Clearcoat Roughness"), 0.12)
    else:
        set_input(bsdf, "Base Color", (0.055, 0.055, 0.058, 1.0))
    me.materials.append(mat)
    return obj


# ---------------------------------------------------------------------------
# world
# ---------------------------------------------------------------------------


def _world(kind: str, sun_elevation: float = 6.0, sun_rotation: float = 135.0) -> None:
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    tree = world.node_tree
    for node in list(tree.nodes):
        if node.bl_idname != "ShaderNodeOutputWorld":
            tree.nodes.remove(node)
    out = tree.nodes.get("World Output") or tree.nodes.new("ShaderNodeOutputWorld")
    bg = tree.nodes.new("ShaderNodeBackground")
    bg.location = (-260, 0)
    tree.links.new(bg.outputs["Background"], out.inputs["Surface"])

    if kind == "sunset":
        sky = tree.nodes.new("ShaderNodeTexSky")
        sky.location = (-560, 0)
        _set_enum(sky, "sky_type",
                  # the physical sky model, renamed between 4.x and 5.x
                  ("MULTIPLE_SCATTERING", "NISHITA", "HOSEK_WILKIE", "PREETHAM"))
        for attr, value in (("sun_elevation", math.radians(sun_elevation)),
                            ("sun_rotation", math.radians(sun_rotation)),
                            ("sun_intensity", 0.6), ("altitude", 300.0),
                            ("air_density", 1.6), ("dust_density", 3.2)):
            if hasattr(sky, attr):
                setattr(sky, attr, value)
        tree.links.new(sky.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 1.0
    elif kind == "garage":
        bg.inputs["Color"].default_value = (0.012, 0.013, 0.016, 1.0)
        bg.inputs["Strength"].default_value = 1.0
    else:                                      # studio: near-black surround
        bg.inputs["Color"].default_value = (0.004, 0.004, 0.005, 1.0)
        bg.inputs["Strength"].default_value = 1.0


# ---------------------------------------------------------------------------
# presets
# ---------------------------------------------------------------------------


def _studio_lights() -> None:
    # one long softbox down each side is what draws the highlight line along
    # the shoulder; a top box opens the roof and the glass
    _emissive_plane("MY_Box_Left", (0.0, 5.2, 3.0), (math.radians(118), 0, 0),
                    (9.0, 3.0), 12.0)
    _emissive_plane("MY_Box_Right", (0.0, -5.2, 3.0), (math.radians(-118), 0, 0),
                    (9.0, 3.0), 9.0)
    _emissive_plane("MY_Box_Top", (0.2, 0.0, 6.0), (math.radians(180), 0, 0),
                    (10.0, 5.0), 5.0)
    _area_light("MY_Key_Front", (7.5, -4.0, 3.2),
                (math.radians(70), 0, math.radians(62)), 4.0, 900.0)
    _area_light("MY_Rim_Rear", (-6.5, 3.6, 2.4),
                (math.radians(75), 0, math.radians(-120)), 3.0, 700.0,
                color=(0.85, 0.90, 1.0))
    _emissive_plane("MY_Reflector_Low", (2.0, -4.0, 0.35),
                    (math.radians(-80), 0, 0), (6.0, 1.2), 3.0,
                    color=(1.0, 0.98, 0.95))


def _sunset_lights() -> None:
    sun = bpy.data.lights.new("MY_Sun", "SUN")
    sun.energy = 5.0
    sun.color = (1.0, 0.76, 0.52)
    if hasattr(sun, "angle"):
        sun.angle = math.radians(1.2)          # soft-edged shadows
    obj = bpy.data.objects.new("MY_Sun", sun)
    obj.rotation_euler = (math.radians(84), 0.0, math.radians(135))
    _collection().objects.link(obj)
    # a big cool bounce from the opposite side stands in for skylight
    _emissive_plane("MY_Sky_Fill", (-2.0, 6.0, 3.2), (math.radians(105), 0, 0),
                    (12.0, 5.0), 1.6, color=(0.55, 0.70, 1.0))


def _garage_lights() -> None:
    for i, x in enumerate((6.0, 1.5, -3.0, -7.5)):
        _emissive_plane("MY_Strip_%d" % i, (x, 0.0, 3.6), (math.radians(180), 0, 0),
                        (0.45, 7.0), 26.0, color=(1.0, 0.95, 0.88))
    _area_light("MY_Garage_Fill", (5.0, -6.0, 2.4),
                (math.radians(74), 0, math.radians(50)), 5.0, 240.0,
                color=(0.9, 0.94, 1.0))


# ---------------------------------------------------------------------------
# camera
# ---------------------------------------------------------------------------


SHOTS = {
    # name: (location, aim, focal length, f-stop)
    #
    # Car photographers use long lenses from a long way back -- it compresses
    # the body and keeps the wheels round.  The distances below are set so the
    # 4.75 m car fills the frame at the given focal length on a 36 mm sensor:
    # distance ~= subject width * focal / sensor width.
    "three_quarter": ((11.6, -9.3, 1.55), (0.10, 0.0, 0.82), 85.0, 4.0),
    "front_low": ((12.2, -2.9, 0.62), (0.80, 0.0, 0.74), 70.0, 3.5),
    "rear_three_quarter": ((-11.9, 7.5, 1.50), (-0.40, 0.0, 0.86), 85.0, 4.0),
    "side": ((0.4, -18.6, 1.02), (0.0, 0.0, 0.85), 120.0, 5.6),
    "wheel": ((5.6, -4.3, 0.52), (1.45, -0.62, 0.42), 105.0, 2.2),
    "cabin": ((0.10, 0.26, 1.14), (0.76, 0.0, 1.00), 42.0, 4.0),
}


SENSOR_WIDTH = 36.0


def frames_car(shot: str, car_width: float = 5.4) -> bool:
    """Would this shot actually fit the car in frame?  Used by the tests."""
    from mathutils import Vector

    location, aim, lens, _ = SHOTS[shot]
    distance = (Vector(aim) - Vector(location)).length
    covered = distance * SENSOR_WIDTH / lens
    return covered >= car_width if shot not in ("wheel", "cabin") else True


def camera(shot: str = "three_quarter") -> bpy.types.Object:
    """Place the scene camera for a named shot, with depth of field on the car."""
    from mathutils import Vector

    location, aim, lens, fstop = SHOTS.get(shot, SHOTS["three_quarter"])
    cam = bpy.data.objects.get("MY_Camera")
    if cam is None or cam.type != "CAMERA":
        data = bpy.data.cameras.new("MY_Camera")
        cam = bpy.data.objects.new("MY_Camera", data)
        _collection().objects.link(cam)
    for constraint in list(cam.constraints):
        cam.constraints.remove(constraint)

    cam.data.lens = lens
    cam.location = location
    direction = Vector(aim) - Vector(location)
    # an object in quaternion mode ignores rotation_euler completely, and the
    # camera silently keeps aiming wherever it was pointed before
    cam.rotation_mode = "XYZ"
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    dof = cam.data.dof
    dof.use_dof = True
    dof.focus_distance = direction.length
    dof.aperture_fstop = fstop
    bpy.context.scene.camera = cam
    return cam


# ---------------------------------------------------------------------------
# render settings
# ---------------------------------------------------------------------------


def _render_settings(samples: int = 256, resolution=(2560, 1440)) -> str:
    scene = bpy.context.scene
    engine = "CYCLES" if _has_cycles() else scene.render.engine
    scene.render.engine = engine

    if engine == "CYCLES" and hasattr(scene, "cycles"):
        c = scene.cycles
        c.samples = samples
        for attr, value in (("use_denoising", True), ("use_adaptive_sampling", True),
                            ("adaptive_threshold", 0.01), ("max_bounces", 16),
                            ("transmission_bounces", 12), ("transparent_max_bounces", 16),
                            ("caustics_reflective", True), ("caustics_refractive", True),
                            ("blur_glossy", 0.5)):
            if hasattr(c, attr):
                setattr(c, attr, value)
        # use the GPU when one is configured: this is the difference between a
        # 40 second frame and a 6 minute one
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            if getattr(prefs, "compute_device_type", "NONE") not in ("NONE", ""):
                c.device = "GPU"
        except (KeyError, AttributeError):
            pass
    elif hasattr(scene, "eevee"):
        for attr, value in (("taa_render_samples", max(64, samples // 4)),
                            ("use_raytracing", True), ("use_shadows", True),
                            ("use_bloom", True), ("use_gtao", True)):
            if hasattr(scene.eevee, attr):
                setattr(scene.eevee, attr, value)

    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    if hasattr(scene.render, "use_motion_blur"):
        scene.render.use_motion_blur = False

    # colour management is doing more work here than most people expect: AgX is
    # what keeps a bright highlight on white paint from clipping to a flat blob
    view = scene.view_settings
    for name in ("AgX", "Filmic"):
        try:
            view.view_transform = name
            break
        except TypeError:
            continue
    for look in ("AgX - Medium High Contrast", "Medium High Contrast", "None"):
        try:
            view.look = look
            break
        except TypeError:
            continue
    view.exposure = 0.0
    view.gamma = 1.0
    return engine


# ---------------------------------------------------------------------------
# public
# ---------------------------------------------------------------------------


def apply(preset: str = "studio", shot: str = "three_quarter", samples: int = 256,
          resolution=(2560, 1440)) -> dict[str, object]:
    """Tear down any previous setup and build ``preset``.  Returns what it did."""
    if preset not in PRESETS:
        preset = "studio"
    clear()
    _world("sunset" if preset == "sunset" else preset)
    ground = _ground({"studio": "studio", "sunset": "asphalt",
                      "garage": "concrete"}[preset])
    if preset == "studio":
        _studio_lights()
    elif preset == "sunset":
        _sunset_lights()
    else:
        _garage_lights()

    # the old build-time studio lights would fight this one
    for name in ("MY_Key", "MY_Fill", "MY_Rim", "MY_Backdrop"):
        obj = bpy.data.objects.get(name)
        if obj is not None:
            obj.hide_render = True
            obj.hide_viewport = True

    cam = camera(shot)
    engine = _render_settings(samples, resolution)
    upgrade_car_materials()
    return {"preset": preset, "shot": shot, "engine": engine,
            "camera": cam.name, "ground": ground.name,
            "objects": len(_collection().objects)}


def upgrade_car_materials(flake: float = 0.35) -> list[str]:
    """Push the car's materials from 'clean CG' towards 'photographed'.

    Three things do most of the work: metallic flake in the paint (a fine noise
    into the normal, so the colour breaks up under a moving highlight), real
    roughness variation on the tyres and alloys, and glass that is a solid
    surface rather than a transparency hack.
    """
    touched = []

    paint = bpy.data.materials.get("MY_Paint")
    if paint is not None and paint.use_nodes:
        tree = paint.node_tree
        bsdf = tree.nodes.get("Principled BSDF")
        if bsdf is not None and not any(n.bl_idname == "ShaderNodeTexNoise"
                                        for n in tree.nodes):
            coord = tree.nodes.new("ShaderNodeTexCoord")
            coord.location = (-980, 260)
            noise = tree.nodes.new("ShaderNodeTexNoise")
            noise.location = (-760, 260)
            noise.inputs["Scale"].default_value = 900.0
            if "Detail" in noise.inputs:
                noise.inputs["Detail"].default_value = 2.0
            bump = tree.nodes.new("ShaderNodeBump")
            bump.location = (-520, 200)
            bump.inputs["Strength"].default_value = flake * 0.06
            tree.links.new(coord.outputs["Object"], noise.inputs["Vector"])
            tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
            if "Normal" in bsdf.inputs:
                tree.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
            set_input(bsdf, ("Coat Weight", "Clearcoat"), 1.0)
            set_input(bsdf, ("Coat Roughness", "Clearcoat Roughness"), 0.02)
            touched.append("MY_Paint")

    glass = bpy.data.materials.get("MY_Glass")
    if glass is not None and glass.use_nodes:
        bsdf = glass.node_tree.nodes.get("Principled BSDF")
        if bsdf is not None:
            if _has_cycles():
                set_input(bsdf, "Alpha", 1.0)
                set_input(bsdf, ("Transmission Weight", "Transmission"), 1.0)
                set_input(bsdf, "Base Color", (0.62, 0.66, 0.70, 1.0))
                set_input(bsdf, "Roughness", 0.03)
                set_input(bsdf, "IOR", 1.52)
            else:
                set_input(bsdf, "Alpha", 0.55)
            touched.append("MY_Glass")

    tyre = bpy.data.materials.get("MY_Tire")
    if tyre is not None and tyre.use_nodes:
        tree = tyre.node_tree
        bsdf = tree.nodes.get("Principled BSDF")
        if bsdf is not None and not any(n.bl_idname == "ShaderNodeTexNoise"
                                        for n in tree.nodes):
            noise = tree.nodes.new("ShaderNodeTexNoise")
            noise.location = (-640, -220)
            noise.inputs["Scale"].default_value = 340.0
            bump = tree.nodes.new("ShaderNodeBump")
            bump.location = (-420, -260)
            bump.inputs["Strength"].default_value = 0.25
            tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
            if "Normal" in bsdf.inputs:
                tree.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
            set_input(bsdf, "Roughness", 0.62)
            set_input(bsdf, "Base Color", (0.013, 0.013, 0.014, 1.0))
            touched.append("MY_Tire")

    alloy = bpy.data.materials.get("MY_WheelAlloy")
    if alloy is not None and alloy.use_nodes:
        bsdf = alloy.node_tree.nodes.get("Principled BSDF")
        if bsdf is not None:
            set_input(bsdf, "Roughness", 0.28)
            set_input(bsdf, "Metallic", 1.0)
            set_input(bsdf, "Base Color", (0.52, 0.53, 0.55, 1.0))
            touched.append("MY_WheelAlloy")

    return touched


def refine_body(levels: int = 2) -> list[str]:
    """Raise subdivision on the shell.

    Reflections are what reveal a low-poly car: the highlight band steps across
    facets instead of flowing.  Level 2 on the body is the cheapest fix there
    is, and it costs nothing in the viewport (render levels only).
    """
    changed = []
    for name in ("ModelY_Body", "Frunk_Lid", "Tailgate", "Mirrors", "Spoiler"):
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        mod = obj.modifiers.get("Smooth")
        if mod is None:
            mod = obj.modifiers.new("Smooth", "SUBSURF")
        mod.levels = min(1, levels)
        mod.render_levels = levels
        if hasattr(mod, "use_limit_surface"):
            mod.use_limit_surface = True
        for poly in obj.data.polygons:
            poly.use_smooth = True
        changed.append(name)
    return changed
