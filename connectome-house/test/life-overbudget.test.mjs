// @ts-check
/* life-overbudget.test.mjs — never an empty memory (2026-10-17).
 *
 * The live shape, reproduced small: a life whose compression failed for a
 * stretch (a broken voice — the fake membrane throws), so periods piled up
 * unsummarized behind the verbatim tail until the store no longer fit its
 * budget. Before, compileFor answered `messages: []`. Now (resident-life.mjs
 * `compileBudgeted`): the best memory that fits (a narrower tail, else the
 * newest stretch), never empty; one compression drain kicked per store
 * (single-flight); and once the drain has folded the backlog, the next
 * compile fits at the configured tail again. Partitions take the same path.
 *
 * Deterministic and order-safe: every test builds its own sandboxes
 * (mkdtemp) and its own fake membrane; nothing reaches a real model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOUSE_COVENANTS_DIR = mkdtempSync(join(tmpdir(), "house-ob-address-"));

const {
  openLife,
  appendPeriod,
  compileFor,
  compileForSettled,
  kickLifeDrain,
  settleLifeDrains,
  drainLifeAll,
  closeLife,
  TAIL_FLOOR_TOKENS,
} = await import("../src/resident-life.mjs");
const { partitionKey } = await import("../src/room-reach.mjs");

/* ---------- fixtures ---------- */

function writeTestament(dir, handle) {
  writeFileSync(
    join(dir, `${handle}.md`),
    ["---", "kind: testament", `handle: ${handle}`, "speaks_for: mock", "---", "", `# ${handle}\n\n## Address\n\nA fixture.\n`].join("\n"),
  );
}

/** a fake voice that can be broken (an expired token) and fixed; every
 * call answers with a short first-person memory, so folding shrinks the
 * store a lot. `gate` (optional) holds each call until released. */
function makeVoice() {
  const v = {
    broken: true,
    calls: 0,
    inFlight: 0,
    maxInFlight: 0,
    /** @type {null | (() => Promise<void>)} */
    gate: null,
    membrane: {
      async complete() {
        if (v.broken) throw Object.assign(new Error("401 token expired (fixture)"), { type: "auth", httpStatus: 401, retryable: false });
        v.calls++;
        v.inFlight++;
        v.maxInFlight = Math.max(v.maxInFlight, v.inFlight);
        try {
          if (v.gate) await v.gate();
          return {
            content: [{ type: "text", text: `I remember a stretch (#${v.calls}).` }],
            stopReason: "end_turn",
            usage: { inputTokens: 40, outputTokens: 8 },
            raw: {},
          };
        } finally {
          v.inFlight--;
        }
      },
    },
  };
  return v;
}

let seq = 0;
const iso = () => new Date().toISOString();

/** one period of `turns` exchanges, each with distinct filler so nothing
 * dedupes: a room owned by `owner` (the resident's own when owner ===
 * handle), private, with `others` present */
