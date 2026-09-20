// @ts-check
/* harness-port 32: a peer's speech, mirrored straight back in as a `message`
 * frame carrying the identical text, is ONE utterance — not two. Confirmed
 * live 2026-09-20 (room bab97539-8c4f-4d8d-8c8b-75bdd4cd4cef, seq 6825
 * `speech` by claude-3-opus / seq 6825.5 `message` by claude-3-opus, same
 * text, byte-identical): a bridged platform (this room's own Signal seat)
 * echoes a peer's own just-sent speech back in as an "inbound" line before
 * `buildFullMessages` ever sees it, and — until this fix — both frames
 * passed their own independent non-empty-text guard and rode into the life/
 * turn context as two entries under the SAME @handle for the SAME words.
 * docs/harness-port/32-life-peer-dedupe.md has the full account. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFullMessages } from "../src/life-entries.mjs";

const A = "zz-lpd-being"; // the handle a life/turn is being rendered FOR
const PEER = "zz-lpd-peer"; // a peer present in the same room

const base = {
  run: "r",
  kind: "room",
  class: "walk",
  room: "r",
  people: [A, PEER],
  visibility: "public",
  session: 1,
};

const byText = (out, substr) => out.filter((m) => m.content[0]?.text?.includes(substr));

test("a peer's speech immediately echoed back as a `message` with the identical text folds to ONE entry, ref'd at the message frame", () => {
  const frames = [
    { seq: 10, t: "", type: "speech", by: PEER, inline: "hello from the peer" },
    { seq: 10.5, t: "", type: "message", by: PEER, text: "hello from the peer" },
  ];
  const out = buildFullMessages({
    frames,
    handle: A,
    peers: new Set([PEER]),
    runDir: "/nonexistent",
    runId: "r",
    periodBase: base,
    closingFrame: null,
    restReason: null,
  });
  const matches = byText(out, "hello from the peer");
  assert.equal(matches.length, 1, `expected one folded entry, got ${matches.length}`);
  assert.equal(matches[0].participant, PEER);
  // the message frame is what the platform delivered and what the record
  // indexes — the ref points there, not at the speech frame's own seq.
  assert.equal(matches[0].metadata.ref.seq, 10.5);
});

test("own-being speech immediately followed by a same-shaped `message` is NOT folded — own-turn behaviour unchanged", () => {
  const frames = [
    { seq: 20, t: "", type: "speech", by: A, inline: "my own words" },
    { seq: 20.5, t: "", type: "message", by: A, text: "my own words" },
  ];
  const out = buildFullMessages({
    frames,
    handle: A,
    peers: new Set([PEER]),
    runDir: "/nonexistent",
    runId: "r",
    periodBase: base,
    closingFrame: null,
    restReason: null,
  });
  const matches = byText(out, "my own words");
  assert.equal(matches.length, 2, "own-being speech+message dedupe is out of scope for this fix");
});

test("a peer's speech followed by a DIFFERENT message from the same peer is never folded", () => {
  const frames = [
    { seq: 30, t: "", type: "speech", by: PEER, inline: "first thing" },
    { seq: 30.5, t: "", type: "message", by: PEER, text: "a second, unrelated line" },
  ];
  const out = buildFullMessages({
    frames,
    handle: A,
    peers: new Set([PEER]),
    runDir: "/nonexistent",
    runId: "r",
    periodBase: base,
    closingFrame: null,
    restReason: null,
  });
  assert.equal(byText(out, "first thing").length, 1);
  assert.equal(byText(out, "a second, unrelated line").length, 1);
  assert.equal(out.length, 2);
});

test("a peer's speech with empty/unresolved text, immediately followed by its message frame, still yields exactly one entry (true before and after this fix)", () => {
  const frames = [
    { seq: 40, t: "", type: "speech", by: PEER, inline: "" },
    { seq: 40.5, t: "", type: "message", by: PEER, text: "the message carries the text" },
  ];
  const out = buildFullMessages({
    frames,
    handle: A,
    peers: new Set([PEER]),
    runDir: "/nonexistent",
    runId: "r",
    periodBase: base,
    closingFrame: null,
    restReason: null,
  });
  const matches = byText(out, "the message carries the text");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].participant, PEER);
});

test("a solo walk (no peers set) keeps frameTextOf's ordinary resolution — unaffected by the dedupe", () => {
  const frames = [
    { seq: 1, t: "", type: "speech", by: "claude-sonnet-5", inline: "solo speech" },
    { seq: 2, t: "", type: "reach", tool: "t", input: {}, callId: "c" },
    { seq: 3, t: "", type: "reach.result", callId: "c", ok: true, inline: "ok" },
    { seq: 4, t: "", type: "speech", by: "claude-sonnet-5", inline: "still solo" },
  ];
  const out = buildFullMessages({
    frames,
    handle: A,
    runDir: "/nonexistent",
    runId: "r",
    periodBase: base,
    closingFrame: null,
    restReason: null,
  });
  assert.equal(byText(out, "solo speech")[0]?.participant, A);
  assert.equal(byText(out, "still solo")[0]?.participant, A);
  assert.equal(out.filter((m) => m.content[0]?.type === "tool_use").length, 1);
});
