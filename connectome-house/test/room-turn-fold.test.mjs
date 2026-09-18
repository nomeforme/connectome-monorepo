// @ts-check
/* connectome-house/test/room-turn-fold.test.mjs — harness-port W3-A,
 * 2026-09-18 (the token-soup fix): room-turn.mjs's own fold no longer
 * writes a frame per streamed `tokens` event (the real probe: 30 speech
 * frames for a 60-token turn, every one `interim: true`, no final). Same
 * real-socket + MockBeing pattern as room-turn-e2e.test.mjs, but asserting
 * frame SHAPES rather than a byte-exact golden fixture — this file is
 * about the fold's own rule, not one scripted conversation's record. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBeing } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "room-turn-fold-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");

const { openRoom, roomInput, restRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");

/** open one synthetic room, attach a scripted MockBeing over a real unix
 * socket, run one addressed turn, and return the resulting frames. */
async function runScriptedTurn(t, streamSuffix, script) {
  const { id, error } = await openRoom({
    platform: "synthetic",
    stream: `room-turn-fold-${streamSuffix}`,
    title: "room-turn-fold.test.mjs fixture",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);

  const sockDir = mkdtempSync(join(tmpdir(), "room-turn-fold-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });
  const being = new MockBeing({ path: sockPath, seatId: `aria-${streamSuffix}`, being: "aria", room: id, script });
  await being.connect();
  t.after(() => being.close());
  t.after(async () => server.close());

  await waitFor(() => (open.get(id)?.seat ? true : null));
  await roomInput({ id, by: "mara", text: "@aria hi there" });
  await waitFor(() => (open.get(id).turn === null ? true : null));
  await restRoom(open.get(id));
  return framesOf(runDir);
}

test("N streamed tokens + one final, no tool call: exactly one speech frame, never per-token", async (t) => {
  const script = [
    { kind: "event", event: { kind: "tokens", text: "Hi " } },
    { kind: "event", event: { kind: "tokens", text: "there, " } },
    { kind: "event", event: { kind: "tokens", text: "friend!" } },
    { kind: "event", event: { kind: "final", text: "Hi there, friend!" } },
  ];
  const frames = await runScriptedTurn(t, "n-tokens", script);
  const speech = frames.filter((f) => f.type === "speech");
  assert.equal(speech.length, 1, `expected exactly one speech frame, got ${JSON.stringify(speech)}`);
  assert.equal(speech[0].interim, undefined, "the one speech frame is the true final, never interim");
  assert.equal(speech[0].inline, "Hi there, friend!");
});

test("a turn with a tool call in the middle: interim segment, then reach + reach.result, then final speech", async (t) => {
  const script = [
    { kind: "event", event: { kind: "tokens", text: "Some " } },
    { kind: "event", event: { kind: "tokens", text: "partial words" } },
    { kind: "event", event: { kind: "final", text: "Some partial words" } },
    { kind: "tool.exec", tool: "lookup", input: { q: "x" } },
    { kind: "event", event: { kind: "final", text: "Here's the answer." } },
  ];
  const frames = await runScriptedTurn(t, "tool-mid", script);
  const turnFrames = frames.filter((f) => ["speech", "reach", "reach.result"].includes(f.type));
  assert.deepEqual(
    turnFrames.map((f) => f.type),
    ["speech", "reach", "reach.result", "speech"],
    `expected interim + reach + reach.result + final, got ${JSON.stringify(turnFrames)}`,
  );
  assert.equal(turnFrames[0].interim, true, "the pre-tool segment is interim");
  assert.equal(turnFrames[0].inline, "Some partial words");
  assert.equal(turnFrames[3].interim, undefined, "the post-tool segment is the true final");
  assert.equal(turnFrames[3].inline, "Here's the answer.");
});

test("an aborted turn discards any buffered final — no partial speech frame, only aborted", async (t) => {
  const script = [
    { kind: "event", event: { kind: "tokens", text: "never " } },
    { kind: "event", event: { kind: "final", text: "never finished" } },
    { kind: "error", message: "simulated provider error" },
  ];
  const frames = await runScriptedTurn(t, "aborted", script);
  const speech = frames.filter((f) => f.type === "speech");
  assert.equal(speech.length, 0, "a buffered final is discarded, never salvaged, on an abnormal end");
  const aborted = frames.filter((f) => f.type === "aborted");
  assert.equal(aborted.length, 1);
});
