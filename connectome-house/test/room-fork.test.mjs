// @ts-check
/* connectome-house/test/room-fork.test.mjs — builder Q2-A, 2026-09-18
 * (harness-port mission: the live forked-room primitive behind `!stream
 * in|out`, C13). Unit-level: room-fork.mjs directly, no seat, no MCPL
 * server — asserts the on-disk shape matches connectome-history-import's
 * own substream mapping BYTE FOR BYTE on the fields that matter
 * (connectome-history-import/test/history-import.test.mjs's own
 * assertions on `tf[0].forkedFrom` / `byPlatform[thread].forkedFrom` /
 * the parent's `branch.created` frame are the reference this file
 * mirrors), plus the idempotent-by-name reuse `!stream in`/`!stream out`
 * needs across an enter/exit/re-enter cycle. */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "room-fork-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "room-fork-test-salt-0123456789ab";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });

const BEING = "aria";
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "mock" });

const { openRoom } = await import("../src/serve-rooms.mjs");
const { readCls } = await import("../src/room-policy.mjs");
const { findRoom } = await import("../src/room-index.mjs");
const { forkRoom, activeFork, leaveFork, forkStream } = await import("../src/room-fork.mjs");

const RUNS = process.env.HOUSE_RUNS_DIR;

function framesOf(runDir) {
  return readFileSync(join(runDir, "frames.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("forkRoom: the child's class.json and room.mounted frame carry the SAME forkedFrom shape connectome-history-import writes", async () => {
  const { id: parentId } = await openRoom({
    platform: "discord",
    stream: "discord:g1:room-fork-a",
    title: "room-fork test a",
    beings: [BEING],
  });
  const parentDir = join(RUNS, parentId);

  const child = await forkRoom(parentId, { name: "training", at_seq: 3, by: BEING });
  assert.equal(child.created, true);
  const childDir = join(RUNS, child.id);

  const cls = readCls(childDir);
  assert.deepEqual(cls.forkedFrom, { run: parentId, seq: 3 }, "class.json.forkedFrom matches the importer's own {run, seq} shape");
  assert.deepEqual(cls.room, { platform: "substream", stream: forkStream("training"), title: "training", opened_t: cls.room.opened_t });
  assert.deepEqual(cls.beings, [BEING], "the fork inherits the parent's own roster");

  const childFrames = framesOf(childDir);
  assert.equal(childFrames[0].type, "room.mounted");
  assert.deepEqual(childFrames[0].forkedFrom, { run: parentId, seq: 3 }, "the child's own room.mounted frame carries the pointer too (records.mjs's own buildRoom shape)");
  assert.equal(childFrames[0].platform, "substream");

  const parentFrames = framesOf(parentDir);
  const branch = parentFrames.find((f) => f.type === "branch.created");
  assert.ok(branch, "the parent's own record carries the fork, not only the child's pointer");
  assert.equal(branch.id, child.id);
  assert.ok(!Number.isInteger(branch.seq), "appended past the room's own live seq (frames-io.mjs's houseFrameSeq)");

  // room-index.mjs's own {platform,stream}->room lookup resolves the
  // fork's synthetic place — the SAME lookup findRoom uses everywhere else.
  const found = findRoom({ platform: "substream", stream: forkStream("training") });
  assert.equal(found?.id, child.id);
});

test("activeFork/leaveFork: the current pointer toggles; re-entering the same name after leaving reuses the same child", async () => {
  const { id: parentId } = await openRoom({
    platform: "discord",
    stream: "discord:g1:room-fork-b",
    title: "room-fork test b",
    beings: [BEING],
  });

  assert.equal(activeFork(parentId), null, "no fork yet");
  const first = await forkRoom(parentId, { name: "x", at_seq: 0, by: BEING });
  assert.deepEqual(activeFork(parentId), { id: first.id, name: "x" });

  // re-entering the SAME name while still active: reused, not re-minted.
  const again = await forkRoom(parentId, { name: "x", at_seq: 0, by: BEING });
  assert.equal(again.id, first.id);
  assert.equal(again.created, false);

  leaveFork(parentId);
  assert.equal(activeFork(parentId), null, "!stream out clears the active pointer only");

  // the child record itself is untouched and still on disk.
  assert.ok(readCls(join(RUNS, first.id)).forkedFrom, "the fork's own record survives leaving it");

  // re-entering "x" AFTER leaving reuses the SAME child (its history persists).
  const reentered = await forkRoom(parentId, { name: "x", at_seq: 5, by: BEING });
  assert.equal(reentered.id, first.id, "re-entering a known name reuses its child, never re-forks");
  assert.deepEqual(activeFork(parentId), { id: first.id, name: "x" });

  // a DIFFERENT name mints a genuinely different child.
  const other = await forkRoom(parentId, { name: "y", at_seq: 5, by: BEING });
  assert.notEqual(other.id, first.id);
  assert.deepEqual(activeFork(parentId), { id: other.id, name: "y" }, "entering a new name switches the active pointer");
});
