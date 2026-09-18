# connectome-history-import

The fleet's VEIL archive (frame buckets, `connectome-ts`'s persistence
layer) restored into `connectome-house`'s own records — rooms, beings, and
each being's life. Ported, with adaptation, from a private deployment's
own history importer (2026-09-18). See `docs/harness-port/04-history-restore.md`
for the full mapping this package implements.

## What it reads

- A VEIL state directory's `frame-buckets/<hash[0:2]>/<hash>.json` (sha256-
  sharded, ~100 frames per bucket, `bucket-refs-index.json` as a hint only)
  and `blobs/<sha[0:2]>/<sha>.{bin,json}`.
- Never `migration-progress.json` (blob-migration scaffolding, not
  conversational content) and never the live `GetFrames`/`snapshot_export`
  RPCs — frame buckets are the only feed with facet ids, blob ids, and
  edit/delete/redaction state intact.

## What it writes

- One room (a `connectome-house` run dir: `class.json`, `run.json`,
  `frames.jsonl`, `external.jsonl`) per VEIL stream, each frame validated
  against `connectome-house/src/frame-schema.mjs`'s closed `Frame` schema
  before it lands (fail-CLOSED — an importer that fails open on history
  restoration would lose that history's only remaining honest witness).
- Attachment bytes into the house's shared blob root (`blob-root.mjs`'s
  `putBlob`/`addRef`), addressed by the same sha256 VEIL used.
- Every platform identity through the house's keeper-owned, salted
  identity map (`identity-map.mjs`) — a human becomes a pseudonymous
  handle, a phone number is hashed before it ever reaches the map's own
  key, never stored as-is anywhere this package writes.
- Each present being's own life (`--no-lives` to skip), through
  `resident-life.mjs`'s ordinary `appendPeriod` — an imported room reads
  `metadata.period.provenance: "imported"`, same as a live period reads
  `"lived"`.

## The mapping, and one real adaptation

`docs/harness-port/04-history-restore.md` §2 has the full table. The one
place this package's OWN design differs from the private-deployment source
it was ported from: an edit is no longer baked into its origin frame's
text in place. The house's `Frame` schema carries a dedicated `EditedFrame`
(`target`, `text`, `edited_at`) added specifically for this port, so this
importer emits one `edited` frame PER edit, in chronological order,
pointing back at its target's own `seq` — a message edited more than once
keeps every rewrite as its own append, not just the last one merged in.
The original message frame keeps its own pre-edit text unchanged.

Two related renames, both required by the house's closed schema (a typo'd
or unknown `type` fails `Frame`'s `oneOf` outright, by design):
`hidden`/`retracted` name the withdrawn frame's own seq `target` (VEIL-era
code called it `of`); a delivered-but-cycle-pending speech (VEIL's
`cyclePending`, 85% of fleet speech by count) sets a NEW `delivered_mid_turn`
flag, never the schema's own `interim` — that names a different concept
(a pre-tool fragment that was never delivered at all); every VEIL speech
facet reaching this importer WAS delivered and belongs in a being's life
regardless.

A substream (a Discord thread, a `!stream in <name>` fork) becomes a
forked room: the child's own `room.mounted` frame carries `forkedFrom`
(§04 mapping); this package ALSO appends a `branch.created` marker to the
PARENT's own already-written record (`write.mjs`'s `markBranchOnParent`,
using the house's own `frames-io.mjs`'s `appendHouseFrame` — the same
"append a house-authored fact to a room that isn't live right now" path a
rested room's bookkeeping already uses). Both ends of the fork carry the
fact, never just the child's pointer.

## K3 / K4 — already decided, not flags

`docs/harness-port/04-history-restore.md` §3 proposed implementing both
options for two load-bearing decisions and letting a flag pick.
`docs/harness-port/06-rounds.md` §7 records that the keeper and orchestrator
already decided both, 2026-09-17, before this package existed — so there
is no `--hide-mode`/`--slice-order` flag here; each decision is simply what
this code does:

