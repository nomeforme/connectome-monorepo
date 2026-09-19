// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_TYPES, PLATFORM_ROOM } from "../src/messages.mjs";
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
  "platform.hello": {
    type: "platform.hello",
    seq: 13,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    platform: "discord",
    being: "aria",
    tools: ["send_message", "reply_message"],
    channels: [{ id: "discord:555:555" }],
  },
  "platform.incoming": {
    type: "platform.incoming",
    seq: 14,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    msg: { envelope: "incoming", eventId: "e1", channelId: "discord:555:555", text: "hi" },
  },
  "platform.history": {
    type: "platform.history",
    seq: 15,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    channelId: "discord:555:555",
    messages: [{ envelope: "history", eventId: "e0", channelId: "discord:555:555", text: "old" }],
  },
  "platform.channels": {
    type: "platform.channels",
    seq: 16,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    channels: [{ id: "discord:555:555" }],
  },
  "platform.result": {
    type: "platform.result",
    seq: 17,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    id: "call-1",
    ok: true,
    result: { messageId: "m1" },
  },
  "platform.child": {
    type: "platform.child",
    seq: 18,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    state: "ready",
  },
  "platform.call": {
    type: "platform.call",
    seq: 19,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    id: "call-1",
    name: "send_message",
    args: { channelId: "discord:555:555", content: "hi" },
  },
  "platform.notify": {
    type: "platform.notify",
    seq: 20,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    method: "channels/typing",
    params: { channelId: "discord:555:555", typing: true },
  },
  "platform.open": {
    type: "platform.open",
    seq: 21,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    id: "open-1",
    channelId: "discord:555:555",
    history: { limit: 50 },
  },
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

// harness-port R2-W, 2026-09-17: the OPTIONAL resumeFromSeq handshake field.
test("a handshake WITHOUT resumeFromSeq still round-trips (back-compat: the field is optional)", () => {
  const line = encodeMessage(FIXTURES.handshake);
  assert.deepEqual(decodeLine(line.slice(0, -1)), FIXTURES.handshake);
});

test("a handshake WITH resumeFromSeq round-trips", () => {
  const withResume = { ...FIXTURES.handshake, resumeFromSeq: 7 };
  const line = encodeMessage(withResume);
  assert.deepEqual(decodeLine(line.slice(0, -1)), withResume);
});

test("rejects a negative resumeFromSeq", () => {
  assert.throws(
    () => validateMessage({ ...FIXTURES.handshake, resumeFromSeq: -1 }),
    SeatProtocolError,
  );
});

// harness-port P-A (parity round, 2026-09-17): three OPTIONAL turn.begin
// fields — !mt's maxTokens and !sysprompt's systemPromptOverride (both
// inside `covenant`), and the top-level `continue` flag (!continue/m
// continue) — connectome-house/src/room-turn.mjs's own consumers.

test("a turn.begin WITHOUT any of the three new optional fields still round-trips (back-compat)", () => {
  const line = encodeMessage(FIXTURES["turn.begin"]);
  assert.deepEqual(decodeLine(line.slice(0, -1)), FIXTURES["turn.begin"]);
});

test("a turn.begin WITH covenant.maxTokens and covenant.systemPromptOverride round-trips", () => {
  const withOverrides = {
    ...FIXTURES["turn.begin"],
    covenant: { ...FIXTURES["turn.begin"].covenant, maxTokens: 500, systemPromptOverride: "be terser" },
  };
  const line = encodeMessage(withOverrides);
  assert.deepEqual(decodeLine(line.slice(0, -1)), withOverrides);
});

test("a turn.begin WITH continue:true round-trips", () => {
  const withContinue = { ...FIXTURES["turn.begin"], continue: true };
  const line = encodeMessage(withContinue);
  assert.deepEqual(decodeLine(line.slice(0, -1)), withContinue);
});

test("rejects a negative covenant.maxTokens", () => {
  assert.throws(
    () =>
      validateMessage({
        ...FIXTURES["turn.begin"],
        covenant: { ...FIXTURES["turn.begin"].covenant, maxTokens: 0 },
      }),
    SeatProtocolError,
  );
});

test("rejects a non-boolean top-level continue", () => {
  assert.throws(
    () => validateMessage({ ...FIXTURES["turn.begin"], continue: "yes" }),
    SeatProtocolError,
  );
});

// harness-port W6, 2026-09-19: the nine platform.* messages — every one
// carries the PLATFORM_ROOM sentinel, never a real room id.

test("every platform.* fixture carries the PLATFORM_ROOM sentinel, not a real room", () => {
  for (const [type, fixture] of Object.entries(FIXTURES)) {
    if (type.startsWith("platform.")) assert.equal(fixture.room, PLATFORM_ROOM);
  }
});

test("rejects a platform.hello missing tools/channels", () => {
  assert.throws(
    () =>
      validateMessage({
        type: "platform.hello",
        seq: 0,
        room: PLATFORM_ROOM,
        server: "s",
        platform: "discord",
        being: "aria",
      }),
    SeatProtocolError,
  );
});

test("a platform.result with ok:false and an error string round-trips", () => {
  const failed = {
    type: "platform.result",
    seq: 22,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    id: "call-2",
    ok: false,
    error: "the server lists no tool named nudge",
  };
  const line = encodeMessage(failed);
  assert.deepEqual(decodeLine(line.slice(0, -1)), failed);
});

test("rejects a platform.child with an out-of-enum state", () => {
  assert.throws(
    () =>
      validateMessage({
        type: "platform.child",
        seq: 0,
        room: PLATFORM_ROOM,
        server: "s",
        state: "sleeping",
      }),
    SeatProtocolError,
  );
});

test("a platform.open WITHOUT history still round-trips (history is optional)", () => {
  const noHistory = {
    type: "platform.open",
    seq: 23,
    room: PLATFORM_ROOM,
    server: "discord-pilot",
    id: "open-2",
    channelId: "discord:555:555",
  };
  const line = encodeMessage(noHistory);
  assert.deepEqual(decodeLine(line.slice(0, -1)), noHistory);
});
