// @ts-check
// harness/test/mcpl-redeliver.test.mjs — pendingRedeliveries reads
// external.jsonl's own delivered:false rows within the catch-up window;
// redeliverRoom resends through a stub host, a pure unit seam, never a
// real platform; the watcher fires once per not-ready → ready edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFrames } from "./lib/fixtures.mjs";
import { recordOutbound } from "../src/mcpl/outbound.mjs";
import {
  CATCHUP_MS,
  createRedeliverWatcher,
  pendingRedeliveries,
  redeliverRoom,
} from "../src/mcpl/redeliver.mjs";

const DIR = mkdtempSync(join(tmpdir(), "house-mcpl-redeliver-"));

test("pendingRedeliveries: only delivered:false reason:not-ready, within the window, not already retried", () => {
  const runDir = join(DIR, "run-pending");
  mkdirSync(runDir);
  recordOutbound(runDir, { platform: "mock", by: "sam", seq: 1, message_id: "m1" }); // delivered — never pending
  recordOutbound(runDir, { platform: "mock", by: "sam", seq: 2, delivered: false, reason: "error", error: "boom" }); // wrong reason
  recordOutbound(runDir, { platform: "mock", by: "sam", seq: 3, delivered: false, reason: "not-ready", error: "x" }); // pending
  recordOutbound(runDir, { platform: "mock", by: "sam", seq: 4, delivered: false, reason: "not-ready", error: "x" }); // already retried below
  recordOutbound(runDir, { platform: "mock", by: "sam", seq: 4, redelivered_of: 4, message_id: "m2" });

  const now = Date.now();
  assert.deepEqual(pendingRedeliveries(runDir, { now }), [{ seq: 3, by: "sam" }]);
  // outside the window: nothing pending at all
  assert.deepEqual(pendingRedeliveries(runDir, { now: now + CATCHUP_MS + 1 }), []);
  // no file at all: honestly empty, never throws
  assert.deepEqual(pendingRedeliveries(join(DIR, "nope")), []);
});

test("redeliverRoom: resends the original speech text once through the host's own tool, a fresh row naming redelivered_of; a second pass finds nothing left", async () => {
  const runDir = join(DIR, "run-resend");
  mkdirSync(runDir);
  writeFrames(runDir, [
    { seq: 1, t: new Date().toISOString(), type: "speech", by: "sam", inline: "hello, this fell over" },
  ]);
  recordOutbound(runDir, {
    platform: "mock",
    by: "sam",
    seq: 1,
    delivered: false,
    reason: "not-ready",
    error: "the server is crashed",
  });

  const calls = [];
  const host = {
    state: { tools: ["send_message"] },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { messageId: "redelivered-1" };
    },
  };
  const cfg = { platform: "mock", being: "sam", being_id: null, limit: 2000 };
  const say = () => {};

  await redeliverRoom({ cfg, host, say }, "mock:g1:c1", runDir);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "send_message");
  assert.equal(calls[0].args.content, "hello, this fell over");
  const rows = readFileSync(join(runDir, "external.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const redelivered = rows.find((r) => r.redelivered_of === 1);
  assert.ok(redelivered, "a fresh row names which seq it retried");
  assert.equal(redelivered.message_id, "redelivered-1");
  assert.equal(redelivered.delivered, true);

  // a second pass: nothing pending any more — never a repeat send
  await redeliverRoom({ cfg, host, say }, "mock:g1:c1", runDir);
  assert.equal(calls.length, 1, "resent once, never twice");
});

test("createRedeliverWatcher: fires exactly on the not-ready → ready edge, never on every poll tick while already ready", () => {
  const runDir = join(DIR, "run-watch");
  mkdirSync(runDir);
  writeFrames(runDir, [{ seq: 1, t: new Date().toISOString(), type: "speech", by: "sam", inline: "hi" }]);
  recordOutbound(runDir, { platform: "mock", by: "sam", seq: 1, delivered: false, reason: "not-ready", error: "x" });

  const calls = [];
  const host = { state: { state: "starting" }, callTool: async (name, args) => (calls.push({ name, args }), { messageId: "w1" }) };
  const watcher = createRedeliverWatcher({ cfg: { platform: "mock", being: "sam", being_id: null, limit: 2000 }, host, say: () => {} });
  const tails = new Map([["room-1", { stream: "mock:g1:c1", runDir }]]);

  watcher.check(tails); // still starting — no edge yet
  assert.equal(calls.length, 0);
  host.state.state = "ready";
  watcher.check(tails); // the edge
  watcher.check(tails); // still ready — not another edge
  watcher.check(tails);
  return new Promise((resolve) =>
    setTimeout(() => {
      assert.equal(calls.length, 1, "exactly one redelivery attempt for the one edge, not one per tick");
      resolve(undefined);
    }, 50),
  );
});
