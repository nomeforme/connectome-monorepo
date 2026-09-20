# 25 — The hard outbound guardrail

Written by builder G, 2026-09-20, on `harness-port`, in response to the
2026-09-20 retrofit-replay cascade (`docs/harness-port/24-incident-2026-09-20-cascade.md`,
read in full before this doc — its §2/§6 are cited throughout below). This
task's own brief asked for six rules "regardless of which bug caused it";
the incident doc's own root-cause analysis (received mid-task) sharpened
three of them — those changes are called out explicitly where they occur.

Nothing here was run against a live house. `docker start/stop/restart/run`
and `docker compose up` were never used while building this; only
`docker ps -a`/`docker logs`/`docker inspect` (read-only) were.

## 0. The six rules, at a glance

| # | rule | primary enforcement | test |
|---|---|---|---|
| 1 | kill switch | `mcpl/outbound-guard.mjs` (`isOutboundOff`), consulted by `mcpl/speak.mjs`'s `guardRefusal`, `mcpl/redeliver.mjs`'s `redeliverRoom`, and a typing-only wrapper in `mcpl/seat.mjs` | `outbound-guard.test.mjs`: "isOutboundOff: off via the env var…", "…off via the polled file…" |
| 2 | age fence | `mcpl/outbound-guard.mjs`'s `isFrameTooOld`, consulted the same three places, plus `mcpl/relay.mjs`'s `tooOldToRelay` | `outbound-guard.test.mjs`: the three `isFrameTooOld` tests, "the exact incident shape…" |
| 3 | import-origin fence | `origin: "import"` stamped in `connectome-history-import/src/write.mjs` (`writeRoom`, `appendSlice`) and `slice.mjs` (`push`, the slice marker); checked via `mcpl/outbound-guard.mjs`'s `isImportOrigin` | `outbound-guard.test.mjs`: "isImportOrigin…"; `connectome-history-import`'s own suite (unchanged, still 20/20) |
| 4 | cursor at attach-time END | `mcpl/room-tails.mjs`'s `trackRoom` (byte size at the moment of attach, never `cursor.mjs`'s own resume-from-last-handled) | `outbound-guard.test.mjs`: "room-tails trackRoom: a fresh attach starts at the record's CURRENT byte end…" |
| 5 | budget + circuit breaker | `mcpl/outbound-guard.mjs` (token buckets + `tripped` set), `!unmute` recognized in `mcpl/seat.mjs`'s `onIncoming` | `outbound-guard.test.mjs`: the breaker/weight/`!unmute` tests |
| 6 | bot-to-bot loop fence | `connectome-house/src/dispatch.mjs`'s `decideActivation` (extended, not duplicated) | `connectome-house/test/dispatch.test.mjs`: the two new rule-6 tests |

Plus two fixes the incident review itself surfaced mid-task, folded into
rules 2 and 4 respectively rather than a new numbered rule:

