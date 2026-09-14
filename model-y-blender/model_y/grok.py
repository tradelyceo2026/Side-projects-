"""Grok, wired to the car.

Two paths, one interface:

* **Live** -- if an xAI API key is present (``XAI_API_KEY``/``GROK_API_KEY`` or
  the add-on preference) requests go to the xAI chat-completions endpoint with
  the car's controls exposed as function-calling tools.  Grok decides what to
  call; the calls execute against :class:`~model_y.vehicle_sim.CarState`, and
  the results go back for a final natural-language answer.
* **Offline** -- with no key (or if the network is unavailable) an intent
  parser resolves the same commands locally and calls the *same* tool
  functions.  Every button Grok can press in live mode also works offline, so
  the car is never a dead prop.

Only the standard library is used: Blender's bundled Python has no ``requests``.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

from .specs import MILE, MPH, PAINT_COLORS, SPEC
from .vehicle_sim import CarState, charge_time_estimate_s

DEFAULT_BASE_URL = "https://api.x.ai/v1"
DEFAULT_MODEL = "grok-4"
ENV_KEYS = ("XAI_API_KEY", "GROK_API_KEY", "X_AI_API_KEY")

SYSTEM_PROMPT = (
    "You are Grok, the assistant built into a {year} {name}. You are running on "
    "the car's centre screen and you can actually operate the vehicle through "
    "the tools you have been given: climate, locks, boot and frunk, charging, "
    "lights, navigation, media, drive mode and paint. "
    "Call a tool whenever the driver asks for something the car can do, then "
    "confirm in one or two short sentences. Be direct, dry and a little funny; "
    "never pad the answer. Use the car's live state rather than guessing. "
    "Refuse anything unsafe: do not shift out of Park while the car is moving "
    "or while a door is open, and say plainly when a request is not something "
    "the car can do."
)


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------


@dataclass
class ToolResult:
    ok: bool
    message: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps({"ok": self.ok, "message": self.message, **self.data})


ToolFn = Callable[[CarState, dict[str, Any]], ToolResult]
_REGISTRY: dict[str, tuple[dict[str, Any], ToolFn]] = {}


def tool(name: str, description: str, params: dict[str, Any],
         required: list[str] | None = None):
    """Register a car function and its JSON schema in one go."""

    def deco(fn: ToolFn) -> ToolFn:
        schema = {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": params,
                    "required": required or [],
                },
            },
        }
        _REGISTRY[name] = (schema, fn)
        return fn

    return deco


@tool("get_vehicle_state", "Read the live state of the car: speed, battery, "
      "range, climate, locks, media, navigation.", {})
def _get_state(state: CarState, args: dict[str, Any]) -> ToolResult:
    return ToolResult(True, "state read", {"state": state.snapshot()})


@tool("set_climate", "Set the cabin temperature, turn the climate system on or "
      "off, or change the fan speed.",
      {"temperature_c": {"type": "number", "description": "Target cabin temp, 15-28 C"},
       "on": {"type": "boolean", "description": "Turn climate on or off"},
       "fan_speed": {"type": "integer", "description": "Fan speed 0-5"}})
def _set_climate(state: CarState, args: dict[str, Any]) -> ToolResult:
    msgs = []
    if "on" in args and args["on"] is not None:
        state.hvac_on = bool(args["on"])
        msgs.append("climate " + ("on" if state.hvac_on else "off"))
    if args.get("temperature_c") is not None:
        lo, hi = SPEC.interior.hvac_min_c, SPEC.interior.hvac_max_c
        t = float(args["temperature_c"])
        clamped = min(hi, max(lo, t))
        state.hvac_setpoint_c = round(clamped * 2) / 2
        state.hvac_on = True
        msgs.append(f"set to {state.hvac_setpoint_c:g} C"
                    + ("" if abs(clamped - t) < 0.01 else f" (clamped from {t:g})"))
    if args.get("fan_speed") is not None:
        state.fan_speed = int(min(5, max(0, int(args["fan_speed"]))))
        msgs.append(f"fan {state.fan_speed}")
    return ToolResult(True, ", ".join(msgs) or "no change",
                      {"cabin_temp_c": round(state.cabin_temp_c, 1),
                       "setpoint_c": state.hvac_setpoint_c})


@tool("set_seat_heater", "Set a front seat heater level 0-3.",
      {"seat": {"type": "string", "enum": ["left", "right", "both"]},
       "level": {"type": "integer", "description": "0 off to 3 high"}},
      ["seat", "level"])
def _seat_heater(state: CarState, args: dict[str, Any]) -> ToolResult:
    level = int(min(3, max(0, int(args.get("level", 0)))))
    seat = str(args.get("seat", "both"))
    if seat in ("left", "both"):
        state.seat_heater_left = level
    if seat in ("right", "both"):
        state.seat_heater_right = level
    return ToolResult(True, f"{seat} seat heater {level}")


@tool("set_lock", "Lock or unlock the car.",
      {"locked": {"type": "boolean"}}, ["locked"])
def _set_lock(state: CarState, args: dict[str, Any]) -> ToolResult:
    state.locked = bool(args["locked"])
    return ToolResult(True, "locked" if state.locked else "unlocked")


@tool("open_closure", "Open or close the frunk, the boot or the charge port.",
      {"closure": {"type": "string", "enum": ["frunk", "trunk", "charge_port"]},
       "open": {"type": "boolean"}}, ["closure", "open"])
def _open_closure(state: CarState, args: dict[str, Any]) -> ToolResult:
    which = str(args["closure"])
    want = bool(args["open"])
    if want and state.speed_ms > 2.0:
        return ToolResult(False, f"cannot open the {which} while the car is moving")
    setattr(state, {"frunk": "frunk_open", "trunk": "trunk_open",
                    "charge_port": "charge_port_open"}[which], want)
    return ToolResult(True, f"{which} {'open' if want else 'closed'}")


@tool("set_gear", "Shift the car into Park, Reverse, Neutral or Drive.",
      {"gear": {"type": "string", "enum": list("PRND")}}, ["gear"])
def _set_gear(state: CarState, args: dict[str, Any]) -> ToolResult:
    gear = str(args["gear"]).upper()[:1]
    if gear not in "PRND":
        return ToolResult(False, f"{gear} is not a gear")
    if gear != "P" and any(state.doors_open):
        return ToolResult(False, "a door is open; not shifting out of Park")
    if gear == "P" and state.speed_ms > 1.0:
        return ToolResult(False, "still rolling; brake to a stop first")
    state.gear = gear
    return ToolResult(True, f"in {gear}")


@tool("set_drive_mode", "Switch between Chill and Standard acceleration.",
      {"mode": {"type": "string", "enum": ["Chill", "Standard"]}}, ["mode"])
def _drive_mode(state: CarState, args: dict[str, Any]) -> ToolResult:
    mode = str(args["mode"]).capitalize()
    if mode not in ("Chill", "Standard"):
        return ToolResult(False, "modes are Chill or Standard")
    state.drive_mode = mode
    return ToolResult(True, f"{mode} mode")


@tool("set_charging", "Start or stop charging, and set the charge limit.",
      {"charging": {"type": "boolean"},
       "limit_percent": {"type": "integer", "description": "Charge limit 50-100"}})
def _set_charging(state: CarState, args: dict[str, Any]) -> ToolResult:
    if args.get("limit_percent") is not None:
        state.charge_limit = min(1.0, max(0.5, int(args["limit_percent"]) / 100.0))
    if args.get("charging") is not None:
        want = bool(args["charging"])
        if want and state.speed_ms > 0.5:
            return ToolResult(False, "cannot charge while driving")
        state.charging = want
        if want:
            state.charge_port_open = True
            state.gear = "P"
    eta = charge_time_estimate_s(state, state.charge_limit) if state.charging else 0.0
    return ToolResult(True,
                      ("charging" if state.charging else "not charging")
                      + f", limit {round(state.charge_limit * 100)}%",
                      {"eta_minutes": round(eta / 60) if eta else 0})


@tool("set_lights", "Turn the headlights on or off.",
      {"on": {"type": "boolean"}}, ["on"])
def _set_lights(state: CarState, args: dict[str, Any]) -> ToolResult:
    state.headlights = bool(args["on"])
    return ToolResult(True, "headlights " + ("on" if state.headlights else "off"))


@tool("set_paint", "Repaint the car in one of the factory colours.",
      {"color": {"type": "string", "enum": list(PAINT_COLORS)}}, ["color"])
def _set_paint(state: CarState, args: dict[str, Any]) -> ToolResult:
    want = str(args["color"]).strip().lower()
    for name in PAINT_COLORS:
        if want == name.lower() or want in name.lower():
            state.paint = name
            return ToolResult(True, f"repainted {name}", {"color": name})
    return ToolResult(False, "that is not a factory colour: " + ", ".join(PAINT_COLORS))


@tool("set_media", "Play, pause, change track or set the volume.",
      {"playing": {"type": "boolean"}, "track": {"type": "string"},
       "volume": {"type": "integer", "description": "0-11"}})
def _set_media(state: CarState, args: dict[str, Any]) -> ToolResult:
    if args.get("track"):
        state.media_track = str(args["track"])[:48]
        state.media_playing = True
    if args.get("playing") is not None:
        state.media_playing = bool(args["playing"])
    if args.get("volume") is not None:
        state.volume = int(min(11, max(0, int(args["volume"]))))
    return ToolResult(True, f"{'playing' if state.media_playing else 'paused'}: "
                            f"{state.media_track} (vol {state.volume})")


@tool("navigate_to", "Set a navigation destination.",
      {"destination": {"type": "string"},
       "distance_miles": {"type": "number",
                          "description": "Optional trip distance if known"}},
      ["destination"])
def _navigate(state: CarState, args: dict[str, Any]) -> ToolResult:
    dest = str(args["destination"])[:64]
    state.navigation_destination = dest
    miles = args.get("distance_miles")
    state.navigation_distance_m = float(miles) * MILE if miles else 18.0 * MILE
    enough = state.navigation_distance_m < state.range_m()
    return ToolResult(True, f"navigating to {dest}",
                      {"distance_miles": round(state.navigation_distance_m / MILE, 1),
                       "range_miles": round(state.range_m() / MILE),
                       "enough_charge": enough})


@tool("set_autopilot", "Engage or disengage Autopilot and set its speed.",
      {"engaged": {"type": "boolean"},
       "speed_mph": {"type": "number"}})
def _autopilot(state: CarState, args: dict[str, Any]) -> ToolResult:
    if args.get("speed_mph") is not None:
        state.autopilot_set_speed_ms = min(90.0, max(20.0, float(args["speed_mph"]))) * MPH
    if args.get("engaged") is not None:
        want = bool(args["engaged"])
        if want and state.gear != "D":
            return ToolResult(False, "Autopilot needs the car in Drive")
        state.autopilot = want
    return ToolResult(True, ("Autopilot engaged at "
                             f"{state.autopilot_set_speed_ms / MPH:.0f} mph"
                             if state.autopilot else "Autopilot off"))


@tool("get_specification", "Look up a published specification of this car.",
      {"topic": {"type": "string",
                 "description": "e.g. range, power, battery, dimensions, "
                                "acceleration, top speed, wheels, weight"}},
      ["topic"])
def _get_spec(state: CarState, args: dict[str, Any]) -> ToolResult:
    topic = str(args.get("topic", "")).lower()
    d, p, b = SPEC.dims, SPEC.perf, SPEC.battery
    table = {
        "range": f"EPA {p.epa_range_m / MILE:.0f} miles on the 21-inch wheels",
        "power": f"{SPEC.powertrain.peak_power_w / 1000:.0f} kW, about 456 hp, dual motor",
        "battery": f"{b.usable_kwh:.0f} kWh usable, {b.max_dc_charge_kw:.0f} kW peak DC",
        "acceleration": f"0-60 mph in {p.zero_to_sixty_s} s with rollout",
        "top speed": f"{p.top_speed_ms / MPH:.0f} mph, electronically limited",
        "dimensions": (f"{d.length * 1000:.0f} x {d.width_body * 1000:.0f} x "
                       f"{d.height * 1000:.0f} mm, {d.wheelbase * 1000:.0f} mm wheelbase"),
        "weight": f"{p.curb_mass:.0f} kg curb",
        "wheels": '21-inch Uberturbine with 255/35R21 tyres',
        "drag": f"drag coefficient {d.drag_coefficient}",
        "cargo": f"{p.cargo_litres:.0f} litres with the seats down, "
                 f"{p.frunk_litres:.0f} litre frunk",
        "charging": f"{b.max_dc_charge_kw:.0f} kW Supercharging, "
                    f"{b.max_ac_charge_kw} kW AC",
    }
    for key, value in table.items():
        if key in topic or topic in key:
            return ToolResult(True, value, {"topic": key})
    return ToolResult(True, "; ".join(f"{k}: {v}" for k, v in table.items()),
                      {"topic": "all"})


def tool_schemas() -> list[dict[str, Any]]:
    return [schema for schema, _ in _REGISTRY.values()]


def tool_names() -> list[str]:
    return list(_REGISTRY)


def execute_tool(name: str, args: dict[str, Any], state: CarState) -> ToolResult:
    entry = _REGISTRY.get(name)
    if entry is None:
        return ToolResult(False, f"unknown tool {name}")
    try:
        return entry[1](state, args or {})
    except Exception as exc:                      # a bad argument must not kill the UI
        return ToolResult(False, f"{name} failed: {exc}")


# ---------------------------------------------------------------------------
# offline intent parser
# ---------------------------------------------------------------------------

_NUM = r"(-?\d+(?:\.\d+)?)"


def _f_to_c(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0


class OfflineBrain:
    """Resolves the common commands without a network round-trip."""

    fell_back = False       # set when the last clause matched no intent
    SPLIT = re.compile(r"\s+and\s+then\s+|\s+and\s+|,\s*then\s+|;\s*")

    def respond(self, text: str, state: CarState) -> tuple[str, list[tuple[str, dict]]]:
        """One request, or a compound one: "open the frunk and set it to 24"."""
        clauses = [c.strip() for c in self.SPLIT.split(text) if c.strip()]
        if len(clauses) > 1:
            replies: list[str] = []
            calls: list[tuple[str, dict]] = []
            for clause in clauses[:3]:
                reply, clause_calls = self._respond_one(clause, state)
                if self.fell_back:
                    # a clause that means nothing on its own ("Whole Foods and
                    # Main") -- treat the whole sentence as one request instead
                    break
                replies.append(reply)
                calls.extend(clause_calls)
            else:
                return " ".join(replies), calls
        return self._respond_one(text, state)

    def _respond_one(self, text: str,
                     state: CarState) -> tuple[str, list[tuple[str, dict]]]:
        self.fell_back = False
        t = text.lower().strip()
        calls: list[tuple[str, dict]] = []

        def run(name: str, **args) -> ToolResult:
            calls.append((name, args))
            return execute_tool(name, args, state)

        # -- climate
        wants_climate = any(w in t for w in ("temp", "degree", "warm", "cool", "cold",
                                             "hot", "climate", "hvac", "a/c", " ac ",
                                             "heat", "cabin", "set it"))
        m = re.search(rf"{_NUM}\s*(?:°|deg(?:rees)?)?\s*(c|f)\b", t)
        if m and wants_climate:
            val = float(m.group(1))
            c = _f_to_c(val) if m.group(2) == "f" else val
            r = run("set_climate", temperature_c=c, on=True)
            return f"Cabin {r.data.get('setpoint_c')} C. {self._quip('climate')}", calls
        # bare number with no unit: Fahrenheit if it is obviously not a Celsius
        # cabin temperature ("set it to 72"), Celsius otherwise
        m = re.search(rf"{_NUM}", t)
        if m and wants_climate and "fan" not in t and "seat" not in t:
            val = float(m.group(1))
            c = _f_to_c(val) if val > 40 else val
            r = run("set_climate", temperature_c=c, on=True)
            return f"Cabin {r.data.get('setpoint_c')} C. {self._quip('climate')}", calls
        if re.search(r"\b(warmer|warm it|heat it|too cold)\b", t):
            r = run("set_climate", temperature_c=state.hvac_setpoint_c + 2, on=True)
            return f"Up to {state.hvac_setpoint_c:g} C.", calls
        if re.search(r"\b(cooler|cool it|colder|too (hot|warm))\b", t):
            r = run("set_climate", temperature_c=state.hvac_setpoint_c - 2, on=True)
            return f"Down to {state.hvac_setpoint_c:g} C.", calls
        if re.search(r"\b(climate|a/?c|hvac)\b.*\boff\b|\bturn off the (ac|climate)\b", t):
            run("set_climate", on=False)
            return "Climate off.", calls
        if re.search(r"\b(climate|a/?c|hvac|heat)\b.*\bon\b", t):
            run("set_climate", on=True)
            return f"Climate on, holding {state.hvac_setpoint_c:g} C.", calls
        m = re.search(r"seat heater.*?(left|right|both)?.*?" + _NUM, t)
        if m or "seat heater" in t:
            level = int(float(m.group(2))) if m and m.group(2) else 2
            seat = (m.group(1) if m and m.group(1) else "both")
            r = run("set_seat_heater", seat=seat, level=level)
            return r.message.capitalize() + ".", calls

        # -- closures and locks
        if re.search(r"\b(unlock|open the car)\b", t):
            run("set_lock", locked=False)
            return "Unlocked.", calls
        if re.search(r"\block\b", t):
            run("set_lock", locked=True)
            return "Locked. Sentry is " + ("on" if state.sentry_mode else "off") + ".", calls
        for word, closure in (("frunk", "frunk"), ("front trunk", "frunk"),
                              ("trunk", "trunk"), ("boot", "trunk"),
                              ("tailgate", "trunk"), ("charge port", "charge_port")):
            if word in t:
                want = not re.search(r"\bclose|shut\b", t)
                r = run("open_closure", closure=closure, open=want)
                return (r.message.capitalize() + "." if r.ok
                        else "No: " + r.message + "."), calls

        # -- driving
        m = re.search(r"\b(?:shift|put it|go|switch) (?:in|into|to) ?(park|reverse|neutral|drive)\b", t)
        if m or re.search(r"\b(park it|into drive|in drive|reverse)\b", t):
            word = (m.group(1) if m else
                    ("park" if "park" in t else "reverse" if "reverse" in t else "drive"))
            r = run("set_gear", gear={"park": "P", "reverse": "R",
                                      "neutral": "N", "drive": "D"}[word])
            return (r.message.capitalize() + "." if r.ok else r.message.capitalize() + "."), calls
        if "chill" in t:
            run("set_drive_mode", mode="Chill")
            return "Chill mode. Your passengers say thanks.", calls
        if re.search(r"\b(standard|sport|fast) mode\b|\bstop being chill\b", t):
            run("set_drive_mode", mode="Standard")
            return "Standard mode. 456 hp, all yours.", calls
        if "autopilot" in t:
            want = not re.search(r"\b(off|disengage|cancel|stop)\b", t)
            sp = re.search(rf"{_NUM}\s*mph", t)
            r = run("set_autopilot", engaged=want,
                    **({"speed_mph": float(sp.group(1))} if sp else {}))
            return (r.message + "." if r.ok else r.message + "."), calls

        # -- charging
        if re.search(r"\b(charge|charging|supercharg)", t):
            if re.search(r"\b(stop|end|unplug|halt)\b", t):
                r = run("set_charging", charging=False)
                return "Charging stopped.", calls
            limit = re.search(rf"{_NUM}\s*%", t)
            args: dict[str, Any] = {"charging": True}
            if limit:
                args["limit_percent"] = int(float(limit.group(1)))
            r = run("set_charging", **args)
            if not r.ok:
                return r.message.capitalize() + ".", calls
            eta = r.data.get("eta_minutes", 0)
            return (f"Charging to {round(state.charge_limit * 100)}%"
                    + (f", about {eta} minutes." if eta else ".")), calls

        # -- lights, media, paint, navigation
        m = re.search(r"\b(?:paint|colou?r)\b.*?\b(white|black|silver|blue|red|quicksilver|grey|gray)\b", t)
        if m:
            key = {"white": "Pearl White Multi-Coat", "black": "Solid Black",
                   "silver": "Midnight Silver Metallic", "grey": "Midnight Silver Metallic",
                   "gray": "Midnight Silver Metallic", "blue": "Deep Blue Metallic",
                   "red": "Red Multi-Coat", "quicksilver": "Quicksilver"}[m.group(1)]
            r = run("set_paint", color=key)
            return f"Done: {key}.", calls
        m = re.search(r"\b(?:navigate|drive|take me|directions?|route)\b.*?\bto\b\s+(.+)$", t)
        if m:
            dest = m.group(1).strip(" .?!").title()
            r = run("navigate_to", destination=dest)
            ok = r.data.get("enough_charge", True)
            return (f"Routing to {dest}, {r.data.get('distance_miles')} miles. "
                    + ("Charge is fine." if ok else "You will need a charge stop."), calls)
        if "headlight" in t or re.search(r"\b(?:the )?lights\b\s*(?:on|off)\b", t) \
                or re.search(r"\b(?:turn|switch)\s+(?:on|off)\s+the\s+lights\b", t):
            want = not re.search(r"\boff\b", t)
            run("set_lights", on=want)
            return "Headlights " + ("on." if want else "off."), calls
        m = re.search(r"\bplay\b\s+(.+)$", t)
        if m and "music" not in m.group(1):
            run("set_media", track=m.group(1).strip(" .?!").title(), playing=True)
            return f"Playing {state.media_track}.", calls
        if re.search(r"\b(pause|stop) (the )?(music|media|song)\b", t):
            run("set_media", playing=False)
            return "Paused.", calls
        if re.search(r"\b(play|resume) (the )?(music|media|song)\b", t):
            run("set_media", playing=True)
            return f"Playing {state.media_track}.", calls
        m = re.search(r"\bvolume\b.*?" + _NUM, t)
        if m:
            run("set_media", volume=int(float(m.group(1))))
            return f"Volume {state.volume}.", calls
        if re.search(r"\b(louder|turn it up|turn up the volume|volume up)\b", t):
            run("set_media", volume=state.volume + 2)
            return f"Volume {state.volume}.", calls
        if re.search(r"\b(quieter|turn it down|turn down the volume|volume down)\b", t):
            run("set_media", volume=state.volume - 2)
            return f"Volume {state.volume}.", calls

        # -- questions
        if re.search(r"\b(range|how far|miles left)\b", t):
            r = run("get_vehicle_state")
            s = r.data["state"]
            return (f"{s['battery_percent']}% charge, about {s['range_miles']} miles "
                    f"of range."), calls
        if re.search(r"\b(0-?60|zero to sixty|how quick|how fast|top speed|horsepower|"
                     r"power|battery size|kwh|dimensions|how (long|wide|heavy)|weigh|"
                     r"cargo|tyres?|tires?|wheels)\b", t):
            topic = ("acceleration" if re.search(r"0-?60|zero to sixty|how quick", t) else
                     "top speed" if "top speed" in t else
                     "power" if re.search(r"horsepower|power", t) else
                     "battery" if re.search(r"battery|kwh", t) else
                     "weight" if re.search(r"heavy|weigh", t) else
                     "cargo" if "cargo" in t else
                     "wheels" if re.search(r"tyres?|tires?|wheels", t) else
                     "dimensions")
            r = run("get_specification", topic=topic)
            return r.message + ".", calls
        if re.search(r"\b(status|how are you|what.?s up|state|report)\b", t):
            r = run("get_vehicle_state")
            s = r.data["state"]
            return (f"{s['gear']}, {s['speed_mph']} mph, {s['battery_percent']}% "
                    f"({s['range_miles']} mi), cabin {s['cabin_temp_c']} C, "
                    f"{'locked' if s['locked'] else 'unlocked'}."), calls

        self.fell_back = True          # nothing matched; only the status readout
        r = run("get_vehicle_state")
        s = r.data["state"]
        return ("I am running offline, so I only do the car: climate, locks, frunk, "
                "boot, charging, lights, paint, navigation, media, drive mode, and "
                f"the spec sheet. Right now: {s['battery_percent']}%, "
                f"{s['range_miles']} miles, cabin {s['cabin_temp_c']} C."), calls

    @staticmethod
    def _quip(topic: str) -> str:
        return {"climate": "The heat pump is doing the work, not the battery's dignity."}.get(
            topic, "")


# ---------------------------------------------------------------------------
# live client
# ---------------------------------------------------------------------------


@dataclass
class AssistantTurn:
    reply: str
    tool_calls: list[tuple[str, dict]] = field(default_factory=list)
    source: str = "offline"           # "grok" | "offline" | "error"
    latency_s: float = 0.0
    error: str = ""


def find_api_key(explicit: str = "") -> str:
    if explicit:
        return explicit.strip()
    for name in ENV_KEYS:
        val = os.environ.get(name, "").strip()
        if val:
            return val
    return ""


class GrokClient:
    """Thin xAI chat-completions client with function calling."""

    def __init__(self, api_key: str = "", model: str = DEFAULT_MODEL,
                 base_url: str = DEFAULT_BASE_URL, timeout: float = 30.0):
        self.api_key = find_api_key(api_key)
        self.model = model or DEFAULT_MODEL
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {self.api_key}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def complete(self, messages: list[dict[str, Any]],
                 tools: list[dict[str, Any]] | None = None,
                 temperature: float = 0.4) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": self.model, "messages": messages,
                                   "temperature": temperature}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        return self._post("/chat/completions", payload)


class GrokAssistant:
    """Conversation state plus the tool-calling loop against a live car."""

    MAX_TOOL_ROUNDS = 4
    HISTORY_TURNS = 12

    def __init__(self, state: CarState, api_key: str = "", model: str = DEFAULT_MODEL,
                 base_url: str = DEFAULT_BASE_URL, allow_network: bool = True):
        self.state = state
        self.client = GrokClient(api_key, model, base_url)
        self.offline = OfflineBrain()
        self.allow_network = allow_network
        self.history: list[dict[str, Any]] = []
        self.transcript: list[tuple[str, str]] = []   # (role, text) for the screen

    # -- public -------------------------------------------------------
    @property
    def mode(self) -> str:
        return "grok" if (self.allow_network and self.client.available) else "offline"

    def ask(self, text: str) -> AssistantTurn:
        text = text.strip()
        if not text:
            return AssistantTurn("", source=self.mode)
        started = time.time()
        self.transcript.append(("user", text))
        if self.mode == "grok":
            turn = self._ask_live(text)
            if turn.source == "error":               # fall back rather than fail
                reply, calls = self.offline.respond(text, self.state)
                turn = AssistantTurn(reply, calls, "offline", error=turn.error)
        else:
            reply, calls = self.offline.respond(text, self.state)
            turn = AssistantTurn(reply, calls, "offline")
        turn.latency_s = time.time() - started
        self.transcript.append(("grok", turn.reply))
        self.transcript = self.transcript[-40:]
        return turn

    def reset(self) -> None:
        self.history.clear()
        self.transcript.clear()

    # -- internals ----------------------------------------------------
    def _system_message(self) -> dict[str, Any]:
        prompt = SYSTEM_PROMPT.format(year=SPEC.model_year, name=SPEC.name)
        prompt += "\n\nLive vehicle state: " + json.dumps(self.state.snapshot())
        return {"role": "system", "content": prompt}

    def _ask_live(self, text: str) -> AssistantTurn:
        self.history.append({"role": "user", "content": text})
        self.history = self.history[-self.HISTORY_TURNS * 2:]
        messages = [self._system_message()] + self.history
        calls: list[tuple[str, dict]] = []
        try:
            for _ in range(self.MAX_TOOL_ROUNDS):
                data = self.client.complete(messages, tool_schemas())
                choice = (data.get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                tool_calls = msg.get("tool_calls") or []
                if not tool_calls:
                    reply = (msg.get("content") or "").strip()
                    self.history.append({"role": "assistant", "content": reply})
                    return AssistantTurn(reply, calls, "grok")
                messages.append(msg)
                for call in tool_calls:
                    fn = call.get("function") or {}
                    name = fn.get("name", "")
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    result = execute_tool(name, args, self.state)
                    calls.append((name, args))
                    messages.append({"role": "tool", "tool_call_id": call.get("id", ""),
                                     "name": name, "content": result.to_json()})
            return AssistantTurn("That took too many steps; try asking for one thing.",
                                 calls, "grok")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:200] if exc.fp else ""
            return AssistantTurn("", calls, "error", error=f"HTTP {exc.code}: {detail}")
        except urllib.error.URLError as exc:
            return AssistantTurn("", calls, "error", error=f"network: {exc.reason}")
        except Exception as exc:
            return AssistantTurn("", calls, "error", error=str(exc))
