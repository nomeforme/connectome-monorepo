/* The cheap start (2026-10-05): every being gets a fresh life that begins
 * now, while its full re-fold waits on the checklist. Two things that has
 * to be true for:
 *  - a fold that throws (a rate limit, a route this house has no
 *    credentials for) never makes the next append store the period twice —
 *    the marker goes down before the fold, the fold is deferred;
 *  - a life that holds nothing yet tells the being so, in one house line,
 *    instead of nothing (or a copy of its address read as memory). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendFrames, frameFactory, writeClass, writeFrames, writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "life-bootstrap-"));
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });

const { openLife, appendPeriod, closeLife } = await import("../src/resident-life.mjs");
const { renderLifeExcerpt } = await import("../src/room-turn.mjs");
const { systemFor } = await import("../src/walk-address.mjs");
const { fQuestionAsked, fSpeech, fRested } = frameFactory();

test("a fold that throws is deferred: the period is stored once, marked, and the next append adds only what's new", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "zz-boot");
  const privateRoot = mkdtempSync(join(tmpdir(), "life-bootstrap-private-"));
  let calls = 0;
  const membrane = {
    async complete() {
      calls++;
      throw new Error("429 rate_limit_error");
    },
  };
  const life = await openLife({
    privateRoot,
    handle: "zz-boot",
    speaksFor: "mock",
    covenant: {},
    membrane,
    // tiny windows, so even this short period is over the fold threshold
    strategyOverrides: { recentWindowTokens: 10, targetChunkTokens: 20, headWindowTokens: 10 },
  });
  const runDir = mkdtempSync(join(tmpdir(), "life-bootstrap-run-"));
  writeClass(runDir, { class: "waking", owner: "zz-boot", visibility: "private", participants: [{ handle: "zz-boot", kind: "resident" }] });
  const long = (s) => `${s} ${"and more words to fill the chunk ".repeat(20)}`;
  writeFrames(runDir, [fQuestionAsked("zz-boot", long("one")), fSpeech("m", long("two")), fRested()]);

  const first = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(first.mode, "trunk");
  assert.ok(calls > 0, "the fold was attempted");
  assert.match(first.compress ?? "", /^deferred: .*429/);

  const ofRun = () => life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
  const s1 = ofRun().length; // ingress may shard long messages, so count what landed
  appendFrames(runDir, [fQuestionAsked("zz-boot", "three"), fSpeech("m", "four"), fRested()]);
  const second = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(second.session, 2);
  assert.equal(second.messages, 3, "only the new frames — session one was marked despite the failed fold");
  const mine = ofRun();
  assert.equal(mine.filter((m) => m.metadata.period.session === 1).length, s1, "session one not stored again");
  assert.equal(mine.filter((m) => m.metadata.period.session === 2).length, 3);
  closeLife(life);
});

test("a fresh life (only its address head) rides as no messages — but it rides, so the being is told how memory works, even in verbatim mode", () => {
  const runDir = join(process.env.HOUSE_RUNS_DIR, "boot-room");
  mkdirSync(runDir, { recursive: true });
  const cls = { class: "wondering", owner: "mara", visibility: "public", being: "aria", beings: ["aria"], participants: [] };
  writeFileSync(join(runDir, "class.json"), JSON.stringify(cls));
  writeFileSync(
    join(runDir, "life.json"),
    JSON.stringify({ handle: "aria", messages: [{ participant: "keeper", content: [{ type: "text", text: "The address, read once:\n\nYou are aria." }] }] }),
  );
  const ex = renderLifeExcerpt({ id: "boot-room", runDir, cls }, "aria", []);
  assert.ok(ex, "the life is present");
  assert.deepEqual(ex.messages, [], "no house line of its own — what is (not) there is the fact");

  writeTestament(process.env.HOUSE_COVENANTS_DIR, "verbatim-aria", {
    body: "# verbatim-aria\n\n## Address\n\nYou are the old fleet's own prompt.\n",
  });
  const base = { being: "verbatim-aria", covenant: { model: "claude-opus-4-8" } };
  const withLife = systemFor({ ...base, context: { conversation: [], life: ex } });
  const without = systemFor({ ...base, context: { conversation: [] } });
  assert.match(withLife, /^You are the old fleet's own prompt\./, "the persona still leads, unchanged");
  assert.match(withLife, /## Your memory/);
  assert.match(withLife, /Today's date is \d{4}-\d{2}-\d{2}\./);
  assert.equal(without.trim(), "You are the old fleet's own prompt.", "no life — nothing added");
});

test("a room owned by a being: the owner is a being, never a human whose consent its private memory waits on", async () => {
  const { roomPeople } = await import("../src/room-reach.mjs");
  const cls = {
    owner: "claude-opus-4-6",
    being: "claude-opus-4-6",
    beings: ["claude-opus-4-6", "claude-sonnet-5"],
    visibility: "private",
    participants: [
      { handle: "discord-abc123" },
      { handle: "claude-opus-4-6", kind: "resident" },
      { handle: "claude-sonnet-5", kind: "resident" },
    ],
  };
  const { others, beings } = roomPeople(cls, "claude-sonnet-5");
  assert.deepEqual(others, ["discord-abc123"]);
  assert.ok(beings.includes("claude-opus-4-6"));
});
