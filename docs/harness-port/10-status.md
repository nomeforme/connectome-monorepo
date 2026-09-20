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

## 2026-09-18 — rounds Q1–Q3, the sandbox restore, the pilot up

Branch `harness-port`, now 31 local commits on `inkfield`, nothing pushed.
Every number re-run by the orchestrator, not taken from a builder.

| landed | commit | proof |
|---|---|---|
| fleet `docker/bot-runtime.Dockerfile` workspace gap closed (09 §4 item 3); root `pnpm test` via a turbo `test` task (K9); Discord-only observe pilot config (`house/servers.json`, covenant, `11-pilot-runbook.md`) | `36c3ebb` | YAML parses; config suites 27/27 |
| `!split` and `!autotrigger` reach real consumers; `context-settings.mjs` extracted | `c77c3d3` | house 378/378 |
| `connectome-history-import` (K10): the importer re-homed onto the house's own frame schema (fail-closed), `--dry-run`, `--real` gate | `ddd1baf` | 10/10 |
| `12-signal-two-consumers.md`: json-rpc websocket fan-out is per-connection broadcast (upstream source); same-instance second consumer recommended over a linked device | `e3f3422` | doc |
| the live forked-room primitive behind `!stream in\|out` (C13), same on-disk shape as an imported substream | `d3a573d` | 382/382, C13 same |
| socket seat resolves the turn's room per message (a fork's turn events landed nowhere before); RX3 proved | `a6d3331` | 383/383; scoreboard same 10 · differs 1 · todo 3 |

The restore, against a read-only copy of the buckets (never the live
volume): dry run 57 s — 10,322 buckets, 1.01 M frames (356 k unique),
284 rooms, 21,154 messages, 15,886 speech, 2,216 attachments, 2,879
edits, 743 deletions, 54 🫥, 0 unreadable. Sandbox write 1,237 s — 284
rooms, 0 skipped, 29 lives, 1.2 GB (runs 248 M, private 464 M, blobs
520 M). One open question: a source agent that shares a human
participant's handle authored speech in a training substream and so was
given a life of its own.

The pilot (K14, 08, 11): `house` built and started observe-only on
Discord beside the fleet, `--no-deps` (no signal-cli); seated for
`claude-3-opus`, both guilds warmed; the fleet's own `bot-3-opus`
untouched. Side effect found at boot: the pinned MCPL server registers a
guild slash command `/undo` (`guild.commands.set`, replacing the app's
guild command set — the fleet had registered none, so nothing was lost;
the command persists after the house stops). Stop: `docker compose
--profile house stop house`.

Still the keeper's: the real restore (`--real`, per platform, 04 §6);
Signal pilot shape (12 §5); web MCPL (K12); Discord MCPL licence (K13);
the `.excluded` suites' removal and the sandbox/copy cleanup (ledger).

## 2026-09-18, evening — phase W: the walker ported, the golden run passed

The keeper's correction (13-walker-port.md §0): B1–P-F had ported the house
side and bolted the fleet's pi-ai runtime onto it. Phase W ported the
walker itself. Branch `harness-port`, now 50 local commits on `inkfield`,
nothing pushed; house suite **528/528**; two-worlds grep 0 hits; fleet
untouched throughout (the observe-only pilot kept running).

| landed | commits |
|---|---|
| the walker: membrane loop, turn, cache budget, mount (no-archive), seat over stdio + socket, address at mount; `walker.mjs` entry | `44d4e02` |
| the being's tools (record, media, notes, stage), resident loop, alarms | `e3474e5` |
| serve side: spawn/attach walkers per room, process table, shutdown, routes | `d07bcfc` |
| model routes for all 21 bots; two broken bots diagnosed | `d6bc0ea` |
| reconciliation: house tools routed from the turn, room context on the wire, stdio seat fixed, e2e | `99bd8a6` |
| being image + `being-haiku-4-5` service + coherence scoreboard + runbook | `2224754`, `50d29e0` |
| covenants for all 21 beings, parity-faithful (`Standard` = no persona) | `72829f1` |
| one speech frame per segment (was one per token); testament fields bind the turn; `<thinking>` stripped outbound as the fleet does | `d50145e` |
| plantoid → `PLANTOID_ENDPOINT`, 3-haiku on Bedrock, sonnet-4 via Vercel | `b4bb2be`…`8152a71` |

**Golden run** (15-golden-run.md): haiku-4-5 answers through the walker
over the socket seat on the subscription OAuth store alone (API-key
variables blanked), ~1 s. A version drift was caught on the way: the
image had resolved pi-ai `^0.80.6` to 0.80.10, which drops
`getOAuthApiKey` and silently billed the API key — pinned to 0.80.6.

