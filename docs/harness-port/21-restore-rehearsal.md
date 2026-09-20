# 21 — Restore rehearsal: landing the importer under a house that already has live rooms

Written by builder C2-restore, 2026-09-20, on `harness-port` (HEAD at start
`6a46824`). Answers the one question `10-status.md`'s "still the keeper's"
list has carried since 2026-09-18: can `connectome-history-import` run
*after* the house already has live-minted rooms, without minting a
duplicate or losing anything? Cites `04-history-restore.md` §3 (K3/K4) and
§6 (cutover order), and `connectome-history-import/README.md`'s own "K3 /
K4 — already decided, not flags" section.

No real content (no ids, handles, message text, or platform identifiers)
appears anywhere below — only counts, and this run's own throwaway
identity-map entry count.

## 0. Setup

A `mktemp -d` sandbox: `runs/` = a copy of the live house's own room
directory (a 6-room snapshot kept for this purpose, read-only input,
copied before any write, never touched in place); `private/` and `blobs/`
started fresh (deliberately — see §4). `HOUSE_IDENTITY_SALT=rehearsal-throwaway`
(a value that must never be reused for anything real — see §3). The
importer's ordinary WRITE path (no `--dry-run`), never `--real` (every
output root was a sandbox path, not the house's own), against the real,
read-only VEIL state volume, with `--beings` pointed at the fleet's own
being registry.

Of the 6 live rooms: 3 are real platform rooms with present beings (one
Discord room shared by three beings, two Signal groups each with one
being); 2 are `platform: "test"` fixture rooms from the container proof
(09), never matchable against any real VEIL stream; 1 is a Discord room
whose `class.json.room.stream` is `null` — flagged in §5, not this
importer's doing.

## 1. Numbers

Dry run, the whole archive (baseline, matches `10-status.md`'s
2026-09-18 restore numbers): 10,322 buckets, 1,011,438 frames read
(356,212 unique, 655,226 duplicates) in ~55s, 284 streams.

Real write, scoped per stream (`--streams`) to each of the 3 real live
rooms in turn, against the sandbox that already held the 6-room copy:

| target | result |
|---|---|
| the shared Discord room (3 beings) | `0 rooms written, 1 skipped`; 3 lives seeded |
| Signal group A (1 being) | `0 rooms written, 1 skipped`; 1 life seeded |
| Signal group B (1 being) | `0 rooms written, 1 skipped`; 1 life seeded |

Every run: found via the same platform+stream key, correctly refused to
mint a duplicate — but, as shipped at HEAD `6a46824`, also refused to
append anything (see §2). After all three runs, the sandbox's fresh
`private/identity-map.json` held **92 entries** (see §3).

## 2. (a) and (b): found and skipped, never a duplicate, never rewritten — but not appended either

