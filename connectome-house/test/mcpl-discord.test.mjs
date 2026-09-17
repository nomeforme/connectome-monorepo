// @ts-check
/* harness-port P-C, 2026-09-17 — connectome-house/test/mcpl-discord.test.mjs
 * — discord.mjs's own pure functions, golden-table style (docs/harness-
 * port/02-user-contract.md §9's "L0 — golden table"): the id grammar
 * (parseChannelId/roomKey/roomKind), the reaction/redaction recognition
 * this task added (REDACT_EMOJI/isReactionEvent/reactionInfo/
 * isRedactReaction), and the edit/delete text-notice parsing this task
 * added (editOrDeleteNotice) — against fixtures shaped exactly like the
 * real discord-mcpl server's own push/event params (@animalabs/
 * discord-mcpl, vendored on the deploy box at
 * mcpl-discord/node_modules/@animalabs/discord-mcpl; server.ts's
 * onReaction/onMessageEdit/onMessageDelete handlers, cited inline). Pure;
 * nothing touches disk or a wire. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BEING_TOOLS,
  editOrDeleteNotice,
  isReactionEvent,
  isRedactReaction,
  LIMIT,
  parseChannelId,
  reactionInfo,
  REDACT_EMOJI,
  roomKey,
  roomKind,
} from "../src/mcpl/discord.mjs";
import { normalizePush } from "../src/mcpl/normalize.mjs";

test("LIMIT: 1900, the real discord-mcpl server's own internal splitForDiscord cap — not the fork's raw 2000", () => {
  // discord-adapter.ts:666 in the vendored server: `splitForDiscord(text, limit = 1900)`.
  // A house-side chunk over 1900 would be silently re-split server-side,
  // and that tool call returns only the LAST chunk's message id — breaking
  // RX3 (every delivered chunk's id must be registered for 🫥 redaction).
  assert.equal(LIMIT, 1900);
});

test("parseChannelId / roomKey / roomKind: the discord:<guild>:<channel> / discord:dm:<channel> grammar", () => {
  assert.deepEqual(parseChannelId("discord:g1:c1"), { guildId: "g1", channelId: "c1", kind: "channel" });
  assert.deepEqual(parseChannelId("discord:dm:c2"), { guildId: "dm", channelId: "c2", kind: "dm" });
  assert.equal(parseChannelId("not-discord:1:2"), null);
  assert.equal(parseChannelId("discord:only-one-part"), null);
  const msg = /** @type {any} */ ({ channelId: "discord:g1:c1", isDM: false });
  assert.equal(roomKey(msg), "discord:g1:c1");
  assert.equal(roomKind(msg), "channel");
  assert.equal(roomKind(/** @type {any} */ ({ channelId: "discord:dm:c2" })), "dm");
  assert.equal(roomKey(/** @type {any} */ ({ channelId: "not-discord" })), null);
});

test("DEFAULT_BEING_TOOLS: read/look-up/react-shaped only — never send_message/reply_message/edit_message/delete_message", () => {
  for (const mutating of ["send_message", "reply_message", "send_dm", "edit_message", "delete_message"]) {
    assert.ok(!DEFAULT_BEING_TOOLS.includes(mutating), `${mutating} must not be a default being tool`);
  }
  assert.ok(DEFAULT_BEING_TOOLS.includes("add_reaction"));
});

/** a push/event params object shaped exactly like discord-mcpl's own
 * reaction forwarder (server.ts:2624-2638) — origin field names verbatim. */
function reactionPush({ emoji, action = "add", messageId = "m1", reactorId = "u1", reactorName = "alice" }) {
  return {
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
  };
}

test("REDACT_EMOJI / isRedactReaction: 🫥 (U+1FAE5) is the one redaction emoji, nothing else", () => {
  assert.equal(REDACT_EMOJI, "\u{1FAE5}");
  assert.equal(isRedactReaction("\u{1FAE5}"), true);
  assert.equal(isRedactReaction("😀"), false);
  assert.equal(isRedactReaction(""), false);
});

test("isReactionEvent / reactionInfo: a discord-mcpl reaction push (🫥 add) normalizes to a legible redaction event", () => {
  const msg = normalizePush(reactionPush({ emoji: "\u{1FAE5}", action: "add" }));
  assert.equal(isReactionEvent(msg), true);
  const info = reactionInfo(msg);
  assert.deepEqual(info, {
    action: "add",
    emoji: "\u{1FAE5}",
    messageId: "m1",
    reactorId: "u1",
    reactorName: "alice",
  });
  assert.equal(isRedactReaction(info.emoji), true);
});

test("reactionInfo: chat:reaction-remove (RX2, the last un-react) reads action:'remove'", () => {
  const msg = normalizePush(reactionPush({ emoji: "\u{1FAE5}", action: "remove", reactorId: "u2", reactorName: "bob" }));
  const info = reactionInfo(msg);
  assert.equal(info.action, "remove");
  assert.equal(info.reactorId, "u2");
});

test("isReactionEvent: an ordinary message push (no chat:reaction tag) is not a reaction at all", () => {
  const ordinary = normalizePush({
    eventId: "e1",
    origin: { source: "discord", channelId: "discord:g1:c1", authorId: "u1", authorName: "alice" },
    tags: ["chat:ambient"],
    payload: { content: [{ type: "text", text: "hello" }] },
  });
  assert.equal(isReactionEvent(ordinary), false);
  assert.equal(reactionInfo(ordinary), null);
});

test("editOrDeleteNotice: an edit push's exact text template (server.ts's onMessageEdit) parses to the new text", () => {
  const msg = normalizePush({
    eventId: "discord_edit_12345",
    origin: { source: "discord", channelId: "discord:g1:c1" },
    tags: [],
    payload: { content: [{ type: "text", text: "[message edited] hello, again" }] },
  });
  assert.deepEqual(editOrDeleteNotice(msg), { kind: "edit", text: "hello, again" });
});

test("editOrDeleteNotice: a delete push's exact text template parses to the deleted message id", () => {
  const msg = normalizePush({
    eventId: "discord_delete_67890",
    origin: { source: "discord", channelId: "discord:g1:c1" },
    tags: [],
    payload: { content: [{ type: "text", text: "[message deleted] 67890" }] },
  });
  assert.deepEqual(editOrDeleteNotice(msg), { kind: "delete", messageId: "67890" });
});

test("editOrDeleteNotice: an ordinary message (any other text) is neither — never a false positive", () => {
  const msg = normalizePush({
    eventId: "e2",
    origin: { source: "discord", channelId: "discord:g1:c1", authorId: "u1", authorName: "alice" },
    tags: ["chat:ambient"],
    payload: { content: [{ type: "text", text: "message edited by hand, not a system notice" }] },
  });
  assert.equal(editOrDeleteNotice(msg), null);
});
