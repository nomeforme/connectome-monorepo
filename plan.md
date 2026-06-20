# Content-Addressed Blob Store for VEIL Attachments

**Status:** Phase 1 in progress on `feat/blob-store-phase1`. Phase 2 deferred.

## Problem

Attachments (images, mp4s, files) currently travel as inline base64 bytes inside
the `Facet.attachments[i].data` field. The same facet is then:

1. Broadcast over every subscriber's gRPC stream — fan-out cost = N × bytes
   (currently ~18 bot subscribers + axons per stream).
2. Returned in full by every `GetStateSnapshot` / `get_speech` MCP query that
   matches the facet — observed `RESOURCE_EXHAUSTED: 93 MB vs 64 MB cap`.
3. Persisted as part of the frame log / snapshot, growing the on-disk archive
   linearly with every send.

Symptoms observed in production: bot-opus-4-8 attached four ~7 MB videos+stills
in one cycle, server accepted the speech facet, then the subscription broadcast
to all subscribers triggered cascading `DEADLINE_EXCEEDED` / `Connection dropped`
on every bot, the heavy `9HhdW` Signal group went unresponsive for 60+ seconds,
and the actual attachments never reached signal-cli (the `Sent N chunk(s)` log
fires regardless of whether `base64_attachments` was on the body).

## Solution

Treat blobs as a **first-class persistence primitive parallel to facets**:
content-addressed (sha256), frame-anchored, snapshot-included, replay-aware. The
`Facet.attachments` field carries refs only (`blob_id`); the bytes live once in
a sidecar store under the persistence root and are pulled on demand by exactly
the consumers that need them.

**Pub/sub stays metadata-only.** An 18 MB attachment travels exactly twice on
the wire (producer → blob store, blob store → consumer), regardless of how many
subscribers exist or how heavy the stream is.

## Architecture

```
Inbound (Signal/Discord → bot):
  receptor pulls bytes from platform → PutBlob(bytes) → emits message event
  with attachment refs (no bytes) → server stores ref-only facet → subscribers
  see small FacetDelta → bot bridge resolves refs via GetBlob before LLM call →
  context-adapter inlines as ImageContent identical to today

Outbound (bot → Signal/Discord):
  attach_file tool reads file → PutBlob(bytes) → returns blob_id → pushed onto
  pendingAttachments → recordSpeech emits agent:speech with attachment refs (no
  bytes) → server stores ref-only speech facet → only the matching bot's
  speech-effector sees the refs → GetBlob → POST to platform
```

The agent abstraction is unchanged. Bots see `ImageContent` exactly as before.
Tools see no API change. Skill-less bots (claude-3-opus) continue to work.

## Storage Model

### Sidecar layout under `connectome-state/`

```
snapshots/snapshot-NNNN.json        # existing — gains blobs.manifest
frame-buckets/<hash-prefix>/<hash>.json   # existing — frame log untouched
deltas/delta-NNNNN.json             # existing
blobs/<sha-prefix-2>/<sha>          # NEW — raw bytes, content-addressed, write-once
```

- `blob_id = sha256(bytes)`. Same content → same id → free dedup across the
  entire archive (one stored copy of an image even if 18 bots saw it).
- Bytes never enter the frame log or facet stateJson — only refs do.
- Write-once + atomic: write to `blobs/<sha>.tmp`, fsync, atomic-rename. Crash
  mid-write leaves `.tmp` orphans which are GC'd at next startup sweep.
- No per-blob refcount file — refcount is derived by walking live VEIL state.
- In a **living archive** (per design discussion), blobs are never GC'd. Files
  written to `blobs/` stay forever. Tiered cold storage is a later concern.

### Snapshot integration (phase 1 minimal, phase 2 full)

Phase 1: snapshots are written unchanged structurally. The blob store sits
beside the snapshot dir. Restoration just reads facets; any ref in a facet
resolves against the blob store on demand.

Phase 2: snapshot manifest gains a `blobsManifest: [{id, size, contentType,
firstFrame}]` listing every blob referenced by live state, so a snapshot is
self-contained for backup/copy purposes.

## Wire Protocol

### `Attachment` proto (add to existing oneof)

```proto
message Attachment {
  string id = 1;
  string content_type = 2;
  oneof data {
    bytes inline_data = 3;   // legacy — deserializer keeps reading these
    string url = 4;          // existing — unused
    string blob_id = 8;      // NEW — sha256, resolves via GetBlob
  }
  int64 size_bytes = 5;
  string filename = 6;
  map<string, string> metadata = 7;
}
```

### New RPCs

