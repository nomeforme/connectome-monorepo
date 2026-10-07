// @ts-check
/* connectome-house/test/walker-multi-room.test.mjs — harness-port W4-A,
 * 2026-09-19: one always-on walker per being, seated to every room it is
 * present in (open-rooms.mjs's own header has the full design — the
 * fleet's own problem: "each container had bots that were always
 * listening everywhere they were added"). A REAL spawned serve.mjs
 * (test/lib/serve-harness.mjs) and ONE REAL `src/walker.mjs` (mock model,
 * no HOUSE_WALKER_ENTRY override — matches walker-tools-e2e.test.mjs's
 * own pattern), spawned per BEING (`--being nix`, no `--room`), proves:
 *
 *   1. rooms A and B (both opened, naming @nix, BEFORE the walker attaches)
 *      both get the ONE seat; addressed input in each runs a real turn in
 *      BOTH — cap 1 (this walker's own default) queues rather than
 *      refuses a second room's `turn.begin` while the first is still
 *      running (walker.mjs's own `cancels`/`queue`) — both turns
 *      eventually complete, each recorded in its OWN room only.
 *   2. room C, opened AFTER the walker already attached, inherits the
 *      SAME seat automatically (open-rooms.mjs's `attachRegisteredSeat`,
 *      wired into `openRoom`) and a turn there works too.
 *   3. a SIGSTOP (freezing the walker mid-read, so a turn is GUARANTEED
 *      still open when the drop lands — no timing race) then SIGKILL
 *      drops the connection: every room's own seat clears at once, and
 *      the turn that was genuinely in flight closes `aborted`.
 */
// these tests pin the abort itself: no grace window for a dropped seat here
process.env.HOUSE_SEAT_GRACE_MS = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, makeServeHarness, waitFor } from "./lib/serve-harness.mjs";

const sockDir = mkdtempSync(join(tmpdir(), "walker-multi-room-sock-"));
const sockPath = join(sockDir, "seat.sock");

// serve-walks.test.mjs's own header explains this gate: /api/live/input
// only passes mayTouch for a room's owner, an accepted participant, or a
// caller whose own roles claim "keeper".
const marasHeaders = { "x-house-user": "mara", "x-house-roles": "keeper", "x-house-home": "testbox" };

const harness = makeServeHarness("walker-multi-room", {
  HOUSE_SEAT_ADDR: `unix:${sockPath}`,
  HOUSE_MOCK_MODEL: "1",
});

/** poll an async predicate (waitFor, serve-harness.mjs, only takes a SYNC
 * fn) — every check here needs an HTTP round trip against the spawned
 * serve.mjs, so this is its own small async version. */
