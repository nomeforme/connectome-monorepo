// @ts-check
/* connectome-house/test/autotrigger.test.mjs — harness-port Q1-C,
 * 2026-09-18 (mission task 2: `!autotrigger` C14 → the turn-close loop):
 * src/autotrigger.mjs's own `applyAutotriggerOnTurnClose` — the storage
 * read/write and reactivate/notice side of the wiring, distinct from
 * dispatch.mjs's `decideAutotriggerReactivation` (already unit-tested,
 * test/dispatch-autotrigger.test.mjs) which this module calls but does
 * not re-test. Uses commands/store.mjs's memory tier directly (no
 * filesystem sandbox needed — nothing here ever calls a persisted-tier
 * function). test/settings-consumers.test.mjs covers the SAME rule
 * end-to-end through a real socket seat and a scripted being.
 *
 * harness-port W6-R3 (K3 fix, 2026-09-19): reactivation is now SCHEDULED
 * (autotrigger.mjs's own 2s -> 4s -> 8s ... 5min-cap pacing, bot-
 * runtime.ts:914,917,919's own numbers), never synchronous — every test
 * below that expects `reactivate()` to have fired now enables
 * `node:test`'s `mock.timers` and advances past the room's own current
 * delay first. */
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { memoryGet, memorySet, resetMemory } from "../src/commands/store.mjs";
import {
  applyAutotriggerOnTurnClose,
  resetAutotriggerPacing,
  _resetAutotriggerTimers,
} from "../src/autotrigger.mjs";

beforeEach(() => {
  resetMemory();
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
  _resetAutotriggerTimers();
  mock.timers.reset();
});

/** @returns {{reactivated: number, noticed: string[]}} */
function spy() {
  const calls = { reactivated: 0, noticed: /** @type {string[]} */ ([]) };
  return {
    calls,
    actions: {
      reactivate: () => {
        calls.reactivated += 1;
      },
      notice: (text) => {
        calls.noticed.push(text);
      },
    },
  };
}

test("roomId null (a synthetic room `!autotrigger` could never have armed): null, no store touched, no action called", () => {
  const { calls, actions } = spy();
  const result = applyAutotriggerOnTurnClose(null, { handle: "aria" }, actions);
  assert.equal(result, null);
  assert.equal(calls.reactivated, 0);
  assert.deepEqual(calls.noticed, []);
});

test("autotrigger never armed for this room: null, neither action called, idle_cycles untouched", () => {
  const { calls, actions } = spy();
  const result = applyAutotriggerOnTurnClose("discord:general", { handle: "aria" }, actions);
  assert.equal(result, null);
  assert.equal(calls.reactivated, 0);
  assert.equal(memoryGet("discord:general", "autotrigger.idle_cycles", undefined), undefined);
});

test("armed, called continue_substream, produced speech: reactivate() is SCHEDULED (fires after the room's 2s base delay), idle_cycles persists to 0", () => {
  memorySet("discord:general", "autotrigger.on", true);
  memorySet("discord:general", "autotrigger.idle_cycles", 2);
  const { calls, actions } = spy();
  const result = applyAutotriggerOnTurnClose(
    "discord:general",
    { handle: "aria", calledContinueSubstream: true, producedSpeech: true },
    actions,
  );
  assert.deepEqual(result, { reactivated: true, ejected: false });
  assert.equal(calls.reactivated, 0, "not yet — the 2s pacing hasn't elapsed");
  mock.timers.tick(2000);
  assert.equal(calls.reactivated, 1);
  assert.deepEqual(calls.noticed, []);
  assert.equal(memoryGet("discord:general", "autotrigger.idle_cycles", undefined), 0);
});

test("armed, did NOT call continue_substream: an ordinary stop — neither action fires, idle_cycles resets to 0", () => {
  memorySet("discord:general", "autotrigger.on", true);
  memorySet("discord:general", "autotrigger.idle_cycles", 3);
  const { calls, actions } = spy();
  const result = applyAutotriggerOnTurnClose(
    "discord:general",
    { handle: "aria", calledContinueSubstream: false, producedSpeech: true },
    actions,
  );
  assert.deepEqual(result, { reactivated: false, ejected: false });
  mock.timers.tick(300_000);
  assert.equal(calls.reactivated, 0);
  assert.deepEqual(calls.noticed, []);
  assert.equal(memoryGet("discord:general", "autotrigger.idle_cycles", undefined), 0);
});

test("armed, called but no speech, under the cap: reactivate() is scheduled, idle_cycles increments", () => {
  memorySet("discord:general", "autotrigger.on", true);
  memorySet("discord:general", "autotrigger.max_speech_only", 5);
  memorySet("discord:general", "autotrigger.idle_cycles", 3);
  const { calls, actions } = spy();
  const result = applyAutotriggerOnTurnClose(
    "discord:general",
    { handle: "aria", calledContinueSubstream: true, producedSpeech: false },
    actions,
  );
  assert.deepEqual(result, { reactivated: true, ejected: false });
  mock.timers.tick(2000);
  assert.equal(calls.reactivated, 1);
  assert.equal(memoryGet("discord:general", "autotrigger.idle_cycles", undefined), 4);
});

test("armed, hits the idle-cycle safety net: ejected — a house notice fires, reactivate does NOT (even well past any delay)", () => {
  memorySet("discord:general", "autotrigger.on", true);
  memorySet("discord:general", "autotrigger.max_speech_only", 5);
  memorySet("discord:general", "autotrigger.idle_cycles", 4);
  const { calls, actions } = spy();
  const result = applyAutotriggerOnTurnClose(
    "discord:general",
    { handle: "aria", calledContinueSubstream: true, producedSpeech: false },
    actions,
  );
  assert.deepEqual(result, { reactivated: false, ejected: true });
  mock.timers.tick(300_000);
  assert.equal(calls.reactivated, 0);
  assert.equal(calls.noticed.length, 1);
  assert.match(calls.noticed[0], /@aria/);
  assert.match(calls.noticed[0], /5 idle cycles/);
  assert.equal(memoryGet("discord:general", "autotrigger.idle_cycles", undefined), 5);
});

