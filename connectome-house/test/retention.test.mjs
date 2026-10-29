// @ts-check
/* connectome-house/test/retention.test.mjs — the keeper-confirmed
 * retention sweep for external rooms: only external, non-imported,
 * non-private runs count; a scan writes nothing and mints a code; a purge
 * needs that code (fresh, unchanged plan), keeps each frame's shape but
 * removes its words, deletes the run's own blobs only those frames used,
 * clears the chronicle frame log of a closed room and marks an open one
 * pending; the reminder speaks at most once a day. Fixtures only. */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetRetention, isExternalRun, proposeRetention, purgeRetention, removedText, retentionReminder, scanRetention,
} from "../src/retention.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const OLD = new Date(NOW - 100 * DAY).toISOString();
const NEW = new Date(NOW - 5 * DAY).toISOString();
const isExternalPlace = (/** @type {string} */ p) => p === "web";
const SHA = "a".repeat(64);

/** @type {string[]} */ const dirs = [];
afterEach(() => {
  _resetRetention();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** a sandbox with: an external board room (old + new words, one old blob,
 * a chronicle store), an imported web run, a private web run, a Signal room */
function sandbox() {
  const runs = mkdtempSync(join(tmpdir(), "retention-"));
  dirs.push(runs);
  const run = (id, cls, frames) => {
    const d = join(runs, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "class.json"), JSON.stringify(cls));
    writeFileSync(join(d, "frames.jsonl"), frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    return d;
  };
  const board = run("board-1", { room: { platform: "web", stream: "web:commons:general", title: "commons #General" }, visibility: "public" }, [
    { seq: 0, t: OLD, type: "room.mounted", platform: "web" },
    { seq: 1, t: OLD, type: "message", by: "web-abc", text: "an outside poster's words", to: ["fable"] },
    { seq: 2, t: OLD, type: "speech", by: "fable", inline: "a being's long reply", blob: SHA, bytes: 9000, preview: "a being's" },
    { seq: 3, t: OLD, type: "reach", by: "fable", tool: "web_flag_post", input: { reason: "quote" } },
    { seq: 4, t: NEW, type: "message", by: "web-abc", text: "a recent post", to: ["fable"] },
  ]);
  mkdirSync(join(board, "chronicle", "blobs", SHA.slice(0, 2)), { recursive: true });
  writeFileSync(join(board, "chronicle", "blobs", SHA.slice(0, 2), SHA), "blob");
  writeFileSync(join(board, "chronicle", "MANIFEST"), "m");
  writeFileSync(join(board, "chronicle", "records.log"), "an outside poster's words");
  run("imported-web", { room: { platform: "web", stream: "web:xeno:1" }, imported: true, visibility: "public" }, [
    { seq: 1, t: OLD, type: "message", by: "x", text: "imported" },
  ]);
  run("private-web", { room: { platform: "web", stream: "web:commons:dm" }, visibility: "private" }, [
    { seq: 1, t: OLD, type: "message", by: "x", text: "private" },
  ]);
  run("signal-room", { room: { platform: "signal", stream: "group:abc" }, visibility: "public" }, [
    { seq: 1, t: OLD, type: "message", by: "x", text: "house words" },
  ]);
  return { runs, board };
}

const frames = (dir) => readFileSync(join(dir, "frames.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("only external, non-imported, non-private runs are external", () => {
  assert.equal(isExternalRun({ room: { platform: "web", stream: "web:a:b" } }, isExternalPlace), true);
  assert.equal(isExternalRun({ room: { platform: "web", stream: "web:a:b" }, imported: true }, isExternalPlace), false);
  assert.equal(isExternalRun({ room: { platform: "web", stream: "web:a:b" }, visibility: "private" }, isExternalPlace), false);
  assert.equal(isExternalRun({ room: { platform: "signal", stream: "g" } }, isExternalPlace), false);
});

test("a scan counts what is due and writes nothing", () => {
  const { runs, board } = sandbox();
  const before = readFileSync(join(board, "frames.jsonl"), "utf8");
  const s = scanRetention({ runsDir: runs, days: 90, now: NOW, isExternalPlace });
  assert.equal(s.total, 3, "message, speech, reach — not room.mounted, not the recent post");
  assert.deepEqual(s.runs.map((r) => r.run), ["board-1"]);
  assert.equal(s.runs[0].oldest, OLD);
  assert.match(s.code, /^[0-9a-f]{8}$/);
  assert.equal(readFileSync(join(board, "frames.jsonl"), "utf8"), before);
});

test("a purge needs a fresh code for an unchanged plan", () => {
  const { runs, board } = sandbox();
  const o = { runsDir: runs, days: 90, now: NOW, isExternalPlace };
  assert.equal(purgeRetention({ ...o, confirm: "deadbeef", by: "keeper" }).ok, false);
  const s = proposeRetention(o);
  assert.match(purgeRetention({ ...o, now: NOW + 31 * 60_000, confirm: s.code, by: "keeper" }).error ?? "", /older than 30 minutes/);

  const s2 = proposeRetention(o);
  // the record moves on: another old line lands before the confirm
  writeFileSync(join(board, "frames.jsonl"), readFileSync(join(board, "frames.jsonl"), "utf8") +
    JSON.stringify({ seq: 5, t: OLD, type: "message", by: "web-abc", text: "late" }) + "\n");
  assert.match(purgeRetention({ ...o, confirm: s2.code, by: "keeper" }).error ?? "", /changed since/);
});

test("a confirmed purge removes the words, keeps the shape, frees the blob, clears a closed room's chronicle log", () => {
  const { runs, board } = sandbox();
  const o = { runsDir: runs, days: 90, now: NOW, isExternalPlace };
  const s = proposeRetention(o);
  const r = purgeRetention({ ...o, confirm: s.code, by: "signal-keeper" });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 3);
  const f = frames(board);
  assert.equal(f[0].type, "room.mounted");
  assert.equal(f[0].redacted, undefined);
  assert.equal(f[1].text, removedText(90));
  assert.equal(f[1].by, "web-abc", "who and when stay");
  assert.equal(f[1].redacted.by, "signal-keeper");
  assert.equal(f[2].inline, removedText(90));
  assert.equal(f[2].blob, undefined);
  assert.equal(f[2].preview, undefined);
  assert.deepEqual(f[3].input, {});
  assert.equal(f[4].text, "a recent post", "recent words stay");
  assert.equal(existsSync(join(board, "chronicle", "blobs", SHA.slice(0, 2), SHA)), false, "the blob only that frame used is gone");
  assert.equal(existsSync(join(board, "chronicle", "records.log")), false, "the closed room's frame log is cleared");
  assert.equal(existsSync(join(board, "chronicle", "blobs")), true, "blobs dir kept for trace.mjs to re-seed");
  assert.equal(frames(join(runs, "signal-room"))[0].text, "house words");
  assert.equal(frames(join(runs, "imported-web"))[0].text, "imported");
  assert.equal(scanRetention(o).total, 0, "nothing due after");
});

test("an open room's chronicle log is marked pending, then cleared once it rests", () => {
  const { runs, board } = sandbox();
  const openO = { runsDir: runs, days: 90, now: NOW, isExternalPlace, isOpen: () => true };
  const r = purgeRetention({ ...openO, confirm: proposeRetention(openO).code, by: "k" });
  assert.equal(r.runs[0].chronicle_pending, true);
  assert.equal(existsSync(join(board, "chronicle", "records.log")), true);
  const s = scanRetention(openO);
  assert.equal(s.total, 0);
  assert.equal(s.runs[0].chronicle_pending, true, "a scan still names it");

  const closedO = { ...openO, isOpen: () => false };
  const r2 = purgeRetention({ ...closedO, confirm: proposeRetention(closedO).code, by: "k" });
  assert.equal(r2.runs[0].chronicle_cleared, true);
  assert.equal(existsSync(join(board, "chronicle", "records.log")), false);
  assert.equal(scanRetention(closedO).runs.length, 0);
});

test("the reminder speaks when something is due, at most once a day", () => {
  const { runs } = sandbox();
  const o = { runsDir: runs, days: 90, now: NOW, isExternalPlace };
  const line = retentionReminder(o);
  assert.match(line ?? "", /3 messages in 1 external room are past the 90-day retention/);
  assert.equal(retentionReminder({ ...o, now: NOW + 3_600_000 }), null);
  assert.ok(retentionReminder({ ...o, now: NOW + DAY + 1 }));
});
