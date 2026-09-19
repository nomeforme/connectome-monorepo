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

## 4. Phase W6 — the seat moves into the being (keeper, 2026-09-19)

The old fleet isolated minds (one container each) but shared its platform
connections (one `discord-axon`, one `signal-axon`) and its record (VEIL).
The house as built shared the same two things in one process. The complete
shape, asked for after the first cutover: **each being's container hosts
its own platform children** (its Discord token, its Signal number — by
variable name, as the fleet's per-bot compose does) and bridges them to the
house over the one socket it already has, in both directions. The house is
a pure record-and-dispatch service: rooms, the single writer, routing,
commands, lives — no platform children.

What it buys: a bot's client and mind live and die together, alone; a
house restart touches no platform connection (the being buffers inbound
and reseats with `resumeFromSeq`); a house crash costs seconds of queued
messages, never a reconnect storm. Strictly better than the fleet.

| round | scope |
|---|---|
| W6-B | seat protocol: `platform.hello/incoming/history/channels/result/child` (being→house), `platform.call/notify/open` (house→being); `mcpl/child.mjs` (the child-spawning half of `host.mjs`, extracted); `platform-runner.mjs` in the walker (`--platforms <servers.json>`), bounded inbound buffer across house downtime; the being image builds `mcpl-discord` and ships `mcpl-signal` |
| W6-A | the house: a remote host for a being-hosted server (same interface as `host.mjs`, wire = the being's socket); `routes.mjs` boots such seats on `platform.hello` instead of spawning; `socket-seat.mjs` dispatches `platform.*` |
| W6-C | compose: `x-being` carries the platform env names; per-being servers selection (`HOUSE_BEING`); the house service drops its platform env; runbook `16-being-hosted-seats.md` |
| W6-R | haiku re-proven on Discord and Signal in the new shape; then C1 (second bot), C2 (restore, overrides, tools list), C3 (batches), C4 (retire) |
