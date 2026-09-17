// @ts-check
/* harness/test/mcpl-typing.test.mjs — typing.mjs's createTypingLoop,
 * pure: an immediate tick plus a re-send on interval, keyed so a room
 * never doubles a loop, stop is idempotent and fires its own onStop once,
 * stopAll clears without one. No I/O — the caller's tick/onStop are
 * plain counters here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTypingLoop } from "../src/mcpl/typing.mjs";

test("createTypingLoop: start ticks once immediately, then again on interval; a second start for the same key is a no-op", async () => {
  const loop = createTypingLoop({ intervalMs: 20 });
  let ticks = 0;
  loop.start("room-1", () => {
    ticks += 1;
  });
  assert.equal(ticks, 1, "the first tick is immediate, not after the first interval");
  loop.start("room-1", () => {
    ticks += 1000;
  }); // ignored: already running
  await new Promise((r) => setTimeout(r, 55));
  assert.ok(ticks >= 3 && ticks < 1000, `re-sent on interval, the second start's tick never ran (ticks=${ticks})`);
  loop.stop("room-1");
});

test("createTypingLoop: stop clears the interval and fires onStop once; stopping an unstarted/already-stopped key is a no-op", async () => {
  const loop = createTypingLoop({ intervalMs: 15 });
  let ticks = 0;
  let stops = 0;
  loop.start("room-1", () => {
    ticks += 1;
  });
  await new Promise((r) => setTimeout(r, 35));
  const atStop = ticks;
  loop.stop("room-1", () => {
    stops += 1;
  });
  assert.equal(stops, 1);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(ticks, atStop, "no further ticks past stop");
  loop.stop("room-1", () => {
    stops += 1;
  });
  assert.equal(stops, 1, "stopping an already-stopped key never fires onStop again");
  loop.stop("never-started", () => {
    stops += 1;
  });
  assert.equal(stops, 1, "stopping a key that never started is a no-op too");
});

test("createTypingLoop: two keys run independently; stopAll clears every running loop with no onStop signal", async () => {
  const loop = createTypingLoop({ intervalMs: 15 });
  const ticks = { a: 0, b: 0 };
  loop.start("a", () => {
    ticks.a += 1;
  });
  loop.start("b", () => {
    ticks.b += 1;
  });
  assert.ok(loop.running("a") && loop.running("b"));
  loop.stop("a");
  assert.ok(!loop.running("a") && loop.running("b"));
  loop.stopAll();
  assert.ok(!loop.running("b"));
  const atStopAll = { ...ticks };
  await new Promise((r) => setTimeout(r, 35));
  assert.deepEqual(ticks, atStopAll, "no ticks survive stopAll");
});
