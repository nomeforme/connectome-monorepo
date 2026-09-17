# Ops — the state volume, backup, cutover, and rollback

> Written by agent B2, 2026-09-17, on `harness-port` (base `4dd8d2f`). Cites
> `00-stack-as-is.md` §10 for the live box facts (direct observation,
> 2026-09-17), `03-house-design.md` for the target architecture, and
> `04-history-restore.md` §6 for the per-stream cutover sequence this doc's
> dual-run procedure reuses.

## 1. The state volume, today

Confirmed by direct inspection of the live box (00 §10), not a code
reading:

- A **100 GB cloud block-storage volume**, mounted at a host path and then
  **bind-mounted a second time** onto the Docker volume path VEIL's
  persistence layer writes to, with boot ordering (`x-systemd.requires-
  mounts-for` / `x-systemd.before=docker.service`) that keeps Docker from
  starting before the block device is attached.
- **44 GB used of 100 GB**: 38 GB snapshots (590 files, ~65 MB average, 86%
  of the volume), 4.2 GB frame buckets, 982 MB deltas, 423 MB blobs across
  2,724 files.
- **Growing, and the growth is unbounded by design, not just by usage**:
  00 §10 traced the root cause directly in `persistence-maintainer.ts` —
  only frame *history* is fragmented across snapshots; the live facet map
  and the full component tree are re-serialized in their entirety on
  *every* snapshot. Since facets accumulate and are rarely removed (a 🫥
  hide sets a flag, it does not delete the facet, 00 §1.5), every one of
  the 590 "fragment" snapshots pays the full cost of the ever-larger facet
  map. This means the 38 GB figure is not a stable baseline to plan
  against — it will keep growing at a rate tied to total conversational
  history, not to the snapshot interval, for as long as VEIL keeps running
  unmodified.
- **Root filesystem**: a separate 119 GB disk, 53% used — headroom here is
  not the constraint; the block volume is.
