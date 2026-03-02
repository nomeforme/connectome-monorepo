# VEIL Delta Repair

Surgical repair of VEIL persistence frame sequence errors without data loss.

## When This Applies

The connectome server fails to start with:
```
Frame sequence error: expected N, got M (current: N-1)
```
This means delta-N is missing from disk, breaking the continuous chain required by `VEILStateManager.applyFrame()`.

## Architecture Context

### Persistence layout (Docker volume `connectome_connectome-state`)
```
/var/lib/docker/volumes/connectome_connectome-state/_data/
├── snapshots/     # Full VEIL state at a sequence number
│   └── snapshot-{SEQ}-{TIMESTAMP}.json
├── deltas/        # One frame per file, applied sequentially after snapshot
│   └── delta-{SEQ}.json
└── frame-buckets/ # (secondary index, not needed for repair)
```

### How restoration works
1. Load latest snapshot (contains facets + `currentSequence`)
2. Load all `delta-{SEQ}.json` files where SEQ > snapshot.sequence
3. Sort numerically, replay each via `veilState.applyFrame(delta.frame)`
4. `applyFrame()` enforces strict `currentSequence + 1 === frame.sequence` — any gap throws

### Key files
- `connectome-ts/src/veil/veil-state.ts:134` — sequence validation in `applyFrame()`
- `connectome-ts/src/host/host.ts:327-346` — snapshot restore + delta replay loop
- `connectome-ts/src/persistence/file-storage.ts:264-324` — `loadDeltas()`, file naming, numeric sort

## Repair Procedure

### Step 1: Identify the gap

From the error message, extract:
- **expected**: the missing sequence number
- **current**: last successfully applied sequence
- **got**: the sequence that was found instead

### Step 2: Find the volume

```bash
MOUNTPOINT=$(docker volume inspect connectome_connectome-state --format '{{.Mountpoint}}')
STATE_DIR="$MOUNTPOINT"
```

### Step 3: Identify the latest snapshot

```bash
ls -t "$STATE_DIR/snapshots/" | head -2
```
The snapshot filename encodes the sequence: `snapshot-{SEQ}-{TIMESTAMP}.json`. The system restores from the highest-sequence snapshot and replays deltas after it.

### Step 4: Verify continuity from snapshot to the gap

```bash
SNAPSHOT_SEQ=21917  # from the snapshot filename
GAP_SEQ=21980       # "expected" from error message

MISSING=0
for seq in $(seq $((SNAPSHOT_SEQ + 1)) $((GAP_SEQ - 1))); do
  if [ ! -f "$STATE_DIR/deltas/delta-${seq}.json" ]; then
    echo "GAP: delta-${seq}.json MISSING"
    MISSING=$((MISSING+1))
  fi
done
[ $MISSING -eq 0 ] && echo "Continuous from $((SNAPSHOT_SEQ+1)) to $((GAP_SEQ-1))"
```

**CRITICAL**: If there are gaps BEFORE the reported one, those must be addressed first. The system only reports the first gap it hits.

### Step 5: List orphaned deltas after the gap

```bash
ls "$STATE_DIR/deltas/" | grep -E '^delta-' | \
  sed 's/delta-//;s/\.json//' | sort -n | \
  awk -v gap="$GAP_SEQ" '$1 >= gap'
```

### Step 6: Inspect what you're losing

```bash
for f in "$STATE_DIR/deltas/delta-"*.json; do
  SEQ=$(basename "$f" | sed 's/delta-//;s/\.json//')
  [ "$SEQ" -ge "$GAP_SEQ" ] || continue
  python3 -c "
import json
d = json.load(open('$f'))
ops = len(d.get('frame',{}).get('deltas',[]))
ts = d.get('frame',{}).get('timestamp','?')
print(f'  delta-${SEQ}: {ops} ops, ts={ts}')
"
done
```

If deltas have 0 ops — they're empty heartbeat frames, no data loss.
If deltas have ops — you lose those facet changes. Document what's lost.

### Step 7: Remove orphaned deltas

**NEVER delete snapshots. ONLY delete delta files after the gap.**

```bash
for f in "$STATE_DIR/deltas/delta-"*.json; do
  SEQ=$(basename "$f" | sed 's/delta-//;s/\.json//')
  if [ "$SEQ" -ge "$GAP_SEQ" ]; then
    rm "$f"
    echo "Removed delta-${SEQ}.json"
  fi
done
```

### Step 8: Verify and restart

```bash
# Confirm highest delta is now GAP_SEQ - 1
ls "$STATE_DIR/deltas/" | grep -E '^delta-' | \
  sed 's/delta-//;s/\.json//' | sort -n | tail -3

# Restart
docker compose up -d connectome
docker compose logs -f connectome  # watch for "Replayed deltas, now at sequence..."
```

Expected output:
```
📼 Replaying N deltas since snapshot...
✅ Replayed deltas, now at sequence {GAP_SEQ - 1}
```

## Rules

1. **NEVER delete snapshots** — they are the recovery floor
2. **NEVER edit delta files** — delete or keep, never modify
3. **Always verify continuity** from snapshot to gap before deleting anything
4. **Always inspect ops** before deletion — know what you're losing
5. **Deltas after a gap are unreachable** — they can never be applied because the chain is broken
6. **Empty frames (0 ops) are free to delete** — they contain no state changes

## Root Cause Prevention

Frame gaps typically occur when:
- The connectome process crashes mid-write (partial delta never flushed)
- Docker kills the container during persistence (OOM, SIGKILL)
- Disk full during delta write

The persistence system writes deltas synchronously but doesn't fsync. A hard kill between `write()` and filesystem flush can lose a delta.
