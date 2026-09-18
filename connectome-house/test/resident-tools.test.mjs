// @ts-check
/* connectome-house/test/resident-tools.test.mjs — makeResidentTools()'s
 * dispatch over rest/house/tell_keeper/draft_outward/ledger, exercising
 * resident-house.mjs's `house` reading and resident-proposals.mjs's
 * three proposal verbs through the same seam a real waking would use.
 * Sandboxes HOUSE_COVENANTS_DIR/HOUSE_PRIVATE_DIR/HOUSE_KEEPERS before
 * the first import (resident-covenant.mjs/testaments.mjs read them at
 * call time, but commands/permissions.mjs's env read happens fresh too).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const COVENANTS = mkdtempSync(join(tmpdir(), "resident-tools-covenants-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "resident-tools-private-"));
const RUNS = mkdtempSync(join(tmpdir(), "resident-tools-runs-"));
process.env.HOUSE_COVENANTS_DIR = COVENANTS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_KEEPERS = "robin";
process.env.HOUSE_RESIDENTS = "aria";
writeTestament(COVENANTS, "aria", { frontmatter: ["wakings_per_day: 3"] });

after(() => {
  rmSync(COVENANTS, { recursive: true, force: true });
  rmSync(PRIVATE, { recursive: true, force: true });
  rmSync(RUNS, { recursive: true, force: true });
  for (const v of ["HOUSE_COVENANTS_DIR", "HOUSE_PRIVATE_DIR", "HOUSE_RUNS_DIR", "HOUSE_KEEPERS", "HOUSE_RESIDENTS"])
    delete process.env[v];
});

const { makeResidentTools } = await import("../src/resident-tools.mjs");

function fakeTrace() {
  return { frame: () => {}, result: (p) => ({ inline: String(p) }) };
}

let closed = [];
const tools = makeResidentTools({
  privateRoot: PRIVATE,
  runsRoot: RUNS,
  requestClose: (job) => closed.push(job),
});

function call(ctx, name, input = {}) {
  tools.beginTurn(ctx, "aria");
  return tools.execute({ id: "c1", name, input }).content;
}

before(() => {
  mkdirSync(join(RUNS, "waking-1"), { recursive: true });
});

test("rest: needs a reason and exactly one of until/after", () => {
  const ctx = { owner: "aria", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  assert.match(call(ctx, "rest", {}), /needs a reason/);
  assert.match(call(ctx, "rest", { reason: "tired" }), /exactly one/);
  assert.match(call(ctx, "rest", { reason: "tired", until: "x", after: "1h" }), /exactly one/);
});

test("rest: sets the alarm unclamped and enqueues a close", () => {
  const ctx = { owner: "aria", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  const out = call(ctx, "rest", { reason: "done for now", after: "6h" });
  assert.match(out, /alarm set for/);
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], { branch: "waking-1", mode: "rested" });
  const alarm = JSON.parse(readFileSync(join(PRIVATE, "aria", "alarm.json"), "utf8"));
  assert.equal(alarm.reason, "done for now");
  assert.ok(typeof alarm.until === "string");
});

test("rest: stay_up_for keeps the door open instead of closing", () => {
  closed = [];
  const ctx = { owner: "aria", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  const out = call(ctx, "rest", { reason: "staying a bit", after: "6h", stay_up_for: "20m" });
  assert.match(out, /door stays open/);
  assert.equal(closed.length, 0);
});

test("rest: wake_on is narrowed to kind:keeper only", () => {
  const ctx = { owner: "aria", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  call(ctx, "rest", { reason: "x", after: "1h", wake_on: [{ kind: "keeper" }, { kind: "sealed" }] });
  const alarm = JSON.parse(readFileSync(join(PRIVATE, "aria", "alarm.json"), "utf8"));
  assert.deepEqual(alarm.wake_on, [{ kind: "keeper" }]);
});

test("house: a plain reading with no model call, sections present", () => {
  const ctx = { owner: "aria", cls: "waking", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  const out = call(ctx, "house");
  assert.match(out, /Your own clock:/);
  assert.match(out, /What arrived/);
  assert.match(out, /Filed /);
  assert.match(out, /Ledger:/);
});

test("tell_keeper: lands in the keeper's inbox as a proposal", () => {
  const ctx = { owner: "aria", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  const out = call(ctx, "tell_keeper", { text: "something noticed" });
  assert.match(out, /keeper's inbox/);
  const inbox = readFileSync(join(PRIVATE, "robin", "inbox.jsonl"), "utf8");
  assert.match(inbox, /something noticed/);
});

test("draft_outward: writes a draft to the outbox, nothing sent", () => {
  const ctx = { owner: "aria", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  const out = call(ctx, "draft_outward", { to: "someone", subject: "hi", body: "a letter" });
  assert.match(out, /drafted, not sent/);
  const files = readdirSync(join(PRIVATE, "aria", "outbox"));
  assert.equal(files.length, 1);
});

test("ledger: appends one line, over-cap refused", () => {
  const ctx = { owner: "aria", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  const out = call(ctx, "ledger", { text: "kept a note" });
  assert.match(out, /kept: kept a note/);
  const text = readFileSync(join(PRIVATE, "aria", "ledger.md"), "utf8");
  assert.match(text, /kept a note/);
  const tooLong = call(ctx, "ledger", { text: "x".repeat(1500) });
  assert.match(tooLong, /keep a ledger line under/);
});

test("house: reflects a fresh ledger/inbox tail after the above calls", () => {
  const ctx = { owner: "aria", cls: "waking", id: "waking-1", runDir: join(RUNS, "waking-1"), trace: fakeTrace() };
  const out = call(ctx, "house");
  assert.match(out, /kept a note/);
});

test("a call with no active room refuses honestly", () => {
  tools.beginTurn(null, "aria");
  const out = tools.execute({ id: "c1", name: "house", input: {} }).content;
  assert.match(out, /not reachable right now/);
});
