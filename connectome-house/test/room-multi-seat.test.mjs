// @ts-check
/* connectome-house/test/room-multi-seat.test.mjs — harness-port W7,
 * 2026-09-19: the live bug's own regression test (2026-09-19 20:45, see
 * this task's own mission) — a Discord pilot room with TWO beings
 * present, each its own always-on walker; a mention naming the SECOND
 * being activated it, but the room's old ONE seat could only ever answer
 * for whichever being already held it — the second being's walker just
 * sat there typing, no turn, no reply, no log, nothing to stop it.
 *
 * Two halves:
 *   - an in-process pair (no spawned walker at all — the same pattern
 *     commands-wired.test.mjs/room-turn-settings.test.mjs already use):
 *     `roomInput` reports an addressed-but-unseated target by name, never
 *     silently; `applyInputAction` (mcpl/room-tails.mjs) releases THAT
 *     target's own typing indicator, by name, through a hand-rolled mock
 *     of the `turns` object mcpl/seat.mjs's own createTurns produces (the
 *     mission's own "mock MCPL seat" — the real thing is a per-stream
 *     typing loop scoped to one seat's own being; this is that same
 *     shape, driven directly rather than through a live mock platform
 *     server, for a fast, deterministic assertion on the exact reason
 *     string).
 *   - a real end-to-end pair (test/walker-multi-room.test.mjs's own
 *     pattern, doubled): a real spawned `serve.mjs` (test/lib/
 *     serve-harness.mjs), TWO real `src/walker.mjs` processes (mock
 *     model), beings A and B both present in ONE room. Proves: a mention
 *     naming only A runs only A's turn; only B, only B's; addressing BOTH
 *     runs both, independently; A's walker exiting (SIGTERM) drops only
 *     A's own seat, never B's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------
// half 1: in-process, no spawned walker — roomInput's own `unseated`
// report, and applyInputAction's typing release. Own sandboxed roots,
// set BEFORE the first import (every in-process test file's own
// convention) — independent of half 2's spawned-child roots below.
// ---------------------------------------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), "room-multi-seat-unseated-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });

const { writeTestament } = await import("./lib/fixtures.mjs");
writeTestament(process.env.HOUSE_COVENANTS_DIR, "gustav-w7");
writeTestament(process.env.HOUSE_COVENANTS_DIR, "ghost-w7");

const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { applyInputAction } = await import("../src/mcpl/room-tails.mjs");

test("roomInput: an addressed being present in the roster but with no seat at all is reported unseated, never silently dropped", async () => {
  const { id, error } = await openRoom({
    platform: "synthetic",
    stream: "room-multi-seat-unseated-1",
    title: "unseated fixture",
    beings: ["gustav-w7", "ghost-w7"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const r = await roomInput({ id, by: "mara", text: "@ghost-w7 are you there?" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.started, [], "nothing started — ghost-w7 has no seat to begin a turn on");
  assert.deepEqual(r.unseated, ["ghost-w7"], "roomInput names the addressed-but-unseated target");
});

test("applyInputAction: an unseated target's own MCPL seat has its typing released, by name, with the reason mission text names verbatim", async () => {
  const stopped = [];
  const ended = [];
  const mockTurns = {
    end: (stream, being, reason) => ended.push({ stream, being, reason }),
    stopTyping: (stream, reason) => stopped.push({ stream, reason }),
  };
  // this seat speaks for ghost-w7 — the exact target roomInput reports unseated.
  const mockRoomInput = async () => ({ ok: true, started: [], unseated: ["ghost-w7"] });
  await applyInputAction(
    {
      cfg: { platform: "synthetic", being: "ghost-w7" },
      roomInput: mockRoomInput,
      relay: { markPlatformOrigin: () => {} },
      turns: mockTurns,
      pendingReply: { push: () => {} },
      stats: { inputs: 0 },
      streaks: new Map(),
      linkGate: { notifyUnlinkedRoom: () => {} },
      addParticipant: () => {},
    },
    {
      by: "mara",
      by_kind: "human",
      home: "testbox",
      text: "@ghost-w7 hi",
      targets: ["ghost-w7"],
      observe: false,
      stream: "s1",
      external: { platform: "synthetic" },
    },
    { msg: { messageId: null }, runDir: join(process.env.HOUSE_RUNS_DIR, "unused"), attachments: [], roomId: "unused" },
  );
  assert.deepEqual(ended, [{ stream: "s1", being: "ghost-w7", reason: "no seat" }]);
  assert.deepEqual(
    stopped,
    [{ stream: "s1", reason: "no seat for the being" }],
    "this seat's OWN being was in roomInput's own unseated list — typing released",
  );
});

test("applyInputAction: an unseated target that is NOT this seat's own being never touches this seat's own typing", async () => {
  const stopped = [];
  const mockTurns = { end: () => {}, stopTyping: (stream, reason) => stopped.push({ stream, reason }) };
  const mockRoomInput = async () => ({ ok: true, started: [], unseated: ["some-other-being"] });
  await applyInputAction(
    {
      cfg: { platform: "synthetic", being: "gustav-w7" },
      roomInput: mockRoomInput,
      relay: { markPlatformOrigin: () => {} },
      turns: mockTurns,
      pendingReply: { push: () => {} },
      stats: { inputs: 0 },
      streaks: new Map(),
      linkGate: { notifyUnlinkedRoom: () => {} },
      addParticipant: () => {},
    },
    {
      by: "mara",
      by_kind: "human",
      home: "testbox",
      text: "@some-other-being hi",
      targets: ["some-other-being"],
      observe: false,
      stream: "s2",
      external: { platform: "synthetic" },
    },
    { msg: { messageId: null }, runDir: join(process.env.HOUSE_RUNS_DIR, "unused"), attachments: [], roomId: "unused" },
  );
  assert.deepEqual(stopped, [], "gustav-w7's own seat never stops typing over a DIFFERENT being's unseated report");
});

// ---------------------------------------------------------------------
// half 2: real end-to-end — a spawned serve.mjs, two real walker.mjs
// processes (mock model), one room, both beings present.
// ---------------------------------------------------------------------
const { framesOf, makeServeHarness, waitFor } = await import("./lib/serve-harness.mjs");

const sockDir = mkdtempSync(join(tmpdir(), "room-multi-seat-sock-"));
const sockPath = join(sockDir, "seat.sock");
const marasHeaders = { "x-house-user": "mara", "x-house-roles": "keeper", "x-house-home": "testbox" };
const harness = makeServeHarness("room-multi-seat", {
  HOUSE_SEAT_ADDR: `unix:${sockPath}`,
  HOUSE_MOCK_MODEL: "1",
});

/** poll an async predicate — every check here is an HTTP round trip
 * against the spawned serve.mjs (waitFor, serve-harness.mjs, only takes a
 * SYNC fn — walker-multi-room.test.mjs's own async twin). */
