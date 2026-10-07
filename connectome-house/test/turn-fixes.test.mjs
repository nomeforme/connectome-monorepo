/* The 2026-10-05 review fixes on the turn/record side:
 *  - `!stop`'s "[Cycle stopped]" is the house's notice, never the being's line;
 *  - a being's own interim words (between tool calls) ride as its lines; a
 *    peer's never do;
 *  - a reach stamped with its caller is credited to that caller;
 *  - `!steer` reaches a turn at its next tool boundary;
 *  - a thinking: true covenant turns thinking on even when the walker's own
 *    default is off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFullMessages } from "../src/life-entries.mjs";
import { createTurnRunner } from "../src/walk-turn.mjs";

const base = { run: "r", kind: "room", class: null, room: "x", people: [], visibility: "public", session: 0 };
const build = (frames, peers = []) =>
  buildFullMessages({ frames, handle: "aria", peers: new Set(peers), runDir: "/nonexistent", runId: "r", periodBase: base, closingFrame: null, restReason: null, fullText: true });
const texts = (msgs) => msgs.map((m) => `${m.participant}|${m.content[0]?.text ?? m.content[0]?.type}`);

test("!stop's notice renders as the house's line, not the being's own speech", () => {
  const out = build([{ seq: 1, type: "speech", by: "aria", inline: "[Cycle stopped]", notice: "cycle-stopped" }]);
  assert.deepEqual(texts(out), ["house|[your turn was stopped (!stop)]"]);
});

test("own interim words ride as the being's own lines; a peer's interim never rides", () => {
  const out = build(
    [
      { seq: 1, type: "speech", by: "aria", inline: "let me look that up", interim: true },
      { seq: 2, type: "speech", by: "bex", inline: "thinking out loud", interim: true },
      { seq: 3, type: "speech", by: "aria", inline: "found it" },
    ],
    ["bex"],
  );
  assert.deepEqual(texts(out), ["aria|let me look that up", "aria|found it"]);
});

test("a reach stamped with its caller is credited to it, whoever speaks next", () => {
  const frames = [
    { seq: 1, type: "reach", by: "bex", tool: "fetch", input: {}, callId: "c1" },
    { seq: 2, type: "reach.result", callId: "c1", ok: true, inline: "page" },
    { seq: 3, type: "speech", by: "aria", inline: "my words" },
  ];
  const out = build(frames, ["bex"]);
  // a peer's reach folds to one house line, never aria's own tool call
  assert.ok(!out.some((m) => m.content.some((b) => b.type === "tool_use")), "not rendered as aria's own tool call");
  assert.ok(out.some((m) => m.participant === "house" && /bex/.test(m.content[0].text)), "named as bex's");
});

function toolThenDone() {
  let provided = null;
  return {
    get provided() {
      return provided;
    },
    streamYielding() {
      const events = [
        { type: "tool-calls", calls: [{ id: "c1", name: "fetch", input: {} }] },
        { type: "complete", response: { content: [{ type: "text", text: "done" }], usage: {} } },
      ];
      let i = 0;
      return {
        [Symbol.asyncIterator]() {
          return { next: async () => (i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true }) };
        },
        cancel() {},
        provideToolResults(r) {
          provided = r;
        },
      };
    },
  };
}

function deps(membrane, extra = {}) {
  return {
    being: "aria",
    mock: false,
    membraneFor: () => membrane,
    maxOutputForModel: () => undefined,
    routeForModel: () => "anthropic",
    supportsThinking: () => true,
    usesAdaptiveThinking: () => false,
    thinking: undefined,
    thinkingEffort: "medium",
    maxTokensDefault: 16384,
    streamIdleMs: 45000,
    idleWatchdogMs: 90000,
    systemFor: () => "s",
    toolDefFor: () => null,
    pending: { add: (id, fn) => fn({ ok: true, content: "page text" }), settle() {}, size: () => 0 },
    ...extra,
  };
}
const seat = { send: () => true };
const begin = (covenant = {}) => ({ turnId: "t", room: "r", context: { conversation: [] }, covenant: { model: "claude-x", tools: [], posture: "resident", ...covenant } });

test("!steer: a line delivered mid-turn rides into the next tool result, under its speaker's name", async () => {
  const m = toolThenDone();
  const { runTurn } = createTurnRunner(deps(m, { takeSteers: () => [{ by: "mara", text: "focus on the second link" }] }));
  await runTurn(seat, begin());
  assert.match(String(m.provided[0].content), /page text\n\nmara: focus on the second link/);
});

test("thinking: true on the covenant turns thinking on though the walker's default is off", async () => {
  let req;
  const m = { streamYielding: (r) => ((req = r), toolThenDone().streamYielding()) };
  const { runTurn } = createTurnRunner(deps(m));
  await runTurn(seat, begin({ thinking: true }));
  assert.ok(req.config.thinking, "thinking rides the request");
  let req2;
  const m2 = { streamYielding: (r) => ((req2 = r), toolThenDone().streamYielding()) };
  await createTurnRunner(deps(m2)).runTurn(seat, begin());
  assert.equal(req2.config.thinking, undefined, "unset: the walker's own default (off) stands");
});

test("a dropped seat holds its open turn for the grace window; a seat back in time lets it carry on, one that isn't aborts it", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { handleSeatExit, handleSeatReturn } = await import("../src/room-seats.mjs");
  process.env.HOUSE_SEAT_GRACE_MS = "80";
  const runDir = mkdtempSync(join(tmpdir(), "seat-grace-"));
  writeFileSync(join(runDir, "class.json"), JSON.stringify({ class: "wondering", owner: "mara", being: "aria", beings: ["aria"], participants: [] }));
  writeFileSync(join(runDir, "frames.jsonl"), "");
  const mkTurn = () => {
    let resolved = null;
    return { handle: "aria", turnId: "t", pendingFinal: null, resolve: (v) => (resolved = v), get resolved() { return resolved; } };
  };
  const rec = { id: "room-grace", runDir, cls: null, turns: new Map(), seats: new Map() };

  const t1 = mkTurn();
  rec.turns.set("aria", t1);
  handleSeatExit(rec, "aria");
  assert.equal(rec.turns.get("aria"), t1, "still open during the grace window");
  handleSeatReturn(rec, "aria");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rec.turns.get("aria"), t1, "the seat came back: the turn carries on");
  assert.equal(t1.resolved, null);

  rec.turns.delete("aria");
  const t2 = mkTurn();
  rec.turns.set("aria", t2);
  handleSeatExit(rec, "aria");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rec.turns.get("aria"), undefined, "no seat back in time: aborted");
  assert.equal(t2.resolved?.kind, "aborted");
  assert.match(readFileSync(join(runDir, "frames.jsonl"), "utf8"), /seat disconnected/);
  delete process.env.HOUSE_SEAT_GRACE_MS;
});

test("the platform's copy of a being's own line (markdown stripped, U+FFFC before a mention) is folded, never the house repeating it", () => {
  const out = build([
    { seq: 1, type: "speech", by: "aria", inline: "I tried `polymarket` — *dead* for @0xG" },
    { seq: 1.5, type: "message", by: "aria", text: "I tried polymarket — dead for ￼@0xG" },
  ]);
  assert.deepEqual(texts(out), ["aria|I tried `polymarket` — *dead* for @0xG"]);
});

test("a peer's markdown reply and its stripped platform echo are one entry", () => {
  const out = build(
    [
      { seq: 1, type: "speech", by: "bex", inline: "**bold** claim" },
      { seq: 1.5, type: "message", by: "bex", text: "bold claim" },
    ],
    ["bex"],
  );
  assert.equal(out.length, 1);
});
