/* 🫥 takes a line out of what a being sees (un-reacting returns it), a
 * platform delete withdraws it, an edit replaces its text — a human's line
 * or a being's own spoken one (reacted to through its posted copy). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFullMessages } from "../src/life-entries.mjs";

const base = { run: "r", kind: "room", class: null, room: "x", people: [], visibility: "public", session: 0 };
const build = (frames) =>
  buildFullMessages({ frames, handle: "aria", peers: new Set(), runDir: "/nonexistent", runId: "r", periodBase: base, closingFrame: null, restReason: null, fullText: true })
    .map((m) => `${m.participant}|${m.content[0]?.text}`);

const convo = [
  { seq: 1, type: "message", by: "mara", text: "keep me" },
  { seq: 2, type: "message", by: "mara", text: "hide me" },
  { seq: 3, type: "speech", by: "aria", inline: "my reply" },
  { seq: 3.5, type: "message", by: "aria", text: "my reply" },
  { seq: 4, type: "message", by: "mara", text: "typo" },
  { seq: 5, type: "message", by: "mara", text: "delete me" },
];

test("a 🫥'd line is gone; an un-reacted one is back", () => {
  assert.deepEqual(build([...convo, { seq: 6, type: "hidden", target: 2, by: ["mara"] }]), [
    "mara|keep me", "aria|my reply", "mara|typo", "mara|delete me",
  ]);
  const back = build([...convo, { seq: 6, type: "hidden", target: 2, by: ["mara"] }, { seq: 7, type: "hidden", target: 2, by: [] }]);
  assert.ok(back.includes("mara|hide me"));
});

test("a being's own line 🫥'd through its posted copy is gone too", () => {
  const out = build([...convo, { seq: 6, type: "hidden", target: 3.5, by: ["mara"] }]);
  assert.ok(!out.some((l) => l.includes("my reply")));
});

test("an edit replaces the text; a delete leaves only the fact", () => {
  const out = build([...convo, { seq: 6, type: "edited", target: 4, text: "fixed" }, { seq: 7, type: "retracted", target: 5 }]);
  assert.ok(out.includes("mara|fixed") && !out.includes("mara|typo"));
  assert.ok(!out.includes("mara|delete me"));
  assert.ok(out.includes("house|[a message was withdrawn]"));
});
