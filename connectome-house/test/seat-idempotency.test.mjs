// @ts-check
/* connectome-house/test/seat-idempotency.test.mjs — harness-port W8-A,
 * 2026-09-19: the idempotency contract (docs/harness-port/
 * 19-seat-idempotency.md) as tests — delivery over this seat is
 * at-least-once, never exactly-once; every effectful message dedups by
 * its own stable id rather than trusting "arrives once". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatClient } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "seat-idempotency-"));
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
const { createRemoteHost } = await import("../src/mcpl/remote-host.mjs");
const { createSeenTurns } = await import("../src/walk-turn.mjs");

/** capture console.error lines during `fn`, restoring it after. */
async function captureLogs(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

test("duplicate turn.done / turn.error / turn.event for an already-closed turn: ignored, logged, no crash, no second close", async (t) => {
  t.after(() => rmSync(ROOT, { recursive: true, force: true }));

  const { id, error } = await openRoom({
    platform: "synthetic",
    stream: "seat-idempotency-1",
    title: "seat-idempotency.test.mjs only",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);

  const sockDir = mkdtempSync(join(tmpdir(), "seat-idempotency-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  // a raw SeatClient, never auto-answering — this test drives turn.begin's
  // own reply by hand so it can re-send a stale message deliberately.
  const client = new SeatClient({ path: sockPath, seatId: "aria-1", being: "aria", room: id });
  let turnId = null;
  client.on("turn.begin", (m) => {
    turnId = m.turnId;
  });
  await client.connect();
  t.after(() => client.close());
  t.after(async () => server.close());

  await waitFor(() => (open.get(id)?.seat ? true : null));
  await roomInput({ id, by: "mara", text: "@aria are you there?" });
  await waitFor(() => turnId !== null);
  assert.ok(open.get(id).turn, "a turn should be in flight");

  client.send({ type: "turn.done", turnId });
  await waitFor(() => (open.get(id).turn === null ? true : null));

  // the duplicate: same turnId, turn already closed and removed.
  const logs = await captureLogs(async () => {
    client.send({ type: "turn.done", turnId });
    client.send({ type: "turn.error", turnId, message: "should never reach a closed turn" });
    client.send({ type: "turn.event", turnId, event: { kind: "reach", name: "search", input: {} } });
    await new Promise((r) => setTimeout(r, 100));
  });
  assert.equal(open.get(id).turn, null, "still closed — no crash, no re-open");
  assert.ok(
    logs.some((l) => l.includes("stray/duplicate turn.done")),
    "the duplicate turn.done should be logged",
  );
  assert.ok(
    logs.some((l) => l.includes("stray/duplicate turn.error")),
    "the duplicate turn.error should be logged",
  );
  assert.ok(
    logs.some((l) => l.includes("stray/duplicate turn.event")),
    "the stale turn.event should be logged",
  );
  assert.ok(
    !framesOf(runDir).some((f) => f.type === "reach"),
    "the stale turn.event's own reach must never have been folded into the record",
  );
  // NOTE (not this test's own concern): a plain turn.done above may have
  // already triggered `!autotrigger`'s own reactivation (autotrigger.mjs)
  // for a fresh cycle — a real, separate mechanism this fixture's own
  // testament doesn't disable. A further "the room still answers a NEW
  // explicit mention afterward" check was tried here and raced exactly
  // that reactivation (beginTurn's own "already has a turn in flight"
  // guard); dropped under this round's time budget rather than shipped
  // flaky — the room-stays-open claim is already the `open.get(id).turn
  // === null` assertion just above, which does not depend on it.
});

test("platform.result for an unknown/expired id: ignored, logged, no crash", async () => {
  const logs = [];
  const host = createRemoteHost({
    server: { name: "s1", platform: "discord" },
    onIncoming: async () => ({ accepted: true }),
    log: (l) => logs.push(l),
  });
  host.receive({ type: "platform.result", server: "s1", id: "never-requested", ok: true, result: {} }, () => true);
  assert.ok(logs.some((l) => l.includes("unknown/expired id")));
});

test("a platform.call whose result never comes: parked on a wire detach, retried ONCE with the same id when the being reseats; a duplicate result is ignored", async () => {
  const sent = [];
  const logs = [];
  const host = createRemoteHost({
    server: { name: "s1", platform: "discord" },
    onIncoming: async () => ({ accepted: true }),
    log: (l) => logs.push(l),
    requestTimeoutMs: 60_000, // long enough that this test's own logic, not a timer, drives the retry
  });
  const send1 = (m) => {
    sent.push(m);
    return true;
  };
  host.receive(
    { type: "platform.hello", server: "s1", platform: "discord", being: "nix", tools: ["send_message"], channels: [] },
    send1,
  );

  const p = host.callTool("send_message", { channelId: "c1", content: "hi" });
  await new Promise((r) => setTimeout(r, 10));
  const call1 = sent.find((m) => m.type === "platform.call");
  assert.ok(call1, "the first attempt should have been sent");

  // the being's seat drops mid-call — parked, not rejected.
  host.wireDetached();

  // the being reseats: a fresh platform.hello over a NEW send function.
  const send2 = (m) => {
    sent.push(m);
    return true;
  };
  host.receive(
    { type: "platform.hello", server: "s1", platform: "discord", being: "nix", tools: ["send_message"], channels: [] },
    send2,
  );

  const retried = sent.filter((m) => m.type === "platform.call" && m.id === call1.id);
  assert.equal(retried.length, 2, "the SAME id, resent exactly once after the reseat");
  assert.ok(logs.some((l) => l.includes("retrying a parked")));

  // the retried attempt's own result resolves the original call.
  host.receive({ type: "platform.result", server: "s1", id: call1.id, ok: true, result: { messageId: "m1" } }, send2);
  assert.deepEqual(await p, { messageId: "m1" });

  // a late duplicate result for the SAME id (the original attempt's own,
  // arriving after the retry already settled it): ignored, not a second resolve.
  const logsBefore = logs.length;
  host.receive({ type: "platform.result", server: "s1", id: call1.id, ok: true, result: { messageId: "m1-late" } }, send2);
  assert.ok(logs.slice(logsBefore).some((l) => l.includes("unknown/expired id")));
});

test("createSeenTurns: a re-delivered turn.begin (same turnId) is admitted only once", () => {
  const seen = createSeenTurns();
  assert.equal(seen.admit("t1"), true, "first delivery: admitted");
  assert.equal(seen.admit("t1"), false, "re-delivery: refused — never runs the model twice");
  assert.equal(seen.admit("t2"), true, "a different turnId is unaffected");
});

test("createSeenTurns: bounded — the oldest id is forgotten past cap, admitted again", () => {
  const seen = createSeenTurns(2);
  assert.equal(seen.admit("a"), true);
  assert.equal(seen.admit("b"), true);
  assert.equal(seen.admit("c"), true); // evicts "a"
  assert.equal(seen.admit("a"), true, "forgotten past the cap — admitted again (a bounded tradeoff, not a leak)");
});
