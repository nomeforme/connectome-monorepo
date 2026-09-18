// @ts-check
/* connectome-house/test/user-notes.test.mjs — user_note_read/write
 * (presence + group_visible consent gates, snapshot-on-replace) and
 * self_note_read/write (no presence/consent gate, cross-room reach
 * check) over a sandboxed private root. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeUserNotes } from "../src/user-notes.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "user-notes-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function fakeTrace() {
  return { frame: () => {}, result: (p) => ({ inline: String(p) }) };
}

const tools = makeUserNotes({ privateRoot: ROOT });

function call(ctx, handle, name, input, model) {
  tools.beginTurn(ctx, handle, model);
  return tools.execute({ id: "c1", name, input }).content;
}

test("user_note_read: nothing kept yet is an honest, valid state", () => {
  const ctx = { owner: "mara", humans: new Set(["mara"]), runDir: join(ROOT, "r1"), trace: fakeTrace() };
  const out = call(ctx, "aria", "user_note_read", {});
  assert.match(out, /nothing kept for @mara yet/);
});

test("user_note_write then user_note_read: round-trips, snapshotting the prior version", () => {
  const ctx = { owner: "mara", humans: new Set(["mara"]), runDir: join(ROOT, "r1"), trace: fakeTrace() };
  const w1 = call(ctx, "aria", "user_note_write", { text: "first testament" });
  assert.match(w1, /now reads as you wrote it/);
  assert.doesNotMatch(w1, /snapshotted/);
  const r1 = call(ctx, "aria", "user_note_read", {});
  assert.match(r1, /first testament/);
  const w2 = call(ctx, "aria", "user_note_write", { text: "revised testament" });
  assert.match(w2, /snapshotted, not lost/);
  const history = readdirSync(join(ROOT, "mara", "user.md.history"));
  assert.equal(history.length, 1);
});

test("user_note_read: a person not present in this room is refused", () => {
  const ctx = { owner: "mara", humans: new Set(["mara"]), runDir: join(ROOT, "r1"), trace: fakeTrace() };
  const out = call(ctx, "aria", "user_note_read", { person: "someone-else" });
  assert.match(out, /is not in this room/);
});

test("user_note_read: a present non-owner is refused absent group_visible", () => {
  const ctxWrite = { owner: "mara", humans: new Set(["mara"]), runDir: join(ROOT, "r2"), trace: fakeTrace() };
  call(ctxWrite, "aria", "user_note_write", { text: "mara's note" });
  const ctxRead = {
    owner: "theo",
    humans: new Set(["theo", "mara"]),
    runDir: join(ROOT, "r2"),
    trace: fakeTrace(),
  };
  const refused = call(ctxRead, "aria", "user_note_read", { person: "mara" });
  assert.match(refused, /keeps their note to themselves/);
});

test("self_note_read/write: no active being yet is refused", () => {
  tools.beginTurn({ runDir: join(ROOT, "r5"), trace: fakeTrace() }, null);
  const out = tools.execute({ id: "c1", name: "self_note_read", input: {} }).content;
  assert.match(out, /no active being here yet/);
});

test("self_note_write then self_note_read: round-trips under the being's own handle, model recorded", () => {
  const ctx = { runDir: join(ROOT, "r3"), trace: fakeTrace() };
  const w = call(ctx, "aria", "self_note_write", { text: "what I noticed" }, "claude-sonnet-5");
  assert.match(w, /now reads as you wrote it/);
  const r = call(ctx, "aria", "self_note_read", {});
  assert.match(r, /what I noticed/);
  assert.match(r, /claude-sonnet-5/);
  assert.ok(existsSync(join(ROOT, "aria", "self.md")));
});

test("self_note_write: an over-cap note is refused", () => {
  const ctx = { runDir: join(ROOT, "r4"), trace: fakeTrace() };
  const out = call(ctx, "aria", "self_note_write", { text: "x".repeat(9000) });
  assert.match(out, /biography, not a testament/);
});