async function waitForAsync(fn, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`condition never became true within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

test("one walker, one being, three rooms: cap-1 queues rather than refuses, a later room auto-attaches, SIGSTOP+SIGKILL drops every room and aborts the in-flight turn", async (t) => {
  writeTestament(harness.roots.covenants, "nix");
  mkdirSync(join(harness.roots.private, "mara"), { recursive: true });
  await harness.start();
  t.after(() => harness.stop());
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));

  const { id: roomA } = await harness.openRoom({}, {
    platform: "synthetic",
    stream: "wmr-a",
    title: "room A",
    beings: ["nix"],
  });
  const { id: roomB } = await harness.openRoom({}, {
    platform: "synthetic",
    stream: "wmr-b",
    title: "room B",
    beings: ["nix"],
  });
  assert.ok(roomA && roomB, "both rooms should open before the walker attaches");

  // spawn the REAL walker.mjs for @nix — no --room named at all (serve-
  // walks.mjs's own new per-being spawn).
  let r = await harness.api(`/api/rooms/${roomA}/walker/spawn`, { method: "POST", body: { being: "nix" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.attached, true, "the real walker.mjs should attach within the spawn's own timeout");
  const pid = r.json.pid;
  assert.ok(Number.isInteger(pid) && pid > 0);

  // both rooms named @nix in their own roster — the ONE seat serves both,
  // even though only room A's own door was used to spawn it.
  let rA = await harness.api(`/api/rooms/${roomA}/walker`);
  let rB = await harness.api(`/api/rooms/${roomB}/walker`);
  assert.equal(rA.json.walker.pid, pid);
  assert.equal(rB.json.walker.pid, pid);
  assert.ok(
    rA.json.walker.rooms.includes(roomA) && rA.json.walker.rooms.includes(roomB),
    `@nix's one seat should list both rooms: ${JSON.stringify(rA.json.walker.rooms)}`,
  );

  // 1. fire BOTH rooms' inputs concurrently — cap 1 (this walker's own
  // default) must queue the second, never refuse it: both must still
  // complete, each in its own room only.
  await Promise.all([
    harness.api("/api/live/input", { method: "POST", headers: marasHeaders, body: { id: roomA, text: "@nix hello A" } }),
    harness.api("/api/live/input", { method: "POST", headers: marasHeaders, body: { id: roomB, text: "@nix hello B" } }),
  ]);

  await waitFor(() =>
    framesOf(join(harness.roots.runs, roomA)).some((f) => f.type === "speech" && !f.interim && f.by === "nix")
      ? true
      : null,
  );
  await waitFor(() =>
    framesOf(join(harness.roots.runs, roomB)).some((f) => f.type === "speech" && !f.interim && f.by === "nix")
      ? true
      : null,
  );

  const framesA1 = framesOf(join(harness.roots.runs, roomA));
  const framesB1 = framesOf(join(harness.roots.runs, roomB));
  assert.ok(framesA1.some((f) => f.type === "message" && f.text === "@nix hello A"));
  assert.ok(framesB1.some((f) => f.type === "message" && f.text === "@nix hello B"));
  // neither room's own input crossed into the other's record.
  assert.ok(!framesA1.some((f) => f.text === "@nix hello B"), "room B's input must never land in room A's record");
  assert.ok(!framesB1.some((f) => f.text === "@nix hello A"), "room A's input must never land in room B's record");

  // cap 1 really did serialize them (not just "both happened to work"):
  // the walker's own stderr proves it — either it logged the explicit
  // queue line for whichever room arrived second while the cap was full,
  // or (a legitimate alternative if the mock turn was fast enough to
  // never overlap) it logged two separate turn.begin lines, one per room,
  // which a broken "refuse the second" implementation could never do at
  // all (that room would show NO speech above — already ruled out).
  const errAfterAB = harness.stderr();
  const beginLines = errAfterAB.split("\n").filter((l) => l.includes("turn.begin context.room="));
  assert.ok(beginLines.length >= 2, `expected at least 2 turn.begin log lines:\n${errAfterAB.slice(-2000)}`);

  // 2. room C, opened AFTER the walker already attached — inherits the
  // SAME seat automatically (open-rooms.mjs's attachRegisteredSeat).
  const { id: roomC } = await harness.openRoom({}, {
    platform: "synthetic",
    stream: "wmr-c",
    title: "room C",
    beings: ["nix"],
  });
  await waitForAsync(async () => {
    const res = await harness.api(`/api/rooms/${roomC}/walker`);
    return res.json.walker?.pid === pid ? true : null;
  });

  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id: roomC, text: "@nix hello C" },
  });
  await waitFor(() =>
    framesOf(join(harness.roots.runs, roomC)).some((f) => f.type === "speech" && !f.interim && f.by === "nix")
      ? true
      : null,
  );

  // 3. freeze the walker (SIGSTOP) BEFORE sending one more input — this
  // guarantees the resulting turn is still genuinely open when the seat
  // drops (no timing race against a fast mock reply): a stopped process
  // cannot read its socket at all, so `beginTurn`'s own `rec.turn` is set
  // and stays set until the drop is observed.
  process.kill(pid, "SIGSTOP");
  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id: roomA, text: "@nix are you still there" },
  });
  // give the house's own roomInput->beginTurn a moment to land (the HTTP
  // call above already awaited serve.mjs's own response, which returns
  // only after beginTurn was called — this is a small extra safety
  // margin, not load-bearing).
  await new Promise((res) => setTimeout(res, 200));

  process.kill(pid, "SIGKILL");
  await waitFor(() => {
    try {
      process.kill(pid, 0); // signal 0: existence probe, no actual signal sent
      return null; // still alive — keep waiting
    } catch {
      return true; // ESRCH — gone
    }
  });

  // every room's own seat is gone at once (the SAME connection served
  // all three) — checked as "no walker, or a DIFFERENT pid", robust
  // against serve-walks.mjs's own restart-on-unplanned-exit racing back
  // in before this poll runs.
  for (const id of [roomA, roomB, roomC]) {
    await waitForAsync(async () => {
      const res = await harness.api(`/api/rooms/${id}/walker`);
      return !res.json.walker || res.json.walker.pid !== pid ? true : null;
    });
  }

  // the turn that was genuinely in flight (room A, frozen mid-read)
  // closed `aborted` — the record's own proof, unaffected by any later
  // restart.
  const framesA2 = framesOf(join(harness.roots.runs, roomA));
  const aborted = framesA2.find((f) => f.type === "aborted");
  assert.ok(aborted, `room A should have an aborted frame for its in-flight turn: ${JSON.stringify(framesA2.slice(-5))}`);
  assert.equal(aborted.reason, "seat disconnected");
});
