// @ts-check
/* connectome-house/test/room-turn-begin-guard.test.mjs — docs/harness-port/
 * 31-silent-turn.md's own structural guard on room-turn.mjs's `beginTurn`:
 * a failure strictly between marking a turn in-flight (`rec.turns.set`)
 * and actually delivering it (`seat.send`) must never leave `rec.turns`
 * stuck — every later activation for the same being in the same room
 * would otherwise be refused forever with "already has a turn in flight",
 * and silently (the caller only ever sees a rejected/settled promise, not
 * a house line, unless this guard names one itself).
 *
 * A REAL platform room (openRoom/roomInput, serve-rooms.mjs) with a real
 * testament, exactly like room-turn-settings.test.mjs's own fixture —
 * only the seat itself is a hand-attached stand-in (open-rooms.mjs's
 * `attachSeat`, a documented test/production seam) whose `send` throws on
 * command, so the failure is deterministic and needs no real socket. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "room-turn-begin-guard-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");

const { openRoom } = await import("../src/serve-rooms.mjs");
const { open, attachSeat } = await import("../src/open-rooms.mjs");
const { beginTurn } = await import("../src/room-turn.mjs");

async function realRoom(streamSuffix) {
  const stream = `room-turn-begin-guard-${streamSuffix}`;
  const { id, error } = await openRoom({
    platform: "discord",
    stream,
    title: "room-turn-begin-guard.test.mjs fixture",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  return { rec: open.get(id), id };
}

test("beginTurn: a throw between marking the turn in-flight and delivering it is logged, frees rec.turns, and resolves the caller's promise as an error — never a silent stuck turn", async () => {
  const { rec, id } = await realRoom("throwing-send");
  attachSeat(id, {
    being: "aria",
    send() {
      throw new Error("socket exploded");
    },
  });

  const originalError = console.error;
  /** @type {string[]} */
  const logged = [];
  console.error = (line) => logged.push(String(line));
  let result;
  try {
    result = beginTurn(rec, "aria");
  } finally {
    console.error = originalError;
  }

  assert.ok(result instanceof Promise, "beginTurn never throws synchronously for this failure class — always a promise the caller can await");
  const outcome = await result;
  assert.equal(outcome.kind, "error", "the caller's own donePromise settles as an error, never hangs forever");
  assert.match(outcome.message, /socket exploded/);

  assert.ok(
    logged.some((l) => l.includes("[room]") && l.includes("@aria") && l.includes(id) && l.includes("socket exploded")),
    `expected one house line naming the being, room and error; got: ${JSON.stringify(logged)}`,
  );

  assert.equal(rec.turns.get("aria"), undefined, "the in-flight turn was released, not left stuck");
});

test("beginTurn: after a send-failure release, the SAME being can be activated again in the SAME room without 'already has a turn in flight'", async () => {
  const { rec, id } = await realRoom("throwing-send-then-retry");
  let shouldThrow = true;
  /** @type {any[]} */
  const sent = [];
  attachSeat(id, {
    being: "aria",
    send(msg) {
      if (shouldThrow) throw new Error("first attempt: socket exploded");
      sent.push(msg);
    },
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    const first = await beginTurn(rec, "aria");
    assert.equal(first.kind, "error");
  } finally {
    console.error = originalError;
  }

  shouldThrow = false;
  // the precondition beginTurn's own second guard checks — this must NOT throw.
  assert.doesNotThrow(() => beginTurn(rec, "aria"));
  assert.equal(sent.length, 1, "the retried turn really was delivered over the wire this time");
  assert.equal(sent[0].type, "turn.begin");
});
