// @ts-check
/* connectome-house/test/stage-tools.test.mjs — task_continue: refuses
 * when unarmed, counts returns against the human-staged budget and the
 * covenant's own returns_per_period alike, and stops at each cap. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStageTools } from "../src/stage-tools.mjs";

function fakeTrace() {
  const frames = [];
  return { frames, frame: (type, data) => frames.push({ type, ...data }), result: (p) => ({ inline: String(p) }) };
}

function call(tools, name, input) {
  return tools.execute({ id: "c1", name, input });
}

test("task_continue: refuses when neither staged nor own-continuation is armed", async () => {
  const tools = makeStageTools({ requestContinue: () => {} });
  tools.beginTurn({ id: "r1", trace: fakeTrace() }, "aria");
  const out = await call(tools, "task_continue", { next: "x" });
  assert.match(out.content, /not armed/);
});

test("task_continue: a human-staged room counts against the default budget", async () => {
  const requested = [];
  const tools = makeStageTools({ requestContinue: (job) => requested.push(job) });
  const ctx = { id: "r2", trace: fakeTrace(), stagedWork: true };
  tools.beginTurn(ctx, "aria");
  const out = await call(tools, "task_continue", { next: "the next tranche" });
  assert.equal(ctx.stageContinues, 1);
  assert.equal(ctx.continuedThisTurn, true);
  assert.equal(requested.length, 1);
  assert.deepEqual(requested[0], { room: "r2", handle: "aria" });
  assert.match(out.content, /1\/6 returns/);
});

test("task_continue: an own-continuation period uses ownReturnsMax and its own wording", async () => {
  const tools = makeStageTools({ requestContinue: () => {} });
  const ctx = { id: "r3", trace: fakeTrace(), ownContinuation: true, ownReturnsMax: 2 };
  tools.beginTurn(ctx, "aria");
  await call(tools, "task_continue", {});
  const out = await call(tools, "task_continue", {});
  assert.match(out.content, /2\/2 returns this period/);
  const capped = await call(tools, "task_continue", {});
  assert.match(capped.content, /returns are spent/);
});

test("task_continue: the human-staged budget caps at 6 and reports spent", async () => {
  const tools = makeStageTools({ requestContinue: () => {} });
  const ctx = { id: "r4", trace: fakeTrace(), stagedWork: true, stageContinues: 6 };
  tools.beginTurn(ctx, "aria");
  const out = await call(tools, "task_continue", {});
  assert.match(out.content, /stage budget.*spent/);
});