- **K3 (🫥 on import): legible.** A 🫥 becomes a `hidden` frame naming the
  CURRENT set of reactor handles (`by`) — never VEIL's own silent,
  render-layer-only omission. The record stays legible to anyone reading
  it raw; a being's *rendered* context still excludes the text, same as
  today.
- **K4 (record order at cutover): a late slice is accepted, never
  re-ordered.** `slice.mjs`'s late-arriving frames land AFTER whatever is
  already on disk, in append order, marked by a leading late-slice marker
  (see below) — never spliced back into VEIL sequence order, and never
  held in a staging buffer (which would mean a second live copy of the
  same text existing for however long the buffer held it).

Since the house's `Frame` schema has no dedicated "this is a later import
slice" type, K4's marker rides the generic `house` frame
(`frame-schema.mjs`'s `HouseFrame` — "a house-authored fact with no single
speaker"), tagged `note: "import-slice"` plus `source`/`stream`/
`first_seq`/`last_seq`/`exported_t`. A future round that wants this more
strongly typed can add a dedicated frame type; this package's own
`Frame`-schema validation would immediately flag every existing marker
that needs migrating, rather than silently drifting.

## Beings vs. humans: a speech facet isn't always a being's own words

A substream/workflow stream can record a HUMAN's typed messages as speech
facets whose `agentName` is the human's own display handle — an importer
that treats every speech author as a bot would mint a being out of a
person: a `speech` frame `by: <human>`, `kind: "resident"` in
`participants`, listed under `beings`, and a life seeded under
`private/<human>/`. `--beings <path>` names the known-beings set an
`agentName` must be in to still mint a being: a JSON file, either the
fleet's own `bot-runtime/config.json` shape (`{"bots":[{"name":…}]}`) or a
plain `["name", …]` array (`src/beings.mjs`).

- **Absent** (today's default, unchanged for a caller that doesn't opt
  in): every speech author is a being — the report carries a one-line
  warning naming this.
- **A speech author IN the set**: a being, exactly as before — a `speech`
  frame, `kind: "resident"`, a life.
- **A speech author NOT in the set**: a human. Emitted as a `message`
  frame (the same shape an inbound platform message gets), attributed to
  the SAME handle as any ordinary message this person already sent in the
  archive (matched against every known display name, slug-normalized —
  `identity.mjs`'s `humanFromSpeechAuthor`/`handleForName`), else a fresh
  handle via `identityFor` like any unseen human. No `kind: "resident"` in
  `participants`, not listed under `beings`, no life seeded. The report's
  own "Speech authors re-classed as humans" section names every
  `agentName → handle` this run re-classed, with a message count.

`--dry-run` applies the SAME classification (`streams.mjs`'s `countGroup`
takes the same `knownBeings`): its per-platform `messages`/`speech`/
`bots`/`humans` counts, and the re-classed section, already show what a
real write would produce — no identity map exists yet in a dry run
(no salt is required), so the section names each re-classed `agentName`
without a handle. `slice.mjs`'s `sliceRoom` takes the same `knownBeings`
too, for a cutover slice's own speech facets.

`beings.mjs`'s `classifySpeechAuthor` is the ONE place this whole
classification happens (records.mjs, slice.mjs, streams.mjs, cli.mjs all
call it, never re-derive the rule) — two more cases besides being/human:

- **`agentName` is `"system"`** (case-insensitive; `SYSTEM_AUTHORS`, a
  small explicit constant, extend it there): VEIL workflow-stream
  automation naming itself as a speaker, never a being NOR a human. Lands
  as the house's own notice — the SAME generic `house` frame the
  `import-slice` marker rides (`frame-schema.mjs`'s `HouseFrame`), tagged
  `note: "system"`, its text carried inline; no participant entry, no
  handle, no life. The report counts these separately ("System notices").
- **`agentName` is a Cyrillic/Greek-confusable variant of a known being's
  own registry name** (the real archive: three bots occasionally spoke
  under their Discord DISPLAY name instead, e.g. `сlαυdе opus 4.6` for
  `claude-opus-4-6`): the SAME being, same handle — `canonicalBeingName`
  matches after de-confusing + slug-normalizing (NFKD, diacritics
  stripped, the common Cyrillic/Greek lookalikes mapped to their Latin
  letter, non-alnum collapsed to `-`) and compares against every known
  being's own `slugHandle`. A beings-file entry's own `display`/
  `displayName`/`nickname` field, when present, is an additional exact
  alias for free (`bot-runtime/config.json`'s current entries carry none
  of these — the confusable fallback is what the real bug needed). The
  report's "Display-name aliases resolved" section names every
  `agentName → registry name` match, with a count.

## What is lost, and why (never silently)

`records.mjs`'s `LOST` constant, carried into every room's own
`class.json.imported.lost` and the CLI's markdown report: reply/quote
references (VEIL never stored them on the way in), every reaction but 🫥,
typing indicators, ambient/bot-config facets, and agent-activation/
rendered-context facets (derived views of the same history). Edit history
is NOT on this list — see above, it is no longer lost.

## Flags

```
node connectome-history-import/src/cli.mjs
  --state <veil-state dir> --out <runs dir> --private <private dir> --blobs <blob root>
  [--streams <glob>] [--limit N] [--dry-run] [--report <path>]
  [--no-lives] [--scrub-names] [--real] [--beings <path>]
```

- `--beings <path>`: see "Beings vs. humans" above. `--beings
  /opt/connectome/bot-runtime/config.json` reads the fleet's live registry
  directly (its `bots[].name` shape).
- `--dry-run`: reads every frame, prints per-stream counts, writes
  NOTHING outside `--report <path>` (if given). The default posture for
  development; the real import runs once per platform, per the cutover
  sequence in `04-history-restore.md` §6, only on the keeper's own word.
- `--real`: required when `--out`/`--private`/`--blobs` resolve to
  `connectome-house`'s own real `runs`/`private`/blob roots (siblings of
  this package, `../connectome-house/{runs,private,blobs}`) — refused
  otherwise, so a sandbox test can never write into a real deployment by
  accident.
- `HOUSE_IDENTITY_SALT` must be set for any non-dry-run write (refused
  otherwise) — the same salted-pseudonym discipline
  `connectome-house/src/identity-map.mjs` already enforces for a live
  seat.
- `slice.mjs`'s `sliceRoom` is a separate entry point (no CLI flag yet —
  it's the cutover procedure's own tool, called per-room, not swept in by
  the bulk `--out` walk `cli.mjs` does): appends a room already on disk
  past its own `imported.last_seq`, refusing unless the room is at rest and
  no other import already holds its `.import.lock`.

## Tests

`node --test` runs every suite: `test/history-import.test.mjs` (a full
synthetic VEIL state — a Discord channel, its thread, a Signal group, a
Signal DM — through the CLI end to end, including the PII sweep, the
`--real` gate, `--dry-run`, idempotency, `findRoom`, and a life append),
`test/history-import-slice.test.mjs` (`slice.mjs` against two cuts of the
same fixture state, including `sliceRoom`'s own `knownBeings` gate), and
`test/history-import-authors.test.mjs` (`--beings`: a workflow-stream
human re-classed to the same handle as her real message, never a being,
no life; a real bot in the beings file unaffected; the no-flag default
and its report warning; `--dry-run --beings` showing the same
classification in its counts and re-classed section; a `system`-authored
speech facet landing as a house notice, case-insensitively; a Discord
display-name Cyrillic/Greek-confusable variant of a known being resolving
to the SAME being). Every root is a `mkdtemp` sandbox; nothing here ever
touches a real `connectome-house` deployment.
