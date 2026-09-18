// @ts-check
/* connectome-house/test/walk-turn-covenant.test.mjs — harness-port W3-A,
 * 2026-09-18, mission task 2: walk-turn.mjs's own covenant consumers —
 * `thinking: false` (a being's testament, riding on `covenant.thinking`)
 * overrides this walker's process-wide `--thinking` flag for just the one
 * turn; `covenant.promptCaching` overrides the auto-derived per-route
 * default. Also pins the pre-existing "ended by length cap" safety net
 * (walk-turn.mjs's own `finalSeg` fallback, never tested directly before
 * this task): a stream that completes with no `tool-calls` event at all
 * still yields a `final` turn.event before `turn.done`. A fake membrane
 * (duck-typed `streamYielding`, no network), matching walk-frame.test.mjs's
 * own `fakeSeat()` pattern. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnRunner } from "../src/walk-turn.mjs";

function fakeSeat() {
  const sent = [];
  return { sent, send: (msg) => (sent.push(msg), true) };
}

/** a membrane whose one call replays `events` (tokens/tool-calls/complete/…)
 * and captures the assembled `request` it was given. */
function fakeMembrane(events, { response = { content: [{ type: "text", text: "" }], usage: {} } } = {}) {
  let request = null;
  return {
    request: () => request,
    streamYielding(req) {
      request = req;
      let i = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () =>
              i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true },
          };
        },
        cancel() {},
        provideToolResults() {},
      };
    },
    _response: response,
  };
}

function baseDeps(membrane) {
  return {
    being: "aria",
    mock: false,
    membraneFor: () => membrane,
    maxOutputForModel: () => undefined,
    routeForModel: () => "anthropic",
    supportsThinking: () => true,
    usesAdaptiveThinking: () => false,
    thinking: { enabled: true, budgetTokens: 4096 },
    thinkingEffort: "medium",
    maxTokensDefault: 16384,
    streamIdleMs: 45000,
    idleWatchdogMs: 90000,
    systemFor: () => "a system prompt",
    toolDefFor: () => null,
    pending: { add() {}, settle() {}, size: () => 0 },
  };
}

function turnBegin(covenant) {
  return { turnId: "t1", context: { conversation: [] }, covenant: { model: "claude-x", tools: [], posture: "resident", ...covenant } };
}

test("covenant.thinking === false overrides the walker's own --thinking flag for this turn", async () => {
  const events = [{ type: "tokens", content: "hi" }, { type: "complete", response: { content: [{ type: "text", text: "hi" }], usage: {} } }];
  const membrane = fakeMembrane(events);
  const { runTurn } = createTurnRunner(baseDeps(membrane));
  await runTurn(fakeSeat(), turnBegin({ thinking: false }));
  assert.equal("thinking" in membrane.request().config, false, "no thinking config at all when the covenant says off");
});

test("covenant.thinking unset: the walker's own --thinking flag still applies", async () => {
  const events = [{ type: "tokens", content: "hi" }, { type: "complete", response: { content: [{ type: "text", text: "hi" }], usage: {} } }];
  const membrane = fakeMembrane(events);
  const { runTurn } = createTurnRunner(baseDeps(membrane));
  await runTurn(fakeSeat(), turnBegin({}));
  assert.deepEqual(membrane.request().config.thinking, { enabled: true, budgetTokens: 4096 });
});

test("covenant.promptCaching overrides the auto-derived per-route default", async () => {
  const events = [{ type: "complete", response: { content: [{ type: "text", text: "hi" }], usage: {} } }];
  const membrane = fakeMembrane(events);
  const { runTurn } = createTurnRunner(baseDeps(membrane));
  await runTurn(fakeSeat(), turnBegin({ promptCaching: false }));
  assert.equal(membrane.request().promptCaching, false, "anthropic would auto-derive true; the covenant said false");
});

test("covenant.promptCaching unset: the auto-derived per-route default still applies", async () => {
  const events = [{ type: "complete", response: { content: [{ type: "text", text: "hi" }], usage: {} } }];
  const membrane = fakeMembrane(events);
  const { runTurn } = createTurnRunner(baseDeps(membrane));
  await runTurn(fakeSeat(), turnBegin({}));
  assert.equal(membrane.request().promptCaching, true, "anthropic route, not mock — auto-derives true");
});

test("a stream ending by length cap (no tool-calls event) still sends a final turn.event before turn.done", async () => {
  const events = [
    { type: "tokens", content: "part one " },
    { type: "tokens", content: "part two" },
    { type: "complete", response: { content: [{ type: "text", text: "part one part two" }], usage: {}, stopReason: "max_tokens" } },
  ];
  const membrane = fakeMembrane(events);
  const { runTurn } = createTurnRunner(baseDeps(membrane));
  const seat = fakeSeat();
  await runTurn(seat, turnBegin({}));
  const finals = seat.sent.filter((m) => m.type === "turn.event" && m.event?.kind === "final");
  assert.equal(finals.length, 1, `expected exactly one final turn.event, got ${JSON.stringify(seat.sent)}`);
  assert.equal(finals[0].event.text, "part one part two");
  assert.ok(seat.sent.some((m) => m.type === "turn.done"), "turn.done must still follow");
});