- **The `message`-relay path had no per-seat ownership rule at all**
  (unlike `speech`/`media.attached`, each gated on "is this MY OWN
  being's output") — 21 seats each independently relayed the same 15
  historical human messages, 315 sends. Fixed in `mcpl/relay.mjs`
  (`isRelayOwner`, `alreadyRelayedOut`) and wired into `mcpl/seat.mjs`'s
  `onFrame`.
- **`speech`/`media.attached` had zero age guard** before this task —
  now covered because both call `speak()`/`speakMedia()` with the
  frame itself (`{frame: f}`), and `guardRefusal` checks it there.

## 1. Env names and defaults (docker-compose.yml, the `house` service only)

```
HOUSE_OUTBOUND=on                 # rule 1 — "off" (any case) mutes every seat's own send/attachment/typing call
HOUSE_OUTBOUND_MAX_AGE_MS=600000  # rule 2 — 10 minutes
HOUSE_OUTBOUND_RATE_SEAT=6        # rule 5 — sends/min, per (seat, stream)
HOUSE_OUTBOUND_RATE_BEING=30      # rule 5 — sends/min, per being (across every room it's in)
HOUSE_OUTBOUND_RATE_HOUSE=120     # rule 5 — sends/min, house-global
HOUSE_BOT_CHAIN_MAX=3             # rule 6 — consecutive being-authored activations before the chain fence trips
```

`HOUSE_OUTBOUND` is read **once, at house boot** (module load of
`mcpl/outbound-guard.mjs`) — a live flip needs the file below, not this
var. The four `HOUSE_OUTBOUND_RATE_*`/`HOUSE_OUTBOUND_MAX_AGE_MS` values
and `HOUSE_BOT_CHAIN_MAX` are also read once, at load, by design (they are
tuning constants, not something a keeper needs to flip mid-incident the
way the kill switch is).

## 2. Flipping the kill switch without a restart

`<HOUSE_PRIVATE_DIR>/outbound.off` (in compose, `/workspace/private/outbound.off`,
inside the `house-private` volume) — polled every 2 seconds by every
process that has `mcpl/outbound-guard.mjs` loaded. Presence of the file
mutes outbound, regardless of content; absence does not (it is never
consulted for content, only existence).

```
docker exec house sh -c 'touch /workspace/private/outbound.off'   # mute
docker exec house sh -c 'rm -f /workspace/private/outbound.off'   # unmute
```

Muting this way does **not** reset a tripped circuit breaker (rule 5) —
those two mechanisms are independent by design (a keeper might want to
mute everything AND separately know which specific scope tripped and why,
rather than one action clearing both signals at once).

## 3. `!unmute` — resetting a tripped breaker

Rule 5's own breaker, once tripped for a scope (`stream:<platform>:<being>:<stream>`,
`being:<handle>`, or `house`), stays tripped until a house restart or an
explicit `!unmute`. **This is not a `commands/registry.mjs` table entry**
— that file, and `mcpl/route.mjs`, are both NO-TOUCH for this task
(they own the real `!` command grammar, and an unrecognized `!x` falls
through as an ordinary chat message on Discord/web — `commands/index.mjs`
— so a table entry wouldn't even fire uniformly across platforms without
touching route.mjs too). Instead, `mcpl/seat.mjs`'s `onIncoming` recognizes
`/^!unmute\b/i` directly, before any routing — the same placement
`link.mjs`'s own `link <code>` gate already uses for the identical
reason. It is:

- **keeper-only** (checked against `HOUSE_KEEPERS`, the same allowlist
  every other keeper-gated action in this seat already reads);
- **never recorded as a room turn** — it does not call `roomInput`, does
  not activate a being, and produces no `message` frame;
- **log-only feedback** (`say(...)`, i.e. `docker logs house`/`docker logs
  being-<x>`) — it does not currently post a confirmation into the room
  itself. This is a deliberate, named scope cut (see §5) rather than an
  oversight.

Calling `unmuteAll()` (`mcpl/outbound-guard.mjs`) clears every tripped
scope, tops every token bucket back to full capacity (so sends resume at
once rather than waiting on a partial natural refill), and re-arms the
one-time trip announcement for next time.

## 4. Where each rule actually runs

**Rule 1 — kill switch.** `mcpl/outbound-guard.mjs`: `isOutboundOff()`
(env, read once, OR'd with the polled file). Consulted by:
- `mcpl/speak.mjs`'s `guardRefusal` (used by both `speak()` and
  `speakMedia()` — covers `send_message`/`reply_message`/attachments and
  the `!`-command reply lane, which bypasses `route.mjs`'s own gates
  entirely, the same reason `observe_only` is checked here too).
- `mcpl/redeliver.mjs`'s `redeliverRoom` — this path calls
  `host.callTool` directly, never through `speak()`, so it asks the guard
  independently.
- `mcpl/seat.mjs`'s `createTurns({ host: { typing: … } })` wrapper — the
  one path (typing indicators) that is neither a send nor routed through
  `speak.mjs`; `turns.mjs` itself is NO-TOUCH, so the gate is a thin host
  wrapper at the one call site that constructs it. Turning typing **off**
  always passes through, so a mute never leaves a stuck "typing…"
  indicator behind.

Each suppressed send is recorded (`recordOutbound`, `reason: "muted"`)
and announced **once per room** (`mcpl/outbound-guard.mjs`'s
`announceOnce`, keyed `muted:<roomId>`) as a house line — never
re-broadcast to the platform itself (`houseLine`'s own `by: "house"`
frames are filtered out of the relay path by `relay.mjs`'s own
`textFor`, so announcing a mute can never itself be an outbound send).