```proto
service ConnectomeService {
  // ... existing RPCs ...

  // Client-streaming upload. First chunk carries the header, subsequent chunks
  // carry bytes. Returns the content-addressed blob_id.
  rpc PutBlob(stream PutBlobChunk) returns (PutBlobResult);

  // Server-streaming download. First message carries the header, subsequent
  // messages carry chunks. Total transfer never exceeds the 64MB single-msg
  // limit because each chunk is bounded.
  rpc GetBlob(GetBlobRequest) returns (stream BlobChunk);
}

message PutBlobChunk {
  oneof payload {
    PutBlobHeader header = 1;
    bytes chunk = 2;
  }
}

message PutBlobHeader {
  string content_type = 1;
  string filename = 2;
  int64 size_bytes = 3;  // hint; not authoritative
}

message PutBlobResult {
  string blob_id = 1;       // sha256 hex
  int64 size_bytes = 2;
  bool already_existed = 3; // dedup signal
}

message GetBlobRequest {
  string blob_id = 1;
}

message BlobChunk {
  oneof payload {
    BlobHeader header = 1;
    bytes chunk = 2;
  }
}

message BlobHeader {
  string blob_id = 1;
  int64 size_bytes = 2;
  string content_type = 3;
  string filename = 4;
}
```

Chunk size: 256 KB. Stays well under the 64 MB single-message gRPC limit, fits
many chunks in a single TCP segment, doesn't fragment heap badly.

## Backward Compatibility

- `Attachment` proto adds a new oneof variant. Old clients writing `inline_data`
  still parse correctly on new servers.
- `facet-serializer` always reads `blob_id` first, falls back to `inline_data`,
  finally `url`. Writers prefer `blob_id` going forward; the `inline_data`
  branch stays in the writer only for tests / fallback.
- Snapshot/frame-log files containing `inline_data` are readable forever. The
  bot bridge's `transformToMessages` already handles both shapes.

## Phase 1 — New attachments use the blob store

**Scope:** every new attachment created after deploy goes through the blob
store. The system is fully functional with this alone. Historical attachments
on disk continue to work via the legacy deserialization path.

### Implementation order (dependency DAG)

1. **`connectome-grpc-common`** (`main`, push `origin`)
   - Add `blob_id` field to `Attachment.oneof` in proto.
   - Add `PutBlob` / `GetBlob` RPCs + supporting messages.
   - `facet-serializer.ts`: round-trip `blob_id`; `protoToAttachment` returns
     `{blobId, contentType, filename, sizeBytes}` when `blob_id` is set.
   - `Attachment` TS type: add `blobId?: string`.
   - `ConnectomeServer`: add `putBlob` / `getBlob` to `ConnectomeServiceHandlers`
     interface + corresponding `addService` entries (streaming RPCs).
   - `ConnectomeClient`: add `putBlob(bytes, meta)` / `getBlob(id)` methods that
     wrap the streaming calls and return Promises<Uint8Array>.

2. **`connectome-ts`** (`grpc`, push `fork`)
   - New `BlobStore` class in `src/persistence/blob-store.ts`. Methods:
     `putBlob(bytes, meta) → Promise<{id, alreadyExisted}>`,
     `getBlob(id) → Promise<{bytes, contentType, filename}>`,
     `hasBlob(id) → Promise<boolean>`, `cleanupTempFiles()`.
   - Mount under `FileStorageAdapter` (constructor wires `basePath/blobs`).
   - `grpc-main.ts`: instantiate BlobStore from persistence dir, expose via
     handlers wired into the gRPC server.

3. **`connectome-agent-core`** (`grpc`, push remote — check)
   - `context-adapter.ts`: extend `ContextMessage.metadata.attachments` shape
     with `blobId?: string`. If `data` is present, inline as today. If `blobId`
     present without `data`, leave a textual stub — caller is responsible for
     pre-resolving.
   - Export `resolveAttachmentRefs(messages, fetchBlob)` helper that walks
     messages and resolves any blob refs into `data` by calling `fetchBlob(id)`.

4. **`bot-runtime`** (`main`, push `origin`)
   - `tools/attach-tool.ts`: read file → `client.putBlob(bytes, {contentType,
     filename, sizeBytes})` → push `{id, blobId, contentType, filename,
     sizeBytes}` into `pendingAttachments` (no `data` field).
   - `connectome-bridge.ts`:
     - `transformToMessages`: when a message has attachment refs (blobId
       without data), `await client.getBlob(id)` and populate `data` before
       returning to the context-adapter.
     - `recordSpeech`: pass `attachments` through with their refs (already
       does — payload structure now carries `blobId` not `data`).

