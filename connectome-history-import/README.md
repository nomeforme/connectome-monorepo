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
  [--no-lives] [--scrub-names] [--real]
```

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

`node --test` runs both suites: `test/history-import.test.mjs` (a full
synthetic VEIL state — a Discord channel, its thread, a Signal group, a
Signal DM — through the CLI end to end, including the PII sweep, the
`--real` gate, `--dry-run`, idempotency, `findRoom`, and a life append) and
`test/history-import-slice.test.mjs` (`slice.mjs` against two cuts of the
same fixture state). Every root is a `mkdtemp` sandbox; nothing here ever
touches a real `connectome-house` deployment.
