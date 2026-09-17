// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketSeatServer } from "@connectome/seat-protocol";
import { MockBeing } from "../src/mock-being.mjs";
import { SeatClient } from "../src/seat-client.mjs";

/** a fresh unix socket path in its own mkdtemp dir. */
function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), "seat-client-test-"));
  return { dir, path: join(dir, "seat.sock") };
}

/** strip the wire-only `seq`/`room` fields so a collected event can be
 * compared against a golden fixture that only cares about the payload. */
function bare(msg) {
  const { seq, room, ...rest } = msg;
  return rest;
}

test("SocketSeatServer <- MockBeing: turn.begin -> scripted turn.events -> turn.done", async (t) => {
  const { dir, path } = socketPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const collected = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const server = new SocketSeatServer({
    onSeat(seat) {
      seat.onEvent((msg) => {
        collected.push(msg);
        if (msg.type === "turn.done") resolveDone();
      });
      seat.send({
        type: "turn.begin",
        turnId: "t1",
        context: { conversation: [] },
        covenant: { model: "m", tools: [], posture: "present" },
      });
    },
    onError(e) {
      throw e;
    },
  });
  await server.listen({ path });

  const being = new MockBeing({
    path,
    seatId: "seat-1",
    being: "aria",
    room: "room-1",
    script: [
      { kind: "event", event: { kind: "tokens", text: "hi" } },
      { kind: "event", event: { kind: "final", text: "hi there" } },
    ],
  });
  await being.connect();

  await done;

  const golden = [
    { type: "turn.event", turnId: "t1", event: { kind: "tokens", text: "hi" } },
    { type: "turn.event", turnId: "t1", event: { kind: "final", text: "hi there" } },
    { type: "turn.done", turnId: "t1" },
  ];
  assert.deepEqual(collected.map(bare), golden);

  // close the being's socket before the server: net.Server#close()'s
  // callback waits for every live connection to end, so closing the
  // listener first while the being is still connected would hang forever.
  being.close();
  await server.close();
});

test("a tool.exec -> tool.result exchange completes mid-turn", async (t) => {
  const { dir, path } = socketPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const collected = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const server = new SocketSeatServer({
    onSeat(seat) {
      seat.onEvent((msg) => {
        collected.push(msg);
        if (msg.type === "tool.exec") {
          seat.send({ type: "tool.result", callId: msg.callId, ok: true, content: { echoed: msg.input } });
        }
        if (msg.type === "turn.done") resolveDone();
      });
      seat.send({
        type: "turn.begin",
        turnId: "t2",
        context: {},
        covenant: { model: "m", tools: ["search"], posture: "present" },
      });
    },
    onError(e) {
      throw e;
    },
  });
  await server.listen({ path });

  const being = new MockBeing({
    path,
    seatId: "seat-1",
    being: "aria",
    room: "room-1",
    script: [
      { kind: "tool.exec", tool: "search", input: { q: "archive" } },
      { kind: "event", event: { kind: "final", text: "done searching" } },
    ],
  });
  await being.connect();

  await done;

  const toolExec = collected.find((m) => m.type === "tool.exec");
  assert.ok(toolExec, "house never saw a tool.exec");
  assert.equal(toolExec.tool, "search");
  assert.deepEqual(toolExec.input, { q: "archive" });

  const final = collected.find((m) => m.type === "turn.event" && m.event.kind === "final");
  assert.ok(final, "turn never produced its final speech after the tool round");
  assert.equal(final.event.text, "done searching");

  being.close();
  await server.close();
});

test("a malformed message is rejected with a typed error and the socket survives", async (t) => {
  const { dir, path } = socketPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const errors = [];
  let seatRef = null;
  const server = new SocketSeatServer({
    onSeat(seat) {
      seatRef = seat;
      seat.onEvent(() => {});
    },
    onError(e) {
      errors.push(e);
    },
  });
  await server.listen({ path });

  const being = new MockBeing({ path, seatId: "seat-1", being: "aria", room: "room-1", script: [] });
  await being.connect();

  // wait for the seat to exist before poking the raw socket directly
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (seatRef) {
        clearInterval(iv);
        resolve(undefined);
      }
    }, 5);
  });

  // bypass the client's own validating `send()` to exercise the reader's
  // own rejection path: one non-JSON line, one well-formed-but-invalid one.
  being.client.socket.write("not json at all\n");
  being.client.socket.write(`${JSON.stringify({ type: "turn.event", seq: 1, room: "room-1" })}\n`);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e.name === "SeatProtocolError"));

  // the socket survives: a further well-formed message still gets through.
  const seen = [];
  seatRef.onEvent((m) => seen.push(m));
  being.client.send({ type: "turn.event", turnId: "t1", event: { kind: "tokens", text: "still alive" } });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event.text, "still alive");

  being.close();
  await server.close();
});

// harness-port R2-W, 2026-09-17: SeatClient sends `resumeFromSeq` (its own
// `lastSeqSeen`) whenever it has one — omitted on a genuinely fresh
// connect (nothing seen yet), present once at least one house->being
// message has been observed, reconnect or not.
test("SeatClient's own handshake: no resumeFromSeq on a fresh connect; present (as lastSeqSeen) once a message has been seen", async (t) => {
  const { dir, path } = socketPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  /** @type {Record<string, unknown>[]} */
  const handshakes = [];
  let seat1 = null;
  const server = new SocketSeatServer({
    onSeat(seat, handshake) {
      handshakes.push(handshake);
      seat1 = seat;
      seat.onEvent(() => {});
    },
    onError(e) {
      throw e;
    },
  });
  await server.listen({ path });

  const client = new SeatClient({ path, seatId: "seat-1", being: "aria", room: "room-1" });
  await client.connect();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handshakes.length, 1);
  assert.equal(
    Object.hasOwn(handshakes[0], "resumeFromSeq"),
    false,
    "a fresh client has nothing to resume — the field is simply absent, never a guessed 0",
  );

  // the house sends one message; the client's own lastSeqSeen advances.
  seat1.send({ type: "turn.begin", turnId: "t1", context: {}, covenant: { model: "m", tools: [], posture: "present" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(client.lastSeqSeen >= 0);

  // a second connect (standing in for a reconnect — the wire-level
  // behaviour is identical either way) now carries resumeFromSeq.
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.connect();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handshakes.length, 2);
  assert.equal(handshakes[1].resumeFromSeq, client.lastSeqSeen);

  client.close();
  await server.close();
});
