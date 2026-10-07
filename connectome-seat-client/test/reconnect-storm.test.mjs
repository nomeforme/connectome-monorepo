/* The 2026-10-03 restart storm (docs/harness-port/38), as three tests:
 *  - a failing reconnect schedules exactly ONE retry per failure (it used
 *    to schedule two — close handler + the attempt's own .catch — so
 *    parallel retry chains doubled per failure: ~360 connects/s);
 *  - `retryInitial`: a first connect() against no house waits and
 *    succeeds once the house appears, instead of rejecting (the walker
 *    used to exit fatally and get restarted into the herd);
 *  - a stale socket file left by a crashed server no longer blocks
 *    listen(); a live server's socket is never taken over. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatClient } from "../src/seat-client.mjs";
import { SocketSeatServer } from "@connectome/seat-protocol";

const dir = mkdtempSync(join(tmpdir(), "seat-storm-"));

/** a raw unix server that accepts and immediately drops every connection
 * — a house that keeps refusing the handshake — counting connects */
function droppingServer(path) {
  let connects = 0;
  const srv = createServer((sock) => {
    connects++;
    sock.destroy();
  });
  return new Promise((resolve) => srv.listen(path, () => resolve({ srv, count: () => connects })));
}

test("a seat that keeps failing reconnects ONCE per failure — no doubling fan-out", async () => {
  const path = join(dir, "drop.sock");
  const { srv, count } = await droppingServer(path);
  const client = new SeatClient({
    path,
    seatId: "s1",
    being: "aria",
    room: "r",
    reconnect: { initialDelayMs: 20, maxDelayMs: 40, resetAfterMs: 60_000 },
  });
  await client.connect().catch(() => {}); // first attempt: accepted then dropped
  await new Promise((r) => setTimeout(r, 1000));
  client.close();
  srv.close();
  // single-flight at a 20→40 ms backoff caps out near 1000/40 ≈ 25 attempts;
  // the doubling bug reaches thousands inside the same second
  assert.ok(count() <= 40, `expected ≤ 40 connects in 1 s, saw ${count()}`);
  assert.ok(count() >= 5, `reconnect should keep trying, saw only ${count()}`);
});

test("retryInitial: connect() waits for a house that isn't up yet, then resolves", async () => {
  const path = join(dir, "late.sock");
  const misses = [];
  const client = new SeatClient({
    path,
    seatId: "s2",
    being: "aria",
    room: "r",
    reconnect: { initialDelayMs: 20, maxDelayMs: 50 },
    retryInitial: true,
    onInitialRetry: (e) => misses.push(e?.code ?? String(e)),
  });
  const connected = client.connect();
  await new Promise((r) => setTimeout(r, 200)); // several refused attempts
  const server = new SocketSeatServer({ onSeat: () => {} });
  await server.listen({ path });
  await connected; // resolves now rather than having rejected at the first ENOENT
  assert.ok(misses.length >= 2, `expected retries before the house came up, saw ${misses.length}`);
  assert.equal(client.live, true);
  client.close();
  await server.close();
});

test("listen() clears a stale socket file, but never takes over a live one", async () => {
  const stale = join(dir, "stale.sock");
  // a crashed server's leftover: a child listens, then is SIGKILLed —
  // Node only unlinks the path on a CLEAN close, so the file stays
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(stale)}, () => console.log("up"))`]);
  await new Promise((r) => child.stdout.once("data", r));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.ok(existsSync(stale), "fixture: stale socket file left behind");
  const s1 = new SocketSeatServer({ onSeat: () => {} });
  await s1.listen({ path: stale }); // used to reject with EADDRINUSE
  // a second server on the same, now LIVE, path must still fail loudly
  const s2 = new SocketSeatServer({ onSeat: () => {} });
  await assert.rejects(() => s2.listen({ path: stale }), /EADDRINUSE/);
  await s1.close();
});

test("a plain file at the path is not a socket we own — left for listen to report", async () => {
  const p = join(dir, "notasocket");
  writeFileSync(p, "x");
  const s = new SocketSeatServer({ onSeat: () => {} });
  await assert.rejects(() => s.listen({ path: p }));
  assert.ok(existsSync(p));
});

test("a message sent while reconnecting is held and delivered, in order, once the house acks the new connection", async () => {
  const path = join(dir, "outbox.sock");
  const got = [];
  let conns = 0;
  const server = new SocketSeatServer({
    onSeat: (raw) => {
      conns++;
      raw.onEvent((m) => got.push(m.event?.text));
      setImmediate(() => raw.send({ type: "seat.ready", being: "aria" })); // after the seat is live, as the house does
      if (conns === 1) setTimeout(() => raw.kill(), 30); // the blip
    },
  });
  await server.listen({ path });
  const client = new SeatClient({ path, seatId: "s5", being: "aria", room: "r", reconnect: { initialDelayMs: 50, maxDelayMs: 50 } });
  await client.connect();
  await new Promise((r) => setTimeout(r, 60)); // the first connection is gone now
  assert.equal(client.send({ type: "turn.event", turnId: "t1", event: { kind: "final", text: "1" } }), true, "held, not dropped");
  assert.equal(client.send({ type: "turn.event", turnId: "t1", event: { kind: "final", text: "2" } }), true);
  await new Promise((r) => setTimeout(r, 300)); // reconnect + seat.ready + flush
  assert.deepEqual(got, ["1", "2"]);
  client.close();
  await server.close();
});
