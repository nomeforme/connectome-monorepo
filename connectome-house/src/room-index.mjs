// @ts-check
/* connectome-house/src/room-index.mjs — the {platform, stream} -> room index
 * serve-rooms.mjs's openRoom/findRoom key off (split out so that file's
 * own ratchet has room; behaviour identical either way).
 *
 * The index is an ACCELERATOR only, cached on RUNS's mtime alone — a
 * class.json written or rewritten inside an EXISTING run dir never bumps
 * RUNS's own mtime, so this never trusts the cache blind: a HIT is
 * re-verified by rereading that run's class.json, and a MISS always falls
 * back to a full, uncached scan before findRoom concludes "no room" — a
 * false miss would mint a second room for one stream, the one failure a
 * room-centric house must never have. `rememberRoom` lets a mint (or a
 * rescan hit) update the index directly, so the next lookup for the same
 * room is the fast path again without waiting for RUNS's mtime to move. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUNS } from "./serve-paths.mjs";
import { placeOf, readCls } from "./room-policy.mjs";
import { canonicalStream } from "./stream-key.mjs";

/** @typedef {{id:string, platform:string, stream:string}} RoomRow */
let cache = {
  sig: -1,
  rooms: /** @type {RoomRow[]} */ ([]),
  index: /** @type {Map<string,RoomRow>} */ (new Map()),
};

/** every room {id, platform, stream} — an array for callers that scan
 * (e.g. slug8 lookup), rebuilt only when RUNS's own mtime has moved. */
export function scanRooms() {
  let sig = -1;
  try {
    sig = statSync(RUNS).mtimeMs;
  } catch {
    return [];
  }
  if (cache.sig === sig) return cache.rooms;
  const rooms = [];
  const index = new Map();
  for (const d of readdirSync(RUNS)) {
    try {
      const place = placeOf(readCls(join(RUNS, d)));
      if (place?.platform && place?.stream) {
        const row = { id: d, platform: place.platform, stream: place.stream };
        rooms.push(row);
        index.set(`${place.platform}:${place.stream}`, row);
      }
    } catch {
      /* no class.json, or no place — not ours to list */
    }
  }
  cache = { sig, rooms, index };
  return rooms;
}

/** does `row.id`'s class.json STILL name {platform, key}? A cache hit is
 * only as good as this — the index can outlive a rewrite that moved a
 * room's own place, or briefly outrun a mint whose class.json wasn't
 * written yet when the entry was cached. */
function verifyRow(row, platform, key) {
  try {
    const place = placeOf(readCls(join(RUNS, row.id)));
    return place?.platform === platform && place?.stream === key;
  } catch {
    return false;
  }
}

/** the ground truth a cache MISS falls back to: a full, uncached read of
 * every run dir. Cheap relative to being wrong. */
function scanForRoom(platform, key) {
  let dirs;
  try {
    dirs = readdirSync(RUNS);
  } catch {
    return null;
  }
  for (const d of dirs) {
    try {
      const place = placeOf(readCls(join(RUNS, d)));
      if (place?.platform === platform && place?.stream === key)
        return { id: d, platform, stream: key };
    } catch {
      /* no class.json, or no place */
    }
  }
  return null;
}

/** records a room the cache didn't yet have. */
export function rememberRoom(row) {
  if (!cache.rooms.some((r) => r.id === row.id)) cache.rooms.push(row);
  cache.index.set(`${row.platform}:${row.stream}`, row);
}

/** one key's worth of findRoom: a verified cache hit, else a full rescan
 * (never a bare "not in the index"). A stale hit is dropped; a rescan hit
 * is remembered, so the fast path resumes next time. */
function lookupKey(platform, key) {
  const hit = cache.index.get(`${platform}:${key}`);
  if (hit) {
    if (verifyRow(hit, platform, key)) return hit;
    cache.index.delete(`${platform}:${key}`);
  }
  const found = scanForRoom(platform, key);
  if (found) rememberRoom(found);
  return found;
}

/** {platform, stream} -> its room: canonical key first, then `stream`
 * verbatim (back-compat — a room minted before canonicalization existed). */
export function findRoom({ platform, stream }) {
  scanRooms();
  const canon = canonicalStream(platform, stream);
  return (
    lookupKey(platform, canon) ?? (canon !== stream ? lookupKey(platform, stream) : null) ?? null
  );
}
