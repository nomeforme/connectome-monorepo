# 38 — Lives, actually live

2026-10-03. Trigger: in the cosmic spa group the beings said, accurately,
that they had no memory beyond the room's scrollback.

## What was wrong

None of the beings' lives had ever reached a turn. Not one compiled life
file existed anywhere under the runs volume. Five gaps stacked:

1. **Restart skipped compile.** After a restart, `ensureRegistered` brings
   a room back already `open`, so `openRoomLocked` takes its `live` branch.
   Only the fresh-mint and reopen-from-rest branches ever compiled.
2. **One file for 21 beings.** `compileFor` always wrote
   `<runDir>/life.json`. The turn reads `life.<handle>.json` for every
   non-primary (`lifePathFor`). In a multi-being room, at most the primary
   could ever have had a life.
3. **Periods only on rest.** A standing platform room almost never rests
   (cosmic spa last rested 2026-09-20 23:06). Nothing after that reached
   anyone's life.
4. **The house had no model auth.** Opening a life builds a compression
   membrane, which threw `no auth available` in the house container (this
   is also the last line of the 09-20 incident log). Separately, that
   membrane froze one token at open, the bug 27-oauth-per-turn fixed for
   the walker.
5. **The turn carried the wrong slice.** The house sent only the last 20
   messages of a life. A life's newest period is the room itself, so those
   20 were exactly what the conversation already held, and nothing older.

