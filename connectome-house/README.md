# connectome-house

The house: one process per box, owner of rooms, the record, per-being
lives, and the MCPL platform seats (docs/harness-port/03-house-design.md
§1). Ported, with adaptation, from a private deployment's headwaters
harness (2026-09-17) — never from a public archive/product's own copy;
see "What this is not" below.

## Layout

```
src/
  trace.mjs, lineage.mjs          the record (chronicle-backed, JSONL fallback)
  frame-schema.mjs, frames-io.mjs the closed frame schema + validate/tail/hydrate
  house-config.mjs, serve-paths.mjs, serve-http.mjs, serve-identity.mjs
  identity-map.mjs                salted platform-id -> handle map
  open-rooms.mjs                  the live-room registry + a seat-attach hook
  room-index.mjs, room-policy.mjs, stream-key.mjs
  serve-rooms.mjs, serve-room-open.mjs   room open/reopen/rest, HTTP handlers
  testaments.mjs, resident-covenant.mjs, dispatch.mjs, mentions.mjs   covenants
  resident-life.mjs, life-entries.mjs, room-reach.mjs   per-being lives
  auth.mjs, providers.mjs, model-registry.mjs, mock-adapter.mjs, run-model.mjs
  blob-root.mjs, media-normalize.mjs, media-share.mjs   shared attachment store
  platform-tools.mjs              a being-container's own platform-reach tools
  seat/                           the being's-turn seat: protocol.mjs (wire verbs),
                                   stdio-seat.mjs (one transport)
  mcpl/                           the MCPL afferents (host/route/adapters/discord/
                                   signal/...) — one seat per platform account
  serve.mjs                       the minimal entrypoint
test/                             the source's own tests, adapted
```

## What this is not

This package is generic house infrastructure. It names no archive, no
organization, no machine, and no person from the deployment it was
ported from — a deployment wires its own covenant files, its own
optional archive mount (`HOUSE_ARCHIVE_PATH`), and its own MCPL server
configuration on top of this package; none of that lives here.

## Env var renames (source deployment → this package)

Rule: the source's own five-letter project-name prefix on every one of
its env vars becomes `HOUSE_`, suffix unchanged. This package uses only
the `HOUSE_` form; every var actually read is listed under "Layout"'s
sibling files and in each module's own header comment. Two suffixes were
NOT carried over mechanically, because the mechanical rule alone would
have produced an awkward or misleading name:

| this package's var | what it replaces | why the suffix changed |
|---|---|---|
| `HOUSE_CONFIG_FILE` | the source's own config-file path override | the mechanical rule alone would double up (`HOUSE_` + a suffix that already read `..._HOUSE_CONFIG`) |
| `HOUSE_COVENANTS_DIR` | the source's own testament-scan directory override | the scanned directory holds covenant/testament files, not the source project's own "address" concept (a different, project-specific framework this port does not carry) |

Introduced in this port (no source equivalent — a cut feature's stand-in,
or a genuinely new knob):

| var | replaces / is |
|---|---|
| `HOUSE_ID` | the source's cross-machine registry (`machine-manifest.mjs`), cut — a deployment names its own box, if at all |
| `HOUSE_KEEPERS` | the source's product-side keeper-account lookup (`serve-notify.mjs`), cut — a plain comma-separated allowlist |
| `HOUSE_ARCHIVE_PATH` | new — a being's optional archive mount (see `house-config.mjs`) |
| `HOUSE_PORT` / `HOUSE_HOST` | new — the source parsed `--port` from argv; this minimal entrypoint reads env instead |

## What was cut, and why

Per the porting brief (not the walk child, not anything that composes a
corpus surface, not evals/address/app):

- **The walk child itself** — no CLI-arg-spawned subprocess, no
  `--walkers`/`--life-for`/`--platform-surface` argv building
  (`serve-room-open.mjs`'s own CLI-arg functions were cut; what's kept
  is the room-record shape and per-being life compilation, reshaped as
  plain data for a seat implementation to use).
