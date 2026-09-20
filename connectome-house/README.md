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

## How a seat notices a new frame

`frames-io.mjs`'s `appendHouseFrame` is the one function that appends a
house-side frame to a room's record, and it notifies an in-process
`frameBus` the instant it does — `mcpl/seat-bus.mjs` subscribes once per
seat, so a room's own tail reacts to a frame as it lands, not on the next
tick of a poll. Each seat still runs a slow (5s) sweep, but only as a
startup catch-up and a safety net for whatever the bus missed, never the
primary path.

A seat's OWN copy can still lag a sibling's (a platform's own second-
consumer risk) — `mcpl/seat-registry.mjs` keeps every live seat's
`trackRoom` reachable by (platform, being); `room-tails.mjs`'s `ensureLive`
starts every present or policy-"any" sibling tracking a room at once, house-side.

## What this is not

This package is generic house infrastructure. It names no archive, no
organization, no machine, and no person from the deployment it was
ported from — a deployment wires its own covenant files, its own
optional archive mount (`HOUSE_ARCHIVE_PATH`), and its own MCPL server
configuration on top of this package; none of that lives here.

## Ported tools (C2-ports, 2026-09-20)

`src/tools/` carries five fleet tools (`bot-runtime`'s config-driven or
always-on tools, docs/harness-port/20-tools-surface.md §1/§4) that need
no VEIL: `fetch-tools.mjs` (`fetch`), `polymarket-tools.mjs`
(`polymarket`, gated on `POLYMARKET_CLI` naming a binary — this house
bundles none), `wallet-tools.mjs` (`get_wallet_info`/`check_balance`/
`transfer`/`x402_fetch` — the fleet's own encrypted-secret resolution is
ported in full; on-chain signing itself needs viem/@solana/web3.js, not a
dependency of this package, so it degrades to an honest, labeled refusal
rather than a throw or a fabricated balance), `inkfield-tools.mjs`
(`paint_inkfield`, a rendered PNG lands in blob-root.mjs's shared store
and a `media.attached` frame — the same mechanism `media_attach` uses, so
mcpl/media-out.mjs delivers it unchanged), and `kohya-tools.mjs` (the
`kohya-lora-training` MCP surface, a hand-rolled streamable-http JSON-RPC
client — no `@modelcontextprotocol/sdk` dependency — whose tool list is
learned at connect and offered `kohya-lora-training__<name>`-prefixed,
matching the fleet's own MCPManager naming). All five mount through
`house-tools.mjs`'s `mountHouseTools()` beside the earlier record/media/
notes/stage/resident tools, so a covenant's `tools:` list offers them by
the SAME names the fleet's own covenants already carry.

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

## Auth: the OAuth store, the refresh, pi is not a dependency

`auth.mjs` resolves a subscription-OAuth token in this order: `ANTHROPIC_AUTH_TOKEN`
env, `~/.pi/agent/auth.json` (refreshable — see below), `~/.claude/.credentials.json`
(read-only borrow, never refreshed from here), then `ANTHROPIC_API_KEY`. `PI_AUTH_DIR`
(default `~/.pi/agent`) is kept as a path name only — the fleet's own bots still share
that store file; it names no package dependency.

The refresh itself (`src/oauth-refresh.mjs`) is a from-scratch reproduction of the
wire protocol a removed dependency once supplied: the same token URL, method, JSON
body (`grant_type`, `client_id`, `refresh_token`), the same `expires = now +
expires_in*1000 − 5min` skew, and the same identity contract (`newCredentials ===
creds.anthropic` when nothing expired, a fresh object when it did) that `auth.mjs`'s
atomic tmp+rename persist and rotation-race retry depend on. `CLIENT_ID` is Claude
Code's public OAuth client id, not a secret. **pi is not a dependency of this
package** — `package.json` no longer lists it, only borrowed for the fleet's own
bots elsewhere in the monorepo.

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
handshake, the seat is attached to EVERY open room whose roster already
names that being — one always-on walker per being, seated wherever it's
present (`open-rooms.mjs`'s `seatBeing`/`seatsByBeing`, harness-port W4-A).
A second simultaneous connection for the SAME being is refused (one live
seat per being at a time); several DIFFERENT beings present in the SAME
room each hold their own seat and run their own turn, independently
(`rec.seats`/`rec.turns`, `Map<being, ...>` — harness-port W7, 2026-09-19:
the live bug this answered — a mention naming a second, present, seated
being used to get no turn at all, since the room's old singular `rec.seat`
slot could only ever answer for whichever being already held it).

When `roomInput` (`serve-rooms.mjs`) records a message, it decides
activation per being present (`dispatch.mjs`'s `decideActivation`) UNLESS
the caller already computed `targets`/`observe` itself (an MCPL platform
seat's own `mcpl/route.mjs` routing, unchanged). For EACH being that
activates AND holds its own seat in this room:

- **activated** → `room-turn.mjs`'s `beginTurn` sends `turn.begin`. Its
  `context` is `{conversation, life}`: `conversation` REUSES
  `life-entries.mjs`'s `buildFullMessages` — the one place this port
  already renders a room's frames into a per-being view (own turns under
  the being's own handle, everyone else's under theirs) — never a second
  frame→conversation renderer; `life` is `serve-room-open.mjs`'s already-
  compiled `life.json`/`life.<handle>.json`, tailed to its last 20
  messages. `covenant` is `{model, tools, posture, maxTokens?,
  systemPromptOverride?, thinking?, promptCaching?}` (`resident-covenant.
  mjs`'s `covenantFor`, folded through `room-turn-tools.mjs`'s
  `resolveCovenantFields` — harness-port W3-A, 2026-09-18: a testament's
  own static `max_tokens`/`tools`/`thinking`/`prompt_caching` fields bind
  here, each yielding to a live `!`-command override; `house/covenants/
  README.md`'s field table is the full list).
- **not activated** (whether or not it holds a seat here) → the existing
  `line` wire message (observe-only context, no turn) — sent to every
  seated being not given a turn this round, unchanged in shape from before
  this round, just no longer limited to a single room-wide seat.
- **activated but has NO seat here at all** → `roomInput` reports it in a
  new `unseated` array (`{ok, started, unseated}`) rather than dropping it
  silently; the message still lands in the record either way. The MCPL
  seat side (`mcpl/room-tails.mjs`'s `applyInputAction`) is who releases
  the typing indicator it optimistically started for that being
  (`mcpl/seat.mjs`'s `turns.stopTyping(stream, "no seat for the being")`)
  — only when that being is THIS seat's own (`mcpl/turns.mjs`'s typing
  loop is scoped to one seat's own being already).

Streamed `turn.event`s fold into the record (`room-turn-fold.mjs`,
harness-port W3-A) as ONE `speech` frame per SEGMENT, never per token:
`tokens` accumulates on the wire only (walk-turn.mjs's own `segText`) and
writes no frame; a `final` segment is buffered (`turn.pendingFinal`) until
either a tool call proves it was interim (a `reach`/`tool.exec` flushes it
`interim: true` first) or the turn's own close proves it was the true
final (flushed plain, no `interim` field). The 2026-09-18 defect this
fixed: a per-`tokens`-event frame, 30 frames for one 60-token turn, no
final at all. `reach` frames (a tool call the being already resolved
itself, reported for the record only) flush the same way. A live
`tool.exec` for a HOUSE tool (record/media/
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
dropped seat (`room-seats.mjs`'s `handleSeatExit`) both append an
`aborted` frame and free THAT BEING's own seat slot only — every other
being's own seat and turn in the same room are untouched; the room itself
stays open either way.

`covenant.tools` (harness-port W1-R, 2026-09-18) is every house tool's own
name PLUS whatever a registered platform executor offers — a being's-turn
room always offers both, never house tools alone — UNLESS the being's own
testament names its own `tools:` list (W3-A, 2026-09-18), in which case
that list is intersected with the same offered set instead (an unoffered
name is dropped and logged, never thrown). house-tools.mjs's
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
minting from a bare handshake (harness-port W7, 2026-09-19, closed the
former "one seat per room" gap — several beings present now each hold
their own seat and turn, `rec.seats`/`rec.turns`); no real PLATFORM-tool
executor registered anywhere yet
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
  08-pilot-observe.md §2; bce2d29, 2026-09-19): default `false`. `true` on
  a server entry (or as the top-level global default) means that seat
  records everything it hears — the room fills exactly as it would
  otherwise — but never activates a being, never speaks, never reacts,
  never sends a typing indicator. Silences this seat's own being only:
  every other being present in the room keeps its ordinary activation
  decision, so a second bot identity sharing the same platform channel
  never blocks the room's own answer. Gated at TWO points, both required
  (`mcpl/route.mjs`'s own activation decision, and `mcpl/speak.mjs`'s
  `speak()`/`speakMedia()` — the `!`-command reply lane bypasses the
  first, so the second is not redundant). Visible per-seat at `GET
  /api/mcpl` (`seat.mjs`'s own `snapshot()`).

- **`${NAME}` in a room's `stream`** (`config-env.mjs`): expands from
  `process.env` at load — unset/empty NAME skips that room (logged, never
  a throw); a comma-separated value fans out one room per value, cartesian.

- **`rooms_policy`** (harness-port W5-A, 2026-09-19): default `"listed"` —
  today's behaviour, an unconfigured/unopened stream is ignored (a DM from
  a linked sender or the keeper excepted, `admitsUnlistedDM`). `"any"` is
  axon parity: every stream the server delivers (`channels/register`/
  `channels/incoming`) is a standing room — opened at seat start for the
  channels the server already lists, and on first message for a new one
  (`host.mjs`'s `openStandingRooms`) — public by default (`config-policy.
  mjs`'s `isPublicRoom`) unless an explicit `rooms[]` entry for that exact
  stream says `public: false`; an explicit entry's `title`/`beings` still
  apply too. An unlisted DM from an unlinked stranger answers as well
  under `"any"` (`seat.mjs` skips the link pre-gate for an ordinary
  message; `link <code>` itself still runs) — a deliberate parity call
  with the fleet's own Signal axon, which answered every DM unconditionally
  with no linking concept at all.

- **`number_env`** (harness-port W5-A): a variable NAME the house reads at
  seat start — `cfg.number_id = phoneId(process.env[NAME])` (the hashed
  id, never the number, never logged), christened to `being` the way
  `being_id` is (`room-tails.mjs`'s `christenBeing`, extended to fall back
  to `number_id`). For a Signal seat with no `being_id` of its own.

- **A server's own announced uuid** (harness-port W6-R1, 2026-09-19): a
  Signal mention carries the mentioned account's uuid, never its number
  (`<@uuid>` tokens, `mcpl-signal`'s own mention grammar), so `number_id`
  alone left a self-mention resolving to a fresh stranger handle instead
  of the being's own. `mcpl-signal`'s `initialize`/`channels/self` carries
  `serverInfo.self = {uuid, numberId}`; `host.mjs`/`remote-host.mjs` both
  surface it as `state.self` (the being-hosted path via `child.mjs`
  forwarding it inside `platform.hello.capabilities.self`), and
  `seat.mjs`'s own poll (`checkSelf`) sets `cfg.self_uuid` and re-runs
  `christenBeing` the moment it's new — idempotent, same as `being_id`/
  `number_id`. `christenBeing` itself now takes a LIST of ids (defaulting
  to `being_id`, `number_id`, `self_uuid`), christening every one it
  knows for the being rather than only the first found. **W6-R5,
  2026-09-19**: Discord's own being-hosted seat carries no `being_id` (the
  house never sees its child's stderr) — `child.mjs` now parses its own
  connect line (`Discord connected as bot <id>`) into `state.self.id`,
  `christenBeing` grew a fourth id (`self_id`), and `checkSelf` (moved to
  `room-tails.mjs`'s `createSelfTracker`) keys on the whole `self` object
  so either platform's shape re-christens.

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

The being's own turn on membrane, as ONE always-on process, seated to
EVERY room the house finds it present in (harness-port W4-A, 2026-09-19 —
the fleet's own problem this answers: "each container had bots that were
always listening everywhere they were added", a process per (bot, room)):

```
node src/walker.mjs --being <handle> --seat <unix:/path|tcp://host:port|stdio> [--room <id>] [--max-concurrent <n>]
```

The handshake names only a BEING; the house (`open-rooms.mjs`'s
`seatsByBeing`/`seatBeing`) attaches this one connection to every open
room whose roster already names it, plus any room that opens later
(`attachRegisteredSeat`, wired into `serve-rooms.mjs`'s `openRoom`). A
dropped seat detaches from every room at once, and closes any in-flight
turn there `aborted`. One turn runs PER ROOM at a time, up to
`--max-concurrent` (default 1, the fleet's own one-cycle-per-bot posture)
— a room's `turn.begin` past the cap QUEUES rather than being refused
(`walker.mjs`'s own `cancels`/`queue`); the house tolerates the wait, no
timeout shorter than a model call. `--room` is legacy: naming one still
selects a single-room handshake (a few tests keep this for a fixed,
known room); its absence is the new default, using the being's own handle
as a harmless wire placeholder (the house's attach logic never reads it —
every actual turn message carries its own real `room` field explicitly,
stamped by `room-turn.mjs`/`seat/protocol.mjs`). `serve-walks.mjs`'s own
process table spawns this same command PER BEING, never per room
(`HOUSE_WALKER_ENTRY` overrides it, for a test's own stub); an externally
started walker (a container) dials the identical socket handshake with no
house-side spawn at all — both converge on `open-rooms.mjs`'s `seatBeing`.

**The being outlives the house** (W6-R4): a dropped seat no longer exits
this process — it logs once, keeps its platform children running, and
reconnects forever (1s backoff doubling to 30s), re-handshaking as the
same being. `--exit-on-seat-loss` restores the old exit-on-drop behaviour.

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

## Being-hosted platform seats (`platform-runner.mjs`)

harness-port W6-B, 2026-09-19 ("the seat moves into the being",
`docs/harness-port/13-walker-port.md` §4): the house used to spawn every
bot's MCPL child itself (Discord/Signal servers, `mcpl/host.mjs`) — a house
restart dropped every platform connection at once, a crash was fleet-wide.
The complete shape instead: **each being's container hosts its own
platform children** (its Discord token, its Signal number, by variable
name — the fleet's per-bot compose convention) and bridges them to the
house over the SAME seat socket the walker already holds — turns
(`turn.*`/`tool.*`) and platform traffic (`platform.*`) multiplexed by
message type on one connection per being. The children stay up across a
house restart; that is the entire point.

```
node src/walker.mjs --being <handle> --seat <unix:/path|tcp://host:port> --platforms <servers.json>
```

(or set `HOUSE_PLATFORMS_FILE` instead of `--platforms`; `--seat stdio`
works too, though a real deployment seats a being over the socket). Absent,
nothing changes — no platform children, no new sends on the seat.

**The pieces**: `mcpl/child.mjs` is the child-spawning HALF of
`mcpl/host.mjs` (handshake, state, `callTool`/`notify`/`openChannel`,
backoff restart) — copied out, not shared, since the house's own accept/
reject business logic no longer belongs at this layer: every push/event
and channels/incoming is answered `{accepted: true}` at once (MCPL's own
30s request timeout leaves no room to wait on the house over the wire),
and the normalized message is handed to `platform-runner.mjs` to forward.
`platform-runner.mjs` reads the servers file (`config.mjs`'s own
`validateServer`, read-only — never expanding a room's `${VAR}`, the
house's own concern), spawns one child per entry whose `being` matches,
and bridges each to the seat: `platform.hello` once a child's handshake
completes (and again after every automatic restart); `platform.incoming`/
`platform.history`/`platform.channels`/`platform.child` as they happen;
`platform.call`/`platform.open` from the house answered by `platform.result`
with the same `id`; `platform.notify` forwarded to the child, fire and
forget. All nine message types (`@connectome/seat-protocol`'s
`messages.mjs`) carry the sentinel `room: "*"` — a platform server isn't
scoped to one room.

**Buffering**: while `seat.isLive()` is false, every being->house send
this module makes queues in one bounded FIFO (default 500, oldest dropped
with a stderr line naming the running count) instead of being silently
lost. `platform.hello` is never buffered — a stale one could describe a
child whose state has moved on — so on reseat (`isLive()` false -> true,
polled; neither seat transport exposes a "reconnected" event of its own) a
FRESH hello goes out for every ready/degraded child first, and only then
does the buffer flush, in order.

**Image**: `docker/house/being.Dockerfile` builds `mcpl-discord` fresh and
ships `mcpl-signal`'s source, exactly as `docker/house/Dockerfile` does for
the house — a being-hosted child runs inside THIS container now.

**Tests**: `test/platform-runner.test.mjs` drives a real mock MCPL child
(`test/lib/mock-mcpl-server.mjs`) against a fake house seat double —
hello's tools/channels, an inbound message becoming `platform.incoming`, a
`platform.call` round-tripping to `platform.result` by id, the
house-down/buffer/reseat sequence, and a scripted crash producing
`platform.child` `"exited"` then a restart's second hello.

### Being-hosted seats — house side (`mcpl/remote-host.mjs`)

harness-port W6-A, 2026-09-19, the house-side half of the section above.
A server's `hosted_by: "being"` (`config.mjs`, default `"house"`) needs no
`command`/`args` at all — `mcpl/routes.mjs`'s `bootSeats` never spawns it;
instead `mcpl/seat.mjs` builds its host from `mcpl/remote-host.mjs`'s
`createRemoteHost` (same interface as `mcpl/host.mjs`'s `createHost` —
`state`, `start`/`stop`/`restart`, `openChannel`/`closeChannel`,
`callTool`, `typing`/`lifecycle`, `connected`, `snapshot`; nothing else in
the seat changes) and `bootSeats` registers the result in `open-rooms.mjs`'s
`remoteHostsByBeing`, keyed by `(server.being, server.name)`, in a fresh
`"waiting"` state — `calls.mjs`'s own `CALLABLE_STATES` excludes it, so a
call attempted before any being ever says hello refuses `"not-ready"`
through the same typed gate a spawned host uses.

A being's `platform.hello`/`platform.incoming`/`platform.history`/
`platform.channels`/`platform.result`/`platform.child` arrives on its ONE
seat connection carrying the `room: "*"` sentinel — `seat/socket-seat.mjs`
routes these (before its ordinary room-keyed dispatch ever sees them) to
the remote host `remoteHostFor(being, msg.server)` names, handing it the
seat's own `send` so `callTool`/`typing`/`lifecycle`/`openChannel` can
answer with `platform.call`/`platform.notify`/`platform.open` over that
same connection — never a second one. A being that connects AFTER the
house has already booted, or reconnects later, simply sends `platform.hello`
again on its (new) connection: the SAME registered host picks it back up
(`receive` re-arms the send function it answers through), and
`openStandingRooms` skips any channel `st.open` already has, so a
reconnect never re-opens a room. The connection dropping
(`socket-seat.mjs`'s `onExit`) calls the host's own `wireDetached()` —
`connected()` goes false and every in-flight call rejects, but `state` is
kept as last reported, for the snapshot.

**Named gaps from a spawned host**, all by the wire's own shape, not an
oversight: `toolDefs` stays `[]` (`platform.hello` carries tool NAMES
only); `closeChannel` has no wire counterpart (nothing calls it today,
house-wide) and is house-side bookkeeping only; `platform.history` lands
independently of `openChannel`'s own returned promise rather than awaited
inline. Grant enforcement is not duplicated here — the being's own
child-side host already negotiated its grant with the real MCPL server
before ever reporting a tools list; this proxy trusts that list and
reapplies only `calls.mjs`'s `callRefusal`/`GrantRefused`, the same typed
refusal shape a caller already catches.

**Tests**: `test/remote-seat.test.mjs` — the real `bootSeats`/
`createHouseSeatServer`, a `hosted_by: "being"` server, and a
`MockBeing` (`@connectome/seat-client`) playing both a being's own turn
answers and its platform bridging on the one connection: hello attaches
and auto-opens the configured room, a mention turns for real, the reply
rides `platform.call send_message` into `external.jsonl`, typing rides
`platform.notify`, and a simulated reconnect resumes without a duplicate
room open.

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
