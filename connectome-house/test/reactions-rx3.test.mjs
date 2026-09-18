// @ts-check
/* connectome-house/test/reactions-rx3.test.mjs — harness-port Q3-A,
 * 2026-09-18 (PARITY-discord.md §5's RX3, "🫥 on the being's own
 * message"): kept as its own file rather than added to
 * test/reactions-edits.test.mjs — that file already sits at 359 lines,
 * within a hair of this package's own 400-line file-length ratchet, and
 * the mission's own hard rule is that a file grows only by extraction,
 * never by addition once it is close to the cap.
 *
 * Proves, end to end, that a multi-chunk speech already leaves every
 * chunk's own platform message id findable: speak.mjs's `recordOutbound`
 * call sits INSIDE the per-chunk send loop (outbound.mjs), so a two-chunk
 * speech writes TWO "out" rows to external.jsonl, both keyed to the SAME
 * speech-frame seq — message-index.mjs's `buildMessageIndex` already
 * reads every "out" row generically, needing no change for this. A 🫥 on
 * the SECOND chunk specifically is then routed (route.mjs's own
 * reaction branch, reused verbatim — test/reactions-edits.test.mjs's own
 * style: pure function, stubbed deps) and applied (room-tails.mjs's
 * applyMetaFrameAction, real frames.jsonl) to confirm it resolves to the
 * ONE speech frame both chunks came from, never a guess. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { routeIncoming } from "../src/mcpl/route.mjs";
import { normalizePush } from "../src/mcpl/normalize.mjs";
import { buildMessageIndex, frameSeqForMessageId } from "../src/mcpl/message-index.mjs";
import { applyMetaFrameAction } from "../src/mcpl/room-tails.mjs";
import { createSpeaker } from "../src/mcpl/speak.mjs";
import { Frame } from "../src/frame-schema.mjs";

const ajv = new Ajv({ strict: false });
const validateFrame = ajv.compile(Frame);

const ROOT = mkdtempSync(join(tmpdir(), "reactions-rx3-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const BEING = "watson";
const STREAM = "discord:g1:c1";
const SERVER = {
  name: "mock-1",
  platform: "discord",
  being: BEING,
  rooms: [{ stream: STREAM, title: "general", beings: [BEING], public: true }],
};

/** mirrors test/reactions-edits.test.mjs's own `deps()`. */
function deps(overrides = {}) {
  return {
    server: SERVER,
    roomsOpen: () => null,
    identityFor: ({ platform, id, display }) => ({ handle: `${platform}-${id}`, known: true, display }),
    isBeing: (h) => h === BEING,
    covenants: () => ({ posture: "present", dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 } }),
    roomKeyOf: (stream) => `discord:${stream}`,
    awakeOf: () => true,
    streakOf: () => 0,
    frameSeqFor: () => null,
    ...overrides,
  };
}

/** mirrors test/reactions-edits.test.mjs's own `reactionPush()`. */
function reactionPush({ emoji, action = "add", messageId = "m1", reactorId = "u1", reactorName = "alice" }) {
  return normalizePush({
    eventId: `discord_reaction_${action}_${messageId}_${emoji}_${reactorId}_1`,
    origin: { source: "discord", channelId: STREAM, messageId, guildId: "g1", reactorId, reactorName, emoji, action },
    tags: [action === "add" ? "chat:reaction" : "chat:reaction-remove"],
    payload: { content: [{ type: "text", text: `[reaction] @${reactorName} reacted ${emoji} on message ${messageId}` }] },
  });
}

function freshRunDir(name) {
  const d = join(ROOT, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function framesOf(runDir) {
  return readFileSync(join(runDir, "frames.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("RX3: a two-chunk speech leaves both chunk ids findable; a 🫥 on the SECOND chunk resolves to the ONE speech frame both came from", async () => {
  const roomId = "rx3-room";
  const runDir = freshRunDir(roomId);
  writeFileSync(
    join(runDir, "frames.jsonl"),
    `${JSON.stringify({ seq: 0, t: "t0", type: "room.mounted", platform: "discord", substrate: "jsonl-fallback" })}\n` +
      `${JSON.stringify({ seq: 7, t: "t7", type: "speech", by: BEING, inline: "chunk one. chunk two." })}\n`,
  );

  // a stub host: every send_message call gets its own distinct message
  // id — recordOutbound is called once per chunk (speak.mjs's own send
  // loop), so a real multi-chunk speech should already leave every
  // chunk's own id behind; this proves it, never assumes it.
  let nextId = 0;
  const calls = [];
  const host = {
    state: { tools: [] },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { messageId: `d-chunk-${++nextId}` };
    },
  };
  const cfg = { platform: "discord", being: BEING, being_id: null, limit: 12, observe_only: false };
  const { speak } = createSpeaker({ cfg, host, stats: { sent: 0, undelivered: 0 }, say: () => {}, RUNS: ROOT });
  await speak(roomId, STREAM, "chunk one. chunk two.", { by: BEING, seq: 7 });
  assert.ok(calls.length >= 2, `expected at least two chunks under a 12-char limit, got ${calls.length}`);

  const index = buildMessageIndex(runDir);
  for (let i = 1; i <= calls.length; i++)
    assert.equal(index.get(`d-chunk-${i}`), 7, `chunk ${i}'s own id must resolve to the speech frame's own seq`);

  const msg = reactionPush({ emoji: "\u{1FAE5}", action: "add", messageId: "d-chunk-2", reactorId: "u9", reactorName: "carol" });
  const actions = routeIncoming({
    ...deps({
      roomsOpen: (s) => (s === STREAM ? { id: roomId, beings: [BEING], live: true } : null),
      frameSeqFor: (rId, messageId) => frameSeqForMessageId(join(ROOT, rId), messageId),
    }),
    msg,
  });
  assert.deepEqual(actions, [{ kind: "redact", stream: STREAM, roomId, target: 7, action: "add", by: "discord-u9" }]);

  applyMetaFrameAction({ RUNS: ROOT }, actions[0]);
  const hidden = framesOf(runDir).find((f) => f.type === "hidden");
  assert.equal(hidden.target, 7, "the reaction on the SECOND chunk still resolves to the one speech frame both chunks came from");
  assert.deepEqual(hidden.by, ["discord-u9"]);
  assert.ok(validateFrame(hidden), ajv.errorsText(validateFrame.errors));
});
