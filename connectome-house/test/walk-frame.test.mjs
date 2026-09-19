// @ts-check
/* connectome-house/test/walk-frame.test.mjs — pins for the wire-level
 * tool-call round trip (src/walk-frame.mjs). Rewritten from the reference
 * harness's walk-frame.test.mjs (a LOCAL trace.mjs writer, traceReach):
 * this port's walk-frame.mjs never writes a frame itself — the house is
 * the record's sole writer (room-turn.mjs's handleToolExec already
 * appends reach/reach.result) — so these pins cover the seat round trip
 * instead: one tool.exec sent, resolved by its matching tool.result. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execViaHouse, makePendingToolCalls } from "../src/walk-frame.mjs";

function fakeSeat() {
  const sent = [];
  return { sent, send: (msg) => (sent.push(msg), true) };
}

test("execViaHouse: sends one tool.exec, resolves once the matching tool.result settles", async () => {
  const seat = fakeSeat();
  const pending = makePendingToolCalls();
  const call = { id: "c1", name: "some_tool", input: { a: 1 } };
  const p = execViaHouse(seat, "room-1", "t1", call, pending);
  assert.deepEqual(seat.sent, [{ type: "tool.exec", room: "room-1", turnId: "t1", callId: "c1", tool: "some_tool", input: { a: 1 } }]);
  assert.equal(pending.size(), 1);
  const handled = pending.settle({ callId: "c1", ok: true, content: "hello" });
  assert.equal(handled, true);
  assert.deepEqual(await p, { toolUseId: "c1", content: "hello", isError: false });
  assert.equal(pending.size(), 0);
});

test("execViaHouse: a refusal (ok:false) becomes an errored ToolResult", async () => {
  const seat = fakeSeat();
  const pending = makePendingToolCalls();
  const p = execViaHouse(seat, "room-1", "t1", { id: "c2", name: "archive_read", input: {} }, pending);
  pending.settle({ callId: "c2", ok: false, content: "archive_read is not offered here" });
  assert.deepEqual(await p, { toolUseId: "c2", content: "archive_read is not offered here", isError: true });
});

test("execViaHouse: input defaults to {} when the call carries none", async () => {
  const seat = fakeSeat();
  const pending = makePendingToolCalls();
  const call = { id: "c3", name: "no_args_tool", input: undefined };
  const p = execViaHouse(seat, "room-1", "t1", call, pending);
  assert.deepEqual(seat.sent[0].input, {});
  pending.settle({ callId: "c3", ok: true, content: "" });
  await p;
});

test("makePendingToolCalls.settle: an unknown callId is ignored, never throws", () => {
  const pending = makePendingToolCalls();
  assert.equal(pending.settle({ callId: "ghost", ok: true, content: "x" }), false);
});

test("makePendingToolCalls: two in-flight calls resolve independently by callId", async () => {
  const seat = fakeSeat();
  const pending = makePendingToolCalls();
  const p1 = execViaHouse(seat, "room-1", "t1", { id: "a", name: "x", input: {} }, pending);
  const p2 = execViaHouse(seat, "room-1", "t1", { id: "b", name: "y", input: {} }, pending);
  pending.settle({ callId: "b", ok: true, content: "second" });
  pending.settle({ callId: "a", ok: true, content: "first" });
  assert.equal((await p1).content, "first");
  assert.equal((await p2).content, "second");
});
