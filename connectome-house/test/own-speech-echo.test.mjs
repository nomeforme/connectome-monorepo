// @ts-check
/* connectome-house/test/own-speech-echo.test.mjs — harness-port 33
 * (docs/harness-port/33-own-speech-echo.md): the write-side half of the
 * race docs/harness-port/32-life-peer-dedupe.md only folds at RENDER time.
 * A being's own send_message/reply_message call can still be in flight (or
 * resolved a moment ago, its own external.jsonl row not yet written) when
 * the fleet's Signal daemon fans that SAME text back inbound under the
 * being's own handle — serve-rooms.mjs's roomInput used to have no way to
 * recognize that as anything but a new message. Exercised two ways below:
 * mcpl/pending-outbound.mjs's own ledger, pure; and the real
 * speak()/roomInput pair, driving the actual race timeline with a
 * controllable host.callTool. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "own-speech-echo-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
process.env.HOUSE_RESIDENTS = "";
process.env.HOUSE_IDENTITY_SALT = "own-speech-echo-salt-0123456789";

const RUNS = process.env.HOUSE_RUNS_DIR;
const BEING = "zz-ose-being"; // the echo gate is scoped to a KNOWN BEING sender
const HUMAN = "zz-ose-human"; // never gated — testamentFor is null for one
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, HUMAN), { recursive: true }); // knownHandle() without a testament
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING);

const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { createSpeaker } = await import("../src/mcpl/speak.mjs");
const { registerPendingOutbound, resolvePendingOutbound, takeMatchingPendingOutbound } = await import(
  "../src/mcpl/pending-outbound.mjs"
);
const { buildMessageIndex } = await import("../src/mcpl/message-index.mjs");
const { splitForPlatform } = await import("../src/mcpl/outbound.mjs");

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** a fresh room, seeded with one `speech` frame at `seq` — what the
 * being's own turn already wrote before speak() ever runs. A fresh,
 * random stream every call: openRoom reuses a room by (platform, stream). */