- **A browser-facing UI layer** — `serve-sse.mjs`'s SSE hub/broadcast,
  the wiki/viz/loom-fork/composition-advertisement/compose-surface-mirror
  routes, `serve-decay.mjs`, `serve-alarms.mjs`'s UI surface. What's kept
  from `serve-sse.mjs` is just the live-room registry, now
  `open-rooms.mjs` — bookkeeping only, no SSE.
- **A wake/sleep alarm clock and its "threshold receipt"**
  (`alarm-store.mjs`, `serve-threshold.mjs`) — every being reads as
  awake in this port (`mcpl/seat.mjs`'s `awakeOf`); a deployment that
  wants a resident-style sleep posture reintroduces this on top.
- **Participant invite/join HTTP flow and its life-compile-on-join
  orchestration** (`serve-participants.mjs`) — `serve-rooms.mjs` keeps
  a small local `addParticipant` (record + registry update only).
- **The resident's own autonomy tools** (proposals, house-side
  self-management — `resident-tools.mjs`) and the derived-testament-
  per-pinned-model feature (`testaments.mjs`'s old `derivedTestaments`)
  — both are being-container/product concerns per
  `docs/harness-port/03-house-design.md` §3.1.
- **A cross-machine identity registry** (`machine-manifest.mjs`) —
  replaced by `HOUSE_ID` everywhere it was read.
- **Everything under `app/`** (an archive-composition pipeline,
  a compiled wiki, a specific viz app) — `house-config.mjs`'s `archive`
  section is now a single optional mount path, no compose/media/made/
  wiki/answers/compiled pipeline.

Where a copied module imported one of the above, the import and the
code path were cut with a short comment naming what the house does
instead (or nothing) — see each file's own header for specifics.

## The seat: two transports, one wire

`seat/protocol.mjs` names the house→seat wire verbs (`turn.begin`-shaped
sends). `seat/stdio-seat.mjs` is ONE transport (a spawned child's stdio) —
ported verbatim since it has no dependency on anything cut. The being's-
turn SOCKET transport docs/harness-port/03-house-design.md §2.3
recommends is wired now (round R2-A, 2026-09-17, 06-rounds.md): implement
the same shape (`send`/`isLive`/`onExit`/`kill`) and attach it to an open
room via `open-rooms.mjs`'s `attachSeat(id, seat)` — `seat/socket-seat.mjs`
does exactly this over `@connectome/seat-protocol`'s `SocketSeatServer`.
Until a seat is attached, a room's record still accepts and stores input
with no seat at all — the house is always the record's writer, whether or
not a being is currently seated to answer it.

### The room worker loop (`room-turn.mjs` + `seat/socket-seat.mjs`)

`HOUSE_SEAT_ADDR` (`unix:<path>` or `tcp://host:port`/`host:port`), set
before `serve.mjs` boots, starts a `SocketSeatServer`. On a being's
handshake, the seat is attached to the room the handshake's own `room`
field names — "or to a room on demand" (house-design.md §2.1) means the
being names an already-open room directly; this round does not yet mint
one from a bare handshake. A room already holding a seat refuses a second
handshake (this port seats **one being's turn per room** — several beings
sharing one room, each with its own seat, is a documented gap, not a
silent one).

When `roomInput` (`serve-rooms.mjs`) records a message, it decides
activation per being present (`dispatch.mjs`'s `decideActivation`) UNLESS
the caller already computed `targets`/`observe` itself (an MCPL platform
seat's own `mcpl/route.mjs` routing, unchanged). For the being holding this
room's one seat:

- **activated** → `room-turn.mjs`'s `beginTurn` sends `turn.begin`. Its
  `context` is `{conversation, life}`: `conversation` REUSES
  `life-entries.mjs`'s `buildFullMessages` — the one place this port
  already renders a room's frames into a per-being view (own turns under
  the being's own handle, everyone else's under theirs) — never a second
  frame→conversation renderer; `life` is `serve-room-open.mjs`'s already-
  compiled `life.json`/`life.<handle>.json`, tailed to its last 20
  messages. `covenant` is `{model, tools, posture}` (`resident-covenant.
  mjs`'s `covenantFor`, `tools` empty until a platform executor is
  registered for this room — see below).
- **not activated** → the existing `line` wire message (observe-only
  context, no turn) — unchanged from before this round.

Streamed `turn.event`s fold into the record as `speech` frames (`tokens`
→ `interim: true`, `final` → the turn's closing speech, may recur) and
`reach` frames (a tool call the being already resolved itself, reported
for the record only). A live `tool.exec` for a HOUSE tool (record/media/
notes/stage/resident — house-tools.mjs, W-B) routes to `executeHouseTool`
(room-turn-tools.mjs's `handleToolExec`, extracted out of room-turn.mjs to
hold it under its own line-length ratchet) — framed ONCE, by that tool
module's own `ctx.trace` (never a second time by the generic path below,
which would double the frame). Everything ELSE goes through
`registerPlatformExecutor(roomId, executor)` for a platform tool bridge no
round has wired up yet, else an honest `"<tool> is not offered here"`
refusal, worded like `platform-tools.mjs`'s own — recorded as a
`reach`/`reach.result` pair, then a `tool.result` reply either way.
`turn.done` closes the turn with no further frame; `turn.error` or a
dropped seat (`handleSeatExit`) both append an `aborted` frame and free
the room's seat slot — the room itself stays open either way.

`covenant.tools` (harness-port W1-R, 2026-09-18) is now every house tool's
own name PLUS whatever a registered platform executor offers — a being's-
turn room always offers both, never house tools alone; house-tools.mjs's
own `mountHouseTools({requestContinue, requestClose})` mounts once at
`serve.mjs` boot with the house's own callbacks (see "Known gaps" below
for how far those actually reach). The house-tool `ctx` `beginTurn(ctx,
handle)` receives (room-turn-tools.mjs's own header names the exact
shape) also carries `owner`/`ownerKind`/`being`/`cls`/`life` resolved from
the room's own class.json and compiled life.json — `stagedWork`/
`ownContinuation` are left OUT on purpose (named below), so `task_continue`
always honestly refuses this round.

A room actively streaming a turn needed its own strictly-increasing
integer frame-seq counter (`room-turn.mjs`'s `appendTurnFrame`/
`resyncTurnSeq`) — `frames-io.mjs`'s `appendHouseFrame` is built for a
single isolated insertion into a non-live run and, called twice in a row
with no live/integer frame in between, was found to mint the SAME
fractional seq both times (fixed in `houseFrameSeq` this round too, for
every OTHER caller's benefit as well).

`restRoom` now also lets every present being's life gain this session's
period (`resident-life.mjs`'s `appendPeriod`, awaited — never wired into
any live server path in this port until now).

**Protocol field this round wanted, deferred to the protocol builder**:
`connectome-seat-client`'s `SeatClient` tracks `.lastSeqSeen` and could
carry it as an optional `resumeFromSeq` on its `handshake` for a house
that wants to redeliver what a reconnecting seat missed — not added to
`@connectome/seat-protocol`'s schema by this builder (NO-TOUCH package);
today's client simply never sends the field, and no house-side redelivery
exists yet either.

**Known gaps, named rather than silently absent**: no room-on-demand
minting from a bare handshake; one seat per room (no multi-being-per-room
socket wiring); no real PLATFORM-tool executor registered anywhere yet
(`registerPlatformExecutor` exists, unused — house tools ARE wired, as of
harness-port W1-R); `sendSeatVerb`/`sendSummon`/`sendWalkReport`/`sendFork`
(seat/protocol.mjs) have no socket-transport counterpart (fork/multi-walker
concepts the seat-protocol message set doesn't model) — calling them on a
socket seat logs and no-ops. `mountHouseTools`'s `requestContinue` is
unreachable in practice this round (nothing arms `ctx.stagedWork`/`ctx.
ownContinuation` from a live seat); `requestClose` (`rest`'s own verb) IS
reachable but `closeTurn` has no "close once this turn ends" hook yet —
`serve.mjs`'s own callback logs the request and the room stays open. The
house-tool `ctx.life` is the STATS view (life.json's `.stats` + `.note`);
`beginTurn`'s own `context.life` (the model-prompt EXCERPT) is a different
shape for a different reader — the two are not interchangeable.

### The servers file (`HOUSE_MCPL_SERVERS`)

One JSON file (a path named by `HOUSE_MCPL_SERVERS`, gitignored — never
committed) names every MCPL server this house seats a bot identity
against; `mcpl/config.mjs`'s own header comment is the full field-by-field
shape (`name`, `platform`, `command`/`args`, `being`, `rooms`, and the
optional per-server fields below, each with a GLOBAL default a server's
own explicit value always overrides).

- **`observe_only`** (harness-port P-F, 2026-09-17, docs/harness-port/
  08-pilot-observe.md §2): default `false`. `true` on a server entry (or
  as the top-level global default) means that seat records everything it
  hears — the room fills exactly as it would otherwise — but never
  activates a being, never speaks, never reacts, never sends a typing
  indicator. Gated at TWO points, both required (`mcpl/route.mjs`'s own
  activation decision, and `mcpl/speak.mjs`'s `speak()`/`speakMedia()` —
  the `!`-command reply lane bypasses the first, so the second is not
  redundant). Visible per-seat at `GET /api/mcpl` (`seat.mjs`'s own
  `snapshot()`).

### `!stream in|out` — the forked-room primitive (C13)

`room-fork.mjs` is the live forked-room primitive behind `!stream in
<name>` / `!stream out`: a house-side child room, minted with the SAME
`forkedFrom: {run, seq}` pointer shape `connectome-history-import` writes
for an imported substream, plus a `branch.created` frame on the parent —
a live fork and an imported one are indistinguishable on disk. There is
no child channel on the platform: while a room is "in" a fork, an
addressed turn is recorded in the CHILD room instead of the parent
(`mcpl/room-tails.mjs`'s `applyInputAction`, reading `activeFork`), and
the being's speech is rendered back into the PARENT's real platform
channel with the fleet's own relay prefix (`room-fork.mjs`'s own
`streamRelay`, applied by `seat.mjs`'s `onFrame`) — `> **[substream:
<name>]** <being>: ` on Discord, `[substream:<name>] <being>: ` on
Signal, matching `substream-relay-effector.ts`/`signal-substream-relay-
effector.ts` byte for byte. Re-entering a name after `!stream out` reuses
its history (a name is only ever forked once per parent room); the same
being's-turn seat answers in both records.

## The walker (`walker.mjs`)

The being's own turn on membrane, as a process:

```
node src/walker.mjs --being <handle> --seat <unix:/path|tcp://host:port|stdio> [--room <id>]
```

`--room` is required for a socket seat (every seat-protocol message
carries `room`); unused for stdio (implicit — one child, one branch).
`serve-walks.mjs`'s own process table spawns this same command
(`HOUSE_WALKER_ENTRY` overrides it, for a test's own stub); an externally
started walker (a container) dials the identical socket handshake with no
house-side spawn at all — both converge on `open-rooms.mjs`'s `attachSeat`.

**The seams**: `walk-turn.mjs` (`createTurnRunner`) runs one turn on
membrane, folding the stream's tokens/tool-calls/complete/aborted events
into `turn.event` sends and every tool call through `walk-frame.mjs`'s
`execViaHouse` (`tool.exec`/`tool.result` — the house is the record's sole
writer, this process never frames its own reach); `walk-address.mjs`
composes the address fresh per turn (persona + standing + room + presence
+ tools, no caching — a keeper's testament edit reaches the very next
turn); `cache-budget.mjs` fits prompt-cache breakpoints; `registerTools`
(`walk-turn.mjs`) is the schema registry `toolDefFor` reads from — this
process calls `registerTools(houseToolDefinitions())` once at boot so a
REAL (non-mock) turn's `covenant.tools` names resolve to real JSON
schemas, not `null` (`covenant.tools` itself is room-turn.mjs's own
concern, house-side — this process only ever supplies the schema half; it
never executes a house tool itself).

**What's mocked**: `HOUSE_MOCK_MODEL=1` (or `--mock`) swaps `resolveAuth()`
+ every real provider adapter for `mock-adapter.mjs`'s `MockAdapter` — a
scripted `responseQueue`, offline, that never varies by request content
(covenant/tools/context are irrelevant to what it plays back).
`HOUSE_MOCK_HOUSE_TOOL=1` (test-only) swaps its default archive-flavored
script (`archive_glob`/`archive_read`/`file_note` — always refused honestly
here, this port's beings have no archive) for one that calls `record_list`,
a real house tool, instead — `test/walker-tools-e2e.test.mjs`'s own proof
that a house tool's `tool.exec` round-trips end to end, framed once.

**Dropped, not ported** (obsoleted by the house's own architecture, or out
of scope): `walk-world.mjs` (no archive mirror to resolve), `walk-seat.mjs`
(mid-run reseating), `walk-resume.mjs` (the house re-renders context fresh
every turn), `walk-platform-tools.mjs` (superseded by `tool.exec`),
`run-class.mjs` (the private corpus-walk CLI, no equivalent here).

## Tests

`node --test` runs everything under `test/` matching `*.test.mjs`,
adapted from the source's own suite (paths/env names updated; sandboxes
via `HOUSE_RUNS_DIR` / `HOUSE_PRIVATE_DIR` / `HOUSE_COVENANTS_DIR`).

This round brought over the tests for every module ported with high
fidelity (rooms/room-index/stream-key/room-policy/room-reach, identity-
map, testaments, resident-covenant, dispatch, the resident-life/life-
entries family, the mcpl leaf modules this round had time to verify:
adapters, wire, typing, route, redeliver, media-out, sweep's pure
helper, seat-stdio) plus `house-config.test.mjs`, rewritten for this
package's simplified config shape.

R2-A (the room worker loop, above) added `room-turn-e2e.test.mjs` (a
scripted multi-turn conversation over a REAL unix socket, `@connectome/
seat-client`'s `MockBeing` as the being — golden-record, closed-schema,
and one-life-period assertions) and `seat-abort.test.mjs` (a dropped
socket mid-turn → `aborted`, room stays open, a new being can seat).

**Not brought this round** (named `*.test.mjs.excluded` in `test/` —
rename back to `.test.mjs` once the gap below is closed):

- `life-house.test.mjs.excluded` — a full sandboxed-serve integration
  test for a resident's autonomous "waking" period, `/api/live/start`,
  and the alarm-plant convention (`alarm-store.mjs`, `serve-house.mjs`)
  — a wake/sleep clock and a plain (non-platform-room) conversation
  route, both cut from this port (see "What was cut" above).
- `life-late-join.test.mjs.excluded` — depends on `/api/live/start`,
  `/api/runs/:id/invite`, `/api/runs/:id/join`, `/api/runs/:id/reopen`
  — the participant invite/join HTTP flow (`serve-participants.mjs`),
  cut from this port; `serve-rooms.mjs` keeps only a trimmed local
  `addParticipant`.
- `mention-mode.test.mjs.excluded` — spawns the walk child (`walk.mjs`)
  directly to exercise activation end to end; the walk child isn't part
  of this port at all. `dispatch.test.mjs` (brought over, direct-import,
  no spawn) already covers `decideActivation` itself at the unit level.

Also not brought this round at all (no attempt made — the source's own
e2e suite around a live platform connection or the full app/UI wiring,
out of this round's budget): `mcpl-being-tools-*`, `mcpl-box`,
`mcpl-discord`, `mcpl-errors-to-chat`, `mcpl-host`, `mcpl-keeper-dm`,
`mcpl-link`, `mcpl-media-in`, `mcpl-media-seat`, `mcpl-multi-bot-echo`,
`mcpl-relay*`, `mcpl-room-title`, `mcpl-seat-*`, `mcpl-signal-e2e`,
`beings-http`, `being-group`, `serve-rooms(-inflight)`, `serve-room-open`,
`mention-mode`'s own spawn-based variant. A follow-up round should
prioritize `serve-rooms`/`serve-room-open` next — the room-open/reopen
logic these test is the piece this port rewrote most heavily (no more
walk-child spawn), so it's the least-verified surface in the package.