5. **`signal-axon`** (`grpc`, push `origin`)
   - `SignalMessageReceptor`: on inbound message with attachments, decode
     base64 bytes → `client.putBlob(bytes, meta)` → emit `signal:message`
     event with `attachments: [{blobId, ...}]` (no inline bytes).
   - `SignalSpeechEffector`: when speech facet's attachments have `blobId` set
     and no `data`, call `client.getBlob(id)` → base64 → POST to signal-cli.

6. **`discord-axon`** (`grpc`, push `fork`)
   - Discord receptor: same pattern as signal — fetch from Discord CDN, PutBlob,
     emit with refs.
   - `DiscordSpeechEffector`: GetBlob → Buffer → discord.js AttachmentBuilder.

7. **Workspace build + monorepo pointer commit** on `feat/blob-store-phase1`.
   Do NOT merge to main until user has live-tested.

### Done criteria for phase 1

- `pnpm turbo run build` passes across the workspace.
- A bot can attach a file in Signal/Discord and the file actually arrives at
  the platform.
- A user-sent image in Signal/Discord reaches the bot as `ImageContent` (i.e.
  the LLM still sees the image — no regression for skill-less bots).
- MCP `get_speech` returns ref-only facets and no longer trips the 64 MB cap
  for attachment-heavy streams.
- Subscription broadcasts do not trigger `DEADLINE_EXCEEDED` cascades when a
  large attachment is sent in the heavy `9HhdW` group.
- Old facets with `inline_data` on disk continue to be readable.

## Phase 2 — Rolling historical backfill

**Status:** deferred. Phase 1 is independent and ships standalone. The
deserializer's `inline_data` branch keeps historical archives readable
indefinitely until the migrator gets to them.

### Goal

Unify the on-disk archive under content-addressed blob refs. Realize the dedup
dividend: same bytes stored across history coalesce to one canonical file.
Historical archive likely shrinks substantially.

### Approach

A **rolling, idempotent, content-preserving rewriter** runs in the background
of a live server (or offline for the first pass).

For each frame bucket and snapshot file, in chronological order:

1. Read entries; for any with `inline_data`:
   - Compute `sha256(bytes)`
   - `PutBlob(bytes)` (idempotent — same sha = no-op)
   - Construct rewritten entry with `blob_id` replacing `inline_data`
2. Write rewritten file to `<original>.v2`, fsync
3. Atomic-rename `<original>.v2` → `<original>`. POSIX guarantees the swap is
   atomic. Crash at any point leaves either the old file (inline bytes still
   readable) or the new file (refs + bytes in blob store). Never partial.
4. Record progress in a side-table (`migration-progress.json`) so the migrator
   knows what to skip on resume.

### Properties

- **Resumable + crash-safe**: side-table tracks completed files; mid-file crash
  is recovered by the atomic rename pattern.
- **Idempotent**: re-running over already-migrated files is a no-op.
- **Pause-able**: runs as a low-priority unit. Can be throttled to avoid
  competing with live traffic for IO.
- **Content-preserving invariant**: any VEIL state reconstructable from the
  old format is reconstructable from the new format + blob store.

### Dedup dividend (the bonus)

Content-addressed migration coalesces every duplicate inline image across the
entire archive into one stored blob. In a multi-bot fleet that's been running
for months, the same images get inlined into dozens of facets across history.
Migration recovers that disk silently.

### Deletion of legacy deserializer

After the migrator has covered the entire archive AND a verification pass
confirms no `inline_data` remains in any file, the writer-side `inline_data`
branch can be deleted from `facet-serializer`. The deserializer branch stays
forever (cheap, no maintenance cost).

## Deployment Notes

- Phase 1 deploy requires connectome restart (~12 min downtime expected from
  the user's prior framing). All bot containers also need rebuild for the
  new `attach-tool` behavior, but bots can roll-restart independently of the
  server.
- Order: ship server first (with backward-compat deserializer), then bots one
  at a time. Mixed deployment is safe in both directions because the proto is
  additive and the deserializer is bidirectional.
- Rollback: if a bot is rolled back to pre-phase-1, its attach_file emits
  inline bytes again — server handles transparently. If server is rolled back,
  bots that already use PutBlob will fail at runtime — so server stays ahead.

## What's NOT in scope for phase 1

- Snapshot manifest of blobs (phase 2)
- Blob garbage collection / refcount tracking
- Tiered cold storage
- External blob backends (S3, MinIO)
- Migrator for historical inline_data on disk (phase 2)
- Snapshot compaction
- Tiered snapshot cadence
