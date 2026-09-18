// @ts-check
/* connectome-house/test/walker-tools-e2e.test.mjs — harness-port W1-R's
 * own proof: the four modules become one working path. A real spawned
 * serve.mjs (test/lib/serve-harness.mjs), HOUSE_MOCK_MODEL=1, and NO
 * HOUSE_WALKER_ENTRY override — serve-walks.mjs's own walkerCommand()
 * therefore resolves the REAL src/walker.mjs (W-A's own entry point),
 * never test/lib/stub-walker.mjs. A being's turn (room-turn.mjs) begins
 * over a real unix-socket seat; the mock adapter's own scripted turn
 * (mock-adapter.mjs's mockHouseTool script, HOUSE_MOCK_HOUSE_TOOL=1) calls
 * record_list, a W-B house tool, which room-turn-tools.mjs's
 * `handleToolExec` routes to `executeHouseTool` — framed ONCE, by
 * record-tools.mjs's own `ctx.trace` (never a second time by room-turn.
 * mjs's generic reach/reach.result fallback, which a house tool must
 * never also get). Also proves `beginTurn`'s own `context.room` addition
 * (task 1a) actually reached the walker process, via its own stderr log
 * line (surfaced through serve.mjs's own stderr — serve-walks.mjs
 * re-emits a spawned walker's stdout/stderr as `console.error("[walker
 * <roomId>] ...")`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, makeServeHarness, waitFor } from "./lib/serve-harness.mjs";

const sockDir = mkdtempSync(join(tmpdir(), "walker-tools-e2e-sock-"));
const sockPath = join(sockDir, "seat.sock");

// serve-walks.test.mjs's own header explains this gate: /api/live/input
// only passes mayTouch for a room's owner, an accepted participant, or a
// caller whose own roles claim "keeper".
const marasHeaders = { "x-house-user": "mara", "x-house-roles": "keeper", "x-house-home": "testbox" };

const harness = makeServeHarness("walker-tools-e2e", {
  HOUSE_SEAT_ADDR: `unix:${sockPath}`,
  HOUSE_MOCK_MODEL: "1",
  HOUSE_MOCK_HOUSE_TOOL: "1",
});

test("real walker.mjs: a house tool's tool.exec is framed once, context.room reaches the walker, and speech closes the turn", async (t) => {
  writeTestament(harness.roots.covenants, "aria");
  mkdirSync(join(harness.roots.private, "mara"), { recursive: true });
  await harness.start();
  t.after(() => harness.stop());
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));

  const { id, res: openRes } = await harness.openRoom(
    {},
    {
      platform: "synthetic",
      stream: "walker-tools-e2e-1",
      title: "walker-tools-e2e.test.mjs",
      beings: ["aria"],
    },
  );
  assert.ok(id, `room should open: ${JSON.stringify(openRes.json)}`);

  // spawn the REAL walker.mjs for this room (no HOUSE_WALKER_ENTRY override
  // in this harness's own env — serve-walks.mjs's walkerCommand() falls to
  // its own conventional src/walker.mjs, which now exists).
  let r = await harness.api(`/api/rooms/${id}/walker/spawn`, { method: "POST", body: { being: "aria" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.attached, true, "the real walker.mjs should attach within the spawn's own timeout");

  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id, text: "@aria can you check the record?" },
  });
  await waitFor(() =>
    framesOf(join(harness.roots.runs, id)).some((f) => f.type === "speech" && !f.interim && f.by === "aria")
      ? true
      : null,
  );

  const frames = framesOf(join(harness.roots.runs, id));

  // one reach + one reach.result for record_list — framed ONCE, by
  // record-tools.mjs's own ctx.trace, never a second time by room-turn.
  // mjs's generic fallback path (which would double it for a house tool).
  const reaches = frames.filter((f) => f.type === "reach" && f.tool === "record_list");
  const results = frames.filter((f) => f.type === "reach.result");
  assert.equal(reaches.length, 1, `record_list should be reached exactly once: ${JSON.stringify(frames)}`);
  assert.equal(results.length, 1, "exactly one reach.result — no duplicate frame from the generic path");
  assert.equal(results[0].callId, reaches[0].callId);
  assert.equal(results[0].ok, true, `record_list should succeed: ${JSON.stringify(results[0])}`);

  const speech = frames.find((f) => f.type === "speech" && !f.interim);
  assert.ok(speech, "the turn should close with a final speech frame");
  assert.equal(speech.by, "aria");

  // beginTurn's own `room: {id, participants, being}` addition (task 1a)
  // actually reached the walker process — its own stderr log line,
  // surfaced through serve.mjs's own stderr (serve-walks.mjs re-emits a
  // spawned walker's stdio as `[walker <roomId>] ...`).
  const err = harness.stderr();
  const logLine = err.split("\n").find((l) => l.includes("turn.begin context.room="));
  assert.ok(logLine, `walker's own turn.begin log line should appear in serve's stderr:\n${err.slice(-2000)}`);
  const roomPayload = JSON.parse(logLine.slice(logLine.indexOf("context.room=") + "context.room=".length));
  assert.equal(roomPayload.id, id, "the walker's received context.room.id should equal the room id");
  assert.equal(roomPayload.being, "aria");
});
