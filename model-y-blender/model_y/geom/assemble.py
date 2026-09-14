"""Assemble every geometry part of the car into named meshes."""

from __future__ import annotations

from .body import build_body, build_mirrors, build_spoiler
from .interior import build_interior
from .lights import build_lights
from .mesh import Mesh
from .wheels import build_wheels


def build_all(interior: bool = True) -> list[Mesh]:
    parts: list[Mesh] = list(build_body().values())
    parts.extend([build_mirrors(), build_spoiler()])
    parts.extend(build_lights())
    parts.extend(build_wheels())
    if interior:
        parts.extend(build_interior())
    return parts


def part_names() -> list[str]:
    return [m.name for m in build_all()]


def merged(interior: bool = True, name: str = "ModelY") -> Mesh:
    out = Mesh(name)
    for part in build_all(interior=interior):
        out.merge(part)
    return out
