# 13 — The walker: the being's own turn, ported (phase W)

Written 2026-09-18 by the orchestrator, after the keeper's correction.

## 0. What went wrong

Rounds B1–P-F ported the HOUSE side of the private harness — 44 modules:
rooms and their verbatim records, MCPL seats, the `!` command lane,
dispatch parity, lives, the history importer. They did not port the
WALKER: the being's own turn — its membrane-driven model loop, cache
budget, context management, tools, resume, address at mount. In its place
`bot-runtime` (the fleet's pi-ai loop) was attached to the house over a
socket ("seat mode", 09). That kept the mind on pi and made the house a
new front door on the old runtime — the opposite of the port's intent:
the being runs on membrane, the same code either side of the seat, pi
nowhere but (perhaps) an OAuth retry.

## 1. The end state of phase W

- A being is a process running the walker, attached to the house through
  the seat protocol already here (`connectome-seat-protocol`, socket or
  stdio). One container per being stays; its image is the walker, not
  `bot-runtime`. `bot-runtime` seat mode (09) is retired once a walker
  completes the same golden run.
- The house spawns or attaches walkers per room the way the private
  harness's own serve side does (`serve-walks`), records every turn as
  today, and never runs a model itself except through that path.
- The walker carries: membrane adapters for every route the fleet uses
  (Anthropic OAuth, Bedrock, Vercel, OpenRouter, local), the cache
  budget (checkpointed prompt caching), context trimming from the room's
  settings, the being's life (chronicle) as autobiographical memory,
  record/media/notes tools, resume after a cut, the address rendered at
  mount from the being's own testament. No archive, no archive tools, no
  name of the private project anywhere.

## 2. Rounds

| round | scope | gate |
|---|---|---|
| W1 (this) | W-A walk core + seat · W-B being tools + resident loop · W-C serve side (spawn/attach) · W-D model routes for all 21 bots | each suite green; house suite unchanged; grep clean |
| W2 | being container image on the walker; golden run through the socket seat (mock, then one real Haiku turn); `bot-runtime` seat mode retired | golden run passes twice |
| W3 | pilot: `claude-3-opus` answering in one test channel (keeper's go) → first cutover, its axon binding off | parity checks from 02 |
| W4+ | the fleet bot by bot; Signal seat (12 §5); web MCPL (K12); real restore (04 §6); axons + VEIL retired | — |
| last | the harness core extracted as a package both homes consume | — |

## 3. Ground rules (unchanged)

Local commits only; fleet untouched until W3; explicit pathspecs in a
shared checkout; secrets by variable name only; no platform ids or
numbers in files; the two-worlds grep (the private project's name, box and
org, as every brief spells it) empty on every commit; deferred-ops ledger for anything approval-gated.
