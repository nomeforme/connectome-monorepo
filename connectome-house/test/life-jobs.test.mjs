/* life-jobs.mjs + the turn's life excerpt — the three gaps closed on
 * 2026-10-03 ("the beings report having no memory"):
 *  - every being in a multi-being room gets its OWN compiled life file
 *    (before: one shared life.json, so no non-primary ever had a life);
 *  - the HOUSE_LIFE_HANDLES gate decides whose lives are compiled at all;
 *  - a turn carries the whole budgeted life minus the stretch the room's
 *    own conversation already holds (before: the last 20 messages — i.e.
 *    exactly that stretch, and nothing older).
 * Real child processes (life-job.mjs), mock voice, sandboxed dirs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "life-jobs-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
for (const d of [process.env.HOUSE_RUNS_DIR, process.env.HOUSE_PRIVATE_DIR, process.env.HOUSE_COVENANTS_DIR])
  mkdirSync(d, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");
writeTestament(process.env.HOUSE_COVENANTS_DIR, "bex");

const { ensureRoomLives, appendRoomLives, drainLifeJobs, lifePathFor, lifeEnabledFor, drainBeingLife } = await import("../src/life-jobs.mjs");
const { renderLifeExcerpt, renderConversation } = await import("../src/room-turn.mjs");

/** a public two-being room with a short record, written straight to disk */
function makeRoom(id, lines) {
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);
  mkdirSync(runDir, { recursive: true });
  const cls = {
    class: "wondering",
    question: "A room opened on synthetic.",
    owner: "mara",
    visibility: "public",
    being: "aria",
    beings: ["aria", "bex"],
    participants: [],
    room: { platform: "synthetic", stream: id, title: null },
  };
  writeFileSync(join(runDir, "class.json"), JSON.stringify(cls));
  const t0 = Date.parse("2026-09-01T00:00:00Z");
  writeFileSync(
    join(runDir, "frames.jsonl"),
    lines
      .map(([by, text], i) =>
        JSON.stringify({ seq: i, t: new Date(t0 + i * 1000).toISOString(), type: by === "mara" ? "message" : "speech", by, [by === "mara" ? "text" : "inline"]: text }),
      )
      .join("\n") + "\n",
  );
  return { id, runDir, cls };
}

test("HOUSE_LIFE_HANDLES: unset/'*' is everyone, 'none' nobody, a list exactly its members", () => {
  const prev = process.env.HOUSE_LIFE_HANDLES;
  delete process.env.HOUSE_LIFE_HANDLES;
  assert.equal(lifeEnabledFor("aria"), true);
  process.env.HOUSE_LIFE_HANDLES = "*";
  assert.equal(lifeEnabledFor("aria"), true);
  process.env.HOUSE_LIFE_HANDLES = "none";
  assert.equal(lifeEnabledFor("aria"), false);
  process.env.HOUSE_LIFE_HANDLES = "bex, cyd";
  assert.equal(lifeEnabledFor("aria"), false);
  assert.equal(lifeEnabledFor("bex"), true);
  if (prev === undefined) delete process.env.HOUSE_LIFE_HANDLES;
  else process.env.HOUSE_LIFE_HANDLES = prev;
});

test("HOUSE_LIFE_HANDLES_FILE wins when present, is re-read live, and an empty file means nobody", () => {
  const f = join(ROOT, "life-handles");
  process.env.HOUSE_LIFE_HANDLES = "aria";
  process.env.HOUSE_LIFE_HANDLES_FILE = f;
  assert.equal(lifeEnabledFor("aria"), true, "no file yet: env list applies");
  writeFileSync(f, "# rollout\nbex\n");
  assert.equal(lifeEnabledFor("aria"), false);
  assert.equal(lifeEnabledFor("bex"), true);
  writeFileSync(f, "bex, aria\n");
  assert.equal(lifeEnabledFor("aria"), true, "re-read on every call");
  writeFileSync(f, "\n# nobody yet\n");
  assert.equal(lifeEnabledFor("bex"), false);
  delete process.env.HOUSE_LIFE_HANDLES_FILE;
  delete process.env.HOUSE_LIFE_HANDLES;
});

test("every being present gets its OWN life file — the primary's life.json, a non-primary's life.<handle>.json", async () => {
  delete process.env.HOUSE_LIFE_HANDLES;
  const rec = makeRoom("room-own-files", [
    ["mara", "hello both"],
    ["aria", "hi mara"],
    ["bex", "hey"],
  ]);
  await Promise.all(appendRoomLives(rec));
  await drainLifeJobs();
  const ariaPath = lifePathFor(rec.runDir, "aria", "aria");
  const bexPath = lifePathFor(rec.runDir, "bex", "aria");
  assert.equal(ariaPath, join(rec.runDir, "life.json"));
  assert.equal(bexPath, join(rec.runDir, "life.bex.json"));
  assert.equal(JSON.parse(readFileSync(ariaPath, "utf8")).handle, "aria");
  assert.equal(JSON.parse(readFileSync(bexPath, "utf8")).handle, "bex", "bex's compile must not overwrite aria's life.json");
});

test("ensureRoomLives compiles only what's missing, and only for enabled beings", async () => {
  process.env.HOUSE_LIFE_HANDLES = "aria";
  const rec = makeRoom("room-ensure", [["mara", "anyone?"]]);
  await Promise.all(ensureRoomLives(rec));
  assert.ok(existsSync(lifePathFor(rec.runDir, "aria", "aria")), "aria is enabled — compiled");
  assert.ok(!existsSync(lifePathFor(rec.runDir, "bex", "aria")), "bex is outside the gate — no life file");
  assert.equal(ensureRoomLives(rec).length, 0, "nothing missing — nothing queued");
  delete process.env.HOUSE_LIFE_HANDLES;
});