test("the ejection cap defaults to 5 with no --max-speech-only ever set for this room", () => {
  memorySet("discord:general", "autotrigger.on", true);
  memorySet("discord:general", "autotrigger.idle_cycles", 4);
  const { calls, actions } = spy();
  const result = applyAutotriggerOnTurnClose(
    "discord:general",
    { handle: "aria", calledContinueSubstream: true, producedSpeech: false },
    actions,
  );
  assert.equal(result.ejected, true);
  mock.timers.tick(300_000);
  assert.equal(calls.reactivated, 0);
});

test("two different rooms keep independent idle-cycle counts", () => {
  memorySet("discord:room-a", "autotrigger.on", true);
  memorySet("discord:room-b", "autotrigger.on", true);
  const { actions: a } = spy();
  const { actions: b } = spy();
  applyAutotriggerOnTurnClose("discord:room-a", { handle: "aria", calledContinueSubstream: true, producedSpeech: false }, a);
  applyAutotriggerOnTurnClose("discord:room-b", { handle: "aria", calledContinueSubstream: true, producedSpeech: true }, b);
  assert.equal(memoryGet("discord:room-a", "autotrigger.idle_cycles", undefined), 1);
  assert.equal(memoryGet("discord:room-b", "autotrigger.idle_cycles", undefined), 0);
});

// ---------------------------------------------------------------------
// K3 (harness-port W6-R3): the pacing schedule itself — 2s -> 4s -> 8s
// doubling capped at 5min (bot-runtime.ts:914,917,919's own numbers),
// reset by any human input (resetAutotriggerPacing, called by mcpl/
// room-tails.mjs's applyInputAction — exercised directly here since this
// file never spins up a real seat), cancelled by `!autotrigger off` (the
// fleet's own re-check-at-fire-time shape: no direct timer handling).
// ---------------------------------------------------------------------

test("K3 — successive reactivations double: 1st waits 2s, 2nd waits 4s, 3rd waits 8s", () => {
  memorySet("discord:pace", "autotrigger.on", true);
  const { calls, actions } = spy();

  applyAutotriggerOnTurnClose("discord:pace", { handle: "aria", calledContinueSubstream: true, producedSpeech: true }, actions);
  mock.timers.tick(1999);
  assert.equal(calls.reactivated, 0, "1st: not yet at 1999ms");
  mock.timers.tick(1);
  assert.equal(calls.reactivated, 1, "1st: fires at 2000ms");

  applyAutotriggerOnTurnClose("discord:pace", { handle: "aria", calledContinueSubstream: true, producedSpeech: true }, actions);
  mock.timers.tick(3999);
  assert.equal(calls.reactivated, 1, "2nd: not yet at 3999ms");
  mock.timers.tick(1);
  assert.equal(calls.reactivated, 2, "2nd: fires at 4000ms");

  applyAutotriggerOnTurnClose("discord:pace", { handle: "aria", calledContinueSubstream: true, producedSpeech: true }, actions);
  mock.timers.tick(7999);
  assert.equal(calls.reactivated, 2, "3rd: not yet at 7999ms");
  mock.timers.tick(1);
  assert.equal(calls.reactivated, 3, "3rd: fires at 8000ms");
});

test("K3 — the delay caps at 5 minutes and never grows past it", () => {
  memorySet("discord:pace-cap", "autotrigger.on", true);
  memorySet("discord:pace-cap", "autotrigger.delay_ms", 250_000);
  const { calls, actions } = spy();
  applyAutotriggerOnTurnClose("discord:pace-cap", { handle: "aria", calledContinueSubstream: true, producedSpeech: true }, actions);
  assert.equal(memoryGet("discord:pace-cap", "autotrigger.delay_ms", undefined), 300_000, "250_000*2 capped at 300_000");
  mock.timers.tick(250_000);
  assert.equal(calls.reactivated, 1);
});

test("K3 — a human message resets the room's pacing back to the 2s base", () => {
  memorySet("discord:pace-reset", "autotrigger.on", true);
  memorySet("discord:pace-reset", "autotrigger.delay_ms", 64_000); // deep into a prior backoff
  resetAutotriggerPacing("discord:pace-reset");
  const { calls, actions } = spy();
  applyAutotriggerOnTurnClose("discord:pace-reset", { handle: "aria", calledContinueSubstream: true, producedSpeech: true }, actions);
  mock.timers.tick(1999);
  assert.equal(calls.reactivated, 0);
  mock.timers.tick(1);
  assert.equal(calls.reactivated, 1, "back to the 2s base, not the stale 64s backoff");
});

test("K3 — `!autotrigger off` during the wait cancels the scheduled reactivation (re-check at fire time, no direct timer touch)", () => {
  memorySet("discord:pace-off", "autotrigger.on", true);
  const { calls, actions } = spy();
  applyAutotriggerOnTurnClose("discord:pace-off", { handle: "aria", calledContinueSubstream: true, producedSpeech: true }, actions);
  memorySet("discord:pace-off", "autotrigger.on", false); // the `!autotrigger off` command's own write
  mock.timers.tick(2000);
  assert.equal(calls.reactivated, 0, "off before the timer fired: reactivate() never runs");
});
