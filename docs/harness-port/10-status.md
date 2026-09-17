# Where the port stands (2026-09-17, parked)

Branch `harness-port` on this box, 23 local commits on top of `inkfield`
(`fce107f`), nothing pushed. The fleet has run untouched throughout: 30/30
containers, the default compose services byte-identical. Every number below
was re-run by the orchestrator at parking time, not taken from a builder.

## Built and green

| package / doc | what it is | tests |
|---|---|---|
| `docs/harness-port/00–09`, `web-mcpl-spec.md`, `PARITY-discord.md`, `mcpl-signal/PARITY.md` | the as-is read, the argued questions, the user contract, house design, history restore, ops, rounds + decisions (§7), deploy, pilot design, container proof | — |
| `connectome-house` | the house: one process per box; rooms with one verbatim record each; a life per being; the being's-turn seat over a unix socket; MCPL seats (Discord upstream pin, Signal own server); the `!` command lane with the fork's reply text byte-exact; dispatch with Discord/Signal parity rules; reactions (🫥), edits, deletes into the record; `observe_only` seats | 363/363 |
| `connectome-seat-protocol` / `connectome-seat-client` | the typed being's-turn message set (13 types, optional `resumeFromSeq`, `maxTokens`, `systemPromptOverride`, `continue`), NDJSON over unix/TCP, `SocketSeatServer`, `SeatClient`, `MockBeing` | 26/26, 4/4 |
| `mcpl-signal` | stdio MCPL server over signal-cli-rest-api; 13 conformance vectors; privacy fail-closed; edit/delete forwarding; parity table | 61/61 |
| `mcpl-discord` | install recipe for the pinned upstream server (built offline; `sharp`'s install script not approved) | build proof |
| `bot-runtime` (submodule, its own `harness-port` branch) | seat mode behind `HOUSE_SEAT_ADDR`: the same turn loop, the house's context in, `turn.event`s out, local tools stay local, house tools via `tool.exec`; gRPC mode untouched | 12/12, `tsc` clean |
| compose profile `house` + `docker/house/*` | `house`, `house-signal-cli`, `being-example`; new volumes; fleet services unchanged | config diff 0 |
| container proof (`09`) | a real being container completed a real Haiku 4.5 turn through the house over the socket, OAuth store only; abort and re-seat cases; all frames schema-valid | passed twice |

Parity scoreboard (Discord, `node --test 'test/parity/*.test.mjs'`):
same 8 · differs 1 · todo 4 of 13. Signal: same 20 · differs 12 · missing 5
(`mcpl-signal/PARITY.md`).

## Not done

- **Importer** (`connectome-history-import`): the package is complete on the
  orchestrator's box, tests unrun; its transfer here was blocked by a
  permission check and waits on the keeper. Then: its tests, the dry run
  against the read-only backup copy, the write path, the real run.
- **Pilot, observe-only** (`08`): everything it needs exists (`observe_only`,
  Signal fan-out verified broadcast, the box's identity variable names
  known); not brought up. First shadow: `claude-3-opus`.
- **First real cutover** (one bot in seat mode, its axon binding off):
  after the pilot. The fleet's shared `docker/bot-runtime.Dockerfile` lacks
  the two seat packages in its workspace list — the first rebuild on this
  branch hits it (`09` §fixes has the diff).
- **Web MCPL**: spec only; code waits on confirming the SDK's real consumer.
- **Parity todo rows**: voice/TTS, three reaction rows, the web axon
  subset; settings stored without a consumer: `stream in|out` (no
  forked-room primitive yet), `autotrigger` re-activation not wired into
  the turn-close loop.
- **Retire** the axons and the VEIL server: last, after cutovers.

## Housekeeping on this box

Untracked scratch (never staged): `connectome-house/{private,runs,repro.mjs,
debug-observe-scratch.mjs}`, `connectome-seat-client/probe.mjs`,
`mcpl-signal/test/fixtures/generate-envelopes.mjs`, commit-message files in
`/tmp`. Images `connectome-house:latest` (811 MB), `connectome-being-example`
(1.7 GB); containers `house`/`being-example` stopped, not removed; volumes
`house-*` kept. Disk 58 %.