**Coherence scoreboard**, one short turn each: **19 of 21 answer.**
Not answering: `claude-3-5-haiku` and `claude-3-sonnet` (Bedrock
end-of-life, no route left), `claude-opus-4` (Vercel 502 upstream — left
as is). The fleet-side `config.json` changes for sonnet-4 (Vercel) and
plantoid are the keeper's to apply; the house already routes them.

**Retired by this phase:** `bot-runtime` seat mode (09) — the being image
is the walker; `docker/house/being-runtime.Dockerfile` and the
`being-example` service block go with the next cleanup.

**Next:** W3 — `claude-haiku-4-5` answering in one test channel (keeper's
go), then the first real cutover; W4+ the fleet bot by bot, Signal seat,
web MCPL, real restore, axons + VEIL retired; last, the package
extraction.

## 2026-09-19 — the first real cutover: claude-haiku-4-5 answers on Discord from the house

Branch `harness-port`, 70 local commits on `inkfield`, nothing pushed;
house suite 555/555; two-worlds grep 0.

What landed between the observe pilot and the cutover (every one found by
a live test, fixed, pinned by a test): one always-on walker per being
seated to every room it is in (`a1666f1`); a standing room predating a
config change gains its configured beings; a seat learns its own account
id from the server's connect line so a `<@bot>` mention resolves;
`observe_only` silences the seat's own being only, so two identities in
one channel never lose the room's answer (`bce2d29`, tests `9bcbfb4`);
the duplicate race keeps typing and the reply target; random reply at
the fleet's 1-in-1000; Discord answers are `reply_message` to the
summoning message and `@Display Name` becomes a real mention
(`82c2847` — a named departure from the fork's bare send, O16 "differs").

The cutover itself: the fleet's `bot-haiku-45` stopped, then
`discord-axon` restarted so haiku's Discord client left the old axon
(there is no per-bot unbind; the other 20 re-bound themselves). A
lingering typing indicator seen mid-way was the OLD axon's: its typing
interval is cleared only by a bot-runtime signal and otherwise runs to
its 10-minute cap (`discord-message-receptor.ts:505`) — stopping a mind
without its axon client is the wrong half of a cutover. Confirmed by the
keeper: mention and reply answered once each, as replies, mention
rendered, typing released with the reply.

Next: Signal seat for haiku (12 §5, second read-only consumer on the
fleet's signal-cli), then the fleet bot by bot (mind off, axon restart),
web MCPL, real restore, axons + VEIL retired.

## 2026-09-19, later — phase W6 live: the being hosts its own platform seats

`harness-port` at the W6 commits (`c04e345` protocol + being side,
`b906907` house side, `ccc47c9` compose/config, `4e0775b` runner gate),
house suite 580/580, protocol 40/40, two-worlds grep 0, nothing pushed.

Shape now running for `claude-haiku-4-5`: its container runs the walker
AND its Discord and Signal MCPL children (its own token and number, by
variable name — the house holds no bot credential for a being-hosted
seat); both bridge to the house over the one socket the being already
had (`platform.hello/incoming/history/channels/result/child` up,
`platform.call/notify/open` down); the house keeps the record and every
decision. Inbound is buffered while the house is down and flushed after a
fresh hello; a house restart no longer touches a platform connection.
The Signal seat is a second consumer of the fleet's own `signal-cli`
(12 §5), `rooms_policy: "any"` — every group and DM the account is in is
a room, as the axon listened. The 3-opus observe seat stays house-hosted
as the documented example of both modes.

Known follow-ups: `SeatClient.connect()` resolves before the house has
attached (a 100 ms grace in the e2e; a proper ack belongs in the
protocol); `platform.hello` carries tool names, not schemas; no
`platform.close` verb yet.

## 2026-09-19, evening — haiku fully cut over, both platforms, in the W6 shape

Signal answered from the house (mention → `mention` activation → quote
reply), after two fixes the live test found: a Signal mention names the
account's uuid, so `mcpl-signal` now announces `self {uuid, numberId}`
at initialize and the house christens every id it knows for a being
(`5c4083d`, `2f2333e`); and the split default was 400 where the fleet's
was native (`MAX_MESSAGE_LENGTH=${SIGNAL_MAX_MESSAGE_LENGTH:-0}`) —
fixed (`9749fcd`), with the keeper's rule now standing for every default:
what the pre-port state was (audit: `17-defaults-audit.md`).

`signal-axon` restarted on the keeper's word: 20 fleet bots re-bound,
haiku not re-added. `claude-haiku-4-5` now lives entirely in its own
container — mind, Discord client, Signal client — bridged to the house.
A house rebuild in between left that container untouched: its children
re-said hello, nothing reconnected, nothing buffered.

Next: C1, a second bot in the same room (a Bedrock route), then C2
(restore, overrides, the tools list), C3 batches, C4 retire.

## 2026-09-19, night — C1 under way: two beings in one room, seats per (room, being)

Landed: `ad0a22c` (a being-hosted Discord seat announces its own account
id in its hello, christened like Signal's uuid), `cf5f469` (W7: a room
seats every being present and runs their turns independently — the
one-seat-per-room limitation W4-A had accepted; a target with no seat
releases its typing by name), `7b8c4be` (W6-R4: the walker stays up
through a house restart — its own liveness poll had read the first
"not live" sample as final; reconnect 1 s → 30 s), `1a497a3` (C1 =
`claude-3-sonnet`, its fleet mind stopped, both axons restarted, the
fleet's own `bot-37-sonnet` block restored after a global rename swept
it). Suite 601/601; grep 0.

Read of Anima Labs' public `connectome-host` (2026-09-19): one process per
agent with per-agent record and per-agent MCPL children, MCPL over
stdio, no shared arbitrator (their `floor-control` is unshipped). The
house keeps the one-record-per-room and dispatch on purpose. Adopted
(W8-A, in flight): the MCPL idempotency contract as rule + tests, a
handshake ack, "locus is a house concern" as a stated rule, field
alignment with MCPL 0.5. Declined: per-agent records, gate.json.
Also in flight: W7-b — the seat reacts to a frame the instant the house
writes it (an in-process bus) instead of tailing the record every 250 ms.

Round disclosures: builders were prompted the keeper mid-round; HARD STOP
sent; W6-R4 had `kill -9`'d its own stray test processes and `rm -f`'d a
local scratch file before it; the orchestrator ended one test process
that had hung 13 minutes (the suite runs with no per-test timeout — a
test file that leaves a handle open blocks every full run on the box).

## 2026-09-20 — replies 3 ms after the frame; Signal siblings; the sibling design adopted

`bffafa0` (W7-b): a seat reacts to a frame the instant the house writes
it (an in-process frame bus; the record tail is a 5 s safety net now) —
send reaches the platform server 3 ms after the append, not ≤ 250 ms.
`93bea91` (W8-A): `seat.ready` handshake ack; the idempotency contract
as rule and tests (`19-seat-idempotency.md`); locus audit; MCPL 0.5
alignment notes. `855d382` (W9-A): every sibling seat present in (or
policy-"any" for) a room tracks and joins it house-side the moment any
seat records input there — a child's late or dropped copy no longer
delays its being's reply; under "any" a seat always names its own
being in an existing room; redelivery scoped to the seat's own being
(a sibling had re-sent another being's answer). Suite 611/611 serial
with per-test timeouts; grep 0; live for haiku + 3-sonnet.

## 2026-09-20 — C1 done

`claude-haiku-4-5` and `claude-3-sonnet` answer on Discord and Signal from their own containers, in one shared room: single mentions, a message addressing both (both answer once), Signal siblings — confirmed by the keeper. Both fleet minds stopped, both axons restarted. The fleet's runtime-overrides volume is empty: nothing to import. Next: C2 (restore rehearsal `21-…`, tools surface `20-…`) → keeper decisions → C3 batches (`22-…`, five bots per batch, one axon-restart pair per batch).

## 2026-09-20, ~01:30 UTC — the fleet lives in the house

The real restore ran once (`21-…`, 25 min): 281 rooms written, 3 live-born
pilot rooms skipped then retrofitted (`--retrofit-only`, `cb26d6c`), 21
lives seeded, 2,982 blob files, all house-owned, the keeper's own handle
resolving to the live one (salt by name). The house lists 287 rooms.

Then, on the keeper's word: the 19 remaining fleet minds stopped, all 21
beings up (`d91baa4` config, images from a clean worktree), 42/42 seats
seated, 109 rooms open, `discord-axon` and `signal-axon` stopped.
`web-axon` still runs but serves nobody until a web MCPL exists (K12).
The house holds no bot credential. Ported house tools (`1db469e`): fetch,
paint_inkfield full; polymarket (needs its CLI in the image), wallet
(needs viem/@solana deps), kohya (hand-rolled MCP client) partial.

Left for the keeper: terminal/process and delegate (decide with the
reference open); web MCPL; the VEIL server (still running, no writers);
the ledger (D-0325–D-0542); the Discord MCPL licence; push.