async function waitForAsync(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`condition never became true within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const finalSpeechesBy = (frames, who) => frames.filter((f) => f.type === "speech" && !f.interim && f.by === who);

test("one room, two beings, two real walkers: a mention runs only its own turn; addressing both runs both, independently; one walker's exit drops only its own seat", async (t) => {
  const A = "kestrelw7";
  const B = "lindenw7";
  writeTestament(harness.roots.covenants, A);
  writeTestament(harness.roots.covenants, B);
  mkdirSync(join(harness.roots.private, "mara"), { recursive: true });
  await harness.start();
  t.after(() => harness.stop());
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));

  const { id: roomId } = await harness.openRoom({}, {
    platform: "synthetic",
    stream: "room-multi-seat-1",
    title: "room multi-seat e2e",
    beings: [A, B],
  });
  assert.ok(roomId, "the room should open with both beings in its roster");

  // two REAL walker.mjs processes, one per being — no --room at all
  // (serve-walks.mjs's own per-being spawn, W4-A).
  const rA = await harness.api(`/api/rooms/${roomId}/walker/spawn`, { method: "POST", body: { being: A } });
  assert.equal(rA.status, 200, JSON.stringify(rA.json));
  assert.equal(rA.json.attached, true, "A's real walker.mjs should attach within the spawn's own timeout");
  const pidA = rA.json.pid;

  const rB = await harness.api(`/api/rooms/${roomId}/walker/spawn`, { method: "POST", body: { being: B } });
  assert.equal(rB.status, 200, JSON.stringify(rB.json));
  assert.equal(rB.json.attached, true, "B's real walker.mjs should attach within the spawn's own timeout");
  const pidB = rB.json.pid;
  assert.notEqual(pidA, pidB, "two independent walker processes, one per being");

  // W7's own new per-being surface (serve-walks.mjs's handleRoomWalkerGet):
  // both beings hold their own seat, in this one room.
  const walkerRow = await harness.api(`/api/rooms/${roomId}/walker`);
  const beingsSeated = walkerRow.json.walkers.map((w) => w.being).sort();
  assert.deepEqual(beingsSeated, [A, B].sort(), "both beings hold their own seat in this one room");

  // 1. a mention naming ONLY A: only A's turn runs.
  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id: roomId, text: `@${A} hello, only you` },
  });
  await waitFor(() => (finalSpeechesBy(framesOf(join(harness.roots.runs, roomId)), A).length >= 1 ? true : null));
  let frames = framesOf(join(harness.roots.runs, roomId));
  assert.equal(finalSpeechesBy(frames, A).length, 1, "exactly one speech from A");
  assert.equal(finalSpeechesBy(frames, B).length, 0, "B never turned — it was never addressed");

  // 2. a mention naming ONLY B: only B's turn runs.
  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id: roomId, text: `@${B} hello, only you` },
  });
  await waitFor(() => (finalSpeechesBy(framesOf(join(harness.roots.runs, roomId)), B).length >= 1 ? true : null));
  frames = framesOf(join(harness.roots.runs, roomId));
  assert.equal(finalSpeechesBy(frames, A).length, 1, "A's own count is unchanged — it was not re-addressed");
  assert.equal(finalSpeechesBy(frames, B).length, 1, "exactly one speech from B");

  // 3. addressing BOTH runs both turns, independently — the exact bug
  // this task fixes: "address both" now means both actually answer.
  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id: roomId, text: `@${A} @${B} both of you, please` },
  });
  await waitFor(() => (finalSpeechesBy(framesOf(join(harness.roots.runs, roomId)), A).length >= 2 ? true : null));
  await waitFor(() => (finalSpeechesBy(framesOf(join(harness.roots.runs, roomId)), B).length >= 2 ? true : null));
  frames = framesOf(join(harness.roots.runs, roomId));
  assert.equal(finalSpeechesBy(frames, A).length, 2, "A's second turn ran");
  assert.equal(finalSpeechesBy(frames, B).length, 2, "B's second turn ran too — both, independently");

  // 4. A's walker dies (SIGTERM): only A's own seat is gone; B is untouched.
  process.kill(pidA, "SIGTERM");
  await waitForAsync(async () => {
    const res = await harness.api(`/api/rooms/${roomId}/walker`);
    const beings = res.json.walkers.map((w) => w.being);
    return !beings.includes(A) && beings.includes(B) ? true : null;
  });

  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id: roomId, text: `@${B} still there?` },
  });
  await waitFor(() => (finalSpeechesBy(framesOf(join(harness.roots.runs, roomId)), B).length >= 3 ? true : null));
  frames = framesOf(join(harness.roots.runs, roomId));
  assert.equal(finalSpeechesBy(frames, B).length, 3, "B still answers after A's own walker exited");
});
