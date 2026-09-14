"""A stand-in for ``bpy``/``mathutils`` so the add-on can be smoke-tested in CI.

It is not Blender -- it just implements the slice of the API this add-on
actually touches, which is enough to catch typos, bad socket names, wrong
parenting order and other things that would otherwise only show up the first
time someone clicks Build inside Blender.
"""

from __future__ import annotations

import math
import sys
import types


# --------------------------------------------------------------------------
# mathutils
# --------------------------------------------------------------------------


class Vector(tuple):
    def __new__(cls, seq=(0.0, 0.0, 0.0)):
        return super().__new__(cls, tuple(float(v) for v in seq))

    def __neg__(self):
        return Vector(tuple(-v for v in self))

    def __sub__(self, other):
        return Vector(a - b for a, b in zip(self, other))

    def __add__(self, other):
        return Vector(a + b for a, b in zip(self, other))

    def __mul__(self, k):
        return Vector(a * k for a in self)

    @property
    def length(self):
        return math.sqrt(sum(a * a for a in self))

    def normalized(self):
        n = self.length or 1.0
        return Vector(a / n for a in self)

    def to_track_quat(self, track="-Z", up="Y"):
        # only the euler matters to the callers; aim roughly down the vector
        direction = self.normalized()
        yaw = math.atan2(direction[1], direction[0])
        pitch = math.asin(max(-1.0, min(1.0, direction[2])))
        return _Quaternion(math.pi / 2 - pitch, 0.0, yaw + math.pi / 2)


class _Quaternion:
    def __init__(self, x, y, z):
        self._euler = (x, y, z)

    def to_euler(self):
        return list(self._euler)


class Matrix:
    def __init__(self, translation=(0.0, 0.0, 0.0)):
        self.translation = Vector(translation)

    @classmethod
    def Translation(cls, vec):
        return cls(vec)

    @classmethod
    def Identity(cls, _size=4):
        return cls()

    def __matmul__(self, other):
        return Matrix(tuple(a + b for a, b in zip(self.translation, other.translation)))

    def inverted(self):
        return Matrix(tuple(-v for v in self.translation))


mathutils = types.ModuleType("mathutils")
mathutils.Vector = Vector
mathutils.Matrix = Matrix


# --------------------------------------------------------------------------
# data structures
# --------------------------------------------------------------------------


class Euler(list):
    def __init__(self):
        super().__init__([0.0, 0.0, 0.0])


class Polygon:
    def __init__(self, indices, start):
        self.vertices = list(indices)
        self.loop_indices = list(range(start, start + len(indices)))
        self.material_index = 0
        self.use_smooth = False


class UVLoop:
    def __init__(self):
        self.uv = (0.0, 0.0)


class UVLayer:
    def __init__(self, count):
        self.data = [UVLoop() for _ in range(count)]


class UVLayers(dict):
    def __init__(self, mesh):
        super().__init__()
        self._mesh = mesh

    def new(self, name="UVMap"):
        layer = UVLayer(sum(len(p.vertices) for p in self._mesh.polygons))
        self[name] = layer
        return layer


class Mesh:
    def __init__(self, name):
        self.name = name
        self.vertices: list = []
        self.polygons: list[Polygon] = []
        self.materials: list = []
        self.uv_layers = UVLayers(self)
        self.updated = False

    def from_pydata(self, verts, edges, faces):
        self.vertices = [Vector(v) for v in verts]
        loop = 0
        for face in faces:
            if max(face) >= len(verts):
                raise IndexError(f"{self.name}: face index out of range")
            self.polygons.append(Polygon(face, loop))
            loop += len(face)

    def validate(self, verbose=False):
        return False

    def update(self):
        self.updated = True

    def transform(self, matrix):
        t = matrix.translation
        self.vertices = [Vector((v[0] + t[0], v[1] + t[1], v[2] + t[2]))
                         for v in self.vertices]


class Modifier:
    def __init__(self, name, kind):
        self.name = name
        self.type = kind
        self.levels = 0
        self.render_levels = 0
        self.use_limit_surface = True


class Modifiers(list):
    def new(self, name, kind):
        mod = Modifier(name, kind)
        self.append(mod)
        return mod

    def get(self, name, default=None):
        for mod in self:
            if mod.name == name:
                return mod
        return default

    def remove(self, mod):
        if mod in self:
            list.remove(self, mod)