async function freshRoom(seq, text) {
  const stream = `own-speech-echo-${Math.random().toString(36).slice(2)}`;
  const { id, error } = await openRoom({
    platform: "synthetic",
    stream,
    title: "own-speech-echo.test.mjs only",
    beings: [BEING],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const runDir = join(RUNS, id);
  appendFileSync(
    join(runDir, "frames.jsonl"),
    `${JSON.stringify({ seq, t: new Date().toISOString(), type: "speech", by: BEING, inline: text })}\n`,
  );
  return { id, runDir };
}

/** a speaker over an unregistered platform ("matrix" — genericAdapter, no
 * mention-token/reply-threading specifics, and NOT "signal" so
 * splitLimitFor never touches commands/store.mjs's memory lookup) — the
 * split algorithm exercised is `splitForPlatform` either way. */
function makeSpeaker({ callTool, limit = 2000 }) {
  return createSpeaker({
    cfg: { platform: "matrix", limit, being: BEING, being_id: null, observe_only: false },
    host: { state: { tools: [] }, callTool },
    stats: { sent: 0, undelivered: 0 },
    say: () => {},
    RUNS,
    getAttachedAt: undefined,
  });
}

const messageFrames = (runDir) => framesOf(runDir).filter((f) => f.type === "message");

test("(a) race order — speech, then the echo inbound, then the outbound recorded: exactly one frame, one message-index entry", async () => {
  const seq = 10;
  const text = "the same words, echoed back inbound before the outbound row lands";
  const { id, runDir } = await freshRoom(seq, text);

  let resolveCall;
  const callPromise = new Promise((r) => {
    resolveCall = r;
  });
  const speaker = makeSpeaker({ callTool: async () => callPromise });

  // registerPendingOutbound runs synchronously inside speak(), before its
  // own `await host.callTool(...)` — by the time this call returns a
  // pending promise, the ledger row already exists.
  const sendP = speaker.speak(id, "matrix:c1", text, { by: BEING, seq });

  const echo = await roomInput({
    id,
    by: BEING,
    text,
    external: { platform: "matrix", message_id: "echo-msg-1" },
  });
  assert.equal(echo.ok, true);
  assert.equal(echo.echo, true, "recognized as the being's own echo, not a new message");
  assert.equal(messageFrames(runDir).length, 0, "no duplicate `message` frame while the send is still in flight");

  resolveCall({ messageId: "echo-msg-1" }); // the platform's own send finally resolves, same id
  await sendP;

  assert.equal(messageFrames(runDir).length, 0, "still no duplicate frame once recordOutbound has run too");
  assert.equal(
    buildMessageIndex(runDir).get("echo-msg-1"),
    seq,
    "the echoed platform id resolves to the ORIGINAL speech frame's own seq",
  );
});

test("(b) normal order — outbound recorded before the echo arrives: still deduped by the pre-existing message_id check, unchanged", async () => {
  const seq = 20;
  const text = "already recorded before the echo arrives";
  const { id, runDir } = await freshRoom(seq, text);
  const speaker = makeSpeaker({ callTool: async () => ({ messageId: "echo-msg-2" }) });
  await speaker.speak(id, "matrix:c1", text, { by: BEING, seq }); // resolves at once — recordOutbound has already run

  const r = await roomInput({
    id,
    by: BEING,
    text,
    external: { platform: "matrix", message_id: "echo-msg-2" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true, "caught by externalAlreadyRecorded — the new echo path is never even reached");
  assert.equal(messageFrames(runDir).length, 0);
  assert.equal(buildMessageIndex(runDir).get("echo-msg-2"), seq);
});

test("(c) a being's genuinely new inbound (different text) is never dropped", async () => {
  const seq = 30;
  const text = "the original speech";
  const { id, runDir } = await freshRoom(seq, text);
  const speaker = makeSpeaker({ callTool: async () => ({ messageId: "m-orig" }) });
  await speaker.speak(id, "matrix:c1", text, { by: BEING, seq });

  const other = "a completely different line, never sent by speak()";
  const r = await roomInput({
    id,
    by: BEING,
    text: other,
    external: { platform: "matrix", message_id: "echo-msg-3" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.echo, undefined, "the text never matched a pending/resolved send — not an echo");
  assert.ok(
    messageFrames(runDir).some((f) => f.text === other),
    "a genuinely new inbound message from the being still lands as its own `message` frame",
  );
});

test("(d) a human inbound with text identical to a being's own in-flight send is never treated as an echo", async () => {
  const seq = 40;
  const text = "an identical line, but a human said it this time";
  const { id, runDir } = await freshRoom(seq, text);

  let resolveCall;
  const callPromise = new Promise((r) => {
    resolveCall = r;
  });
  const speaker = makeSpeaker({ callTool: async () => callPromise });
  const sendP = speaker.speak(id, "matrix:c1", text, { by: BEING, seq }); // left in flight throughout

  const r = await roomInput({
    id,
    by: HUMAN,
    text,
    external: { platform: "matrix", message_id: "echo-msg-4" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.echo, undefined, "the sender is human — testamentFor is null, the echo gate never runs at all");
  assert.ok(messageFrames(runDir).some((f) => f.by === HUMAN && f.text === text));

  resolveCall({ messageId: "never-observed" });
  await sendP; // let the being's own still-pending send settle before the test ends
});

test("(e) a multi-chunk send (splitForPlatform) — each chunk's own echo is dropped, neither is duplicated", async () => {
  const seq = 50;
  const para1 = "first part of this message, on its own";
  const para2 = "second part of this message, on its own";
  const longText = `${para1}\n\n${para2}`;
  const LIMIT = 40;
  const chunks = splitForPlatform(longText, LIMIT);
  assert.equal(chunks.length, 2, "fixture text must actually split in two under this limit");
  assert.equal(chunks[0], para1);
  assert.equal(chunks[1], para2);

  const { id, runDir } = await freshRoom(seq, longText);

  /** @type {Array<(v: {messageId: string}) => void>} */
  const resolvers = [];
  let calls = 0;
  const speaker = makeSpeaker({
    limit: LIMIT,
    callTool: async () => {
      calls += 1;
      return new Promise((r) => resolvers.push(r));
    },
  });
  const sendP = speaker.speak(id, "matrix:c1", longText, { by: BEING, seq });

  // chunk 0's own host.callTool has already been invoked (registered
  // synchronously, same as test (a)) — its echo arrives before it resolves.
  const echo0 = await roomInput({
    id,
    by: BEING,
    text: chunks[0],
    external: { platform: "matrix", message_id: "echo-chunk-0" },
  });
  assert.equal(echo0.echo, true, "chunk 0's own echo is recognized");
  resolvers[0]({ messageId: "echo-chunk-0" });

  // let the loop's next iteration reach chunk 1's own host.callTool.
  for (let i = 0; i < 50 && calls < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, "chunk 1's own send should have started by now");

  const echo1 = await roomInput({
    id,
    by: BEING,
    text: chunks[1],
    external: { platform: "matrix", message_id: "echo-chunk-1" },
  });
  assert.equal(echo1.echo, true, "chunk 1's own echo is ALSO recognized — a distinct ledger row, not a fluke of chunk 0's");
  resolvers[1]({ messageId: "echo-chunk-1" });
  await sendP;

  assert.equal(messageFrames(runDir).length, 0, "neither chunk's echo produced a duplicate `message` frame");
  const idx = buildMessageIndex(runDir);
  assert.equal(idx.get("echo-chunk-0"), seq);
  assert.equal(idx.get("echo-chunk-1"), seq);
});

test("pending-outbound: register -> resolve -> take resolves to the registered seq; a match consumes the row (an echo is seen once)", () => {
  const runDir = "/fake/run/dir-1";
  registerPendingOutbound(runDir, { stream: "s1", by: BEING, text: "hello there", seq: 100 });
  resolvePendingOutbound(runDir, { by: BEING, text: "hello there", messageId: "m-100" });
  assert.equal(takeMatchingPendingOutbound(runDir, { by: BEING, text: "hello there" }), 100);
  assert.equal(
    takeMatchingPendingOutbound(runDir, { by: BEING, text: "hello there" }),
    null,
    "consumed — a second identical inbound is no longer treated as this same echo",
  );
});

test("pending-outbound: keyed on (room, being, text) — a different being or a different room never matches", () => {
  registerPendingOutbound("/fake/run/dir-2", { stream: "s1", by: BEING, text: "same words", seq: 5 });
  assert.equal(
    takeMatchingPendingOutbound("/fake/run/dir-2", { by: HUMAN, text: "same words" }),
    null,
    "different sender",
  );
  assert.equal(
    takeMatchingPendingOutbound("/fake/run/dir-3", { by: BEING, text: "same words" }),
    null,
    "different room",
  );
  assert.equal(
    takeMatchingPendingOutbound("/fake/run/dir-2", { by: BEING, text: "same words" }),
    5,
    "still there for the actual matching key",
  );
});

test("pending-outbound: an unmatched row ages out past the ledger's own bound, never leaking forever", () => {
  const runDir = "/fake/run/dir-ttl";
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    registerPendingOutbound(runDir, { stream: "s1", by: BEING, text: "old news", seq: 9 });
    Date.now = () => 1_000_000 + 6 * 60 * 1000; // 6 minutes later — past the 5-minute bound
    assert.equal(
      takeMatchingPendingOutbound(runDir, { by: BEING, text: "old news" }),
      null,
      "aged out — never matched once stale",
    );
  } finally {
    Date.now = realNow;
  }
});

/* 2026-10-19: a platform's copy is matched as the platform renders it —
 * Signal's styled mode strips markdown, so an exact-text ledger missed
 * every formatted echo and each became a duplicate `message` frame. */
const { echoForm } = await import("../src/mcpl/pending-outbound.mjs");

const MARKDOWN_ECHOES = [
  ["italic", "a *proof-of-validation* step", "a proof-of-validation step"],
  ["bold", "**the sauna goes cold.**", "the sauna goes cold."],
  ["underscore", "__strong__ and _soft_", "strong and soft"],
  ["code", "run `node --test` first", "run node --test first"],
  ["fence", "```\nconst a = 1;\n```", "const a = 1;"],
  ["strike + spoiler", "~~gone~~ ||secret||", "gone secret"],
  ["link", "see [the board](https://example.test/b)", "see the board https://example.test/b"],
  ["header", "## Notes\nbody", "Notes\nbody"],
  ["list", "- one\n- two\n1. three", "one\ntwo\nthree"],
  ["quote", "> quoted line", "quoted line"],
  ["signal mention", "hi <@0f0f0f0f-0000-4000-8000-000000000001> there", "hi ￼ there"],
  ["discord mention vs handle", "ping <@123456789012345678> now", "ping @zz-ose-human now"],
];

for (const [name, sent, echoed] of MARKDOWN_ECHOES) {
  test(`pending-outbound: a markdown-stripped echo still matches its send (${name})`, () => {
    const runDir = `/fake/run/md-${name}`;
    registerPendingOutbound(runDir, { stream: "s1", by: BEING, text: sent, seq: 7035 });
    assert.equal(takeMatchingPendingOutbound(runDir, { by: BEING, text: echoed }), 7035);
  });
}

test("pending-outbound: Discord's verbatim echo (markdown kept) matches exactly as before", () => {
  const runDir = "/fake/run/md-discord";
  const text = "**bold** and `code` and [a link](https://example.test)";
  registerPendingOutbound(runDir, { stream: "s1", by: BEING, text, seq: 3 });
  assert.equal(takeMatchingPendingOutbound(runDir, { by: BEING, text }), 3);
});

test("pending-outbound: different words never match, markdown or not", () => {
  const runDir = "/fake/run/md-diff";
  registerPendingOutbound(runDir, { stream: "s1", by: BEING, text: "**the sauna goes cold.**", seq: 4 });
  assert.equal(takeMatchingPendingOutbound(runDir, { by: BEING, text: "the sauna stays warm." }), null);
  assert.equal(echoForm("<@123>"), "", "a bare mention normalizes to nothing…");
  registerPendingOutbound(runDir, { stream: "s1", by: BEING, text: "<@123>", seq: 5 });
  assert.equal(takeMatchingPendingOutbound(runDir, { by: BEING, text: "<@999>" }), null, "…so it keys on its raw text");
});

test("(f) race order with markdown — Signal's stripped echo lands as an echo row, never a `message` frame", async () => {
  const seq = 7035;
  const text = "the *proof-of-validation* holds; **the sauna goes cold.**";
  const { id, runDir } = await freshRoom(seq, text);
  let resolveCall;
  const callPromise = new Promise((r) => {
    resolveCall = r;
  });
  const speaker = makeSpeaker({ callTool: async () => callPromise });
  const sendP = speaker.speak(id, "matrix:c1", text, { by: BEING, seq });
  const echo = await roomInput({
    id,
    by: BEING,
    text: "the proof-of-validation holds; the sauna goes cold.",
    external: { platform: "matrix", message_id: "md-echo-1" },
  });
  assert.equal(echo.echo, true);
  resolveCall({ messageId: "md-echo-1" });
  await sendP;
  assert.equal(messageFrames(runDir).length, 0, "no duplicate frame by the being");
  assert.equal(buildMessageIndex(runDir).get("md-echo-1"), seq);
});
