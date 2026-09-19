// @ts-check
/* connectome-house/test/seat-resume.test.mjs — harness-port R2-W,
 * 2026-09-17 (mission task 5): a being's socket drops, then reconnects
 * naming `resumeFromSeq` (its own `lastSeqSeen` from before the drop) —
 * whatever this room's seat was sent in the meantime (still held in
 * socket-seat.mjs's own bounded per-room ring) replays on the NEW
 * connection, once, in order. Mirrors seat-abort.test.mjs's own house-only
 * setup (openRoom + a bare unix-socket seat server), but drives the being
 * side with a raw `SeatClient` (not `MockBeing`) so `resumeFromSeq` can be
 * set by hand rather than by racing a real reconnect-with-backoff cycle —
 * the SAME "one reconnect, deterministic" scope this task's own protocol
 * doc comments (seat-client.mjs, socket-seat.mjs) name as what this round
 * actually verifies. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatClient } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "seat-resume-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");

const { openRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");

test("disconnect, reconnect with resumeFromSeq: the lines sent while the seat was gone arrive on the new connection, once, in order", async (t) => {
  t.after(() => rmSync(ROOT, { recursive: true, force: true }));

  const { id, error } = await openRoom({
    platform: "synthetic",
    stream: "seat-resume-1",
    title: "a synthetic room, for seat-resume.test.mjs only",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);

  const sockDir = mkdtempSync(join(tmpdir(), "seat-resume-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });
  // t.after() hooks run in REGISTRATION order (FIFO), not LIFO — every
  // seat connection this test opens must close BEFORE the server does, or
  // net.Server#close()'s callback waits forever for a still-live one
  // (seat-abort.test.mjs's own documented lesson, matching connectome-
  // seat-client/test/socket-round-trip.test.mjs). Registered at the very
  // end of this test, once client2 exists.

  // --- first connection: seat, receive three lines, note lastSeqSeen ---
  const client1 = new SeatClient({ path: sockPath, seatId: "aria-seat-1", being: "aria", room: id });
  const seen1 = [];
  client1.on("line", (m) => seen1.push(m));
  await client1.connect();
  await waitFor(() => (open.get(id)?.seat ? true : null));
  // harness-port W8-A, 2026-09-19: the house's own handshake ack
  // (`seat.ready`) now rides this SAME per-connection wire seq — wait for
  // it to land before taking a baseline, rather than assume seq 0 is the
  // first thing this connection will ever see (additive, protocol-level,
  // not this test's own concern).
  await waitFor(() => (client1.lastSeqSeen >= 0 ? true : null));
  const seqBeforeLines = client1.lastSeqSeen;

  // the wrapped seat object itself — captured BEFORE the drop below, so
  // sends can still be pushed through it (and buffered into its ring)
  // even after the room's own `seat` slot is cleared by the disconnect.
  const seatRef = open.get(id).seat;
  seatRef.send({ type: "line", by: "keeper", text: "line-0" });
  seatRef.send({ type: "line", by: "keeper", text: "line-1" });
  seatRef.send({ type: "line", by: "keeper", text: "line-2" });
  await waitFor(() => (seen1.length >= 3 ? true : null));
  assert.deepEqual(seen1.map((m) => m.text), ["line-0", "line-1", "line-2"]);
  assert.equal(
    client1.lastSeqSeen,
    seqBeforeLines + 3,
    "the wire's own per-connection seq: three sends advance it by exactly 3, whatever it started at",
  );

  // the drop: a clean client-side close (same FIN a crashed/dropped being
  // would send) — the room's own seat slot clears, but socket-seat.mjs's
  // ring for THIS room persists independently (module-level, keyed by
  // roomId, not by any one connection's id).
  client1.close();
  await waitFor(() => (open.get(id)?.seat === null ? true : null));

  // sent while genuinely disconnected — nobody receives these yet; they
  // land only in the ring (seatRef.send still pushes there even though
  // the dead raw connection's own send silently fails).
  seatRef.send({ type: "line", by: "keeper", text: "line-3" });
  seatRef.send({ type: "line", by: "keeper", text: "line-4" });

  // --- reconnect, naming resumeFromSeq: the being's own remembered
  // high-water mark from BEFORE the drop (client1.lastSeqSeen, 2) ---
  const client2 = new SeatClient({ path: sockPath, seatId: "aria-seat-2", being: "aria", room: id });
  client2.lastSeqSeen = client1.lastSeqSeen; // what a real process would persist/recall
  const seen2 = [];
  client2.on("line", (m) => seen2.push(m));
  await client2.connect();
  t.after(() => client2.close());

  await waitFor(() => (seen2.length >= 2 ? true : null));
  assert.deepEqual(
    seen2.map((m) => m.text),
    ["line-3", "line-4"],
    "exactly the two lines sent while disconnected, in order, each exactly once",
  );

  // a further live send still behaves normally afterward — through the
  // room's now-current seat (client2's own), not the first (dead) one.
  const seatRef2 = open.get(id).seat;
  assert.notEqual(seatRef2.id, seatRef.id, "a fresh seat attached for the reconnect, not the dead one");
  seatRef2.send({ type: "line", by: "keeper", text: "line-5" });
  await waitFor(() => (seen2.length >= 3 ? true : null));
  assert.equal(seen2[2].text, "line-5");

  // registered LAST: client2 is still live above (its own t.after already
  // queued before this one, so it closes first) — only now is it safe to
  // close the server without net.Server#close() waiting on a live client.
  t.after(async () => server.close());
});
