// @ts-check
/* connectome-history-import/src/buckets.mjs — VEIL's frame buckets
 * (connectome-ts/src/persistence/frame-bucket-store.ts:
 * `frame-buckets/<xx>/<sha>.json`, 100 frames each, content-addressed) read
 * ONCE, in sequence order, every frame yielded exactly once. Snapshots
 * re-bucket the same history at shifting boundaries, so most buckets
 * overlap their neighbours — dedupe is by frame `uuid` (falling back to
 * `sequence:timestamp` for a uuid-less frame). The refs index
 * (`bucket-refs-index.json`) is only a hint: buckets on disk that it
 * doesn't name are read too, their range taken from the file itself.
 *
 * Ported (with adaptation) from a private deployment's own history importer
 * (2026-09-18): this module's own frame-bucket reading is unchanged — the
 * source format doesn't vary with the target.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {{hash: string, startSequence: number, endSequence: number, frameCount: number, path: string}} BucketRef */

/** every bucket on disk, ordered by (startSequence, endSequence, hash).
 * @param {string} stateDir @returns {BucketRef[]} */
export function listBuckets(stateDir) {
  const root = join(stateDir, "frame-buckets");
  if (!existsSync(root)) throw new Error(`no frame-buckets/ under ${stateDir}`);
  /** @type {Map<string, {startSequence: number, endSequence: number, frameCount: number}>} */
  const indexed = new Map();
  const indexPath = join(stateDir, "bucket-refs-index.json");
  if (existsSync(indexPath)) {
    try {
      const idx = JSON.parse(readFileSync(indexPath, "utf8"));
      for (const r of idx?.refs ?? []) {
        if (typeof r?.hash === "string" && typeof r.startSequence === "number")
          indexed.set(r.hash, {
            startSequence: r.startSequence,
            endSequence: r.endSequence,
            frameCount: r.frameCount,
          });
      }
    } catch {
      /* an unreadable index is only a lost shortcut — the files still say */
    }
  }
  /** @type {BucketRef[]} */
  const out = [];
  for (const shard of readdirSync(root)) {
    const dir = join(root, shard);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const hash = shard + f.slice(0, -5);
      const path = join(dir, f);
      const known = indexed.get(hash);
      if (known) {
        out.push({ hash, path, ...known });
        continue;
      }
      try {
        const b = JSON.parse(readFileSync(path, "utf8"));
        out.push({
          hash,
          path,
          startSequence: b.startSequence,
          endSequence: b.endSequence,
          frameCount: b.frameCount ?? b.frames?.length ?? 0,
        });
      } catch {
        /* a corrupt bucket file is skipped, counted by the caller's own tally */
      }
    }
  }
  out.sort(
    (a, b) =>
      a.startSequence - b.startSequence ||
      a.endSequence - b.endSequence ||
      (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
  );
  return out;
}

/** the dedupe key for a frame — its uuid, else sequence:timestamp */
export function frameKey(frame) {
  if (typeof frame?.uuid === "string" && frame.uuid) return frame.uuid;
  return `${frame?.sequence}:${frame?.timestamp}`;
}

/**
 * Stream every distinct frame across `buckets`, in bucket order (which is
 * sequence order at bucket granularity; within a bucket frames are already
 * ordered). Yields `{frame, bucket}`; `stats` fills in as it goes.
 * @param {BucketRef[]} buckets
 * @param {{buckets: number, frames_read: number, frames_unique: number, duplicates: number, unreadable: number}} stats
 */
export function* streamFrames(buckets, stats) {
  const seen = new Set();
  for (const bucket of buckets) {
    let b;
    try {
      b = JSON.parse(readFileSync(bucket.path, "utf8"));
    } catch {
      stats.unreadable += 1;
      continue;
    }
    stats.buckets += 1;
    for (const frame of b.frames ?? []) {
      stats.frames_read += 1;
      const key = frameKey(frame);
      if (seen.has(key)) {
        stats.duplicates += 1;
        continue;
      }
      seen.add(key);
      stats.frames_unique += 1;
      yield { frame, bucket };
    }
  }
}

export const emptyStats = () => ({
  buckets: 0,
  frames_read: 0,
  frames_unique: 0,
  duplicates: 0,
  unreadable: 0,
});
