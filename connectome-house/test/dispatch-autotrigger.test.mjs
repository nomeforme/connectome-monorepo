// @ts-check
/* connectome-house/test/dispatch-autotrigger.test.mjs — harness-port P-A
 * (parity round, 2026-09-17), mission task 2: `!autotrigger`'s (C14) own
 * re-activation rule, src/dispatch.mjs's `decideAutotriggerReactivation` —
 * pure, no sandboxing needed, no filesystem touched (matches dispatch.
 * test.mjs's own convention, extended here rather than into that file
 * since this is a distinct command's own consumer, not `decideActivation`
 * itself). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutotriggerReactivation } from "../src/dispatch.mjs";

test("autotrigger off: never reactivates, regardless of the last turn's own shape", () => {
  const r = decideAutotriggerReactivation({
    autotrigger: { on: false, idleCycles: 3 },
    lastTurn: { calledContinueSubstream: true, producedSpeech: true },
  });
  assert.deepEqual(r, { reactivate: false, idleCycles: 3, ejected: false });
});

test("autotrigger on, being called continue_substream and spoke: reactivates, idle count resets to 0", () => {
  const r = decideAutotriggerReactivation({
    autotrigger: { on: true, idleCycles: 2 },
    lastTurn: { calledContinueSubstream: true, producedSpeech: true },
  });
  assert.deepEqual(r, { reactivate: true, idleCycles: 0, ejected: false });
});

test("autotrigger on, being did NOT call continue_substream: 'no call = loop ends' — an ordinary stop, not an ejection", () => {
  const r = decideAutotriggerReactivation({
    autotrigger: { on: true, idleCycles: 4 },
    lastTurn: { calledContinueSubstream: false, producedSpeech: true },
  });
  assert.deepEqual(r, { reactivate: false, idleCycles: 0, ejected: false });
});

test("autotrigger on, called continue_substream but produced no speech: idle count increments, still reactivates while under the cap", () => {
  const r = decideAutotriggerReactivation({
    autotrigger: { on: true, idleCycles: 3, maxSpeechOnly: 5 },
    lastTurn: { calledContinueSubstream: true, producedSpeech: false },
  });
  assert.deepEqual(r, { reactivate: true, idleCycles: 4, ejected: false });
});

test("--max-speech-only's own safety net: the Nth consecutive idle cycle ejects instead of reactivating", () => {
  const r = decideAutotriggerReactivation({
    autotrigger: { on: true, idleCycles: 4, maxSpeechOnly: 5 },
    lastTurn: { calledContinueSubstream: true, producedSpeech: false },
  });
  assert.deepEqual(r, { reactivate: false, idleCycles: 5, ejected: true });
});

test("the ejection cap defaults to 5 when a room never named --max-speech-only (the fork's own default)", () => {
  const r = decideAutotriggerReactivation({
    autotrigger: { on: true, idleCycles: 4 }, // no maxSpeechOnly at all
    lastTurn: { calledContinueSubstream: true, producedSpeech: false },
  });
  assert.equal(r.ejected, true);
  assert.equal(r.idleCycles, 5);
});

test("a fresh room (no autotrigger state persisted at all) never reactivates, never throws", () => {
  const r = decideAutotriggerReactivation({ autotrigger: undefined, lastTurn: undefined });
  assert.deepEqual(r, { reactivate: false, idleCycles: 0, ejected: false });
});
