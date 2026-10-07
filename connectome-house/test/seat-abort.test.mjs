// @ts-check
/* connectome-house/test/seat-abort.test.mjs — house-design.md §2.2's
 * "turn.error/a dropped socket -> the turn ends aborted, room stays
 * open" acceptance (06-rounds.md R2-A): a being's socket drops while a
 * turn is genuinely still open (the being never answers `turn.begin` at
 * all — a raw `SeatClient`, not `MockBeing`'s auto-completing script, so
 * nothing races the drop), the house appends an `aborted` frame for that
 * turn, the ROOM's own registry status stays "open" (never rested/
 * aborted at the room level — only the turn's own outcome says
 * "aborted"), the room's one seat slot is freed, and a fresh being can
 * seat into the very same room afterward and complete an ordinary turn.
 */
// these tests pin the abort itself: no grace window for a dropped seat here
process.env.HOUSE_SEAT_GRACE_MS = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBeing, SeatClient } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "seat-abort-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");

const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");

test("a being's socket dropped mid-turn ends the turn aborted; the room stays open; a new being can seat", async (t) => {
  t.after(() => rmSync(ROOT, { recursive: true, force: true }));

  const { id, error } = await openRoom({
    platform: "synthetic",
    stream: "seat-abort-1",
    title: "a synthetic room, for seat-abort.test.mjs only",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);

  const sockDir = mkdtempSync(join(tmpdir(), "seat-abort-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });
  // t.after() hooks run in REGISTRATION order (FIFO), not LIFO — every
  // seat connection this test opens must close BEFORE the server does,
  // or net.Server#close()'s callback waits forever for a still-live one
  // (matches connectome-seat-client/test/socket-round-trip.test.mjs's own
  // documented lesson). Registered at the very end of this test, once
  // both `client` and `being2` below have their own close hooks in.

  // a raw SeatClient, never answering turn.begin at all — the turn stays
  // genuinely open until the drop below, nothing races it.
  const client = new SeatClient({ path: sockPath, seatId: "aria-seat-1", being: "aria", room: id });
  let sawTurnBegin = false;
  client.on("turn.begin", () => {
    sawTurnBegin = true;
  });
  await client.connect();
  t.after(() => client.close());

  await waitFor(() => (open.get(id)?.seat ? true : null));

  await roomInput({ id, by: "mara", text: "@aria are you there?" });
  assert.ok(open.get(id).turn, "a turn should be in flight right after an activating roomInput");
  await waitFor(() => sawTurnBegin);

  // the drop: a clean client-side close, same signal a real crashed/
  // network-dropped being's socket would send (a FIN either way).
  client.close();

  await waitFor(() => (open.get(id).seat === null ? true : null));
  assert.equal(open.get(id).turn, null, "the turn should be closed once the seat is gone");
  assert.equal(open.get(id).status, "open", "the room itself stays open — only the turn's own outcome is aborted");

  const frames = framesOf(runDir);
  const last = frames[frames.length - 1];
  assert.equal(last.type, "aborted", "the record's last frame should be the turn's own abort");
  assert.equal(last.reason, "seat disconnected");

  // a new being can seat, and complete an ordinary turn.
  const being2 = new MockBeing({
    path: sockPath,
    seatId: "aria-seat-2",
    being: "aria",
    room: id,
    script: [{ kind: "event", event: { kind: "final", text: "back now, sorry" } }],
  });
  await being2.connect();
  t.after(() => being2.close());
  t.after(async () => {
    await server.close();
  });
  await waitFor(() => (open.get(id)?.seat?.being === "aria" ? true : null));

  await roomInput({ id, by: "mara", text: "@aria you still there?" });
  await waitFor(() =>
    framesOf(runDir).some((f) => f.type === "speech" && f.by === "aria" && f.inline?.includes("back now")),
  );
});
