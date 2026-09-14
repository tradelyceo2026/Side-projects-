# The Intent Layer

A design concept and working prototype for the Tesla Model Y center display: an in-car assistant that only
claims what it can verify, asks before it spends money, and holds standing intents instead of one-shot commands.

- **Prototype:** https://claude.ai/code/artifact/8394295c-b651-4005-ace7-dc21a4d4f505
- **Concept brief:** https://claude.ai/code/artifact/95f6622a-6689-4621-a55e-7a44e3cc4e4d

Independent concept. Not affiliated with, endorsed by, or produced by Tesla, Inc.

## The argument

The 2026 Summer Update gave the in-car assistant direct control of 100-plus vehicle functions, so "let the
assistant control the car" is already shipped. Three gaps survive it, and all three are design problems:

1. **It claims capabilities it does not have.** Documented in press coverage of early builds. A model that is
   wrong about its own body discounts every correct answer that follows.
2. **It is reactive.** The car knows the charge, the route, the weather and the tire that is down four psi.
   It should raise the problem before the driver forms the sentence.
3. **It has no memory of intent.** "Precondition at 7:40" is a command. "Never let me leave for a job under
   40 percent" is a rule, and nothing in the car holds one.

## What the prototype implements

| | |
|---|---|
| Capability registry | 15 entries with availability, consent tier, and the Fleet API endpoint each maps to. The model is handed the registry as a tool and cannot describe an action it has not looked up. |
| Consent tiers | `direct` applies instantly (climate, seats, lock). `propose` raises a confirmation card with real numbers (charging, navigation, Sentry). `never` is refused and explained. |
| Anticipation engine | Six rules over live state: cold-start preconditioning, range against the queued route, standing-intent violation, tire divergence, Sentry at an unfamiliar stop, job-stop logging. |
| Standing intents | A sentence expressing a rule is stored and re-evaluated on every state change. |
| Model router | A pure function routing each request to on-device, resident, or reasoning. The badge on each reply shows which brain answered. |
| Work mode | Job stops, arrival time, odometer and address captured for invoice lines. |

The assistant is real: inside the artifact viewer it runs on Claude with tool calling against the vehicle model.
Outside it, a deterministic rules engine takes over so the concept still demos with no network.

## Integration reality

| Path | Verdict |
|---|---|
| Native third-party app on the center screen | Not possible. No SDK, no sideloading. |
| Web app in the in-car browser | Ships today. The 2026 update added camera and mic access on AMD Ryzen cars, so a real in-cabin voice loop needs no firmware change. |
| Fleet API with a virtual key and signed commands | Ships today. Capability ids in the prototype were named to match real endpoints, so the simulator swaps for the command proxy through one adapter. |
| First-party pluggable reasoning backend | The actual ask. Only the in-cabin team can decide it. |

## Files

```
src/intent.html    the prototype: vehicle model, capability registry, anticipation rules, AI layer, UI
docs/brief.html    the concept brief written to be presented
```

Both are single self-contained files with no build step. Open either in a browser.
