# Restoring this repo's own history into house records

> Written by agent B2, 2026-09-17, on `harness-port` (base `4dd8d2f`). Cites
> `00-stack-as-is.md` §1.3/§1.4/§10 for the source format, `03-house-design.md`
> §0/§1 for the target vocabulary (room, record, being, life). This doc
> assumes 03's decisions: the house is the sole writer of the record; a room
> is what VEIL calls a stream; a life is a being's own persisted memory,
> separate from any one room's record.

## 0. Why this is a real restoration, not a fresh start

This repo already holds a real, lived conversational archive: 44 GB of
state on the live box, 38 GB of it snapshots, 4.2 GB frame buckets, 982 MB
deltas, 423 MB blobs across 2,724 files, spanning frames dated back to at
least early 2026 (00 §10). Every one of the 21 beings currently running has
months of history behind it, held in VEIL's frame buckets. A port that
starts every being's memory at zero on day one is not a port, it's an
amnesia event dressed as an upgrade. The importer described here exists so
that does not happen.

## 1. Source format, restated for the mapping

From 00 §1.3: frames live in content-addressed, sha256-sharded buckets
(`frame-buckets/<hash[0:2]>/<hash>.json`, `bucketSize` 100 frames per
bucket), each `Frame` a `{sequence, timestamp, uuid, activeStream, events,
deltas, transition}` (00 §1.1). Facets (00 §1.1) carry the content: speech,
event (inbound platform message), action, state, ambient. `snapshot_export`
(`connectome-mcp/src/snapshot.ts`) is **not** a usable import feed — no
facet ids, no blob ids, no edit/delete/redaction state, and it dedupes on a
50-character content prefix, which silently drops distinct messages that
happen to start alike. **The importer must read frame buckets directly**
(`frame-bucket-store.ts:15-21`, walking each `Frame.deltas`), the same path
`connectome-mcp`'s own tooling avoids for exactly this reason.

## 2. The mapping