class Constraint:
    def __init__(self, kind):
        self.type = kind
        self.target = None
        self.track_axis = ""
        self.up_axis = ""


class Constraints(list):
    def new(self, kind):
        con = Constraint(kind)
        self.append(con)
        return con


class Object:
    def __init__(self, name, data):
        self.name = name
        self.data = data
        self._location = [0.0, 0.0, 0.0]
        self.rotation_euler = Euler()
        self.rotation_mode = "QUATERNION" if type(data).__name__ == "Camera" else "XYZ"
        self.scale = [1.0, 1.0, 1.0]
        self.parent = None
        self.matrix_parent_inverse = Matrix()
        self.empty_display_type = "PLAIN_AXES"
        self.empty_display_size = 1.0
        self.hide_render = False
        self.hide_viewport = False
        self.type = {"Mesh": "MESH", "Camera": "CAMERA",
                     "Light": "LIGHT"}.get(type(data).__name__, "EMPTY")
        self.modifiers = Modifiers()
        self.constraints = Constraints()
        self.animation_data = None
        self.keyframes: list[tuple[str, int]] = []
        self.users_collection: list = []

    @property
    def location(self):
        return self._location

    @location.setter
    def location(self, value):
        # Blender hands back a mutable Vector, so component assignment works
        self._location = [float(v) for v in value]

    @property
    def matrix_world(self):
        return Matrix(self.location)

    def keyframe_insert(self, path, frame=0):
        self.keyframes.append((path, frame))


class Collection:
    def __init__(self, name):
        self.name = name
        self.objects = ObjectSlots()
        self.children = CollectionSlots()

    @property
    def children_recursive(self):
        out = []
        for child in self.children.values():
            out.append(child)
            out.extend(child.children_recursive)
        return out


class ObjectSlots(list):
    def link(self, obj):
        if obj not in self:
            self.append(obj)
            obj.users_collection.append(self)

    def unlink(self, obj):
        if obj in self:
            self.remove(obj)


class CollectionSlots(dict):
    def link(self, col):
        self[col.name] = col

    def unlink(self, col):
        self.pop(col.name, None)

    def __contains__(self, key):
        return dict.__contains__(self, key)

    def values(self):  # noqa: D401 - dict passthrough
        return list(dict.values(self))


class Pixels(list):
    def foreach_set(self, values):
        self[:] = list(values)


class Preview:
    def reload(self):
        pass


class Image:
    def __init__(self, name, width, height):
        self.name = name
        self.size = (width, height)
        self.pixels = Pixels([0.0] * (width * height * 4))
        self.colorspace_settings = types.SimpleNamespace(name="sRGB")
        self.preview = Preview()

    def update(self):
        pass


class Socket:
    def __init__(self, name, default=0.0):
        self.name = name
        self.default_value = default


class Sockets(dict):
    def get(self, name, default=None):
        return dict.get(self, name, default)

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return dict.__getitem__(self, key)


PRINCIPLED_SOCKETS = [
    "Base Color", "Metallic", "Roughness", "IOR", "Alpha", "Emission Color",
    "Emission Strength", "Coat Weight", "Coat Roughness", "Transmission Weight",
    "Specular IOR Level",
]


