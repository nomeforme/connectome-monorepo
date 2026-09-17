// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_TYPES } from "../src/messages.mjs";
import { encodeMessage, decodeLine } from "../src/codec.mjs";
import { SeatProtocolError, validateMessage } from "../src/validators.mjs";

/** one valid fixture per declared message type. */
const FIXTURES = {
  handshake: {
    type: "handshake",
    seq: 0,
    room: "room-1",
    seatId: "seat-1",
    being: { handle: "aria" },
    protocolVersion: 1,
  },
  "turn.begin": {
    type: "turn.begin",
    seq: 1,
    room: "room-1",
    turnId: "t1",
    context: { conversation: [] },
    covenant: { model: "m", tools: ["read"], posture: "present" },
  },
  line: { type: "line", seq: 2, room: "room-1", by: "keeper", text: "hello" },
  interrupt: { type: "interrupt", seq: 3, room: "room-1", by: "keeper" },
  close: { type: "close", seq: 4, room: "room-1", mode: "rest" },
  "tool.result": {
    type: "tool.result",
    seq: 5,
    room: "room-1",
    callId: "c1",
    ok: true,
    content: { text: "42" },
  },
  participant: {
    type: "participant",
    seq: 6,
    room: "room-1",
    action: "joined",
    handle: "aria",
    participantKind: "walker",
  },
  "house.frame": {
    type: "house.frame",
    seq: 7,
    room: "room-1",
    frame: { type: "threshold.receipt", note: "x" },
  },
  "turn.event": {
    type: "turn.event",
    seq: 8,
    room: "room-1",
    turnId: "t1",
    event: { kind: "tokens", text: "hi" },
  },
  "tool.exec": {
    type: "tool.exec",
    seq: 9,
    room: "room-1",
    turnId: "t1",
    callId: "c1",
    tool: "search",
    input: { q: "x" },
  },
  "turn.done": { type: "turn.done", seq: 10, room: "room-1", turnId: "t1", usage: { inputTokens: 1 } },
  "turn.error": { type: "turn.error", seq: 11, room: "room-1", turnId: "t1", message: "boom" },
  ping: { type: "ping", seq: 12, room: "room-1" },
};

test("every declared message type has a round-trip fixture", () => {
  for (const type of MESSAGE_TYPES) {
    assert.ok(FIXTURES[type], `missing fixture for "${type}"`);
  }
  assert.equal(Object.keys(FIXTURES).length, MESSAGE_TYPES.length);
});

for (const [type, fixture] of Object.entries(FIXTURES)) {
  test(`round-trips "${type}"`, () => {
    const line = encodeMessage(fixture);
    assert.ok(line.endsWith("\n"));
    const decoded = decodeLine(line.slice(0, -1));
    assert.deepEqual(decoded, fixture);
  });
}

test("rejects a message missing a required field", () => {
  assert.throws(() => validateMessage({ type: "line", seq: 0, room: "r" }), SeatProtocolError);
});

test("rejects an unknown message type", () => {
  assert.throws(() => validateMessage({ type: "not-a-verb", seq: 0, room: "r" }), SeatProtocolError);
});

test("rejects a close with an out-of-enum mode", () => {
  assert.throws(
    () => validateMessage({ type: "close", seq: 0, room: "r", mode: "dissolved" }),
    SeatProtocolError,
  );
});

test("decodeLine throws SeatProtocolError on bad JSON, not a bare SyntaxError", () => {
  assert.throws(() => decodeLine("not json"), SeatProtocolError);
});