| VEIL source | house record target | notes |
|---|---|---|
| an `event` facet (inbound platform message) | a `message.received` record entry | carries the platform's own message id in an `external` sub-object (§3) |
| a `speech` facet | a `speech` record entry | `cyclePending: true` (00 §4.8 — a segment delivered mid-cycle, not the final one, 85% of fleet speech by count) maps to a `delivered-mid-turn` flag on the entry, **not** to the house's own notion of a pre-tool interim segment (03-house-design.md §5's `!continue` note and 02-user-contract.md O12 both depend on this distinction) — every VEIL speech facet that was actually delivered to the platform enters the being's life, whether or not it was the cycle's last word |
| an action facet + its resulting event | a **reach pair**: one entry for the call, one for its result, linked by id | mirrors the shape a live house turn already produces for its own tool calls (03-house-design.md §2.2) |
| a substream (`CreateStream` with `parentStreamId`, 00 §5.4) | a **forked room**: a new room record whose parent is the originating room, forked at the corresponding sequence | matches 03-house-design.md's room-forking requirement (01 §1.2 item 5) |
| a 🫥 hide/unhide (00 §4.4, §1.5) | a `hidden` record entry naming the remaining set of human reactors | **the record stays legible**: unlike VEIL, which silently omits a hidden message from every rendered context with no trace at the record layer (`context-handler.ts:198-206`), the house's record keeps the fact of the hide visible to anyone reading the raw record, while a being's *rendered* context still excludes the text exactly as today. This is a deliberate, named divergence: see §3 for why it needs a keeper's word before the real import runs. |
| a message edit (00 §4.5) | an `edited` entry: final text plus an edit marker | the pre-edit text is not retained in the new record (VEIL doesn't retain it either — `editedAt` in state, 00 §4.5 — so nothing is lost that the source format already discarded) |
| a message delete (00 §4.5) | a **tombstone**: the fact of deletion, never the deleted text | consent-bearing: a person who deleted a message consented to its removal, not to its preservation under a different name |
| a reply/quote reference | **not restorable** | VEIL itself never stores reply/quote references on the way in (`event-handler.ts:129-138,196-206`) — this is lost upstream of the importer, not an importer limitation. The import marks each affected room's provenance record with this gap explicitly rather than silently producing a record that looks complete. |

## 3. What needs a keeper's word before it runs for real

Two decisions are load-bearing enough that the importer should implement
both options and let a flag pick, rather than assume:

1. **🫥 on import: hide as VEIL did (silently, at the render layer only,
   leaving no record-level trace at all), or keep it legible with the
   `hidden` marker described above (03-house-design.md's whole redaction
   design assumes the record stays legible; 02-user-contract.md §3.1 makes
   the same case for the live path).** Recommendation: legible, for
   consistency with the live-path design — a record format that behaves
   one way for imported history and another for everything after it is a
   maintenance trap.
2. **Record order at cutover** (§6) — accept a late-arriving import slice
   landing after live-recorded frames in sequence order (marked with a
   provenance note), or hold overlap-window messages in a staging buffer
   until the slice lands so sequence order matches wall-clock order.
   Recommendation: accept it — a staging buffer means a second live copy of
   the same text exists for however long the buffer holds it, which
   contradicts the single-writer, one-verbatim-copy design this whole port
   is built around (03-house-design.md §1).

## 4. PII handling

This repo is the **public** home of the house design (03-house-design.md,
05-ops.md). Every platform identifier the importer touches needs to leave
that identity behind before it lands in a committed-adjacent, publicly
readable record format:

- **Every platform id → a handle, via a salted map kept outside version
  control.** Discord snowflakes, Signal UUIDs-or-phone-numbers, and display
  names all resolve through this map before they reach a record entry. The
  map itself — the only place a real platform identity and a house handle
  are ever written down together — lives in the box's own private
  configuration directory, gitignored, keeper-owned, never in this repo's
  tracked tree.
- **Phone numbers never enter a record, full stop**, even though the
  identity map itself is untracked. A Signal contact known only by number
  resolves to a stable digest (a salted hash) rather than the number
  itself, so the map can be inspected or regenerated without ever having
  written a real number into anything the house serializes. This mirrors a
  design choice already worth adopting on the live MCPL side too
  (03-house-design.md §4's note on the Signal server never putting a raw
  number on the wire) — the import path and the live path should use the
  *same* identity resolution, not two independently-written ones that can
  drift.
- **Strip the `<authorName> text` prefix VEIL bakes into content**
  (`event-handler.ts:127`, 00 §1.5) before it lands in a record entry — the
  name belongs in the entry's own attributed-sender field, never
  concatenated into the text itself, or a name-stripping pass later has to
  parse prose to find it again.
- **Room addresses may keep a platform's own stream id** (e.g. a Discord
  guild:channel pair) as a room's own address, since a room address is
  routing information the house needs to find the right record, not a
  person's identity — but any id sanitization applied to a *human-readable*
  identifier (a room title, a display name) still applies even here.

## 5. Provenance

Every imported room and every imported stretch of a being's life is marked,
not left to be inferred:

- A room restored by the importer carries an explicit provenance record
  (source, the stream id it came from, the sequence range covered, and a
  list of anything known to be lost — the reply/quote gap from §2 chief
  among them).
- **Provenance is tracked per sequence range, not per room.** A room that
  is imported once and then goes live afterward has *both* imported and
  lived history in the same record; marking the whole room "imported"
  would mislabel every live turn that happens in it after cutover. Each
  slice (§6) contributes its own sequence range to the provenance record,
  and a frame's provenance is resolved by which range (if any) its
  sequence falls inside.
- A being's life gains a new, explicitly-marked period for each import
  slice, exactly like a lived period, so a being (or an operator reading
  its life) can tell "this is something I actually experienced happening"
  from "this is something I was told happened before I was there for it."

## 6. Cutover: overlap, never gap

The importer is not a one-time migration tool — it needs a mode that can
run again, safely, after a room has already gone partly live under the
house. This is what makes the actual platform-by-platform cutover safe:

