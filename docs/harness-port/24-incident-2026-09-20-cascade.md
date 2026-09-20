# 24 — Incident 2026-09-20: the retrofit-replay cascade

Read-only incident analysis, `harness-port` HEAD `15a11d0` (parents include
`cb26d6c` history-import retrofit-as-a-flag, `d91baa4` C3-all being-hosted
seats). No message text, phone numbers, platform group ids, or human user
ids appear below — only counts, room ids (uuids), timestamps, frame types,
and seat/being names.

## 0. What happened, in one paragraph

Tonight's switch-over ran the full archive restore (`connectome-history-import`,
00:29:02–~00:54, 281 rooms) and, because 3 rooms were already live-minted
(pre-existing, in-use rooms), skipped them there and retrofitted them
separately (`--retrofit-only`, two passes: 00:32:08 and 00:35:15, the
second run concurrently with the live house). The retrofit appended
hundreds to thousands of historical frames — `speech`, `message`,
`media.attached` — to each room's `frames.jsonl`, correctly carrying
their *original* timestamps, but at *new*, monotonically-increasing
`seq` numbers that land **after** whatever `seq` the room's live,
pre-retrofit conversation had last reached. When the house's 21
being-seats were registered onto one of those rooms at 00:49:09 (16.5
minutes after house start, once the fleet's own being-hosted config
finished loading), each seat computed its tail cursor from the highest
`seq` it had ever spoken to (`cursor.mjs`'s `tailOffsetFor`) — a cursor
that, for this room, sat *before* the entire retrofitted backlog. The
seats' `startupSweep` then drained that whole backlog through
`onFrame` (`connectome-house/src/mcpl/seat.mjs`) in one burst. Two of
`onFrame`'s three outbound branches (`speech`, `media.attached`) carry
**no check at all** on a frame's own age; the third (`message`) has an
age check (`tooOldToRelay`, 1-hour window) that, empirically, did not
stop the flood either (§4). The result: 554 outbound send attempts to
one Signal room in under 90 seconds, 21-way duplicated for at least one
class of frame, most timing out against the shared platform transport
under the concurrent load — the "ping cascade" the keeper stopped by
hand at 00:50:32.

## 1. Timeline

| t (UTC) | event |
|---|---|
| 00:29:02 | `connectome-history-import` full restore starts (report: `restore-all.md`, wall 1520.3s); 281 rooms, 36,978 frames written; 3 already-live rooms explicitly skipped (`3c51ff61…`, `411d697c…`, `bab97539…`) |
| 00:32:08 | Retrofit pass 1 (`--retrofit-only`, report `retrofit-all.md`, wall 82.3s) appends the skipped rooms' history: `3c51ff61…` gets 514 frames (seq 13.5–527.5); `bab97539…` gets 6,818 frames (seq 5.998–6823.998); `411d697c…` left mid-turn, not retrofitted this pass |
| 00:32:28 | `house` container starts (image built 00:13:33, same source tree); by 00:32:39 all 42 seats' MCPL children report ready. Beings are NOT yet tracking the 3 pre-existing rooms |
| 00:35:15 | Retrofit pass 2 starts in a second container (`ecstatic_cohen` — an untracked, non-compose name; report `retrofit-all-2.md`), re-targeting all 3 rooms while `house` is already live, to catch `411d697c…` |
| 00:47:45 | `411d697c…` (Discord) becomes fully retrofitted; all 21 beings register as participants at once. A real, live human message arrives in the same minute and is answered normally (single replies from the addressed beings) — **not part of the cascade** (see §2, ruled out) |
| 00:49:09.369 | All 21 beings' covenants default for `3c51ff61…` (Signal) — the moment every seat first calls `trackRoom`/`ensureLive` on this room. Cursors compute to a point before the entire 514-frame retrofit backlog |
| 00:49:09.520–00:49:10.4 | First "spoke in … not carried" cross-seat notices (own-being guard correctly refusing to carry other beings' frames) |
| 00:49:11.743 | **First outbound send of the incident** (see §3, Q1) |
| 00:49:10.978–00:50:17 | 4 "typing on"/"typing off" pairs logged (of the 21 seats) |
| 00:49:15–00:49:28 | Bulk of the 554 send attempts fire; shared Signal transport starts timing out under 21-way concurrent load; 907 "inbound attachment dropped (decode-failed)" notices accumulate (generic inbound image-decode failures, `media-normalize.mjs:114`, not a cascade-specific signal) |
| 00:49:20.6+ | First **genuinely new** (non-replayed) speech frames appear — `t` matches the live incident clock, authored by several beings — a small secondary wave of real LLM turns riding the activated room (§2) |
| 00:50:31.977–00:50:32.788 | SIGTERM reaches every being container and `house` (clean exit 0, no OOM) — the keeper's stop. Final lines are `[life] appendPeriod failed … no auth available`, the shutdown racing a last memory flush |
| now | `house` and all 21 `being-*` containers Exited(0); the prior 19-bot fleet (`bot-*`) had stopped ~23 min earlier, at the original switch-over; `ecstatic_cohen` (retrofit pass 2) is still `Up …(unhealthy)` — untouched by the stop, a loose end for the keeper |

## 2. The mechanism

**Q1 — first outbound send.** `2026-09-20T00:49:11.743Z`, seat
`signal-haiku-4-5` (being `claude-haiku-4-5`), room `3c51ff61…`, frame
`seq 153`, type `speech`, own `t` = `2026-06-16T23:50:35.103Z` —
**retrofitted**, not live (roughly three months old at send time, inside
the retrofit's 13.5–527.5 seq range). Two more `speech` frames from the
same being (`seq 141`, `seq 151`, also June 16) and one from
`claude-3-sonnet` (`seq 95`, `2026-05-09`) went out in the same
sub-100ms burst.

**Q2 — the mechanism, confirmed against source and the on-disk record:**

- `cursor.mjs`'s `tailOffsetFor(runDir)` derives a seat's tail-start
  purely from `lastHandledSeq` — the highest `seq` among `direction:"out"`
  rows already in `external.jsonl` — never from wall-clock time. For
  `3c51ff61…`, real pre-retrofit traffic had only reached `seq ≈12.5`
  (a handful of genuine sends on 2026-09-19, 16:46–23:32, all
  `delivered:true`). The retrofit then appended content at
  `seq 13.5–527.5` — numerically *after* that point, regardless of the
  frames' own (much older) `t`. Any seat computing its cursor *after*
  the retrofit landed sees the entire backlog as unhandled.
- That computation only happens once, at `trackRoom()` (`room-tails.mjs:60-64`),
  called from `ensureLive`/seat `start()`. The 21 beings did not call it
  for this room until 00:49:09 — 16.5 minutes after both retrofit passes
  had already written their frames — so the whole backlog was still
  sitting unhandled when all 21 seats attached in the same instant,
  turning a should-have-been-staggered replay into one simultaneous burst.
- `seat.mjs`'s `onFrame` (lines ~340-400) has three outbound branches:
  `message` (checks `tooOldToRelay` first — a 1-hour window,
  `relay.mjs:34-38`), `media.attached` (**no age check**, only an
  own-being check for `requested_by:"model"` and a best-effort echo-mark
  for `requested_by:"human"`), and `speech` (**no age check**, only an
  own-being check: `f.by !== cfg.being`). The own-being check is why the
  "not carried" lines exist and why no being ever spoke *another*
  being's retrofitted lines — that guard held. Nothing gates a being
  replaying its *own* old lines, or a human's old attachment going back
  out, by age.
- The `message`/relay path additionally has **no own-participant
  restriction at all** — any seat currently tracking the room may relay
  any `message`-type frame out, gated only by `relay.textFor`'s
  in-memory, per-seat `matchesInboundRow` dedupe (text-hash or a 5-second
  fallback window) and `tooOldToRelay`. On disk, 15 distinct historical
  `message` frames from the room's one human participant (dated 2026-05-21
  through 2026-07-04 — well outside the 1-hour window) were each relayed
  by **all 21 seats independently** (21 × 15 = 315 outbound rows,
  confirmed by exact per-seq counts in `external.jsonl`), each also
  carrying a `media.attached` companion frame resent the same way. Why
  `tooOldToRelay` did not block these specific frames could not be
  settled by static reading alone — the code as checked out (unchanged
  since the single porting commit `f4b72b7`, matching the running
  image's build time) should reject anything this old; the on-disk
  record shows it plainly did not. Naming this an open, unresolved
  question rather than a guessed answer.
- Did replayed sends loop back as fresh inbound and activate other
  beings? Partially, and mostly safely: 3,262 `in resident:… → …`
  decisions were logged across all seats (each seat independently
  evaluating the same inbound traffic); all but 2 resolved `"none"` for
  every being. The 2 exceptions were the resident-to-resident
  random-reply lottery (`dispatch.random_reply`) firing once each in
  `3c51ff61…`, producing the handful of genuinely-new speech frames seen
  from `2026-09-20T00:49:20.6` onward (`seq >528.5`, authored by several
  different beings) — a small secondary wave of real generations riding
  the flood, not the bulk of it.
- `411d697c…` (Discord) is **ruled out** of the cascade: its 19 outbound
  rows all answer a live human message with the current day's `t`
  (`2026-09-20T00:47:45`–`00:49:37`), single replies from the addressed
  beings only — ordinary, correct operation coinciding in time with that
  room's own mass participant-registration event, not a replay. Its
  retrofit range must have already been behind that room's live
  `lastHandledSeq` by the time all seats attached, so the bug's precondition
  (cursor lands before the backlog) never held there.
- What stopped it: a clean SIGTERM to every being container and `house`
  (exit 0, no OOM) at 00:50:31–32 — the keeper's stop, not a guard or a
  crash.

## 3. Counts

**Room `3c51ff61…` (Signal, the flooded room) — the whole cascade:**

| | |
|---|---|
| frames.jsonl / external.jsonl | 797 / 1,272 lines |
| retrofit payload (pass 1) | 514 frames, seq 13.5–527.5: 234 `speech`, 213 `message`, 41 `media.attached`, 16 `participant.joined`, 10 `hidden`, 1 `rested` |
| pre-incident live sends (2026-09-19, legitimate) | ~10, all `delivered:true` |
| incident outbound attempts (all in the 00:49 minute) | 554: 468 `delivered:false` (reason `error`, RPC/`platform.call` timeout at 15,000ms), 86 `delivered:true` |
| outbound-by-being (own `speech`, no 21-way duplication) | plantoid 63, claude-sonnet-4-5 31, claude-opus-4-6 30, claude-opus-4-7 24, claude-fable-5 18, claude-sonnet-4-6 17, claude-opus-4-5 14, claude-3-6-sonnet 12, claude-haiku-4-5 11, claude-3-sonnet 9, claude-sonnet-5 5, claude-opus-4 5, claude-3-opus 5, claude-3-5-sonnet 3, claude-opus-4-1 1, claude-3-7-sonnet 1 (Σ 249) |
| outbound attributed to the room's one human participant | 315 (15 distinct historical frames × 21 seats each) |
| turns/typing starts logged | 4 `typing on`/`off` pairs (of 21 seats) |
| inbound-attachment decode failures | 907 (generic, not cascade-specific) |

**Room `411d697c…` (Discord) — ruled out, for scale:** 19 outbound rows
total, all `delivered:true`, all answering live 2026-09-20 human
messages, spread `00:47:45`–`00:49:37`; 138 `activates` decisions
logged fleet-wide (mostly this room, mostly the same live human message
evaluated redundantly by every present seat, actioned once by the
addressed being each time).

**Room `bab97539…` (Signal, second group) — the averted risk:**
6,833 frames (3,440 `message`, **2,307 `speech`**, **909 `media.attached`**,
67 `edited`, 53 `participant.joined`, 28 `retracted`, 22 `hidden`);
5,747 external.jsonl rows, **zero** `direction:"out"` rows recorded — no
seat had attached to this room before the stop. Its retrofit payload
(6,818 frames, roughly 4–13× the size of what actually cascaded in
`3c51ff61…`) is untouched and carries the identical precondition. This
is the most urgent open risk: it will replay on first attach unless
fixed first.

## 4. Guards: which held, which didn't

| guard | held? | why |
|---|---|---|
| own-being check on `speech`/`media.attached(model)` (`seat.mjs` `onFrame`) | **Held** | Every cross-being frame produced a "not carried" notice instead of a send; no being ever spoke another's lines |
| `dispatch.random_reply` / `bot_mention_budget` lottery (ported from the fleet, `resident-covenant.mjs`, default budget 1) | **Held, almost entirely** | 3,260 of 3,262 inbound-resident evaluations resolved to no activation; only 2 random hits, both in the flooded room |
| `tooOldToRelay` (`relay.mjs:34`, `message` frames only, 1-hour window) | **Did not hold** | 15 historical `message` frames (2–4 months old) were relayed anyway, 21-fold; code reads as if it should block them — behavior says otherwise; not resolved by static reading (§2) |
| own-participant restriction on the `message`/relay path | **Does not exist** | Unlike `speech`, no seat-exclusivity check gates who may relay a `message` frame — this is what turned 15 old messages into 315 sends |
| age check on `speech` / `media.attached` frames | **Does not exist** | Neither branch reads a frame's own `t` at all |
| cursor / cut-off between "already handled" and "newly imported" | **Does not exist** | `tailOffsetFor` uses `seq` order only; a retrofit inserted after a room's live point is indistinguishable from new live activity |
| per-seat outbound rate limit / circuit breaker | **Does not exist** | 21 seats hammered one shared Signal transport concurrently until it started timing out; nothing throttled or paused the drain loop on repeated failures |
| typing-state guard | **N/A here** | Only 4 typing events fired total; not a factor in the volume |

## 5. What the old fleet had that this port lacks

- **`MessageConsistencyChecker`** (`signal-axon/src/grpc/components/message-consistency-checker.ts`):
  a per-message tracker (keyed by message id) recording which bots
  received a group message, re-injecting it for any bot that missed it.
  Solves the *opposite* problem (a message a live bot should have seen
  but didn't) — but its existence shows the old fleet already had an
  explicit, shared, per-message delivery ledger across bots sharing a
  room. The new house has no room-shared equivalent: each seat's
  `relay.mjs` dedupe state (`marks`, `consumedRows`) is process-local, so
  21 seats independently re-derive "have I already sent this" with no
  shared ledger — a structural reason the same `message` frame could be
  relayed 21 times.
- **`bot_mention_budget`** — ported and present (`dispatch.mjs:122`,
  `resident-covenant.mjs:65`, default `1`) and, per §4, it worked.
- VEIL's "recorded but never re-emitted" property (the append-only
  history store never itself re-drives platform sends) is exactly what
  the retrofit importer preserves on the *read* side — `write.mjs`/`slice.mjs`
  write frames with their original `t`, never touch `external.jsonl`'s
  own dedupe rows retroactively as "already spoken." The gap is on the
  *consumption* side: nothing in the live house re-asserts that same
  property when a room's `frames.jsonl` is bulk-appended to out from
  under a seat that is about to attach.

## 6. Guardrails, ranked

1. **A frame is never spoken or relayed if its own `t` predates the
   seat's attach time to that room** (`seat.mjs` `onFrame`, all three
   outbound branches — `speech`, `media.attached`, `message`). This is
   the single highest-leverage fix: it would have silently no-op'd the
   entire `3c51ff61…` backlog regardless of cursor math.
2. **An imported or retrofitted frame is never outbound-eligible**,
   full stop — tag it at write time (`connectome-history-import/src/write.mjs`
   / `slice.mjs`, which already tag `retrofit: true` on the room's
   `class.json.imported`) and have `onFrame` refuse to speak/relay any
   frame carrying that mark, independent of age or cursor position.
3. **A newly-tracked room's cursor starts at the record's END, not at
   `lastHandledSeq`'s position in a possibly-since-rewritten file**
   (`cursor.mjs` `tailOffsetFor` / `room-tails.mjs` `trackRoom`) — or, at
   minimum, `tailOffsetFor` should refuse to resolve to an offset that
   predates a `class.json.imported.slices[].exported_t` newer than the
   room's own last real activity.
4. **A room-shared, not per-seat, relay ledger** for the `message` path
   (closing the gap in §5) — one record of "this exact frame has already
   gone to the platform," visible to every seat in the room, not 21
   independent in-memory maps.
5. **A per-seat outbound budget with a circuit breaker**: N sends (or N
   consecutive `not delivered`) per room per minute, then stop and flag
   for the keeper — would have capped this at a fraction of 554 attempts
   regardless of the other fixes.
6. **A global kill switch env** (checked once, cheaply, at the top of
   `onFrame` and `redeliverOne`) — the keeper's actual recourse tonight
   was a container-level SIGTERM; a faster, narrower stop (mute all
   outbound, keep recording) would have preserved more forensic signal
   and cost less mid-flood.
7. Retire the untracked-name pattern for retrofit runs (`ecstatic_cohen`)
   — run these through the same compose/name discipline as `house`, so
   a `docker ps` after an incident doesn't need forensic reconstruction
   to notice a second process was ever writing into the same live
   volumes.

## Sources

`docker logs -t house`, `docker logs -t ecstatic_cohen`, `docker logs -t
being-plantoid`; `docker inspect house|ecstatic_cohen`; `/var/lib/docker/volumes/connectome_house-runs/_data/{3c51ff61-0e2b-46bc-a77e-6f0155981e0f,411d697c-56bf-45cb-87c6-adc5d9c18d4b,bab97539-8c4f-4d8d-8c8b-75bdd4cd4cef}/{frames.jsonl,external.jsonl,class.json}`;
`/var/lib/docker/volumes/connectome_house-private/_data/{restore-all.md,retrofit-all.md,retrofit-all-2.md}`;
`connectome-house/src/mcpl/{seat.mjs,seat-bus.mjs,cursor.mjs,room-tails.mjs,relay.mjs,redeliver.mjs,sweep.mjs}`;
`connectome-history-import/src/{write.mjs,slice.mjs}`;
`signal-axon/src/grpc/components/message-consistency-checker.ts`;
`docs/harness-port/10-status.md`, `21-restore-rehearsal.md`.