class Node:
    def __init__(self, idname, name=""):
        self.bl_idname = idname
        self.name = name or idname
        self.location = (0, 0)
        self.image = None
        self.interpolation = "Linear"
        self.inputs = Sockets()
        self.outputs = Sockets()
        if idname == "ShaderNodeBsdfPrincipled":
            for sock in PRINCIPLED_SOCKETS:
                self.inputs[sock] = Socket(sock)
            self.outputs["BSDF"] = Socket("BSDF")
        elif idname == "ShaderNodeTexImage":
            self.outputs["Color"] = Socket("Color")
            self.outputs["Alpha"] = Socket("Alpha")
        elif idname == "ShaderNodeOutputMaterial":
            self.inputs["Surface"] = Socket("Surface")
        elif idname == "ShaderNodeBackground":
            self.inputs["Color"] = Socket("Color", (0, 0, 0, 1))
            self.inputs["Strength"] = Socket("Strength", 1.0)
            self.outputs["Background"] = Socket("Background")
        elif idname == "ShaderNodeOutputWorld":
            self.inputs["Surface"] = Socket("Surface")
        elif idname == "ShaderNodeTexNoise":
            for sock, default in (("Vector", None), ("Scale", 5.0), ("Detail", 2.0),
                                  ("Roughness", 0.5), ("Distortion", 0.0)):
                self.inputs[sock] = Socket(sock, default)
            self.outputs["Fac"] = Socket("Fac")
            self.outputs["Color"] = Socket("Color")
        elif idname == "ShaderNodeTexCoord":
            for sock in ("Generated", "Normal", "UV", "Object", "Camera", "Window"):
                self.outputs[sock] = Socket(sock)
        elif idname == "ShaderNodeBump":
            for sock, default in (("Strength", 1.0), ("Distance", 1.0),
                                  ("Height", 1.0), ("Normal", None)):
                self.inputs[sock] = Socket(sock, default)
            self.outputs["Normal"] = Socket("Normal")
        elif idname == "ShaderNodeValToRGB":
            self.inputs["Fac"] = Socket("Fac", 0.5)
            self.outputs["Color"] = Socket("Color")
            self.outputs["Alpha"] = Socket("Alpha")
            self.color_ramp = types.SimpleNamespace(
                elements=[types.SimpleNamespace(position=0.0, color=(0, 0, 0, 1)),
                          types.SimpleNamespace(position=1.0, color=(1, 1, 1, 1))])
        elif idname == "ShaderNodeTexSky":
            self.outputs["Color"] = Socket("Color")
            self.sky_type = "NISHITA"
            self.sun_elevation = 0.26
            self.sun_rotation = 0.0
            self.sun_intensity = 1.0
            self.altitude = 0.0
            self.air_density = 1.0
            self.dust_density = 1.0
        elif idname == "ShaderNodeEmission":
            self.inputs["Color"] = Socket("Color", (1, 1, 1, 1))
            self.inputs["Strength"] = Socket("Strength", 1.0)
            self.outputs["Emission"] = Socket("Emission")


class Nodes(list):
    NAMES = {"Principled BSDF": "ShaderNodeBsdfPrincipled",
             "Material Output": "ShaderNodeOutputMaterial",
             "Background": "ShaderNodeBackground"}

    def get(self, name, default=None):
        for node in self:
            if node.name == name:
                return node
        return default

    def new(self, idname):
        name = {v: k for k, v in self.NAMES.items()}.get(idname, idname)
        node = Node(idname, name)
        self.append(node)
        return node


class Links(list):
    def new(self, a, b):
        self.append((a, b))
        return (a, b)


class NodeTree:
    def __init__(self, with_principled=True):
        self.nodes = Nodes()
        self.links = Links()
        if with_principled:
            self.nodes.new("ShaderNodeBsdfPrincipled")
            self.nodes.new("ShaderNodeOutputMaterial")


class Material(dict):
    def __init__(self, name):
        super().__init__()
        self.name = name
        self.use_nodes = False
        self.node_tree = NodeTree()
        self.blend_method = "OPAQUE"
        self.use_screen_refraction = False


class World:
    def __init__(self, name="World"):
        self.name = name
        self.use_nodes = False
        self.node_tree = NodeTree(with_principled=False)
        self.node_tree.nodes.new("ShaderNodeBackground")


class Camera:
    def __init__(self, name):
        self.name = name
        self.lens = 50.0
        self.dof = types.SimpleNamespace(use_dof=False, focus_distance=10.0,
                                         focus_object=None, aperture_fstop=2.8)


class Light:
    def __init__(self, name, kind):
        self.name = name
        self.type = kind
        self.energy = 100.0
        self.size = 1.0
        self.size_y = 1.0
        self.shape = "SQUARE"
        self.color = (1.0, 1.0, 1.0)
        self.angle = 0.526
        self.use_shadow = True


class DataCollection(dict):
    def __init__(self, factory):
        super().__init__()
        self._factory = factory

    def new(self, name, *args, **kwargs):
        item = self._factory(name, *args, **kwargs)
        key = name
        n = 1
        while key in self:
            key = f"{name}.{n:03d}"
            n += 1
        item.name = key
        self[key] = item
        return item

    def get(self, name, default=None):
        return dict.get(self, name, default)

    def remove(self, item, do_unlink=False):
        for key, value in list(self.items()):
            if value is item:
                del self[key]


