// @ts-check
/* connectome-house/test/walk-stdin-verbs.test.mjs — the walker's own
 * STDIO transport (src/walk-stdin-verbs.mjs). Rewritten from the
 * reference harness's walk-stdin-verbs.test.mjs (a house-side tree
 * dispatcher, `handleStdinVerb`): this port's module is the WALKER side
 * of a stdio seat instead — these pins cover its own normalize/dispatch
 * and send-encoding contract directly. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StdioSeat } from "../src/walk-stdin-verbs.mjs";

test("StdioSeat.send: encodes a message as one \\x01-prefixed JSON line", () => {
  const seat = new StdioSeat();
  const chunks = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => (chunks.push(s), true);
  try {
    seat.send({ type: "turn.event", turnId: "t1", event: { kind: "tokens", text: "hi" } });
  } finally {
    process.stdout.write = origWrite;
  }
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].startsWith("\x01"));
  assert.deepEqual(JSON.parse(chunks[0].slice(1)), {
    type: "turn.event",
    turnId: "t1",
    event: { kind: "tokens", text: "hi" },
  });
});

test("StdioSeat._dispatch: a type-keyed message reaches its own listener untouched", () => {
  const seat = new StdioSeat();
  const seen = [];
  seat.on("interrupt", (msg) => seen.push(msg));
  seat._dispatch({ type: "interrupt", by: "house" });
  assert.deepEqual(seen, [{ type: "interrupt", by: "house" }]);
});

test("StdioSeat._dispatch: a wildcard listener sees every message type", () => {
  const seat = new StdioSeat();
  const seen = [];
  seat.on("*", (msg) => seen.push(msg.type));
  seat._dispatch({ type: "line", by: "mara", text: "hi" });
  seat._dispatch({ type: "close", mode: "rest" });
  assert.deepEqual(seen, ["line", "close"]);
});

test("isLive/close: live until closed", () => {
  const seat = new StdioSeat();
  assert.equal(seat.isLive(), true);
  seat.close();
  assert.equal(seat.isLive(), false);
});
