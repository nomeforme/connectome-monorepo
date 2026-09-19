// @ts-check
/* connectome-seat-client/test/seat-ready.test.mjs — harness-port W8-A,
 * 2026-09-19: the handshake ack. `connect()` defaults to the OLD
 * behaviour (resolves on the raw TCP connect, never hears of
 * "seat.ready" at all — a client that doesn't wait still works, even
 * against a bare `SocketSeatServer` that never sends one, as every other
 * test in this package's own socket-round-trip.test.mjs already relies
 * on). `waitForReady: true` opts into waiting for the ack instead, with a
 * typed timeout when it never comes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketSeatServer } from "@connectome/seat-protocol";
import { SeatClient, SeatReadyTimeoutError } from "../src/seat-client.mjs";

function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), "seat-ready-test-"));
  return { dir, path: join(dir, "seat.sock") };
}

test("waitForReady: false (the default) resolves on the raw connect alone, even when the house never sends seat.ready", async (t) => {
  const { dir, path } = socketPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const server = new SocketSeatServer({
    onSeat(seat) {
      seat.onEvent(() => {});
    },
    onError(e) {
      throw e;
    },
  });
  await server.listen({ path });

  const client = new SeatClient({ path, seatId: "s1", being: "aria", room: "r1" });
  await client.connect(); // resolves though no seat.ready is ever sent

  client.close();
  await server.close();
});

test("waitForReady: true resolves only once seat.ready arrives, and captures it as lastSeatReady", async (t) => {
  const { dir, path } = socketPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  /** @type {(() => void)|null} */
  let sendReady = null;
  const server = new SocketSeatServer({
    onSeat(seat) {
      seat.onEvent(() => {});
      // the ack fires from a SEPARATE tick, standing in for onSeat's own
      // real attach work — proves connect() actually waited for it rather
      // than resolving at the earlier raw-connect moment.
      sendReady = () => seat.send({ type: "seat.ready", being: "aria", resumedFromSeq: 2 });
    },
    onError(e) {
      throw e;
    },
  });
  await server.listen({ path });

  const client = new SeatClient({ path, seatId: "s1", being: "aria", room: "r1", waitForReady: true, readyTimeoutMs: 2000 });
  let resolved = false;
  const p = client.connect().then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, false, "connect() must not resolve before seat.ready arrives");

  sendReady?.();
  await p;
  assert.equal(resolved, true);
  assert.deepEqual(client.lastSeatReady && { being: client.lastSeatReady.being, resumedFromSeq: client.lastSeatReady.resumedFromSeq }, {
    being: "aria",
    resumedFromSeq: 2,
  });

  client.close();
  await server.close();
});

test("waitForReady: true rejects with SeatReadyTimeoutError when no seat.ready arrives in time", async (t) => {
  const { dir, path } = socketPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const server = new SocketSeatServer({
    onSeat(seat) {
      seat.onEvent(() => {}); // deliberately never sends seat.ready
    },
    onError(e) {
      throw e;
    },
  });
  await server.listen({ path });

  const client = new SeatClient({ path, seatId: "s1", being: "aria", room: "r1", waitForReady: true, readyTimeoutMs: 100 });
  await assert.rejects(() => client.connect(), SeatReadyTimeoutError);

  client.close();
  await server.close();
});