class BlendData:
    def __init__(self):
        self.meshes = DataCollection(Mesh)
        self.objects = DataCollection(lambda name, data=None: Object(name, data))
        self.materials = DataCollection(Material)
        self.collections = DataCollection(Collection)
        self.images = DataCollection(
            lambda name, width=1024, height=1024, alpha=False: Image(name, width, height))
        self.cameras = DataCollection(Camera)
        self.lights = DataCollection(lambda name, kind="POINT": Light(name, kind))
        self.worlds = DataCollection(World)

    def reset(self):
        self.__init__()


# --------------------------------------------------------------------------
# module assembly
# --------------------------------------------------------------------------


def _prop(**kwargs):
    return ("PROP", kwargs)


class _Types:
    class Operator:
        bl_idname = ""
        bl_label = ""

        def report(self, level, message):
            pass

    class Panel:
        bl_idname = ""

    class PropertyGroup:
        pass

    class AddonPreferences:
        pass

    class Scene:
        pass

    class Node:
        pass

    class Material:
        pass

    class Object:
        pass

    class Collection:
        pass

    class Image:
        pass


def install() -> types.ModuleType:
    """Register the fake modules in ``sys.modules`` and return the bpy stub."""
    bpy = types.ModuleType("bpy")
    bpy.data = BlendData()

    scene = types.SimpleNamespace(
        collection=Collection("Scene Collection"),
        render=types.SimpleNamespace(engine="BLENDER_EEVEE_NEXT", fps=24, fps_base=1.0,
                                     film_transparent=False, resolution_x=1920,
                                     resolution_y=1080),
        cycles=types.SimpleNamespace(samples=64),
        world=None,
        camera=None,
        frame_current=1,
        frame_start=1,
        frame_end=250,
        view_settings=types.SimpleNamespace(view_transform="Standard", look="None",
                                            exposure=0.0, gamma=1.0),
    )
    screen = types.SimpleNamespace(areas=[])
    bpy.context = types.SimpleNamespace(
        scene=scene,
        screen=screen,
        window=None,
        window_manager=types.SimpleNamespace(
            event_timer_add=lambda *a, **k: object(),
            event_timer_remove=lambda *a, **k: None,
            modal_handler_add=lambda *a, **k: None),
        preferences=types.SimpleNamespace(addons={}),
    )

    types_mod = types.ModuleType("bpy.types")
    for attr in dir(_Types):
        if not attr.startswith("_"):
            setattr(types_mod, attr, getattr(_Types, attr))
    bpy.types = types_mod
    bpy.types.RenderSettings = types.SimpleNamespace(
        bl_rna=types.SimpleNamespace(properties={"engine": types.SimpleNamespace(
            enum_items=[types.SimpleNamespace(identifier="CYCLES"),
                        types.SimpleNamespace(identifier="BLENDER_EEVEE_NEXT")])}))

    props = types.ModuleType("bpy.props")
    for name in ("BoolProperty", "EnumProperty", "FloatProperty", "IntProperty",
                 "StringProperty", "PointerProperty", "FloatVectorProperty",
                 "CollectionProperty"):
        setattr(props, name, _prop)
    bpy.props = props

    registered: list = []
    bpy.utils = types.SimpleNamespace(
        register_class=lambda cls: registered.append(cls),
        unregister_class=lambda cls: registered.remove(cls) if cls in registered else None,
    )
    bpy.utils.registered = registered

    bpy.path = types.SimpleNamespace(abspath=lambda p: p)

    handlers = types.SimpleNamespace(persistent=lambda fn: fn, load_post=[],
                                     frame_change_post=[])
    bpy.app = types.SimpleNamespace(handlers=handlers, version=(4, 2, 0))

    utils_mod = types.ModuleType("bpy.utils")
    utils_mod.register_class = bpy.utils.register_class
    utils_mod.unregister_class = bpy.utils.unregister_class
    app_mod = types.ModuleType("bpy.app")
    app_mod.handlers = handlers
    handlers_mod = types.ModuleType("bpy.app.handlers")
    handlers_mod.persistent = handlers.persistent
    handlers_mod.load_post = handlers.load_post
    handlers_mod.frame_change_post = handlers.frame_change_post

    sys.modules["bpy"] = bpy
    sys.modules["bpy.props"] = props
    sys.modules["bpy.types"] = bpy.types
    sys.modules["bpy.utils"] = utils_mod
    sys.modules["bpy.app"] = app_mod
    sys.modules["bpy.app.handlers"] = handlers_mod
    sys.modules["mathutils"] = mathutils
    return bpy
