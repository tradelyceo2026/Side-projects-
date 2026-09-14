"""Session state that Blender properties cannot hold.

Blender's RNA can only store primitives, so the live :class:`CarState` and the
Grok assistant live here as module singletons and the UI reads through them.
"""

from __future__ import annotations

from .grok import DEFAULT_MODEL, GrokAssistant, find_api_key
from .vehicle_sim import CarState

STATE = CarState()
_ASSISTANT: GrokAssistant | None = None
_CONFIG: dict[str, object] = {"api_key": "", "model": DEFAULT_MODEL, "allow_network": True}
LAST_ERROR = ""

# Frame -> CarState snapshot, filled by the bake operator so a rendered
# animation can replay the touchscreen as well as the mechanical rig.
BAKED: dict[int, CarState] = {}


def configure(api_key: str = "", model: str = DEFAULT_MODEL,
              allow_network: bool = True) -> None:
    """Called from the add-on preferences; rebuilds the assistant if needed."""
    global _ASSISTANT
    changed = (_CONFIG["api_key"] != api_key or _CONFIG["model"] != model
               or _CONFIG["allow_network"] != allow_network)
    _CONFIG.update({"api_key": api_key, "model": model, "allow_network": allow_network})
    if changed and _ASSISTANT is not None:
        history = _ASSISTANT.transcript
        _ASSISTANT = None
        assistant().transcript = history


def assistant() -> GrokAssistant:
    global _ASSISTANT
    if _ASSISTANT is None:
        _ASSISTANT = GrokAssistant(
            STATE,
            api_key=str(_CONFIG["api_key"]),
            model=str(_CONFIG["model"]),
            allow_network=bool(_CONFIG["allow_network"]),
        )
    return _ASSISTANT


def has_api_key() -> bool:
    return bool(find_api_key(str(_CONFIG["api_key"])))


def reset_car(keep_conversation: bool = True) -> None:
    global STATE, _ASSISTANT
    STATE = CarState()
    BAKED.clear()
    transcript = _ASSISTANT.transcript if (_ASSISTANT and keep_conversation) else []
    _ASSISTANT = None
    assistant().transcript = transcript
