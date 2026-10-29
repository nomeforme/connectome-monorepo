// @ts-check
/* 2026-10-19: the being sees which message it is answering — a human's
 * platform reply to one of the rendering being's own posted lines is
 * marked `(replying to you) ` in buildFullMessages (external.jsonl's
 * inbound `reply_to` against that being's own outbound/echo ids). Also
 * the render-time echo fold for OLD records with markdown-stripped echoes,
 * now on pending-outbound.mjs's shared echoForm. Fake handles/ids only. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { replyMark, buildFullMessages, hydrateTail, repliesToHandle } from "../src/life-entries.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "reply-framing-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const ME = "zz-rf-being";
const PEER = "zz-rf-peer";
const HUMAN = "zz-rf-human";
const base = { run: "r", kind: "room", class: "walk", room: "r", people: [ME, PEER], visibility: "public", session: 1 };
const sha = (t) => createHash("sha256").update(t.trim()).digest("hex");
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** a run dir: ME spoke (seq 1, posted as m-me), PEER spoke (seq 2, m-peer),
 * then HUMAN replied to ME (seq 3), to PEER (seq 4), and plainly (seq 5) */
function room(name) {
  const runDir = join(ROOT, name);
  mkdirSync(runDir, { recursive: true });
  const frames = [
    { seq: 1, type: "speech", by: ME, inline: "my line" },
    { seq: 2, type: "speech", by: PEER, inline: "peer line" },
    { seq: 3, type: "message", by: HUMAN, text: "answering you", to: [ME] },
    { seq: 4, type: "message", by: HUMAN, text: "answering the peer", to: [PEER] },
    { seq: 5, type: "message", by: HUMAN, text: "just talking", to: [ME] },
  ];
  writeFileSync(join(runDir, "frames.jsonl"), jsonl(frames));
  writeFileSync(
    join(runDir, "external.jsonl"),
    jsonl([
      { direction: "out", platform: "signal", delivered: true, message_id: "m-me", by: ME, seq: 1 },
      { direction: "out", platform: "signal", delivered: true, message_id: "m-peer", by: PEER, seq: 2 },
      { direction: "in", platform: "signal", message_id: "h1", author: HUMAN, text_sha: sha("answering you"), reply_to: "m-me" },
      { direction: "in", platform: "signal", message_id: "h2", author: HUMAN, text_sha: sha("answering the peer"), reply_to: "m-peer" },
      { direction: "in", platform: "signal", message_id: "h3", author: HUMAN, text_sha: sha("just talking") },
    ]),
  );
  return { runDir, frames };
}

const render = (runDir, frames, handle, peers, replyMarker = true) =>
  buildFullMessages({
    replyMarker,
    frames,
    handle,
    peers: new Set(peers),
    runDir,
    runId: "r",
    periodBase: base,
    closingFrame: null,
    restReason: null,
    fullText: true,
  });
const textOf = (out, s) => out.find((m) => m.content[0]?.text?.includes(s))?.content[0].text;

test("a platform reply to the being's own line is marked for that being only", () => {
  const { runDir, frames } = room("a");
  const mine = render(runDir, frames, ME, [PEER]);
  assert.equal(textOf(mine, "answering you"), `${replyMark(ME)}answering you`);
  assert.equal(textOf(mine, "answering the peer"), "answering the peer", "a reply to someone else carries no mark");
  assert.equal(textOf(mine, "just talking"), "just talking", "being in `to` alone is not a reply");
  const peers = render(runDir, frames, PEER, [ME]);
  assert.equal(textOf(peers, "answering the peer"), `${replyMark(PEER)}answering the peer`);
  assert.equal(textOf(peers, "answering you"), "answering you");
  assert.equal(mine.find((m) => m.content[0].text.includes("answering you")).participant, HUMAN, "name prefixing untouched");
});

test("off by default: without the covenant's reply_marker nothing is marked", () => {
  const { runDir, frames } = room("off");
  const out = render(runDir, frames, ME, [PEER], false);
  assert.equal(textOf(out, "answering you"), "answering you");
});

test("the mark names the being: <replying to @handle>", () => {
  assert.equal(replyMark("pl-x"), "<replying to @pl-x> ");
});

test("a reply aimed at the being's own echo id (echo_of_seq row) is marked too", () => {
  const runDir = join(ROOT, "echo");
  mkdirSync(runDir, { recursive: true });
  const frames = [
    { seq: 1, type: "speech", by: ME, inline: "said once" },
    { seq: 2, type: "message", by: HUMAN, text: "to the echo" },
  ];
  writeFileSync(join(runDir, "frames.jsonl"), jsonl(frames));
  writeFileSync(
    join(runDir, "external.jsonl"),
    jsonl([
      { direction: "in", platform: "signal", message_id: "e-1", author: ME, echo_of_seq: 1 },
      { direction: "in", platform: "signal", message_id: "h-9", author: HUMAN, text_sha: sha("to the echo"), reply_to: "e-1" },
    ]),
  );
  assert.deepEqual([...repliesToHandle(runDir, ME)], [2]);
});

test("no external.jsonl at all — no marks, never a throw", () => {
  const frames = [{ seq: 1, type: "message", by: HUMAN, text: "hi" }];
  const out = render(join(ROOT, "missing"), frames, ME, []);
  assert.equal(out[0].content[0].text, "hi");
});

test("hydrateTail keeps the reply mark when it swaps an excerpt for the full text", () => {
  const { runDir } = room("hyd");
  const text = `${replyMark(ME)}answering you`;
  const cm = { getAllMessages: () => [{ content: [{ type: "text", text }], metadata: { ref: { run: "hyd", seq: 3 } } }] };
  const { messages, hydrated } = hydrateTail(/** @type {any} */ (cm), [{ participant: HUMAN, content: [{ type: "text", text }] }], ROOT);
  assert.equal(hydrated, 1);
  assert.equal(messages[0].content[0].text, text);
  assert.ok(runDir);
});

test("old records: a speech and its markdown-stripped platform echo fold to one entry", () => {
  const variants = [
    ["**the sauna goes cold.**", "the sauna goes cold."],
    ["a *proof-of-validation* step", "a proof-of-validation step"],
    ["see [docs](https://example.test/d)", "see docs https://example.test/d"],
    ["- one\n- two", "one\ntwo"],
  ];
  for (const [spoken, echoed] of variants) {
    const frames = [
      { seq: 7035, type: "speech", by: PEER, inline: spoken },
      { seq: 7035.5, type: "message", by: PEER, text: echoed },
    ];
    const out = render("/nonexistent", frames, ME, [PEER]);
    assert.equal(out.length, 1, `folded: ${spoken}`);
    const own = render("/nonexistent", frames.map((f) => ({ ...f, by: ME })), ME, [PEER]);
    assert.equal(own.length, 1, `own echo folded: ${spoken}`);
  }
});
