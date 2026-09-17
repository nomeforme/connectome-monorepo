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
recommends is a separate package's job: implement the same shape
(`send`/`isLive`/`onTokens`/`onLog`/`onMessage`/`onExit`/`kill`) and
attach it to an open room via `open-rooms.mjs`'s `attachSeat(id, seat)`.
Until then, a room's record still accepts and stores input with no seat
attached — the house is always the record's writer, whether or not a
being is currently seated to answer it.

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
