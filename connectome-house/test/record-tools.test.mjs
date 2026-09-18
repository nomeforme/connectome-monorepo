// @ts-check
/* connectome-house/test/record-tools.test.mjs — record_list/record_search/
 * record_read over a small sandboxed run ledger: visibility gating
 * (public lists to anyone; private only to its owner/participants, or a
 * being reading its own record from elsewhere), narrowing filters, and a
 * verbatim replay including pagination's own cursor. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameFactory, writeClass, writeFrames } from "./lib/fixtures.mjs";
import { makeRecordTools } from "../src/record-tools.mjs";

const RUNS = mkdtempSync(join(tmpdir(), "record-tools-runs-"));
after(() => rmSync(RUNS, { recursive: true, force: true }));

function fakeTrace() {
  return { frame: () => {}, result: (p) => ({ inline: String(p) }) };
}

// room A: public, opened by mara, one exchange
{
  const dir = join(RUNS, "room-a");
  writeClass(dir, { class: "wondering", owner: "mara", question: "what is stillness?", visibility: "public" });
  const f = frameFactory();
  writeFrames(dir, [
    f.fWorldMounted({ model: "sonnet" }),
    f.fQuestionAsked("mara", "what is stillness?"),
    f.fSpeech("aria", "a first answer about stillness and quiet."),
  ]);
}
// room B: private, owned by beren, aria never present
{
  const dir = join(RUNS, "room-b");
  writeClass(dir, { class: "sounding", owner: "beren", visibility: "private", participants: [] });
  const f = frameFactory();
  writeFrames(dir, [f.fWorldMounted({}), f.fQuestionAsked("beren", "a private question")]);
}
// room C: private, owned by aria itself (the being's own record)
{
  const dir = join(RUNS, "room-c");
  writeClass(dir, { class: "waking", owner: "aria", visibility: "private", participants: [] });
  const f = frameFactory();
  writeFrames(dir, [f.fWorldMounted({}), f.fSpeech("aria", "a private thought of my own.")]);
}

const tools = makeRecordTools({ runsRoot: RUNS });

function run(handle, name, input = {}) {
  tools.beginTurn({ owner: "mara", runDir: join(RUNS, "room-a"), trace: fakeTrace() }, handle);
  return tools.execute({ id: "c1", name, input }).content;
}

test("record_list: a public room lists for anyone; a private one owned by someone else does not", () => {
  const out = run("aria", "record_list", {});
  assert.match(out, /room-a/);
  assert.doesNotMatch(out, /room-b/);
});

test("record_list: a being sees its OWN private record from anywhere", () => {
  const out = run("aria", "record_list", {});
  assert.match(out, /room-c/);
});

test("record_list: kind filter narrows", () => {
  const out = run("aria", "record_list", { kind: "wondering" });
  assert.match(out, /room-a/);
  assert.doesNotMatch(out, /room-c/);
});

test("record_search: finds a pattern in spoken text, with a snippet", () => {
  const out = run("aria", "record_search", { pattern: "stillness" });
  assert.match(out, /room-a/);
  assert.match(out, /stillness/);
});

test("record_search: an invalid regex is refused honestly, not thrown", () => {
  const out = run("aria", "record_search", { pattern: "(" });
  assert.match(out, /doesn't parse/);
});

test("record_read: replays a public room verbatim", () => {
  const out = run("aria", "record_read", { room: "room-a" });
  assert.match(out, /the record of room-a/);
  assert.match(out, /a first answer about stillness/);
});

test("record_read: a private room not one's own is refused", () => {
  const out = run("aria", "record_read", { room: "room-b" });
  assert.match(out, /is readable from here/);
});

test("record_read: a being reads its own private record from elsewhere", () => {
  const out = run("aria", "record_read", { room: "room-c" });
  assert.match(out, /a private thought of my own/);
});

test("record_read: an invalid id is refused without touching the filesystem", () => {
  const out = run("aria", "record_read", { room: "../../etc/passwd" });
  assert.match(out, /doesn't name a room/);
});
