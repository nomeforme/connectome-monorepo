// @ts-check
/* harness/test/room-index.test.mjs — the room index (room-index.mjs) is an
 * ACCELERATOR only: a class.json that lands, or changes, inside an
 * EXISTING run dir never bumps RUNS's own mtime (only mkdir/rmdir on an
 * entry directly under RUNS does that), so the cache must never trust a
 * miss (a false "no room" mints a second room for one stream — the one
 * failure a room-centric house must never have) nor a hit past a rewrite
 * that moved a room's own place. Own sandbox, never harness/runs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNS = mkdtempSync(join(tmpdir(), "house-room-index-runs-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = mkdtempSync(join(tmpdir(), "house-room-index-private-"));

const { findRoom } = await import("../src/room-index.mjs");

function writeClass(id, cls) {
  const dir = join(RUNS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "class.json"), JSON.stringify(cls));
  return dir;
}

test("a class.json that appears AFTER the index was built (RUNS's own mtime unchanged) is still found — a miss always rescans", () => {
  const dir = join(RUNS, "room-late-write");
  mkdirSync(dir, { recursive: true }); // bumps RUNS's mtime; no class.json yet
  // warm the cache at THIS mtime: a scan that finds nothing for this stream
  assert.equal(findRoom({ platform: "discord", stream: "channel:late" }), null);
  // the class.json lands now — a write inside an EXISTING dir does NOT
  // bump RUNS's own mtime, so the cache's signature stays exactly as it was
  writeFileSync(
    join(dir, "class.json"),
    JSON.stringify({ room: { platform: "discord", stream: "channel:late" } }),
  );
  const hit = findRoom({ platform: "discord", stream: "channel:late" });
  assert.equal(hit?.id, "room-late-write", "a miss rescans instead of trusting the stale cache");
});

test("a class.json whose stream CHANGED is not returned for the old stream — a hit is re-verified, never trusted blind", () => {
  const dir = writeClass("room-changed", {
    room: { platform: "discord", stream: "channel:before" },
  });
  const before = findRoom({ platform: "discord", stream: "channel:before" });
  assert.equal(before?.id, "room-changed", "warms the cache for the OLD stream");
  // rewritten in place — RUNS's own mtime does not move for this either
  writeFileSync(
    join(dir, "class.json"),
    JSON.stringify({ room: { platform: "discord", stream: "channel:after" } }),
  );
  assert.equal(
    findRoom({ platform: "discord", stream: "channel:before" }),
    null,
    "the stale hit is dropped once re-verified against the CURRENT class.json",
  );
  const after = findRoom({ platform: "discord", stream: "channel:after" });
  assert.equal(
    after?.id,
    "room-changed",
    "the new stream resolves via the same re-verify/rescan path",
  );
});
