"""Cycles/EEVEE materials for the car.

Written to be version-tolerant: Principled BSDF socket names moved around
between Blender 3.x and 4.x (``Transmission`` -> ``Transmission Weight``,
``Clearcoat`` -> ``Coat Weight``, ``Emission`` -> ``Emission Color``), so every
socket is set through :func:`set_input`, which quietly skips names this build
does not have.
"""

from __future__ import annotations

import bpy

from .specs import DEFAULT_PAINT, PAINT_COLORS

SCREEN_IMAGE_NAME = "ModelY_Screen"


def set_input(node: bpy.types.Node, names: str | tuple[str, ...], value) -> bool:
    """Set the first socket that exists out of ``names``; return whether it did."""
    if isinstance(names, str):
        names = (names,)
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            socket.default_value = value
            return True
    return False


def _principled(name: str) -> tuple[bpy.types.Material, bpy.types.Node]:
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        out = nodes.get("Material Output") or nodes.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat, bsdf


def paint_material(color_name: str = DEFAULT_PAINT) -> bpy.types.Material:
    """The body colour, with a clearcoat over metallic flake."""
    spec = PAINT_COLORS.get(color_name, PAINT_COLORS[DEFAULT_PAINT])
    mat, bsdf = _principled("MY_Paint")
    rgb = spec["rgb"]
    set_input(bsdf, "Base Color", (rgb[0], rgb[1], rgb[2], 1.0))
    set_input(bsdf, "Metallic", spec["metallic"])
    set_input(bsdf, "Roughness", spec["roughness"])
    set_input(bsdf, ("Coat Weight", "Clearcoat"), 1.0)
    set_input(bsdf, ("Coat Roughness", "Clearcoat Roughness"), 0.03)
    mat["model_y_paint"] = color_name
    return mat


def set_paint_color(color_name: str) -> None:
    """Repaint in place: called by the add-on and by Grok's ``set_paint`` tool."""
    paint_material(color_name)


def glass_material() -> bpy.types.Material:
    mat, bsdf = _principled("MY_Glass")
    set_input(bsdf, "Base Color", (0.72, 0.76, 0.80, 1.0))
    set_input(bsdf, "Roughness", 0.02)
    set_input(bsdf, "IOR", 1.52)
    set_input(bsdf, ("Transmission Weight", "Transmission"), 0.92)
    # Transparency settings moved across versions: 3.x/4.0 use blend_method +
    # screen-space refraction, 4.2+/5.x use surface_render_method.  EEVEE's
    # default "DITHERED" mode renders glass as noise, so ask for BLENDED.
    for attr, value in (("surface_render_method", "BLENDED"),
                        ("blend_method", "BLEND"),
                        ("use_screen_refraction", True),
                        ("use_backface_culling", False),
                        ("show_transparent_back", False)):
        if hasattr(mat, attr):
            try:
                setattr(mat, attr, value)
            except (TypeError, AttributeError):
                pass
    set_input(bsdf, "Alpha", 0.35)
    return mat


def _simple(name: str, color, roughness: float, metallic: float = 0.0,
            coat: float = 0.0) -> bpy.types.Material:
    mat, bsdf = _principled(name)
    set_input(bsdf, "Base Color", (color[0], color[1], color[2], 1.0))
    set_input(bsdf, "Roughness", roughness)
    set_input(bsdf, "Metallic", metallic)
    if coat:
        set_input(bsdf, ("Coat Weight", "Clearcoat"), coat)
    return mat


def _emissive(name: str, color, strength: float,
              base=(0.02, 0.02, 0.02)) -> bpy.types.Material:
    mat, bsdf = _principled(name)
    set_input(bsdf, "Base Color", (base[0], base[1], base[2], 1.0))
    set_input(bsdf, "Roughness", 0.15)
    set_input(bsdf, ("Emission Color", "Emission"), (color[0], color[1], color[2], 1.0))
    set_input(bsdf, "Emission Strength", strength)
    return mat


def screen_material() -> tuple[bpy.types.Material, bpy.types.Image]:
    """Emissive material fed by the live touchscreen image."""
    image = bpy.data.images.get(SCREEN_IMAGE_NAME)
    if image is None:
        image = bpy.data.images.new(SCREEN_IMAGE_NAME, 1024, 640, alpha=False)
        image.colorspace_settings.name = "sRGB"
    mat, bsdf = _principled("MY_Screen")
    tree = mat.node_tree
    tex = None
    for node in tree.nodes:
        if node.bl_idname == "ShaderNodeTexImage":
            tex = node
            break
    if tex is None:
        tex = tree.nodes.new("ShaderNodeTexImage")
        tex.location = (-380, 120)
    tex.image = image
    tex.interpolation = "Closest"       # keep the pixel UI crisp
    set_input(bsdf, "Base Color", (0.0, 0.0, 0.0, 1.0))
    set_input(bsdf, "Roughness", 0.08)
    set_input(bsdf, "Emission Strength", 3.0)
    emission_socket = (bsdf.inputs.get("Emission Color")
                       or bsdf.inputs.get("Emission"))
    if emission_socket is not None:
        tree.links.new(tex.outputs["Color"], emission_socket)
    return mat, image


LIGHT_MATERIALS = {
    "Light_Head": ((1.0, 0.96, 0.88), 6.0),
    "Light_Tail": ((1.0, 0.06, 0.04), 4.0),
}


def build_all(paint: str = DEFAULT_PAINT) -> dict[str, bpy.types.Material]:
    """Every material the mesh builder can ask for, keyed by geometry slot name."""
    mats: dict[str, bpy.types.Material] = {
        "Paint": paint_material(paint),
        "Glass": glass_material(),
        "Mirror_Glass": _simple("MY_MirrorGlass", (0.62, 0.64, 0.68), 0.04, 1.0),
        "Trim_Black": _simple("MY_TrimBlack", (0.020, 0.020, 0.022), 0.62),
        "Trim_Gloss": _simple("MY_TrimGloss", (0.012, 0.012, 0.014), 0.12, 0.0, 0.6),
        "Carbon": _simple("MY_Carbon", (0.016, 0.016, 0.018), 0.22, 0.1, 0.8),
        "Tire": _simple("MY_Tire", (0.018, 0.018, 0.019), 0.85),
        "Wheel_Alloy": _simple("MY_WheelAlloy", (0.58, 0.59, 0.61), 0.22, 0.95),
        "Wheel_Dark": _simple("MY_WheelDark", (0.05, 0.05, 0.055), 0.40, 0.7),
        "Brake_Disc": _simple("MY_BrakeDisc", (0.27, 0.27, 0.28), 0.35, 0.9),
        "Brake_Caliper": _simple("MY_Caliper", (0.52, 0.02, 0.02), 0.30, 0.3, 0.5),
        "Dash_Trim": _simple("MY_DashTrim", (0.28, 0.20, 0.14), 0.45),
        "Interior_Dark": _simple("MY_InteriorDark", (0.028, 0.028, 0.030), 0.72),
        "Interior_Leather": _simple("MY_Leather", (0.10, 0.10, 0.11), 0.55),
    }
    for name, (color, strength) in LIGHT_MATERIALS.items():
        mats[name] = _emissive("MY_" + name, color, strength)
    mats["Screen"] = screen_material()[0]
    return mats


def set_light_emission(name: str, strength: float) -> None:
    """Dim or light up a lamp material (headlights, brake lights)."""
    mat = bpy.data.materials.get("MY_" + name)
    if mat is None or not mat.use_nodes:
        return
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        set_input(bsdf, "Emission Strength", strength)