- **8 vCPU, 15 GB RAM** (7.3 GB used, 7.4 GB buff/cache at time of reading).
  `docker-compose.yml`'s own comment about needing `--max-old-space-size=
  8192` headroom on a 15 GB host checks out exactly (00 §10) — there is
  little slack for adding a house process plus its own MCPL children
  without also reclaiming memory somewhere (§3.3 below sizes this).
- **46 Docker images (17.5 GB, 9 GB reclaimable), 35 containers, local
  volumes 48.8 GB total** — the 9 GB of reclaimable image layers is the
  cheapest available disk relief and should be pruned as a standing
  practice, not a one-time cleanup, since a port that adds new images
  (a house image, MCPL server images) will only add to this total.

## 2. Backup, before anything else touches the volume

**No destructive or irreversible step in this port (the state-volume move
in §3, any real import in 04-history-restore.md §7) runs before the volume
is backed up at least once, verified, and reachable off-box.** The
procedure, described generically (the exact tool names and destinations are
an operational choice for whoever runs it, not fixed here):

1. **Cut a manifest** of the volume's current contents — a listing of every
   file under the state directory with its size and a content hash,
   written before any copy begins, so the backup's own completeness can be
   checked against a known-good baseline rather than against itself.
2. **Full backup, once**: stream the entire state directory through a
   compressing pipe (e.g. `tar` piped directly into a fast compressor)
   straight off the box to remote storage, without ever materializing an
   uncompressed intermediate copy on the box's own disk — the block volume
   is already at 44% free and shrinking that margin mid-backup is exactly
   the kind of self-inflicted incident this doc exists to prevent.
3. **Increments thereafter, by manifest union, never by mtime or sequence
   range.** Both of the tempting shortcuts are unsafe here specifically:
   mtime windows miss anything the persistence layer touches without
   changing its logical content (a fragment snapshot rewrite can bump
   mtime on unchanged bytes), and sequence-range windows are unsafe because
   VEIL's own bucket sharding does not guarantee monotonically increasing
   file names. A manifest union — the diff between the current manifest and
   the manifest the last backup covered — is the only comparison that
   catches exactly what changed, no more and no less.
4. **Verify before trusting the copy**: list the destination's contents and
   spot-check a sample of files by content hash against the manifest cut in
   step 1. A backup that "looks complete" by file count alone is not
   verified; hash agreement on a real sample is the bar.
5. **A remote-side consistency check** (an rsync-style or equivalent
   "check" pass comparing source and destination) closes the loop — this
   is the step that actually catches a truncated or corrupted transfer,
   which a size-only comparison would miss.
6. **One more increment at each cutover.** Every time a platform account's
   history is sliced for import (04-history-restore.md §6 step 2), that
   slice's source state should itself be captured in the next scheduled
   increment, so the backup chain and the import's own source data stay in
   sync — an import run against state that was never backed up is a risk
   this port doesn't need to take.

**Redundancy is intentional, not waste.** A full backup plus every
increment, kept rather than pruned once superseded, costs storage but costs
nothing in risk — "easier to cut back the retention policy later than to
discover a gap in it," which matches the general posture of this whole port
(nothing retired by default, per 02-user-contract.md's framing).

## 3. Disk

- **Immediate, low-risk relief**: prune the ~9 GB of reclaimable image
  layers (§1) as a standing practice ahead of adding any new images this
  port introduces (a house image, one or more MCPL server images).
- **The real fix is moving the state volume to more headroom, not shrinking
  it.** A larger block-storage volume, attached online (most cloud block
  storage products support this without downtime to the rest of the host),
  is the straightforward answer; the actual cutover — detaching the old
  volume, attaching and mounting the new one, restarting VEIL — is a short,
  VEIL-only stop, not a whole-fleet outage, provided every other service's
  compose dependency on `connectome` is respected during the restart.
- **This is squarely a keeper decision** (creating and attaching cloud
  storage is an account-level, billed action) — this doc recommends timing
  it before, not during, the history import (04-history-restore.md), since
  a slice import that runs out of disk mid-write is a worse failure mode
  than a slow backup.
- **The snapshot growth problem (§1) is a separate, harder problem** that
  disk headroom only defers, not solves. 03-house-design.md's target
  design does not inherit VEIL's un-fragmented facet-map serialization;
  whatever replaces it as the house's own persistence layer should bound
  per-snapshot cost by something other than total history from the start
  — a requirement to carry into whichever build round designs the house's
  own record storage, not something this ops doc can fix on the existing
  volume.

## 4. The dual-run sequence, one bot at a time

Directly reusing 04-history-restore.md §6's per-stream cutover, at the
scale of a whole being (which may be seated in several rooms/platforms at
once):

1. **Backup** (§2), fresh enough to cover everything up to the cutover.
2. **The being's house-seated container starts in observe-only mode** on
   every room it will eventually own, recording but never answering, while
   its existing fork container keeps answering exactly as before.
3. **History import**, per room, per 04-history-restore.md §6–§7: a dry
   run first, reviewed, then a real slice once the keeper says so.
4. **The fork's container for that being is stopped** (not deleted — see
   §5) or detached from the VEIL networks.
5. **The house seat flips from observe to present.**
6. **A visible-behaviour check**, using 02-user-contract.md's conformance
   levels: at minimum an L1 replay against a recorded fixture, ideally an
   L3 pass (a keeper's own eyes on the platform) before calling that being
   fully cut over.
7. **Repeat per being**, never in bulk — a fleet-wide flag flip is exactly
   the kind of change this doc's whole backup-first posture exists to
   avoid needing to reverse under pressure.

Command-parity note (03-house-design.md §5, 02-user-contract.md §2): most
`!` commands become house verbs or retire during this same window per-
being, so the dual-run check in step 6 should specifically exercise
whichever commands that being's users are known to rely on, not just
dispatch and plain speech.

## 5. Rollback

- **The axon (discord-axon, signal-axon, web-axon) and VEIL server images
  and code stay buildable on this branch until the keeper explicitly
  retires them** — nothing in this port deletes or rewrites the existing
  `connectome-ts`/axon packages. A being that has moved to a house seat can
  be moved back by reversing §4's steps: restart its fork container,
  re-advertise its axon bindings, and flip the house seat back to
  observe-only (never delete the house-side room's record — it simply
  stops being the thing that answers).
- **The state volume itself is never made read-only or archived until the
  import is reconciled and backed up twice** (00's own R0-equivalent
  posture, restated here for this repo): a single early backup is not
  sufficient grounds to stop treating VEIL's volume as the live source of
  truth. Only once every stream has been imported, verified, and a second,
  independent backup pass confirms the first should VEIL's volume move to
  read-only.
- **The last thing to retire is VEIL's own gRPC server and persistence
  layer** (03-house-design.md §7's retirement table) — by construction,
  this is only possible after every being has moved and every stream has
  been imported, so rollback of the *whole* port remains possible right up
  until that final step, and becomes progressively narrower (per-being)
  before that.

## 6. What needs the keeper, explicitly

Collected from across this document and its siblings, so nothing here is a
build-round assumption:

- **Storage-account actions**: creating and attaching a larger block volume
  (§3); provisioning wherever backups land (a Drive-style destination or
  equivalent), including any one-time OAuth/authorization step that action
  requires and cannot be scripted around.
- **Credential/token rotation**: whatever the backup destination or the
  MCPL servers' own platform credentials need refreshed periodically —
  named here as a recurring operational cost of the port, not a one-time
  setup step.
- **The real history import** (04-history-restore.md §7) — a dry run can
  run any time against a synced read-only copy, but the actual `--real`
  write against live state, per platform, happens only on the keeper's
  word, timed against §4's dual-run sequence.
- **The 🫥-on-import decision and the record-order-at-cutover decision**
  (04-history-restore.md §3) — both are behaviour changes visible to a
  future reader of the record, not build details a round can decide alone.
- **Licensing** (03-house-design.md §4): this repo currently has no
  top-level license file; the Discord MCPL dependency currently has none
  either. Neither blocks development, but both block treating this repo as
  a stable public home for the house design, which is the stated end state
  of this port.