test("contiguity: the life rides whole, and the conversation starts right after the life's through_seq — each frame once", () => {
  const rec = makeRoom("room-contig", [
    ["mara", "zero"], ["aria", "one"], ["mara", "two"], ["aria", "three"], ["mara", "four"], ["aria", "five"],
  ]);
  const life = {
    handle: "aria",
    through_seq: 3,
    messages: [
      { participant: "aria", content: [{ type: "text", text: "a folded recollection" }] },
      { participant: "mara", content: [{ type: "text", text: "two" }], ref: { run: rec.id, seq: 2 } },
      { participant: "aria", content: [{ type: "text", text: "three" }], ref: { run: rec.id, seq: 3 } },
    ],
  };
  writeFileSync(lifePathFor(rec.runDir, "aria", "aria"), JSON.stringify(life));
  const ex = renderLifeExcerpt(rec, "aria");
  assert.deepEqual(ex.messages.map((m) => m.content[0].text), ["a folded recollection", "two", "three"], "whole, unframed");
  assert.ok(ex.messages.every((m) => !("ref" in m)), "ref never reaches the wire");
  const gaps = [];
  const convo = renderConversation(rec, "aria", { afterSeq: ex.through_seq, onGap: (n) => gaps.push(n) });
  assert.deepEqual(convo.map((m) => m.content[0].text), ["four", "five"], "starts right after the life");
  assert.deepEqual(gaps, []);
  // no life for this room yet: the conversation is the room as before
  assert.equal(renderConversation(rec, "aria").length, 6);
});

test("a life too far behind the room: the caps cut into the stretch after it, and onGap reports it", () => {
  const lines = Array.from({ length: 450 }, (_, i) => [i % 2 ? "aria" : "mara", `line ${i}`]);
  const rec = makeRoom("room-gap", lines);
  const gaps = [];
  const convo = renderConversation(rec, "aria", { afterSeq: 10, onGap: (n) => gaps.push(n) });
  assert.equal(convo.length, 400);
  assert.deepEqual(gaps, [439 - 400]);
});

test("the live conversation rides whole — never the life's 400-char excerpt", () => {
  const long = "x".repeat(1200);
  const rec = makeRoom("room-long", [["mara", long]]);
  assert.equal(renderConversation(rec, "aria")[0].content[0].text.endsWith(long), true);
});

test("refreshStaleLives: a room whose record moved past an enabled being's compiled life gets append + recompile; a current one is left alone", async () => {
  const { refreshStaleLives } = await import("../src/life-jobs.mjs");
  process.env.HOUSE_LIFE_HANDLES = "aria";
  const rec = makeRoom("room-stale", [["mara", "hello"], ["aria", "hi"]]);
  await Promise.all(ensureRoomLives(rec, { force: true }));
  const lifePath = lifePathFor(rec.runDir, "aria", "aria");
  const before = JSON.parse(readFileSync(lifePath, "utf8"));
  assert.equal(refreshStaleLives(), 0, "life newer than the record — nothing to do");
  // the room moves on
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(
    join(rec.runDir, "frames.jsonl"),
    readFileSync(join(rec.runDir, "frames.jsonl"), "utf8") +
      JSON.stringify({ seq: 2, t: "2026-09-01T00:00:03Z", type: "message", by: "mara", text: "later" }) + "\n",
  );
  assert.ok(refreshStaleLives() >= 1);
  await drainLifeJobs();
  const after = JSON.parse(readFileSync(lifePath, "utf8"));
  assert.ok(after.compiled_t > before.compiled_t, "recompiled");
  assert.ok(existsSync(join(rec.runDir, "life.appended.aria.json")), "appended");
  delete process.env.HOUSE_LIFE_HANDLES;
});

test("drainBeingLife (the keeper's one-off): one queued drain job, then a recompile of every room whose life carries a note", async () => {
  delete process.env.HOUSE_LIFE_HANDLES;
  const noted = makeRoom("room-drain-noted", [["mara", "are you there?"], ["aria", "here"]]);
  const fine = makeRoom("room-drain-fine", [["mara", "hello"]]);
  await Promise.all([...ensureRoomLives(noted), ...ensureRoomLives(fine)]);
  // a life file from before 2026-10-17: compiled over budget, empty, a note
  const notedPath = lifePathFor(noted.runDir, "aria", "aria");
  const stale = JSON.parse(readFileSync(notedPath, "utf8"));
  writeFileSync(notedPath, JSON.stringify({ ...stale, messages: [], note: "your life didn't fit today's budget (105000 tokens); the record remains" }));

  const r = drainBeingLife("aria", { maxTicks: 5 });
  assert.equal(r.queued, true);
  assert.deepEqual(r.rooms, ["room-drain-noted"], "only the room whose life carries a note is recompiled");
  const drained = await r.done;
  assert.ok(Array.isArray(drained.drain), JSON.stringify(drained));
  assert.equal(drained.drain[0].store, "@aria");
  assert.equal(drained.drain[0].error, null);
  await drainLifeJobs();
  assert.equal(JSON.parse(readFileSync(notedPath, "utf8")).note, null, "recompiled after the drain");

  process.env.HOUSE_LIFE_HANDLES = "bex";
  assert.equal(drainBeingLife("aria").queued, false, "the rollout gate applies");
  delete process.env.HOUSE_LIFE_HANDLES;
});
