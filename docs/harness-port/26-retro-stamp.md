# 26 — Retro-stamp: `origin: "import"` on frames written before rule 3 existed

Builder H, 2026-09-20, `harness-port`. Rule 3 (`docs/harness-port/25-outbound-
guardrail.md` §4) only protects frames `write.mjs`/`slice.mjs` write from that
commit onward; the night's restore + retrofits ran against pre-rule-3 code,
so their frames carried no marker. New subcommand:
`connectome-history-import/src/cli.mjs --stamp-imported --runs <dir>
(--dry-run|--real)` (`src/stamp-imported.mjs`, `test/history-import-stamp.
test.mjs`, 15 tests).

## Criterion

- **Wholesale room** (`imported` present, `retrofit` not `true`): every
  frame missing `origin` is stamped, UNLESS `run.json.sessions` holds a
  non-`imported` entry (`wholesale-mixed` — skipped; none of tonight's 281
  hit this).
- **Retrofit room** (`imported.retrofit === true`): only frames inside the
  retrofit's own range. **Reliable marker found and used:**
  `imported.slices[]` entries carry `{retrofit:true, house_first_seq,
  house_last_seq, stream, exported_t}`. A real, pre-existing bug in
  `slice.mjs`'s math (`startSeq = lastFrameInfo(...).seq + 2`, vs. the
  trace's actual `Math.ceil(lastSeq)` anchor on resume) makes these
  ABSOLUTE bounds wrong by a per-room offset whenever the pre-retrofit
  last frame had a fractional seq — true of all three rooms tonight
  (`bab97539…`: recorded `5.998046875`, real marker at seq `5`). The
  recorded SPAN is unaffected. So: find the actual `type:"house",
  note:"import-slice"` frame matching the slice's `stream`/`exported_t`,
  take its real seq, add the recorded span. Falls back to the raw bounds
  if no marker frame is found (never hit here).
- **Fallback** (retrofit true, no usable `slices[]`, only
  `original_last_house_seq`): `t` < restore start (`2026-09-20T00:29Z`)
  AND `seq` > the recorded pre-retrofit end. Neither hit tonight.
- No `imported` field: never touched. Frames already carrying `origin`:
  left alone. Write: tmp file + rename; only `origin` appended (raw-line
  splice, never parse+stringify) — byte-exact otherwise.

## Counts

Tar backup: `/root/house-runs-prestamp-20260920.tar` (248,637,440 bytes,
`tar tf | wc -l` = 4772) — a copy, `_data` never moved.

Dry-run and `--real` (`docker run --rm --user 1001:1001`, image
`connectome-house`, `-v connectome_house-runs:/workspace/runs`, `-v
/opt/connectome:/opt/connectome:ro`) agreed exactly:

- rooms touched **284** (281 wholesale + 3 retrofit — `411d697c…` turned
  out retrofitted too, the incident's own "pass 2")
- frames stamped **44,588**; already stamped 0; out of scope 493; parse
  errors 0; not-imported skipped 3; mixed/unresolvable skipped 0
- post-`--real` dry-run: **rooms touched 0, frames stamped 0** — idempotent
- no leftover `.tmp-stamp-*`; `frames.jsonl` stayed `1001:1001`

Per room: `3c51ff61…` 515 (seq 13–527, real marker 13 not recorded 13.5);
`bab97539…` 6,819 (seq 5–6823, real marker 5 not recorded 5.998046875);
`411d697c…` 114 (seq 38–151, real marker 38 not recorded 38.75). All three
`markerGrounded: true`.

Incident rooms, `origin:"import"` present vs. absent, by type:

- `3c51ff61…` — with: speech 234, message 212, media.attached 41,
  participant.joined 16, hidden 10, house 1, rested 1 (Σ515). without:
  message 262, rested 5, aborted 4, speech 10, room.mounted 1 (Σ282 — the
  room's own pre-retrofit live history plus the post-retrofit cascade,
  neither ever touched).
- `bab97539…` — with: message 3431, speech 2307, media.attached 909,
  participant.joined 53, edited 67, retracted 28, hidden 22, house 1,
  rested 1 (Σ6819). without: message 9, rested 4, room.mounted 1 (Σ14, all
  pre-retrofit live).

## Gaps

`write.mjs`'s `appendSlice` doesn't stamp `origin` on a retrofit's own
CLOSING frame (only `writeRoom`'s wholesale path does) — a live bug in the
already-merged rule-3 code, out of this task's scope; this tool's range
intentionally includes that closing frame (class.json's own comment names
it "as much this import as the mapped items between"), so tonight's data
is correct regardless. `slice.mjs`'s recorded-bounds offset bug (above)
was worked around here, not fixed at its source.
