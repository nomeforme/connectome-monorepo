// @ts-check
/* connectome-house/test/reactions-edits.test.mjs — harness-port P-F,
 * 2026-09-17 (mission task 1; PARITY-discord.md §5 / mcpl-signal/
 * PARITY.md §5's own "what this leaves for whoever picks up RX1/RX2/O21/
 * O22"): route.mjs's new reaction/edit/delete branches (pure, stubbed
 * deps — mirrors test/mcpl-route.test.mjs's own style), message-index.mjs's
 * platform-message-id -> frame-seq lookup (real mktemp files, both
 * directions), and room-tails.mjs's applyMetaFrameAction (real frames.jsonl,
 * checked against frame-schema.mjs's own Frame union). */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { routeIncoming } from "../src/mcpl/route.mjs";
import { normalizeIncoming, normalizePush } from "../src/mcpl/normalize.mjs";
import { buildMessageIndex, currentHiddenBy, frameSeqForMessageId } from "../src/mcpl/message-index.mjs";
import { applyMetaFrameAction, isMetaFrameAction } from "../src/mcpl/room-tails.mjs";
import { Frame } from "../src/frame-schema.mjs";

const ajv = new Ajv({ strict: false });
const validateFrame = ajv.compile(Frame);

const ROOT = mkdtempSync(join(tmpdir(), "reactions-edits-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/* ---------------------------------------------------------------------- */
/* route.mjs: the new reaction/edit/delete branches, pure, stubbed deps    */
/* ---------------------------------------------------------------------- */

const BEING = "watson";
const SERVER = {
  name: "mock-1",
  platform: "discord",
  being: BEING,
  rooms: [{ stream: "discord:g1:c1", title: "general", beings: [BEING], public: true }],
};

function deps(overrides = {}) {
  return {
    server: SERVER,
    roomsOpen: (s) => (s === "discord:g1:c1" ? { id: "room-abc123", beings: [BEING], live: true } : null),
    identityFor: ({ platform, id, display }) => ({ handle: `${platform}-${id}`, known: true, display }),
    isBeing: (h) => h === BEING,
    covenants: () => ({ posture: "present", dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 } }),
    roomKeyOf: (stream) => `discord:${stream}`,
    awakeOf: () => true,
    streakOf: () => 0,
    frameSeqFor: () => 42,
    ...overrides,
  };
}

function reactionPush({ emoji, action = "add", messageId = "m1", reactorId = "u1", reactorName = "alice" }) {
  return normalizePush({
    eventId: `discord_reaction_${action}_${messageId}_${emoji}_${reactorId}_1`,
    origin: {
      source: "discord",
      channelId: "discord:g1:c1",
      messageId,
      guildId: "g1",
      reactorId,
      reactorName,
      emoji,
      action,
    },
    tags: [action === "add" ? "chat:reaction" : "chat:reaction-remove"],
    payload: { content: [{ type: "text", text: `[reaction] @${reactorName} reacted ${emoji} on message ${messageId}` }] },
  });
}

test("route.mjs: a 🫥 reaction add on an already-open room resolves to a redact action, house handle attributed", () => {
  const msg = reactionPush({ emoji: "\u{1FAE5}", action: "add" });
  const actions = routeIncoming({ ...deps(), msg });
  assert.deepEqual(actions, [
    { kind: "redact", stream: "discord:g1:c1", roomId: "room-abc123", target: 42, action: "add", by: "discord-u1" },
  ]);
});

test("route.mjs: a 🫥 reaction remove resolves action:'remove' (RX2 — the last un-react makes it visible again)", () => {
  const msg = reactionPush({ emoji: "\u{1FAE5}", action: "remove", reactorId: "u2", reactorName: "bob" });
  const actions = routeIncoming({ ...deps(), msg });
  assert.equal(actions[0].kind, "redact");
  assert.equal(actions[0].action, "remove");
  assert.equal(actions[0].by, "discord-u2");
});

test("route.mjs: any other emoji never redacts (RX4/RX8) — ignored, never entered as ordinary text", () => {
  const msg = reactionPush({ emoji: "\u{1F600}" });
  assert.deepEqual(routeIncoming({ ...deps(), msg }), [{ kind: "ignore", reason: "reaction-not-redaction" }]);
});

test("route.mjs: a reaction on a room never opened here is ignored, never guessed into opening one", () => {
  const msg = reactionPush({ emoji: "\u{1FAE5}" });
  assert.deepEqual(routeIncoming({ ...deps({ roomsOpen: () => null }), msg }), [
    { kind: "ignore", reason: "reaction-no-room" },
  ]);
});

test("route.mjs: a reaction whose target platform id can't be resolved to a frame seq is an honest ignore, never guessed", () => {
  const msg = reactionPush({ emoji: "\u{1FAE5}" });
  assert.deepEqual(routeIncoming({ ...deps({ frameSeqFor: () => null }), msg }), [
    { kind: "ignore", reason: "reaction-target-not-found" },
  ]);
});

test("route.mjs: discord's own text-template edit push (no messageId in origin at all) resolves to an edited action, id recovered from eventId", () => {
  const msg = normalizePush({
    eventId: "discord_edit_555",
    origin: { source: "discord", channelId: "discord:g1:c1" },
    tags: [],
    payload: { content: [{ type: "text", text: "[message edited] hello, again" }] },
  });
  const actions = routeIncoming({ ...deps(), msg });
  assert.deepEqual(actions, [
    { kind: "edited", stream: "discord:g1:c1", roomId: "room-abc123", target: 42, text: "hello, again" },
  ]);
});

test("route.mjs: discord's own text-template delete push resolves to a retracted action, never carrying the deleted text", () => {
  const msg = normalizePush({
    eventId: "discord_delete_999",
    origin: { source: "discord", channelId: "discord:g1:c1" },
    tags: [],
    payload: { content: [{ type: "text", text: "[message deleted] 999" }] },
  });
  const actions = routeIncoming({ ...deps(), msg });
  assert.deepEqual(actions, [{ kind: "retracted", stream: "discord:g1:c1", roomId: "room-abc123", target: 42 }]);
});

test("route.mjs: an edited message's own new text is NEVER read as a fresh '!' command, even if it starts with one", () => {
  const msg = normalizePush({
    eventId: "discord_edit_777",
    origin: { source: "discord", channelId: "discord:g1:c1" },
    tags: [],
    payload: { content: [{ type: "text", text: "[message edited] !stop" }] },
  });
  const actions = routeIncoming({ ...deps(), msg });
  assert.equal(actions[0].kind, "edited", "the edit branch must win over the command lane");
  assert.equal(actions[0].text, "!stop");
});

test("route.mjs: mcpl-signal's own structured chat:edited/chat:deleted tags (a real targetMessageId, no text template needed)", () => {
  const signalServer = { ...SERVER, platform: "signal", rooms: [{ stream: "signal:group:g1", title: "g", beings: [BEING], public: true }] };
  const editMsg = normalizePush({
    eventId: "e1",
    origin: { source: "signal", channelId: "signal:group:g1", targetMessageId: "1700000000000", authorId: "u1" },
    tags: ["chat:edited"],
    payload: { content: [{ type: "text", text: "the corrected words" }] },
  });
  const editActions = routeIncoming({
    ...deps({ server: signalServer, roomsOpen: (s) => (s === "signal:group:g1" ? { id: "room-sig1", beings: [BEING], live: true } : null) }),
    msg: editMsg,
  });
  assert.deepEqual(editActions, [
    { kind: "edited", stream: "signal:group:g1", roomId: "room-sig1", target: 42, text: "the corrected words" },
  ]);

  const deleteMsg = normalizePush({
    eventId: "e2",
    origin: { source: "signal", channelId: "signal:group:g1", targetMessageId: "1700000000001", authorId: "u1" },
    tags: ["chat:deleted"],
    payload: { content: [] },
  });
  const deleteActions = routeIncoming({
    ...deps({ server: signalServer, roomsOpen: (s) => (s === "signal:group:g1" ? { id: "room-sig1", beings: [BEING], live: true } : null) }),
    msg: deleteMsg,
  });
  assert.deepEqual(deleteActions, [{ kind: "retracted", stream: "signal:group:g1", roomId: "room-sig1", target: 42 }]);
});

test("route.mjs: an edit/delete with no target id at all is an honest ignore", () => {
  const msg = normalizePush({
    eventId: "e3",
    origin: { source: "signal", channelId: "discord:g1:c1" },
    tags: ["chat:edited"],
    payload: { content: [{ type: "text", text: "x" }] },
  });
  assert.deepEqual(routeIncoming({ ...deps(), msg }), [{ kind: "ignore", reason: "edit-no-target-id" }]);
});

test("route.mjs: an ordinary message (no reaction/edit/delete signal at all) is unaffected — falls through to the normal input path", () => {
  const msg = incomingLike("hey there, just chatting");
  const actions = routeIncoming({ ...deps(), msg });
  assert.ok(actions.some((a) => a.kind === "input"), "the ordinary path still runs");
  assert.ok(!actions.some((a) => isMetaFrameAction(a)));
});

function incomingLike(text) {
  return normalizeIncoming({
    channelId: "discord:g1:c1",
    messageId: "m-1",
    author: { id: "u-alice", name: "alice" },
    timestamp: "t",
    content: [{ type: "text", text: `alice: ${text}` }],
    metadata: {},
    tags: ["chat:ambient", "chat:from-human"],
  });
}

/* ---------------------------------------------------------------------- */
/* message-index.mjs: platform message_id -> frame seq, both directions   */
/* ---------------------------------------------------------------------- */

function freshRunDir(name) {
  const d = join(ROOT, name);
  mkdirSync(d, { recursive: true });
  return d;
}

test("message-index.mjs: outbound rows carry seq directly — no correlation needed", () => {
  const runDir = freshRunDir("mi-outbound");
  appendFileSync(
    join(runDir, "external.jsonl"),
    `${JSON.stringify({ direction: "out", platform: "discord", message_id: "d1", by: "watson", seq: 3, delivered: true })}\n` +
      `${JSON.stringify({ direction: "out", platform: "discord", message_id: "d2", by: "watson", seq: 4, delivered: true })}\n`,
  );
  const index = buildMessageIndex(runDir);
  assert.equal(index.get("d1"), 3);
  assert.equal(index.get("d2"), 4);
  assert.equal(frameSeqForMessageId(runDir, "d1"), 3);
  assert.equal(frameSeqForMessageId(runDir, "nope"), null);
});

test("message-index.mjs: inbound rows correlate positionally against frames.jsonl by (author, text_sha), in strict order", () => {
  const runDir = freshRunDir("mi-inbound");
  const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
  writeFileSync(
    join(runDir, "frames.jsonl"),
    [
      { seq: 0, t: "t0", type: "room.mounted", platform: "discord", substrate: "jsonl-fallback" },
      { seq: 1, t: "t1", type: "message", by: "alice", text: "first" },
      { seq: 2, t: "t2", type: "message", by: "bob", text: "an unrelated aside" },
      { seq: 3, t: "t3", type: "message", by: "alice", text: "second" },
    ]
      .map((f) => JSON.stringify(f))
      .join("\n") + "\n",
  );
  writeFileSync(
    join(runDir, "external.jsonl"),
    [
      { direction: "in", platform: "discord", message_id: "in-1", author: "alice", text_sha: sha("first") },
      { direction: "in", platform: "discord", message_id: "in-2", author: "alice", text_sha: sha("second") },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  const index = buildMessageIndex(runDir);
  assert.equal(index.get("in-1"), 1, "the FIRST alice message, not bob's in between");
  assert.equal(index.get("in-2"), 3, "the SECOND alice message, cursor advanced past the first match");
});

test("message-index.mjs: an inbound row with no matching frame yet is an honest miss, never guessed", () => {
  const runDir = freshRunDir("mi-miss");
  writeFileSync(join(runDir, "frames.jsonl"), `${JSON.stringify({ seq: 0, t: "t0", type: "room.mounted", platform: "discord", substrate: "jsonl-fallback" })}\n`);
  writeFileSync(
    join(runDir, "external.jsonl"),
    `${JSON.stringify({ direction: "in", platform: "discord", message_id: "in-9", author: "alice", text_sha: "deadbeef" })}\n`,
  );
  assert.equal(frameSeqForMessageId(runDir, "in-9"), null);
});

test("message-index.mjs currentHiddenBy: none yet -> [], one hider -> [handle], a later frame for a DIFFERENT target never interferes", () => {
  const framesPath = join(freshRunDir("mi-hidden"), "frames.jsonl");
  writeFileSync(framesPath, `${JSON.stringify({ seq: 0, t: "t0", type: "room.mounted", platform: "discord", substrate: "jsonl-fallback" })}\n`);
  assert.deepEqual(currentHiddenBy(framesPath, 5), []);
  appendFileSync(framesPath, `${JSON.stringify({ seq: 1.5, t: "t1", type: "hidden", target: 5, by: ["alice"] })}\n`);
  assert.deepEqual(currentHiddenBy(framesPath, 5), ["alice"]);
  appendFileSync(framesPath, `${JSON.stringify({ seq: 1.75, t: "t2", type: "hidden", target: 9, by: ["carol"] })}\n`);
  assert.deepEqual(currentHiddenBy(framesPath, 5), ["alice"], "a different target's own hidden frame is irrelevant");
  assert.deepEqual(currentHiddenBy(framesPath, 9), ["carol"]);
});

/* ---------------------------------------------------------------------- */
/* room-tails.mjs: applyMetaFrameAction — real frames.jsonl, schema-checked */
/* ---------------------------------------------------------------------- */

function framesOf(runDir) {
  return readFileSync(join(runDir, "frames.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function seededRoom(name) {
  const runDir = freshRunDir(name);
  writeFileSync(join(runDir, "frames.jsonl"), `${JSON.stringify({ seq: 0, t: "t0", type: "room.mounted", platform: "discord", substrate: "jsonl-fallback" })}\n`);
  return runDir;
}

test("applyMetaFrameAction: redact add appends a hidden frame with by:[handle], schema-valid", () => {
  const runDir = seededRoom("apply-redact-1");
  const roomId = "apply-redact-1";
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "redact", roomId, target: 1, action: "add", by: "alice" });
  const frames = framesOf(runDir);
  const hidden = frames.find((f) => f.type === "hidden");
  assert.deepEqual(hidden.by, ["alice"]);
  assert.equal(hidden.target, 1);
  assert.ok(validateFrame(hidden), ajv.errorsText(validateFrame.errors));
});

test("applyMetaFrameAction: a second reactor's redact ADD accumulates (reads the current set first, never overwrites)", () => {
  const runDir = seededRoom("apply-redact-2");
  const roomId = "apply-redact-2";
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "redact", roomId, target: 1, action: "add", by: "alice" });
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "redact", roomId, target: 1, action: "add", by: "bob" });
  const hidden = framesOf(runDir).filter((f) => f.type === "hidden");
  assert.deepEqual(hidden.at(-1).by, ["alice", "bob"]);
});