**Rule 2 — age fence.** `mcpl/outbound-guard.mjs`'s `isFrameTooOld(frameT,
attachedAt, maxAgeMs)`: refuses when the frame's own `t` predates
`attachedAt` (this seat's own attach moment to the room, stamped by
`mcpl/room-tails.mjs`'s `trackRoom`) **or** is simply older than
`maxAgeMs` right now — either condition alone is enough.
- `mcpl/seat.mjs`'s `onFrame` passes the whole frame (`{frame: f}`) into
  every `speak()`/`speakMedia()` call — this is what closes the incident's
  own §4 finding that `speech`/`media.attached` had *zero* age check
  before tonight: the check itself lives in `speak.mjs`, but every path
  through `onFrame` now feeds it.
- `mcpl/relay.mjs`'s `tooOldToRelay(f, attachedAt, windowMs = CATCHUP_MS)`
  gained the `attachedAt` parameter (default 0, so every pre-existing
  caller is unchanged) and now delegates to `isFrameTooOld` — an
  independent, earlier check on the exact same `message` path the
  incident's own §2 named as the one whose *existing* 1-hour check
  "did not stop the flood" for reasons static reading couldn't settle.
  This does not explain that mystery; it adds a second, simpler,
  differently-implemented check ahead of it, on the theory that whatever
  bug affected the first should not automatically affect the second.
- `mcpl/redeliver.mjs`'s `redeliverRoom` — independent check, see rule 1.

`HOUSE_OUTBOUND_MAX_AGE_MS` default: 10 minutes. `relay.mjs`'s own
existing `CATCHUP_MS` (1 hour, `redeliver.mjs`) is unchanged and is a
*looser*, pre-existing, differently-scoped check ("is a human's app-line
still worth relaying at all") — rule 2's harder 10-minute ceiling still
applies afterward, at `speak.mjs`, regardless.

**Rule 3 — import-origin fence.** `origin: "import"` is stamped on
*every* frame `connectome-history-import/src/write.mjs` ever writes
(`writeRoom`'s per-frame loop and its closing frame; `appendSlice`'s
per-frame loop and its closing frame — the latter redundantly, since
`slice.mjs`'s own `push()` helper already sets it on every frame it
builds, a second independent guarantee). `frame-schema.mjs`'s `base()`
sets `additionalProperties: true`, so this is schema-safe on every frame
type without touching that NO-TOUCH file. Checked via
`mcpl/outbound-guard.mjs`'s `isImportOrigin`, inside `checkOutbound` —
same call sites as rules 1/2.

**Important limitation, named honestly:** this marker only protects
frames written by a **future** run of this task's own patched
`write.mjs`/`slice.mjs`. The two rooms the incident actually touched
(`3c51ff61…`, and the still-unattached `bab97539…`) were retrofitted by
the *prior*, unpatched code and carry no such marker on disk today. Their
safety depends entirely on rule 2 (age fence) and rule 4 (cursor
hardening) below, not on this rule — confirmed directly by the
`outbound-guard.test.mjs` test that checks the *unmarked* shape.

**Rule 4 — cursor at attach-time END.** Hardened mid-task after
`24-incident-2026-09-20-cascade.md` §2/§6 confirmed the actual mechanism:
`cursor.mjs`'s own `tailOffsetFor` (NO-TOUCH) is **seq-ordered**, not
time-ordered — it resumes a seat from *its own* last-handled `seq`. For
room `3c51ff61…`, a genuine prior send had reached `seq≈12.5`; a *later*
retrofit then appended 514 frames at `seq 13.5–527.5` carrying their own
*old* `t`. Any seat resuming "from my last handled seq" saw the entire
retrofitted backlog as unhandled, however old it actually was — correct
mechanism, unsafe precondition. `mcpl/room-tails.mjs`'s `trackRoom` no
longer calls `tailOffsetFor` at all: a room's first attach in this
process now always starts at `frames.jsonl`'s own current byte size,
full stop, stamped in the same call as `attachedAt`. This trades away
"resume across a brief per-being downtime while the room kept moving" —
a real, named cost — for closing exactly the precondition the incident
exploited; `redeliver.mjs`'s own **separate** not-ready retry mechanism
(keyed off `external.jsonl`, never this offset) is unaffected and still
lets a being recover a failed *send* it already attempted.

**Rule 5 — budget + circuit breaker.** `mcpl/outbound-guard.mjs`: three
token buckets (`stream:<seatKey>`, `being:<handle>`, `house`), refilled
continuously (`capacity / 60000` tokens/ms). Exceeding any one trips
`tripped.add(scope)` for that scope only; every further call for that
scope is refused (`reason: "breaker:<scope>"`) regardless of remaining
tokens elsewhere, until `unmuteAll()`. First trip: one house line
(`mcpl/speak.mjs`'s `guardRefusal`) and one `console.error("[guard]
breaker tripped …")` line; every later suppressed send for that same
scope is recorded but silent (`announceOnce`). Attachments
(`speakMedia`) pass `weight: 2`.

**Rule 6 — bot-to-bot loop fence.** Reused, not duplicated: the existing
mention-only budget (`connectome-house/src/dispatch.mjs`'s
`decideActivation`, `room.bot_mention_streak` — incremented by
`mcpl/room-tails.mjs`'s `applyInputAction`, reset to 0 only by a human
message) gated *only* the `mention` activation reason. Extended to gate
`reply` and the `random_reply` roll too, whenever the triggering message
is being-authored (`by_kind !== "human"`) — a human's activation is
*never* chain-gated, at any reason, however high the streak reads.
`HOUSE_BOT_CHAIN_MAX` (default 3) is a **house-wide floor**: the
effective budget is `min(covenant's own bot_mention_budget ?? ∞,
HOUSE_BOT_CHAIN_MAX)`, so a looser per-room covenant setting can never
raise the ceiling past the house default — it can only tighten it
further (the existing covenant default of 1 already does).

**The relay-ownership + room-shared-ledger fix (folded into rule 2's own
file list).** `mcpl/relay.mjs`: `isRelayOwner(beings, being)` — only the
first (sorted) handle in the room's own roster ever *attempts* a
`message`-frame relay at all (the same "ties broken by roster order"
convention `dispatch.mjs`'s `pickRandomReplyLotteryWinner` already
documents, so every seat computes it identically with no coordination).
`alreadyRelayedOut(runDir, seq)` additionally checks the room's own
shared `external.jsonl` for a prior `direction: "out"` row at this exact
`seq`, from *any* seat — a real, disk-persisted, room-shared ledger, not
21 independent in-memory maps. Named residual gap: this is a
best-effort check, not a file lock; two seats racing within the same
narrow read-then-send window could still both send once each. A true
fix needs a lock (e.g. `connectome-history-import/src/room-shape.mjs`'s
own import-lock pattern) — out of this task's time budget, and, combined
with the ownership rule above, should not fire in practice (only one
seat ever even attempts it).

## 5. Known gaps, named honestly

- `!unmute` gives no in-room confirmation (§3) — log-only. Adding one
  would mean either touching `commands/registry.mjs` (NO-TOUCH) or
  inventing a second, parallel "always-open" send path in `seat.mjs`,
  which felt like more surface for this task's own time budget than the
  gap justified.
- The relay-ledger race (§4, rule 2/relay section) is real, if narrow.
- `HOUSE_BOT_CHAIN_MAX` and the four `HOUSE_OUTBOUND_*` numeric envs are
  read once at process start, matching every other env-sourced constant
  in this port (`mcpl/redeliver.mjs`'s `CATCHUP_MS`) — a keeper wanting
  to retune them mid-incident needs a restart; only the kill switch
  itself (§2) was asked to work without one.
- The still-live second retrofit payload (room `bab97539…`, 2,307
  `speech` + 909 `media.attached` frames, old `t`, unmarked) was **not
  written to** by this task (`docker start/restart` never run) — its
  safety on next boot rests entirely on rules 2 and 4 above, verified by
  `outbound-guard.test.mjs`'s own regression tests reproducing its exact
  shape, not by touching that room's own files.