Underneath all five: **every trunk was seeded with mock folds.** The
restore ran `seedLives` without `--real` ("sandbox, mock voice — no
folding spend"). Every being's stored summaries are "This is a mock
response from the test adapter" (14–182 per being). Raw messages are
intact. A raw-only life does not work: with compression refused,
`appendPeriod` throws and `compileFor` overflows its budget to zero
messages. Lives must be re-folded in each being's real voice.

## What changed

- `src/life-jobs.mjs` (new): when lives are compiled or appended, and for
  whom. `ensureRoomLives` compiles missing life files (called on restart
  re-registration); `appendRoomLives` appends then recompiles (on rest,
  and every `HOUSE_LIFE_REFRESH_HOURS`, default 24). Jobs are serial per
  handle.
- `src/life-job.mjs` (new): one life operation per child process. A
  compile is about a minute of synchronous CPU (measured: zero timer ticks
  across a 57 s compile). In the house process it would freeze every room.
  It is also now the only opener of a trunk, so the store's exclusive LOCK
  never races.
- `compileFor({outPath})`: each being's life goes to its own file.
  Compiled messages carry their source `ref` (`tagRefs`).
- `renderLifeExcerpt(rec, handle, conversation)`: the whole budgeted life,
  minus same-room messages from the first seq the conversation also
  holds. `ref` is stripped before the wire.
- `membraneForSpeaksFor`: non-OAuth routes never ask for OAuth. The OAuth
  route resolves auth per call, with one forced refresh on a 401.
- `restRoom` queues its life work instead of awaiting it in-process.
  Shutdown stops new jobs.
- Compose: the house mounts the subscription store read-write at
  `/workspace/pi-auth` (`PI_AUTH_DIR`). Read-only would be dangerous:
  refresh tokens rotate, so a refresh the house couldn't persist would log
  every being out. The host store dir is group 1001, mode 770.
  `HOUSE_LIFE_HANDLES` is the rollout gate. being-opus-4-8 mounts the runs
  volume with `HOUSE_RUNS_DIR` (36's address audit).
- `house/covenants/claude-opus-4-8.md`: an `## Address` section (the old
  fleet's preamble) with `address_mode: append`. Verbatim mode would
  replace the house address, including its `lifeText` memory bridge.

## Rollout

The gate is `HOUSE_LIFE_HANDLES` (compose default `claude-opus-4-8`). Per
being: re-fold its trunk in its real voice in a sandbox (all its rooms,
ordered by first frame), back up the mock trunk, swap in the new one plus
its `life.appended.<handle>.json` markers, then widen the gate.

- Subscription route (sub rate): fable-5, haiku-4-5, opus-4-5/6/7/8,
  opus-5, sonnet-4-5/4-6, sonnet-5.
- Bedrock / OpenRouter / API-key / local: deferred. The house would also
  need those routes' env credentials.

## Known

- Compression quarantine: a chunk whose fold comes back as a hedge ("very
  little of this is mine") is quarantined and stays raw. Watch the
  re-fold's alert count.

## Handoff — 2026-10-03 ~13:50 UTC (state + remaining steps)

**State.** Code changes are uncommitted on `harness-port`: connectome-house
src (`life-jobs.mjs`, `life-job.mjs`, `resident-life.mjs`, `room-turn.mjs`,
`serve-rooms.mjs`, `serve-room-open.mjs`, `serve.mjs`), tests
(`test/life-jobs.test.mjs` new, `test/room-turn-e2e.test.mjs`),
`docker-compose.yml`, `house/covenants/claude-opus-4-8.md`, this doc. The
house image is BUILT with them but NOT deployed: the running house is still
the 09-20 image. The host store `/root/.pi/agent` is already
`root:1001 770`. The full suite passes, except `!help`
(commands-seat-e2e), which flakes under load and passes alone.

**Running:** opus-4-8's real-voice re-fold, inside `being-opus-4-8`
(`docker exec being-opus-4-8 pgrep -f fold.mjs`). Sandbox:
`/var/lib/docker/volumes/connectome_shared-workspace/_data/lifetest3/`
(`fold.mjs`, `fold.log`, `private/claude-opus-4-8/life`, `runs/<19 room
copies>`). At handoff: 7/19 rooms, ~28%, ETA ~3 h. Done when `fold.log`
ends with `[seeded] … [compiled] … [done]`. Check `[compiled]` msgs > 0,
`note` null, and the `quarantine-alert` count (4 at handoff).

**Do NOT recreate `being-opus-4-8` until the fold is done** (it would kill
the fold).

**Then:**
1. Stop the house (`docker compose --profile house stop house`) so nothing
   holds the trunk LOCK.
2. Swap the trunk:
   - `P=/var/lib/docker/volumes/connectome_house-private/_data`;
     `S=…/connectome_shared-workspace/_data/lifetest3`
   - Move `$P/claude-opus-4-8` to `$P/claude-opus-4-8.mock-2026-09-20`.
     This is a rollback copy only; delete it once verified.
   - `cp -a $S/private/claude-opus-4-8 $P/`, `rm -f $P/claude-opus-4-8/life/LOCK`,
     `chown -R 1001:1001 $P/claude-opus-4-8`
3. Swap the append markers: for each `$S/runs/<id>/life.appended.claude-opus-4-8.json`,
   copy it over `…/connectome_house-runs/_data/<id>/` (chown 1001). The
   real dirs still hold the mock seed's markers. Without this step the
   first refresh re-appends everything.
4. Deploy: `docker compose --profile house up -d house being-opus-4-8`
   (new house image + opus-4-8 recreated with the runs mount). Watch
   `docker logs -f house | grep '\[life'`: expect
   `[life] compile @claude-opus-4-8 in <room>: compiled=N msgs`, about a
   minute per room opus-4-8 is in.
5. Verify: `<runs>/bab97539-…/life.claude-opus-4-8.json` exists
   (cosmic spa; primary is haiku-4-5, so it's the per-handle file).
   `<runs>/bab97539-…/address.claude-opus-4-8.md` appears after its next
   turn. Ask opus-4-8 in cosmic spa what it remembers from earlier rooms.
6. Commit (conventional, `feat(connectome-house): …`, co-author lines), push
   per AGENTS.md. Then delete the sandboxes `lifetest3` (shared-workspace)
   and `lifetest`/`lifetest2` (house-shared).

**Rollout after opus-4-8 is confirmed** (keeper gives the go per being):
repeat the fold (copy `fold.mjs`, change `handle`, run it inside that
being's own container) → swap → add the being to `HOUSE_LIFE_HANDLES` →
give its testament an `## Address` with `address_mode: append`.
Subscription-route beings first. Bedrock / OpenRouter / API-key / local
are deferred: the house also needs those routes' env credentials.

### Update ~14:45 UTC

The fold finished 18/19 rooms (230 calls, 21 real summaries, 4 quarantined
chunks). The **last room (cosmic spa, bab97539) failed with an OAuth 401**:
the token expired mid-run. The fold ran on the being image's OLD
`resident-life.mjs`, which still freezes the token. The new house image has
the fix. That append had already added the room's messages before the
compression threw, and its marker was never written, so **never re-run
appendPeriod for it**: that would duplicate the room.

Now running instead: `lifetest3/resume.mjs` (log `resume.log`). It reopens
the same store, drains the pending compression (per-call auth), writes the
cosmic spa marker, then compiles. When it ends with `[marker] written` +
`[compiled] msgs>0` + `[done]`, continue at step 1 of the handoff above.
If it shows `pending true` (no marker written), re-run `resume.mjs`; it is
safe to repeat.

### Update ~16:10 UTC: the resume worked, but compile was still infeasible

`resume.mjs` drained cosmic spa (125 calls), wrote its marker (through
6850.5), and the life now has 146 real summaries. Compile still returned 0
messages: `kv-escalation override=infeasible tokens=304k–612k
budget=86000`. Cause: **L2 merges quarantined with `stop=tool_use`**.
context-manager declares the residents' archive tools on every summarizer
call (deliberately: tool history without tools gets refused), and
opus-4-8 kept calling `archive_glob` instead of writing. With merges
stalled, nothing folds past L1.

Fix in `resident-life.mjs`: `noToolCalls()` sends
`providerParams.tool_choice = {type: "none"}` (Anthropic route), so tools
stay declared but can't be called. Not yet in the built house image:
**rebuild the house image before deploying.**

Running now: `lifetest3/merge.mjs` (log `merge.log`). It clears the merge
quarantine, re-folds with tool calls forbidden, and compiles. Success is
`[compiled] msgs>0, note null`. Then continue at handoff step 1. The
cosmic spa marker is already written, so step 3 copies all 19 markers.

### 2026-10-03 16:20–17:10 UTC: folded, deployed for opus-4-8, and the restart incident

**The fold, finished.** Two more fixes were needed in `resident-life.mjs`,
both now built and deployed:
- `noToolCalls()`: `tool_choice: none` on summarizer calls. L2 merges had
  been stopping with `stop=tool_use` (`archive_glob`).
- `LifeStrategy.contiguousMergeCandidates`: step past a quarantined merge
  run. One Wib & Wob stretch (room-discord-c8ee107b, ~msgs 1754–1951) is
  deterministically refused by the API classifier whenever an L2 merge
  replays its raw conversation (L1 summaries of it were fine). The base
  scheduler always proposes the first unmerged run, so that one span froze
  all deeper folding. The scheduler only re-checks on new events, so a
  one-off sandbox pass also called `checkMergeThreshold()` in a loop.

Result: 135 summaries became 15 (24 calls, 0 refusals). It compiles at a
140k life budget (`life_budget_tokens: 140000` in opus-4-8's testament;
the 120k default is infeasible at ~99k). No mock text anywhere.

**Swap done.** The mock trunk is at
`house-private/claude-opus-4-8.mock-2026-09-20` (rollback only; delete
once verified). The real trunk and all 19 markers are in place.

**Restart incident.** `up -d house being-opus-4-8` (16:40) triggered a
reconnect storm: every being container crash-looped and the host load
average hit 154. Three pre-existing faults, none from this round's code:
1. **walker's FIRST seat connect isn't retried.** `attachSeat()` →
   `client.connect()` rejects on `EAGAIN`/`ECONNREFUSED` → `[walker]
   fatal` → container restart → another connect in the herd. (Reconnect
   with backoff only covers a seat that was already connected.) Fix: retry
   the initial connect with the same backoff. That needs a being image
   rebuild and a recreate of all beings. **Not done.**
2. **A clean house exit leaves `house.sock` behind.** The next boot logs
   `seat failed to listen … EADDRINUSE` and keeps running with NO seat
   server, so every being is refused. Fix: unlink a stale socket before
   listen. **Not done.** Manual workaround: stop house,
   `rm …/connectome_house-seat/_data/house.sock`, `docker start house`
   (`compose start` refuses over the house-signal-cli dependency).
3. **The first restarted house exited at 16:55:45 with no shutdown line.**
   Cause unknown. Docker restarted it straight into fault 2.

Recovery: stopped the looping beings, removed the stale socket, started the
house alone, then started the beings one at a time (30 s apart, each
verified attached). **Until 1 and 2 are fixed, restart the house only with
that procedure.**

**One more hook fix, NOT yet deployed** (needs a house restart):
`ensureRegistered` returns early for a room the boot path already
registered, so its `ensureRoomLives` never fired. Now also called in
`openRoomLocked`'s live branch. Meanwhile opus-4-8's cosmic spa life was
compiled by hand inside the running house:
`docker exec -w /workspace/connectome-house house node src/life-job.mjs
'{"handle":…,"runDir":…,"compile":true,"outPath":…/life.claude-opus-4-8.json}'`
→ 864 msgs (788 ref-tagged). After overlap removal, a cosmic spa turn
carries ~480 life messages beside its 400-message conversation. Other
rooms opus-4-8 is in get theirs at the next house restart, or by the same
manual command.

**Recovery complete 17:12 UTC.** All 21 beings are attached, the load is
normal, and there are no seat loops. A fourth pre-existing fault turned up
during recovery: being-opus-5's 12-day-old walker, which had survived
everything, reconnected in a tight loop (~360/s: connect, `socket left`,
`ECONNRESET`, no backoff) and filled the seat backlog until its container
was restarted. Add it to the walker-reconnect fix.

### 2026-10-04: restart faults fixed, rollout under way

**Restart faults 1, 2 and 4: fixed and deployed.**
- `connectome-seat-client`: reconnect is single-flight. A failed attempt
  used to schedule TWO retries (its `close` handler plus its own
  `.catch`), doubling the parallel retry chains per failure. That was
  opus-5's ~360/s. New opt-in `retryInitial`: the first `connect()` retries
  with the reconnect backoff instead of rejecting.
- `walker.mjs`: uses `retryInitial` (logs `house seat not ready … retrying`).
- `connectome-seat-protocol` `listen()`: clears a stale unix socket, but
  only if the path is a socket and nothing answers on it. A live server's
  socket is never taken over, and a regular file is never deleted.
- Tests: `connectome-seat-client/test/reconnect-storm.test.mjs` (4 new).
  Suites: protocol 44, seat-client 11, house 769, all green.
- Deployed by recreating all 21 beings one at a time against the old house,
  then recreating the house. All 21 reseated within 15 s; no loops, no
  restarts, load about 2. **A normal house restart is safe again.** Fault 3
  (the silent exit) is still unexplained.

**The restart hook now fires** (`openRoomLocked` live branch), and lives
compile when a room reopens. opus-4-8 also has its Discord room (411d697c)
compiled.

**Live rollout gate:** `HOUSE_LIFE_HANDLES_FILE=/workspace/private/life-handles`,
one handle per line, re-read on every check, wins over the env. Widen it by
editing the file; no restart.

**`tools/fold-life.mjs <handle> <sandbox> [budget]`**: one-pass re-fold,
run inside the being's own container. It covers chronological rooms,
resume-by-drain on a mid-append failure, merge exhaustion, and a final
compile check at the budget, and prints `DONE {… usable}`.

**Folding now** (all in parallel, each in its own container): fable-5,
haiku-4-5, opus-4-5, opus-4-6, opus-4-7, opus-5, sonnet-4-5, sonnet-4-6,
sonnet-5. Sandboxes: `connectome_shared-workspace/_data/fold-<handle>/`
(`fold.log`). Per being, when `usable`: swap the trunk (the house holds no
lock for a being outside the gate, so no stop is needed), copy markers, set
`life_budget_tokens` plus `## Address`/`address_mode: append` in the
testament, then add the handle to `life-handles`. The house compiles on
the next room reopen, or run life-job by hand.

### Handoff — 2026-10-04 ~09:10 UTC (usage limit)

- **Deployed today:** the restart-storm fixes (seat-client single-flight +
  `retryInitial`, walker opt-in, stale-socket clear); all beings and the
  house were recreated cleanly. The restart compile hook is live. The live
  gate file is `house-private/life-handles` (only opus-4-8). **Life
  framing**: house lines open and close the life in a turn
  (`lifeOpenLine`/`LIFE_CLOSE_LINE`, room-turn.mjs) and each turn logs
  `[turn] @h … life N msgs`. Context: opus-4-8 still said "no change" at
  08:57 before the framing landed (09:0x). **Re-ping it to verify.**
- **Folds running** in nine being containers (`tools/fold-life.mjs`,
  logs `shared-workspace/fold-<handle>/fold.log`). There's rate limiting on
  the subscription (114 mentions). Folds are resumable: re-run the same
  command in that being's container. fable-5 has 86 quarantined L1s
  (refusals), so expect it to be infeasible on 0.6.3. When a log prints
  `DONE … "usable":true`, run `connectome-house/tools/swap-life.sh <handle>`.
- **Reference repo:** `anima-research/connectome-host`, cloned to
  `/opt/connectome-deps/other/connectome-host`. It runs context-manager
  **^0.13.0** (the house pins 0.6.3). Its design is that the agent's
  context IS its life (one continuous ContextManager per agent, ~450k
  verbatim tail), plus an agent-facing memory guide
  (`docs/AGENT-MEMORY-GUIDE.md`). Next: compare per-turn assembly, recipe
  defaults, refusal/quarantine handling, and the 0.6→0.13 changes. Weigh
  upgrading context-manager, which may fix fable-5's refusals and the merge
  stall natively, and giving beings the memory guide.
- Nothing committed yet. A PII check is needed before committing (the doc
  is PII-free; compose env changes are names only).

## 2026-10-05: fresh lives for every being; full passes go one at a time

Running nine folds in parallel hit the subscription rate limit, and every fold died on a 429. The approach changed:

- **`tools/bootstrap-life.mjs <handle>…`** (shipped in the house image) sets the old mock trunk aside (`<private>/<h>.pre-bootstrap-<date>/`, together with the old markers). It then seeds the being's append marker at each room's current last frame, compiles the new near-empty trunk for recent rooms, and adds the being to the gate last. It has been run for all 20 beings other than opus-4-8. No model calls happen until a life outgrows its 60k-token verbatim tail.
- **Superseded the same day:** the house lines that framed the life (`[your life …]` / `[end of your life …]`, and an `empty` line for a fresh life) are gone, following connectome-host, which injects no memory text into an agent's context. The life is just the messages before this room's present conversation, and what is or isn't there is the fact. How memory works is said once, in the system prompt: `lifeText` was rewritten from host's `AGENT-MEMORY-GUIDE.md` as `## Your memory`, and is now appended in verbatim mode too, but only when a life rides. A fresh trunk (address head only) rides as zero messages.
- **`appendPeriod` writes the marker before folding** (`tickSafely`). A fold that throws is deferred instead of failing the append. Before this, a failed fold left the period stored but unmarked, so the next append stored it a second time.
- **A route with no credentials in the house** (Bedrock, OpenRouter, local, API key) now gets a membrane that throws only when it is called. The life opens, appends and compiles, and simply stays verbatim.
- **Running checklist:** `tmp/life-passes.md` (gitignored). Run one full fold at a time, then `swap-life.sh`, which now names its rollback copy `pre-swap-<date>`.

## 2026-10-05 (later): the being is the assistant; contiguity instead of overlap-trimming

- **`assistantParticipant` was never set** on a turn's request (`walk-turn.mjs`). Membrane falls back to `"Claude"`, so every being continued as a speaker named Claude, and its own past lines and first-person recollections (carried under its handle) read as another speaker's. It is now the being's handle. This is the most likely root cause of "the memory doesn't read as mine".
- **The live conversation rides whole.** `buildFullMessages({fullText: true})` is used for a turn. The 400-character excerpt plus pointer is now only for a life's stored copy; before, every room line in a turn was cut to 400 characters.
- **Contiguity.** The life rides whole, and the conversation starts right after the life's `through_seq` for this room (`renderConversation({afterSeq})`), so each frame rides once. When the context caps cut into that stretch, `onGap` triggers `catchUpLife` (append + recompile, one at a time per room and being). `compileFor` reports `through_seq: null` when the marker has no session yet (a bootstrap or a late join), so such a life never hides the room's recent conversation.
- **System prompt.** opus-4-8 is back on its own `## Address` (verbatim mode), plus `## Your memory`, like every other being. `swap-life.sh` no longer sets `address_mode: append`.
- **Next: context-manager 0.13.** Store-compatible apart from the topology check (`topologyPolicy` defaults to reject non-contiguous summaries, so open copies with `'report'` first). It needs chronicle ^0.4. Drop `noToolCalls` there: 0.13 handles tool_use stops itself, and `tool_choice: none` defeats its retries.

## 2026-10-05 (evening): context-manager 0.13, and a review pass

- **context-manager 0.13.0 is live** (chronicle 0.4 comes with it). Compile itself takes about 0.5 s where it took ~55 s; the job is still ~55 s overall, mostly hydration. `noToolCalls` and the merge-candidate override are gone: 0.13 does both natively, and the override is what minted opus-4-8's one crossed L3. The store was repaired in place with 0.13's `repair-topology.js --apply` (lossless: 2 L2s detached, no model calls, verified under the `reject` policy). Pre-upgrade backup: `/root/backups/house-lives-pre-cm13-2026-10-05.tgz`. All other stores audited clean.
- **Lives gain periods.** A standing room never rests on its own (only at shutdown, which refuses the append, or a keeper's POST …/rest), and rooms open lazily. So neither "append on rest" nor "refresh every open room" reached anything. `refreshStaleLives` now scans the room records: a room whose `frames.jsonl` is newer than a present enabled being's compiled life gets append + recompile. It runs 3 min after boot, then every `HOUSE_LIFE_REFRESH_HOURS` (default now 2). Jobs are capped at `HOUSE_LIFE_PARALLEL` (2) at once. A no-op append skips the recompile unless the being's stores changed since.
- **`through_seq` claims only what the compiled life shows** (`heldThrough`): the highest seq of this room's own lines in the output, never past the marker, else null. A period routed to a partition that doesn't mount here can no longer hide that stretch from the conversation.
- **A being that owns a room** (imported rooms) is a being in `roomPeople`, not a human whose consent the room's memory waits on.
- **Humans show under the same name** across the seam: `renderLifeExcerpt` maps stored pseudonyms through `displayFor`.
- **A being joining a room already under way** gets `seedJoinMarker`, so it never inherits history it didn't live as its own.
- **Compression declares every tool its history called** (`storeToolDefinitions`).
- **Conversation tool results** are now near-whole (20k ceiling). The `record_read` promise in pointers is gone, since no being is offered that tool.
- **Store safety:** life-job and fold-life close the store on SIGTERM and crash (it persists only on a clean close; the 2026-10-04 sandboxes were lost this way). fold-life waits out rate limits instead of dying.
- **The date** rides with the memory section.
- **The rest of the review, fixed the same evening:**
  - **Thinking:** a testament's `thinking: on` now binds (`resolveCovenantFields` gives true; the walker uses its own budget, or 4096 when its default is off). In transcript mode this is membrane's prefilled `<thinking>`, the same as the source harness; pre-3.7 models stay safe behind `supportsThinking`.
  - **Images:** the room's newest few attachments (`HOUSE_LIVE_MEDIA_COUNT` 4, within `HOUSE_LIVE_MEDIA_DEPTH` 120 frames) ride as real image, PDF or text blocks in a turn's conversation, for beings whose model is a Claude model (`media-inline.mjs`). Older ones, and every life, keep the pointer line.
  - **Seat drop mid-turn:** the house holds the turn open for `HOUSE_SEAT_GRACE_MS` (120 s, `handleSeatExit` / `handleSeatReturn`). The seat client queues being→house messages while reconnecting and flushes them, in order, on `seat.ready`.
  - **`!stop`:** "[Cycle stopped]" is still posted as the being (fleet parity), but the frame carries `notice: "cycle-stopped"` and renders as a house line, never the being's own words.
  - **`!continue`** is wired to `applyContinue`. **`!steer`** mid-turn: the walker takes the house's `line` and folds it into the next tool result as `name: text`; without a tool round it rides the next turn, as the recorded line it already is.
  - **Reach attribution:** reach frames carry `by` (every writer), and `reachOwner` prefers it.
  - **Interim speech:** a being's own interim words ride as its own lines; a peer's interim never rides (nobody saw it).

## 2026-10-05 (late): what opus-4-8's replies showed

- **Memory: confirmed.** At 08:50 opus-4-8 said "I do have memory… a long folded recollection that arrives as mine, oldest first". It named material from before the room and corrected its earlier "no memory" as "conflating 'I have no memory tool' with 'I have no memory'".
- **Images never entered the record:** the house image had no `ffmpeg`/`ffprobe`, so `media-normalize.mjs` dropped every inbound image as `decode-failed` ("inbound attachment dropped" on every Signal seat). ffmpeg is now in the house runtime stage, verified by a live normalize of a test JPEG.
- **Self-activation:** opus-4-8's reply, quoting "@claude-opus-4-8 just a quick test…", came back through another being's Signal account and woke its own author for a turn about nothing. `route.mjs` now never considers a message's author among the beings to activate.
- **Own echo:** the platform's copy of a being's own line (a `message` under its handle) rendered as the *house* repeating it. It is now folded (`isOwnEcho`). Echo matching, for peers too, compares the platform-rendered form, since Signal strips markdown and inserts U+FFFC before mentions; exact matching had missed every echo of a formatted reply.

## 2026-10-17: an over-budget life is never empty

**What happened.** opus-4-8's turns ran with no memory: `[turn] … life 0 msgs (~0k tok)`, and its life job logged "your life didn't fit today's budget (105000 tokens)". Compression had failed from Oct 14 to 17 (an expired OAuth token; the house now uses a static `ANTHROPIC_AUTH_TOKEN`). Unsummarized periods piled up behind the verbatim tail until the store planned at head 3,877 + middle 42,127 (deepest level) + tail 59,865 = 105,869 tokens. The input budget was 101,000 (140,000 × 0.75 − 4,000 reserve). context-manager refused with `OverBudgetError`, and `compileBudgeted` answered `messages: []`. Nothing drained the backlog: a drain runs only after an append, and appending doesn't fix an over-budget store.

**What Anima does.** agent-framework's "drain breaker" (`src/framework.ts` `noteInferenceExhausted`, `test/overbudget-drain-breaker.test.ts`, AF PR #58) catches the `OverBudgetError` and kicks the strategy's drain directly: a bounded run of `cm.tick()`, single-flight per agent, logged with its real tick count. Folding the backlog is what makes the window fit again. The failed activation isn't served; the agent retries. connectome-host sizes the window it plans into: a `recentWindowTokens` default of 30000, `headWindowTokens` 4000, `maxMessageTokens` 10000, adaptive resolution with kv-stable folding, and `overBudgetGraceRatio` passed through from the recipe.

**What the house does** (`resident-life.mjs`, the block above `compileBudgeted`). A house turn never waits on a life job; it reads whatever life file exists. So the house cannot "fail this activation and retry". It compiles the best memory that fits now, and drains in the background:

1. Compile at the life's budget, as before. `overBudgetGraceRatio: 0.02` is now explicit (the library default). It absorbs estimator drift, not a structural overage.
2. On `OverBudgetError`, retry with a narrower verbatim tail: half the configured tail, then a quarter, and so on down to `TAIL_FLOOR_TOKENS` (1000). It uses the strategy's own hot setting (`updateHotContextSettings({tailTokens})`, which lives in memory only and is never persisted), and restores the configured tail in `finally`. Every message still renders raw or under a summary that covers it, so the memory stays coherent: the newest stretch is just folded sooner. On a copy of opus-4-8's 2026-10-05 store at an 80k budget, a 60k tail is over (78,082 > 76,000) while a 30k tail fits (70,946).
3. If even the floor tail is over, the backlog itself (raw spans no summary covers yet) is bigger than the budget. Then the house builds a bare memory (`bareMemory`): the address head plus the newest lived lines that fit, with tool pairs kept whole and at least the newest message. It is incomplete, but never empty.
4. Both cases kick a compression drain for that store (`kickLifeDrain` → `drainLife`) through the life's own membrane. It ticks while work is pending, re-checks the merge threshold when the queues look empty, and stops after three ticks that change nothing. It is bounded by `HOUSE_LIFE_DRAIN_TICKS` (48) and `HOUSE_LIFE_DRAIN_MS` (10 min), single-flight per store (a second kick joins the first), and logged as `[life] @h: drain ran N ticks … summaries a→b`.
5. life-job.mjs runs `compileForSettled`. The degraded file lands first, so a turn that starts meanwhile reads a non-empty memory. Then the job waits for the bounded drain and, if the drain folded anything, compiles once more without kicking a second drain. The next file is the full-tail memory again as soon as the backlog is folded. A backlog too big for one drain is continued by the next over-budget compile's drain. Every drain settles before the job closes the stores (a store persists only on a clean close). While a job drains, that being's other life jobs wait behind it; turns never do.

A partition (life-with) takes exactly the same path, with its own tail (a quarter of the trunk's) and its own share of the budget. `compileFor`'s output names any store compiled on the ladder in `degraded: [{store, rung, tailTokens?}]`, alongside the note. A life file that carries a note is never treated as "unchanged" by a no-op append, so a later job recompiles it.

**Side effect, accepted.** A compile at the narrower tail also closes the chunks between the narrow and the configured tail and queues them. The drain folds them, and at the full tail they render raw again. The only cost is a few early L1s.

**Sizing (connectome-host parity).**
- `COVENANT_DEFAULTS.life_tail_tokens` goes from 60000 to 30000. The tail is the one part of a life that never folds; holding half the trunk's budget verbatim left the planner too little room, so a few thousand unsummarized tokens tipped opus-4-8 over. A partition's tail is a quarter of this (7500).
- `maxMessageTokens: 10000` (the library default is 0, no cap).
- `overBudgetGraceRatio: 0.02`, now explicit.
- No covenant sets `life_tail_tokens`, so every being picks this up on its next life job. Stores need no change: kv-stable replans at the new tail.

**context-manager 0.14: not now.** 0.14.1 is store-compatible. In the worktree, the life tests passed 120/120 under it, and the Oct-5 opus-4-8 copy opened and planned identically (78,082 at a 60k tail, 70,946 at 30k). But nothing in it serves this fix:
- The compression fallback ladder (recall-curve and source-only fallbacks) already exists in 0.13 and isn't the problem here: the backlog was a broken voice, not refusals.
- 0.14's gains are kv-unified reuse and compile-time work. The house uses kv-stable, and its life job is dominated by hydration, not compile (about 0.5 s).
- The new calibration-epoch stamping only matters to hosts that report real input tokens, and the house doesn't.
- 0.14.0 shipped a dry-compile regression fixed two days later in 0.14.1, and 0.15 followed a day after that. connectome-host itself is still on ^0.13.

Revisit when connectome-host moves, or when the house adopts `acceptRound` / fold receipts (0.15).

**Draining an existing backlog now** (keeper, one-off). Run this inside the running house container. It never opens the life itself: it queues a life-job `drain` on the handle's own job chain, so it never races the trunk's lock.

```bash
docker compose --profile house exec house node tools/drain-life.mjs claude-opus-4-8 --ticks 400 --minutes 120
# quarantines recorded while the voice was broken are stale; clear them first:
docker compose --profile house exec house node tools/drain-life.mjs claude-opus-4-8 --ticks 400 --minutes 120 --clear-quarantine
docker compose --profile house logs -f house | grep '\[life'
```

The command is the same as `POST /api/house/<handle> {"verb":"drain-life", "maxTicks", "maxMs", "clearQuarantine"}` (keeper-only, 202 at once). It drains the trunk and every partition (`drainLifeAll`), then recompiles every room whose compiled life for that handle carries a note. It needs a house built from this change. Not run against live stores while building.