test("applyMetaFrameAction: the LAST reactor's redact REMOVE leaves by:[] — visible again (RX2)", () => {
  const runDir = seededRoom("apply-redact-3");
  const roomId = "apply-redact-3";
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "redact", roomId, target: 1, action: "add", by: "alice" });
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "redact", roomId, target: 1, action: "add", by: "bob" });
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "redact", roomId, target: 1, action: "remove", by: "alice" });
  assert.deepEqual(framesOf(runDir).filter((f) => f.type === "hidden").at(-1).by, ["bob"]);
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "redact", roomId, target: 1, action: "remove", by: "bob" });
  assert.deepEqual(framesOf(runDir).filter((f) => f.type === "hidden").at(-1).by, []);
});

test("applyMetaFrameAction: edited appends an edited frame — final text + edited_at, target's own frame untouched", () => {
  const runDir = seededRoom("apply-edited-1");
  const roomId = "apply-edited-1";
  appendFileSync(join(runDir, "frames.jsonl"), `${JSON.stringify({ seq: 1, t: "t1", type: "message", by: "alice", text: "original" })}\n`);
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "edited", roomId, target: 1, text: "corrected", edited_at: "2026-09-17T00:00:00.000Z" });
  const frames = framesOf(runDir);
  const original = frames.find((f) => f.seq === 1);
  assert.equal(original.text, "original", "the record's one-verbatim-copy rule — the original frame is NEVER rewritten");
  const edited = frames.find((f) => f.type === "edited");
  assert.equal(edited.target, 1);
  assert.equal(edited.text, "corrected");
  assert.equal(edited.edited_at, "2026-09-17T00:00:00.000Z");
  assert.ok(validateFrame(edited), ajv.errorsText(validateFrame.errors));
});