function writePeriod(handle, { owner = handle, others = [], turns = 3, tag = "" } = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "house-ob-run-"));
  const participants = [{ handle, kind: "resident" }, ...others.map((h) => ({ handle: h, kind: "human" }))];
  writeFileSync(
    join(runDir, "class.json"),
    JSON.stringify({
      class: owner === handle ? "waking" : "visit",
      owner,
      being: handle,
      visibility: "private",
      participants,
    }),
  );
  const frames = [];
  for (let i = 0; i < turns; i++) {
    const by = others[0] ?? handle;
    frames.push({ seq: seq++, t: iso(), type: "message", by, text: `${tag} question ${i}: ${"tell me about the river and the long road home ".repeat(3)}` });
    frames.push({ seq: seq++, t: iso(), type: "speech", by: handle, interim: false, inline: `${tag} answer ${i}: ${"the river bends twice before the mill and then runs straight to the sea ".repeat(3)}` });
  }
  frames.push({ seq: seq++, t: iso(), type: "rested" });
  writeFileSync(join(runDir, "frames.jsonl"), `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
  return runDir;
}

/** a life with a stretch of unsummarized periods (the voice was broken
 * while they were appended), then the voice fixed */
async function backloggedLife(handle, { budget, tail, periods = 10, voice = makeVoice() }) {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, handle);
  const privateRoot = mkdtempSync(join(tmpdir(), "house-ob-private-"));
  const life = await openLife({
    privateRoot,
    handle,
    speaksFor: "mock",
    covenant: { life_budget_tokens: budget, life_tail_tokens: tail, life_trunk_share: 1 },
    membrane: voice.membrane,
    strategyOverrides: { targetChunkTokens: 150, headWindowTokens: 30, quarantineAlarmIntervalMs: 0 },
  });
  let deferred = 0;
  for (let p = 0; p < periods; p++) {
    const r = (await quiet(() => appendPeriod(life, writePeriod(handle, { tag: `P${p}` }), { privateRoot }))).value;
    if (r.compress?.startsWith("deferred")) deferred++;
  }
  assert.ok(deferred > 0, "the broken voice deferred the folds");
  assert.equal(life.searchSummaries({ limit: 1000 }).length, 0, "nothing summarized: the backlog");
  voice.broken = false; // the voice is fixed (the house's static token)
  return { life, privateRoot, voice };
}

const quiet = async (fn) => {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = orig;
  }
};


const RESERVE = 4000; // openLife's fixed reserveForResponse on the trunk
const lifeFile = (runDir) => JSON.parse(readFileSync(join(runDir, "life.json"), "utf8"));
const roomDir = () => mkdtempSync(join(tmpdir(), "house-ob-compile-"));

/* ---------- the live shape: a raw backlog bigger than the budget ---------- */

test("an over-budget life (an unsummarized backlog) compiles to a non-empty memory that fits, kicks one drain, and fits normally after it", async () => {
  // ~4k tokens of raw periods against a 1000-token input budget: over at
  // every tail (the backlog itself is raw), so the bare rung answers
  const { life } = await backloggedLife("zz-ob-live", { budget: RESERVE + 1000, tail: 400 });
  const runDir = roomDir();

  const { value: out, lines } = await quiet(() => compileFor(life, runDir));
  assert.ok(out.messages.length > 0, "never an empty memory");
  assert.deepEqual(out.degraded, [{ store: "trunk", rung: "bare" }]);
  assert.match(out.note, /didn't fit today's budget .* newest stretch/);
  const cost = out.messages.reduce((n, m) => n + Math.ceil(JSON.stringify(m.content).length / 4), 0);
  assert.ok(cost <= 1000, `the bare memory fits the input budget (${cost})`);
  assert.equal(lifeFile(runDir).messages.length, out.messages.length, "the file a turn reads is the non-empty one");
  assert.equal(life.getHotContextSettings().tailTokens, 400, "the configured tail is restored after the ladder");
  assert.equal(lines.filter((l) => l.includes("kicking a compression drain")).length, 1);

  const drains = (await quiet(() => settleLifeDrains())).value.filter((d) => d.label === "@zz-ob-live");
  assert.equal(drains.length, 1);
  const [drain] = drains;
  assert.ok(drain.ticks > 0 && drain.drained, `the drain folded the backlog: ${JSON.stringify(drain)}`);
  assert.ok(drain.summaries.after > drain.summaries.before);

  const { value: again } = await quiet(() => compileFor(life, roomDir()));
  assert.equal(again.degraded, null, "after the drain: the normal path");
  assert.equal(again.note, null);
  assert.ok(again.messages.length > 0);
  closeLife(life);
});

test("compileForSettled: the degraded compile lands first, then the drain, then a full recompile — one call", async () => {
  const { life } = await backloggedLife("zz-ob-settled", { budget: RESERVE + 1000, tail: 400 });
  const runDir = roomDir();
  const { value: out } = await quiet(() => compileForSettled(life, runDir));
  assert.equal(out.settle?.recompiled, true);
  assert.equal(out.degraded, null);
  assert.equal(out.note, null);
  assert.ok(out.messages.length > 0);
  const onDisk = lifeFile(runDir);
  assert.equal(onDisk.degraded, null, "the file on disk is the settled one");
  assert.equal(onDisk.messages.length, out.messages.length);
  closeLife(life);
});

/* ---------- single-flight ---------- */

test("the drain is single-flight per store: kicks while one runs join it; the next kick after it settles starts anew", async () => {
  const voice = makeVoice();
  const { life } = await backloggedLife("zz-ob-single", { budget: RESERVE + 1000, tail: 400, voice });
  /** @type {Array<() => void>} */
  const held = [];
  voice.gate = () => new Promise((r) => held.push(r));

  const { value: out, lines } = await quiet(async () => {
    const o = await compileFor(life, roomDir()); // kicks the drain; its first fold is held
    const again = await compileFor(life, roomDir()); // over again: joins, never a second drain
    return { o, again, p1: kickLifeDrain(life), p2: kickLifeDrain(life) };
  });
  assert.ok(out.o.messages.length > 0 && out.again.messages.length > 0);
  assert.equal(out.p1, out.p2, "one promise: the same drain");
  assert.ok(lines.filter((l) => l.includes("already draining")).length >= 2, lines.join("\n"));

  // release folds one at a time until the drain settles
  voice.gate = null;
  while (held.length) held.shift()?.();
  const { value: results } = await quiet(() => settleLifeDrains());
  assert.equal(results.filter((d) => d.label === "@zz-ob-single").length, 1, "exactly one drain ran");
  assert.equal(voice.maxInFlight, 1, "never two folds at once");

  const p3 = kickLifeDrain(life);
  assert.notEqual(p3, out.p1, "a kick after the drain settled is a new drain");
  const d3 = (await quiet(() => p3)).value;
  assert.equal(d3.ticks, 0, "nothing left to fold");
  closeLife(life);
});

/* ---------- the tail rung ---------- */

test("a wide verbatim tail over existing summaries: the ladder narrows the tail for that compile and restores it", async () => {
  const handle = "zz-ob-wide";
  const { life, privateRoot, voice } = await backloggedLife(handle, { budget: RESERVE + 1000, tail: 400 });
  await quiet(() => kickLifeDrain(life, { maxTicks: 200 })); // fold everything older than the 400-token tail
  closeLife(life);

  // reopen with a tail wider than the whole budget: the summarized periods
  // now sit inside the tail, raw
  const wide = await openLife({
    privateRoot,
    handle,
    speaksFor: "mock",
    covenant: { life_budget_tokens: RESERVE + 2000, life_tail_tokens: 3800, life_trunk_share: 1 },
    membrane: voice.membrane,
    strategyOverrides: { targetChunkTokens: 150, headWindowTokens: 30, quarantineAlarmIntervalMs: 0 },
  });
  const { value: out } = await quiet(() => compileFor(wide, roomDir()));
  assert.ok(out.messages.length > 0);
  assert.equal(out.degraded?.length, 1);
  const [{ store, rung, tailTokens }] = out.degraded;
  assert.equal(store, "trunk");
  assert.equal(rung, "tail", "a narrower tail fits: no bare rung needed");
  assert.ok(tailTokens < 3800 && tailTokens >= TAIL_FLOOR_TOKENS, String(tailTokens));
  assert.ok(out.note.includes(`folded tighter than usual (a ${tailTokens}-token verbatim tail, not 3800)`), out.note);
  assert.ok(out.messages.some((m) => /I remember a stretch/.test(JSON.stringify(m.content))), "older periods ride as recollections");
  assert.equal(wide.getHotContextSettings().tailTokens, 3800, "restored");
  await quiet(() => settleLifeDrains());
  closeLife(wide);
});

test("the ladder's floor is TAIL_FLOOR_TOKENS", () => {
  assert.equal(TAIL_FLOOR_TOKENS, 1000);
});

/* ---------- partitions ---------- */

test("a partition over its budget takes the same path: non-empty, its own drain, fits after", async () => {
  const handle = "zz-ob-part";
  const other = "web-obpart";
  writeTestament(process.env.HOUSE_COVENANTS_DIR, handle);
  const privateRoot = mkdtempSync(join(tmpdir(), "house-ob-private-"));
  const voice = makeVoice();
  // trunk 4800 (input 800 — it holds only the head and one stub line per
  // period), the partition pool 1200 against ~4k raw tokens of private visits
  const life = await openLife({
    privateRoot,
    handle,
    speaksFor: "mock",
    covenant: { life_budget_tokens: 6000, life_tail_tokens: 400, life_trunk_share: 0.8 },
    membrane: voice.membrane,
    strategyOverrides: { targetChunkTokens: 150, headWindowTokens: 30, quarantineAlarmIntervalMs: 0 },
  });
  for (let p = 0; p < 10; p++) {
    const r = (await quiet(() => appendPeriod(life, writePeriod(handle, { owner: other, others: [other], tag: `V${p}` }), { privateRoot }))).value;
    assert.equal(r.mode, "partition");
    assert.equal(r.key, partitionKey([other]));
  }
  voice.broken = false;

  const { value: out } = await quiet(() => compileFor(life, roomDir(), { people: [other], hasWalker: false }));
  assert.equal(out.partitions.length, 1);
  assert.ok(out.partitions[0].messages > 0, "the partition's memory is not empty");
  assert.deepEqual(out.degraded, [{ store: partitionKey([other]), rung: "bare" }]);
  assert.match(out.note, /the room with @web-obpart didn't fit/);

  // settleLifeDrains is process-wide: read this test's own stores only
  const drains = (await quiet(() => settleLifeDrains())).value.filter((d) => d.label.startsWith("@zz-ob-part"));
  assert.deepEqual(drains.map((d) => d.label), ["@zz-ob-part/with/web-obpart"], "one drain: the partition's, the trunk fit");
  assert.ok(drains[0].ticks > 0 && drains[0].drained);

  const { value: again } = await quiet(() => compileFor(life, roomDir(), { people: [other], hasWalker: false }));
  assert.equal(again.degraded, null);
  assert.ok(again.partitions[0].messages > 0);

  // the keeper's one-off drain reaches the trunk and every partition
  const all = (await quiet(() => drainLifeAll(life))).value;
  assert.deepEqual(all.map((d) => d.label), ["@zz-ob-part", "@zz-ob-part/with/web-obpart"]);
  closeLife(life);
});

/* ---------- the bare rung keeps tool pairs whole ---------- */

test("bareMemory: newest messages that fit, head first, never a half tool pair, never empty", async () => {
  const { bareMemory } = await import("../src/resident-life.mjs");
  const msg = (participant, content, kind = "visit") => ({ participant, content, metadata: { period: { kind } } });
  const fake = (msgs) => ({ getAllMessages: () => msgs });
  const big = "x".repeat(400); // ~100 tokens
  const store = [
    msg("keeper", [{ type: "text", text: "The address, read once: hi" }], "head"),
    msg("zz", [{ type: "text", text: `old ${big}` }]),
    msg("zz", [{ type: "tool_use", id: "t1", name: "archive_glob", input: {} }]),
    msg("zz", [{ type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: big }] }]),
    msg("zz", [{ type: "text", text: `newest ${big}` }]),
  ];
  // room for the newest two only: the tool_result is in, its tool_use is not
  const two = bareMemory(fake(store), 230);
  assert.ok(two.length >= 1);
  assert.ok(!JSON.stringify(two).includes("tool_result"), "a result without its call is dropped");
  assert.ok(JSON.stringify(two).includes("newest"));
  // room for everything: the pair rides whole, head first
  const all = bareMemory(fake(store), 100_000);
  assert.equal(all[0].participant, "keeper");
  assert.ok(JSON.stringify(all).includes("tool_use") && JSON.stringify(all).includes("tool_result"));
  // no room at all: still the newest message
  const none = bareMemory(fake(store), 0);
  assert.equal(none.length, 1);
  assert.ok(JSON.stringify(none).includes("newest"));
});