1. **The house's MCPL seat for a platform account goes live first, in
   observe-only mode**: it records every message on that account's rooms
   (no dispatch, no typing, no outbound), while the fork's own bot on that
   same account (or a sibling identity, so nothing double-delivers) keeps
   answering exactly as before.
2. **An increment of the VEIL state volume is cut** to the latest message
   (05-ops.md §2 has the backup procedure this reuses), and the importer
   runs a **slice** — not a full import — against it: only frames newer
   than the room's last imported sequence, deduplicated against the room's
   own record of platform message ids in either direction (so a message
   the live observe-mode seat already recorded is never imported a second
   time, and vice versa).
3. **The fork's bot container is stopped**, or detached from VEIL.
4. **The house's seat flips from observe to present** (it now answers).
   Before it does, a cursor entry is written marking the last sequence the
   room has recorded, so nothing recorded during the brief observe-to-
   present gap gets treated as new once the seat starts speaking.

The record has **no gap**: the house observes from step 1, and the VEIL
slice covers everything through step 2, which happens after step 1 starts.
The only gap is in *answering* — the seconds between stopping the fork's
bot (step 3) and the house's seat going present (step 4) — which is a
brief silence, not a lost message.

**Stand-in ids.** A VEIL frame without a platform message id of its own
(an occasional gap in the source format) needs a synthetic id so it can
still be deduplicated correctly; these stand-in ids must be constructed so
they can never collide with a real platform id (a clearly-prefixed
namespace, distinguishable on sight), and within the overlap window
specifically, a secondary match (same sender, same text after
normalization, close in time) catches the case where a stand-in-id frame
and a live-recorded frame are actually the same message arriving through
two paths.

## 7. The importer as a tool in this repo

Lives in this repo (a `tools/` or `history-import/` package, exact location
a round-1 decision, 06-rounds.md) as an ordinary, testable command-line
tool, not a one-off script run once and discarded:

- **Idempotent.** Running the same slice twice appends nothing the second
  time — every id it would write is already present. This is what makes
  the cutover procedure in §6 safe to re-run if a step needs retrying.
- **A dry-run mode is the default.** The importer reports what it *would*
  write — room counts, frame counts, provenance ranges, anything it
  couldn't map (the reply/quote gap, any facet type it doesn't recognize)
  — without writing anything. A `--real` flag (or equivalent, explicit and
  hard to trigger by accident) is required for an actual write, and even
  then the tool refuses to write into a room that isn't at rest (avoiding
  a race with a live turn in progress).
- **Verification, every run:** a per-stream frame count comparison against
  the source buckets; a sampled round-trip read of a handful of imported
  entries back out through the house's own record-reading path; and a PII
  sweep (05-ops.md's grep battery, run against the *output* of a real
  import, not just this repo's source tree) confirming no platform id,
  phone number, or raw display name escaped the handle map.
- **The real import runs once the keeper says so, per platform, per the
  cutover sequence in §6** — never as a side effect of merging a build
  round. A dry run against a synced, read-only copy of the state volume
  (05-ops.md §1) can and should run early and often during development;
  only the final `--real` pass against the live volume waits on the
  keeper's word.

## 8. What the importer explicitly does not attempt

- **`migration-progress.json`** (00 §1.3's blob-migration resume file, 142k
  entries) — scaffolding for VEIL's own one-time inline-attachment-to-blob
  migration, not conversational content. Not imported.
- **The in-memory `RegisterAgent` table and `GetFrames`'s bounded array**
  (00 §1.3/§1.4, 01 §4) — neither ever held anything worth restoring; both
  are described in 03-house-design.md §7 as retiring outright.
- **Orphaned volumes from retired identities** (00 §4.11's `ari`-named
  debris) — cross-referenced against current configuration and confirmed
  dead; excluded by construction (the importer only reads rooms that
  correspond to a currently-configured being or an explicitly-requested
  historical one).