test("applyMetaFrameAction: retracted appends a tombstone — the target seq only, never the deleted text", () => {
  const runDir = seededRoom("apply-retracted-1");
  const roomId = "apply-retracted-1";
  appendFileSync(join(runDir, "frames.jsonl"), `${JSON.stringify({ seq: 1, t: "t1", type: "message", by: "alice", text: "oops, sent by mistake" })}\n`);
  applyMetaFrameAction({ RUNS: ROOT }, { kind: "retracted", roomId, target: 1 });
  const frames = framesOf(runDir);
  const retracted = frames.find((f) => f.type === "retracted");
  assert.equal(retracted.target, 1);
  assert.equal(JSON.stringify(retracted).includes("oops"), false, "the tombstone never carries the deleted text");
  assert.ok(validateFrame(retracted), ajv.errorsText(validateFrame.errors));
  const original = frames.find((f) => f.seq === 1);
  assert.equal(original.text, "oops, sent by mistake", "the record's own one-verbatim-copy rule — never removed from disk");
});

test("isMetaFrameAction: recognizes redact/edited/retracted only", () => {
  assert.equal(isMetaFrameAction({ kind: "redact" }), true);
  assert.equal(isMetaFrameAction({ kind: "edited" }), true);
  assert.equal(isMetaFrameAction({ kind: "retracted" }), true);
  assert.equal(isMetaFrameAction({ kind: "input" }), false);
  assert.equal(isMetaFrameAction({ kind: "ignore" }), false);
});
