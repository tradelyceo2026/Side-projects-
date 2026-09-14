"""Turn the pure-Python geometry into a Blender scene.

``build_scene()`` is idempotent: it clears anything it made previously, rebuilds
the car, wires up the rig empties (steering knuckles, wheel spin, panel hinges,
a body root that pitches under acceleration), paints the touchscreen image onto
the 15" display, and optionally adds a small studio: three area lights, a
turntable-friendly camera and a grey backdrop.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Matrix, Vector

from . import materials
from .geom.assemble import build_all as build_geometry
from .geom.body import panel_hinges
from .geom.wheels import wheel_centers
from .specs import DEFAULT_PAINT, SPEC

ROOT_COLLECTION = "Tesla_Model_Y_2023_Performance"
SUB_COLLECTIONS = ("Body", "Wheels", "Interior", "Rig", "Studio")

BODY_PARTS = {"ModelY_Body", "Mirrors", "Spoiler", "Brakelight_Bar"}
PANEL_PARTS = {"Frunk_Lid", "Tailgate"}
LIGHT_PARTS = {"Headlight_L", "Headlight_R", "Taillight_L", "Taillight_R",
               "Reflector_L", "Reflector_R"}


# ---------------------------------------------------------------------------
# collections
# ---------------------------------------------------------------------------


def _collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
    target = parent or bpy.context.scene.collection
    if col.name not in target.children:
        try:
            target.children.link(col)
        except RuntimeError:
            pass
    return col


def clear_existing() -> None:
    """Remove a previously built car so rebuilding never duplicates objects."""
    root = bpy.data.collections.get(ROOT_COLLECTION)
    if root is None:
        return
    for col in list(root.children_recursive) + [root]:
        for obj in list(col.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    for col in list(root.children_recursive):
        bpy.data.collections.remove(col)
    bpy.data.collections.remove(root)


# ---------------------------------------------------------------------------
# mesh conversion
# ---------------------------------------------------------------------------


def mesh_to_object(part, mats: dict[str, bpy.types.Material],
                   collection: bpy.types.Collection) -> bpy.types.Object:
    me = bpy.data.meshes.new(part.name)
    me.from_pydata([Vector(v) for v in part.verts], [], part.faces)
    me.validate(verbose=False)

    for slot_name in part.materials:
        me.materials.append(mats.get(slot_name) or mats["Trim_Black"])
    for poly, index in zip(me.polygons, part.face_materials):
        poly.material_index = index
        poly.use_smooth = part.shade_smooth

    uvs = [uv for uv in part.face_uvs if uv]
    if uvs:
        layer = me.uv_layers.new(name="UVMap")
        for poly, face_uv in zip(me.polygons, part.face_uvs):
            if not face_uv:
                continue
            for k, loop_index in enumerate(poly.loop_indices):
                if k < len(face_uv):
                    layer.data[loop_index].uv = face_uv[k]

    me.update()
    obj = bpy.data.objects.new(part.name, me)
    collection.objects.link(obj)
    return obj


def _empty(name: str, location, collection: bpy.types.Collection,
           display: str = "PLAIN_AXES", size: float = 0.25) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = display
    obj.empty_display_size = size
    obj.location = location
    collection.objects.link(obj)
    return obj


def _parent(child: bpy.types.Object, parent: bpy.types.Object,
            parent_world: "Matrix | None" = None) -> None:
    """Parent without inheriting the parent's offset.

    ``parent.matrix_world`` is only correct after a depsgraph evaluation, and
    objects created in this same run have not had one -- reading it there gives
    the identity and every child ends up offset twice.  The rig's empties are
    pure translations, so the caller passes the world matrix it just set.
    """
    child.parent = parent
    child.matrix_parent_inverse = (parent_world or parent.matrix_world).inverted()


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------


def build_scene(paint: str = DEFAULT_PAINT, interior: bool = True,
                studio: bool = True) -> dict[str, bpy.types.Object]:
    """Build (or rebuild) the whole car.  Returns the named objects."""
    clear_existing()
    root = _collection(ROOT_COLLECTION)
    cols = {name: _collection(f"MY_{name}", root) for name in SUB_COLLECTIONS}
    mats = materials.build_all(paint)

    objects: dict[str, bpy.types.Object] = {}
    body_root = _empty("MY_Body_Root", (0.0, 0.0, 0.0), cols["Rig"], "ARROWS", 0.6)
    objects["MY_Body_Root"] = body_root

    hinges = panel_hinges()
    hinge_objs: dict[str, bpy.types.Object] = {}
    for part_name, pivot in hinges.items():
        h = _empty(f"MY_Hinge_{part_name}", pivot, cols["Rig"], "SINGLE_ARROW", 0.2)
        _parent(h, body_root, Matrix.Identity(4))
        hinge_objs[part_name] = h
        objects[h.name] = h

    steer_objs: dict[str, bpy.types.Object] = {}
    for name, center, _side in wheel_centers():
        knuckle = _empty(f"MY_Steer_{name[-2:]}", center, cols["Rig"], "CIRCLE", 0.22)
        _parent(knuckle, body_root, Matrix.Identity(4))
        steer_objs[name] = knuckle
        objects[knuckle.name] = knuckle

    for part in build_geometry(interior=interior):
        if part.name in PANEL_PARTS:
            col = cols["Body"]
        elif part.name.startswith("Wheel_"):
            col = cols["Wheels"]
        elif part.name in BODY_PARTS or part.name in LIGHT_PARTS:
            col = cols["Body"]
        else:
            col = cols["Interior"]
        obj = mesh_to_object(part, mats, col)
        objects[part.name] = obj

        if part.name in PANEL_PARTS:
            # move the panel's origin onto its hinge so rotation opens it
            pivot = Vector(hinges[part.name])
            obj.data.transform(Matrix.Translation(-pivot))
            obj.location = pivot
            _parent(obj, hinge_objs[part.name], Matrix.Translation(pivot))
        elif part.name.startswith("Wheel_"):
            center = dict((n, c) for n, c, _ in wheel_centers())[part.name]
            obj.data.transform(Matrix.Translation(-Vector(center)))
            obj.location = center
            _parent(obj, steer_objs[part.name], Matrix.Translation(Vector(center)))
            obj.rotation_mode = "YXZ"        # spin on Y without gimbal surprises
        else:
            _parent(obj, body_root, Matrix.Identity(4))

    _apply_modifiers(objects)
    _paint_screen(objects)
    if studio:
        _studio(cols["Studio"], objects)
    return objects


def _apply_modifiers(objects: dict[str, bpy.types.Object]) -> None:
    """A light subdivision on the body, plus edge-split style shading."""
    for name in ("ModelY_Body", "Frunk_Lid", "Tailgate"):
        obj = objects.get(name)
        if obj is None:
            continue
        mod = obj.modifiers.new("Smooth", "SUBSURF")
        mod.levels = 0
        mod.render_levels = 1
        if hasattr(obj.data, "use_auto_smooth"):     # Blender < 4.1
            obj.data.use_auto_smooth = True
            obj.data.auto_smooth_angle = math.radians(38)


def _paint_screen(objects: dict[str, bpy.types.Object]) -> None:
    from .screen_driver import refresh_screen

    screen = objects.get("Center_Screen")
    if screen is None:
        return
    refresh_screen()


def _studio(col: bpy.types.Collection, objects: dict[str, bpy.types.Object]) -> None:
    scene = bpy.context.scene
    # backdrop
    me = bpy.data.meshes.new("MY_Backdrop")
    r = 14.0
    me.from_pydata([(-r, -r, 0.0), (r, -r, 0.0), (r, r, 0.0), (-r, r, 0.0)], [],
                   [[0, 1, 2, 3]])
    me.update()
    floor = bpy.data.objects.new("MY_Backdrop", me)
    mat, bsdf = materials._principled("MY_Studio_Floor")
    materials.set_input(bsdf, "Base Color", (0.045, 0.045, 0.05, 1.0))
    materials.set_input(bsdf, "Roughness", 0.32)
    me.materials.append(mat)
    col.objects.link(floor)
    objects["MY_Backdrop"] = floor

    cam_data = bpy.data.cameras.new("MY_Camera")
    cam_data.lens = 55.0
    cam = bpy.data.objects.new("MY_Camera", cam_data)
    cam.location = (6.4, -5.6, 2.05)
    col.objects.link(cam)
    target = _empty("MY_Camera_Target", (0.0, 0.0, 0.85), col, "SPHERE", 0.2)
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    scene.camera = cam
    objects["MY_Camera"] = cam

    for name, loc, energy, size in (
        ("MY_Key", (5.0, -4.5, 5.2), 1400.0, 6.0),
        ("MY_Fill", (-6.0, -3.0, 3.4), 420.0, 7.0),
        ("MY_Rim", (-3.5, 6.0, 4.2), 900.0, 5.0),
    ):
        light_data = bpy.data.lights.new(name, "AREA")
        light_data.energy = energy
        light_data.size = size
        light = bpy.data.objects.new(name, light_data)
        light.location = loc
        con = light.constraints.new("TRACK_TO")
        con.target = target
        con.track_axis = "TRACK_NEGATIVE_Z"
        con.up_axis = "UP_Y"
        col.objects.link(light)
        objects[name] = light

    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (0.021, 0.023, 0.027, 1.0)
        bg.inputs[1].default_value = 1.0

    scene.render.engine = _preferred_engine()
    if scene.render.engine == "CYCLES" and hasattr(scene, "cycles"):
        scene.cycles.samples = 128
    scene.render.film_transparent = False
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080


def _preferred_engine() -> str:
    """Best engine this build actually offers (EEVEE's identifier keeps moving)."""
    try:
        available = [item.identifier for item in
                     bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    except Exception:
        return bpy.context.scene.render.engine
    for candidate in ("CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if candidate in available:
            return candidate
    return available[0] if available else bpy.context.scene.render.engine


def car_objects() -> dict[str, bpy.types.Object]:
    """Look up the built car by name, for the operators and the rig."""
    root = bpy.data.collections.get(ROOT_COLLECTION)
    if root is None:
        return {}
    found: dict[str, bpy.types.Object] = {}
    for col in [root] + list(root.children_recursive):
        for obj in col.objects:
            found[obj.name] = obj
    return found


def is_built() -> bool:
    return bpy.data.collections.get(ROOT_COLLECTION) is not None
