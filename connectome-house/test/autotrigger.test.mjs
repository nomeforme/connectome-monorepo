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
 * end-to-end through a real socket seat and a scripted being. */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { memoryGet, memorySet, resetMemory } from "../src/commands/store.mjs";
import { applyAutotriggerOnTurnClose } from "../src/autotrigger.mjs";

beforeEach(() => resetMemory());

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

test("armed, called continue_substream, produced speech: reactivate() fires, idle_cycles persists to 0", () => {
  memorySet("discord:general", "autotrigger.on", true);
  memorySet("discord:general", "autotrigger.idle_cycles", 2);
  const { calls, actions } = spy();
  const result = applyAutotriggerOnTurnClose(
    "discord:general",
    { handle: "aria", calledContinueSubstream: true, producedSpeech: true },
    actions,
  );
  assert.deepEqual(result, { reactivated: true, ejected: false });
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
  assert.equal(calls.reactivated, 0);
  assert.deepEqual(calls.noticed, []);
  assert.equal(memoryGet("discord:general", "autotrigger.idle_cycles", undefined), 0);
});

test("armed, called but no speech, under the cap: reactivate() fires, idle_cycles increments", () => {
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
  assert.equal(calls.reactivated, 1);
  assert.equal(memoryGet("discord:general", "autotrigger.idle_cycles", undefined), 4);
});

test("armed, hits the idle-cycle safety net: ejected — a house notice fires, reactivate does NOT", () => {
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