**(a)** For all 3 real live rooms, the bulk sweep (`cli.mjs`) FOUND the
existing room by the same platform+stream key (its own `existingRooms`
scan at HEAD `6a46824`, matching `identity.streamKey(g.stream)` against
each room's own `class.json.room.stream`) and reported it **skipped** —
never minted a second room for the same stream. But because none of the 3
carried an `imported` field (they were born live, never touched by this
importer before), the skip's own reason string read "on disk through seq
null, source now at <n> — not appended (see slice.mjs)": the older VEIL
history was correctly *never duplicated*, but also never *brought in* —
`slice.mjs`'s own `sliceRoom`, the tool the skip message points at, flatly
refused any room with no `imported` field ("not an imported room") — the
exact shape of a room the house itself minted live. This was the gap; §6
is the fix.

The 4th (anomaly) room — `platform: discord`, `room.stream: null` — cannot
be found by any import: no VEIL stream key is ever `null`. Not this
importer's bug; worth the keeper's own look at why that room was minted
without a stream on it.

**(b)** Yes — fully intact. `frames.jsonl` sha256 and a full byte
comparison of `class.json`, taken before and after every one of the 3 real
runs above, are identical: the skip path (before this task's fix) performs
zero writes into an already-found room. K4's own promise ("a late slice is
accepted, never re-ordered... nothing already on disk is ever rewritten")
held throughout, including the pre-fix skip-only behavior; §6's fix
preserves this exactly (append-only; the room's live frames are never
touched, only frames added strictly after them).

## 3. (c): bot handles agree by construction; human handles do NOT, and must not be made to by fiat

Bot identity (`identity.mjs`'s `bot()`) is a deterministic slug of the
model name — salt-independent. Confirmed directly: the rehearsal's own
life-seeding step, run with the throwaway salt, addressed each present
being by exactly the same handle already present in that live room's own
`beings` list (the 3-being Discord room's three handles, the two Signal
groups' one handle each) — no divergence, because none is possible for a
bot handle.

Human identity (`identityFor` in `connectome-house/src/identity-map.mjs`)
is an HMAC of `HOUSE_IDENTITY_SALT` over `"<platform>:<id>"` — by
construction, a DIFFERENT salt yields a DIFFERENT pseudonym for the exact
same raw platform id. The rehearsal's fresh `private/identity-map.json`
picked up 92 entries under `rehearsal-throwaway` — proof the map was
genuinely exercised, and, precisely because that salt is not the house's
real one, proof those 92 pseudonyms would NOT agree with whatever handle
the live house's own (real-salted) identity map has already given the same
people.

**What the real run must do**: never invent, generate, or copy a salt
value for the real run. Source `HOUSE_IDENTITY_SALT` from the house's own
`house/house.env` BY VARIABLE NAME (`source house/house.env` or the
equivalent for however the real run is invoked) so it resolves to the
exact value the live seat has been using — never read that file's contents
into this report, a commit, or a chat transcript; never paste the value
itself anywhere. Doing this is what lets an already-known human resolve to
the SAME handle the live room already recorded for them, rather than
minting a second, orphaned pseudonym for one real person.

## 4. (d): a new trunk in the rehearsal, by design — the real run must point at the real private root

`private/` started fresh in this rehearsal on purpose (never touch real
lives from a throwaway salt). Confirmed directly: after the 3 real writes,
`private/` held exactly 3 fresh `<handle>/life/` directories — one per
present being (the 3-being Discord room's three beings, deduplicated
against the two Signal groups' repeat of one of them) — each a brand-new
`ContextManager` store (`resident-life.mjs`'s `openLife` seeds a fresh
"address, read once" head message whenever `getMessageCount() === 0`,
which is always true for a directory that didn't exist a moment before).

This is not a limitation to fix — it is what a fresh sandbox necessarily
produces, and `openLife`/`appendPeriod`'s own code makes the real-run
behavior unambiguous by inspection: `openLife` opens whatever
`ContextManager` state already exists at `<privateRoot>/<handle>/life`
(the SAME path the live seat's own life already uses), and `appendPeriod`
is idempotent per `(run, handle)` session. Pointed at the house's REAL
`private/` root instead of a fresh one, the exact same code appends a new
period to each being's EXISTING trunk — never a second one — for both
`claude-haiku-4-5` and `claude-3-sonnet` (and the third being sharing the
Discord room). The rehearsal cannot prove this by running it (that would
mean writing to real lives from a rehearsal salt, which is exactly what
this sandboxing exists to prevent) — it is established here by code
reading, not by demonstration, and flagged as such.

## 5. What was fixed, in `connectome-history-import`

1. **`cli.mjs`: room lookup now goes through the house's own `findRoom`.**
   The prior `existingRooms()` was a bespoke re-scan of `--out`, keyed by
   its own read of each room's raw `class.json.room.stream` — a second,
   independently maintained notion of "is this stream already a room"
   alongside the live house's own (`connectome-house/src/room-index.mjs`'s
   `findRoom`, which additionally applies `stream-key.mjs`'s
   `canonicalStream` and a raw-stream back-compat fallback for a room
   minted before that rule existed). Two independently-written lookups
   over the same fact is exactly the shape of bug that mints a duplicate
   room for a stream the house already has open. `cli.mjs` now dynamically
   imports `room-index.mjs`'s `findRoom` (same import-order discipline as
   every other house module it already touches) and asks IT, per stream,
   whether a room exists — never its own scan. Verified unchanged
   idempotency: the existing "second run skips every stream already
   imported" test (4 streams, exact `last_seq` match) still passes
   unmodified.
2. **`slice.mjs`: `sliceRoom` now accepts a room with no `imported` field
   at all** — the retrofit case this rehearsal exists to prove out. A
   missing `imported` is treated as "nothing previously imported"
   (`priorLastSeq = -1`), so every one of the stream's matching VEIL items
   is "new" and lands as ONE slice, appended strictly AFTER whatever the
   room already has live — frames.jsonl is append-only, so this is the
   K4 late-slice shape (04 §6), never the literal PRE-slice (frames
   spliced in before the live ones) 04 §3 also names as an option; the
   format cannot do that without rewriting seq numbers on frames that are
   already someone's honest record of what happened, and this importer's
   own long-standing rule (`write.mjs`) is to never rewrite a frame once
   written. `cls.imported` is created fresh, `retrofit: true`, same flag
   on its one `slices[]` entry; the slice's own `house`/
   `note: "import-slice"` marker frame carries `under_live: true` so a
   later reader can tell, from the record alone, that this room lived
   before any restore touched it. Dedup-by-external-id and
   participant-dedup (both already keyed off the room's own
   `external.jsonl`/`class.json`, not off `imported`) needed no change —
   they already protect a retrofit slice from re-joining an already-live
   participant or double-counting a message.
3. **Tests** (`connectome-history-import`, `node --test`: 20/20 green
   after this task, up from 18): one at the `cli.mjs` level (a room built
   normally, its `imported` field then stripped to simulate a live mint —
   the bulk sweep finds it via `findRoom`, reports it skipped by name
   ("a live-minted room") in the markdown report, and leaves both
   `frames.jsonl` and `class.json` byte-identical); one at the `slice.mjs`
   level (the same stripped-`imported` shape, a second VEIL bucket
   appended via `sliceRoom` — asserts `retrofit: true`, the room's
   original frames untouched byte-for-byte and still ending in its own
   `rested`, the slice marker's `under_live: true`, the new content
   landing strictly after the original frames, `cls.imported.retrofit` and
   `slices[0].retrofit`, no duplicate participant, and idempotency on a
   re-run).

### Known residual limits — not fixed, named honestly

- **Multi-account Signal DM canonicalization** is unchanged and remains a
  documented, pre-existing ambiguity (`stream-key.mjs`'s own header: "a
  placeholder policy, a keeper decision"): `findRoom`'s default treats ANY
  embedded account segment as primary, while the importer's own
  `identity.streamKey` tracks "the first bot phone this import run
  learns is primary." These agree in the single-account case (verified:
  the existing DM fixture test still passes) and are NOT exercised by this
  rehearsal's 6 rooms (none are Signal DMs) — a second live Signal number
  is the case that would need this reconciled, and it hasn't been.
- **The fuzzy stand-in-id secondary match** for a cutover overlap window
  (04 §6's "Stand-in ids" paragraph — same sender, same text, `|Δt| ≤
  120s`) remains unimplemented in `slice.mjs`, as it was before this task.
- **The `room.stream: null` anomaly room** (§2) is unrelated to this fix
  and unresolved — flagged for the keeper, not silently worked around.
- **No CLI flag calls `sliceRoom` yet** — it remains, as the README already
  said, "the cutover procedure's own tool, called per-room," invoked
  directly rather than through `cli.mjs`. The real-run command in §6
  below is honest about this: the retrofit step is a short script, not a
  flag.

## 6. The real run — the keeper's word only

Per platform, per `04-history-restore.md` §6's cutover order (observe-only
seat live first, then slice against a fresh state-volume increment, then
cut the fork over). Two steps — Step 2 is now `--retrofit`, a flag on the
same `cli.mjs`, not a hand script (`connectome-history-import/src/
retrofit.mjs`, done after this rehearsal; §5 above still describes the
gap it closes).

**Step 1 — the ordinary sweep**, mints anything genuinely new and seeds
lives for every present being in a room it finds already live (idempotent
either way):

```
cd /opt/connectome/connectome-history-import
source /opt/connectome/house/house.env   # HOUSE_IDENTITY_SALT by NAME —
                                          # never copied into a script,
                                          # a flag, or this report
node src/cli.mjs \
  --state /root/veil-state-ro \
  --out   /opt/connectome/connectome-house/runs \
  --private /opt/connectome/connectome-house/private \
  --blobs   /opt/connectome/connectome-house/blobs \
  --beings /opt/connectome/bot-runtime/config.json \
  --streams '<this platform's own stream glob, e.g. "discord:<guild>:*">' \
  --report /opt/connectome/connectome-house/private/restore-<platform>.md \
  --real
```

Real roots throughout (`--real` required, per `04-history-restore.md`
§7 — "the real import runs once the keeper says so, per platform"); NOT
sandboxed — this is the real run, not a rehearsal.

**Step 2 — the retrofit**, for every room step 1's own report lists under
"skipped" with a reason naming "not appended" (§2's fix, §5): the same
`cli.mjs`, same real roots, `--retrofit-only` so nothing new is minted a
second time, `--rooms <id,id>` naming exactly the room ids step 1's own
report listed (omit `--rooms` to retrofit every such room the sweep still
finds). Preview first with `--dry-run` (needs no `HOUSE_IDENTITY_SALT` —
it builds no identity map at all):

```
cd /opt/connectome/connectome-history-import
source /opt/connectome/house/house.env   # not read for a --dry-run preview,
                                          # required for the real write below
node src/cli.mjs \
  --state /root/veil-state-ro \
  --out   /opt/connectome/connectome-house/runs \
  --private /opt/connectome/connectome-house/private \
  --blobs   /opt/connectome/connectome-house/blobs \
  --rooms '<the skipped room ids from step 1's report, comma-separated>' \
  --report /opt/connectome/connectome-house/private/retrofit-<platform>.md \
  --retrofit-only --dry-run                # preview: lists what would land
# node src/cli.mjs  <same flags, minus --dry-run>  --retrofit-only --real   # the real write
```

`retrofit.mjs`'s own `sliceRoom` call refuses a room not at rest and is
idempotent on a re-run, so re-invoking Step 2 after a failure — or after
Step 1 mints more of the platform later — is safe.

**Rollback — name it, don't run it.** Per `05-ops.md` §2/§5: before step 1
touches the real volume, cut one more backup increment of the VEIL state
directory (§2 step 6, "one more increment at each cutover") — the shape of
that command, per §2's own generic description (exact destination is an
operational choice, not fixed here):

```
tar -C /root -cf - veil-state-ro | zstd -T0 -o <off-box destination>/veil-pre-restore-<date>.tar.zst
```

and, separately, back up `connectome-house/{runs,private,blobs}` the same
way before step 1 runs, since step 1/2 write into those roots directly.
Because every write here is append-only (never a rewrite of an existing
frame), there is no in-place "undo" for a bad retrofit slice — the correct
rollback for one room is to restore that ROOM'S OWN run directory (and,
if lives were seeded, that being's `private/<handle>/` directory) from
this pre-restore backup, never a live `rm`/hand-edit of `frames.jsonl` or
`class.json`.

## Gates run

`cd connectome-history-import && node --test --test-timeout=60000
--test-concurrency=1`: **20/20 green** (18 pre-existing + 2 new).
`connectome-house/test/history*.test.mjs`: none exist — gate is a no-op.
the standard project-identifier sweep over `git diff -- connectome-history-import/`:
empty.
