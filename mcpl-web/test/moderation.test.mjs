// @ts-check
/* mcpl-web/test/moderation.test.mjs — the board's hide/unhide verdicts
 * forwarded to the house as the push a platform 🫥 reaction is (tags
 * chat:reaction / chat:reaction-remove, origin.{messageId, reactorId,
 * reactorName, emoji, action} — the fields the house's reactionInfo
 * reads), a flags hide carrying its cause, count and author display (never
 * the text); add_reaction / remove_reaction / flag_post through the board;
 * a being's flag counting once toward the threshold. Fake board, fixture
 * principals; every wait is on a condition. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { boot, FULL_GRANT } from "./lib/boot.mjs";
import { createFakeBoard, PRINCIPALS, ROOMS, waitFor } from "./lib/fake-board.mjs";
import { BOARD_REACTOR } from "../src/server.mjs";

const GENERAL = ROOMS[0].id;
const HIDE = "\u{1FAE5}";

async function setup(t, { board: bopts = {}, seat: sopts = {} } = {}) {
  const board = await createFakeBoard(bopts);
  const seat = await boot(board, { open: [GENERAL], ...sopts });
  t.after(async () => {
    await seat.close();
    await board.close();
  });
  await waitFor(() => board.subscribedCount() === 1);
  return { board, seat };
}

const reactionPushes = (seat) => seat.pushes().filter((p) => p.tags.some((x) => x.startsWith("chat:reaction")));

test("a flags hide → a 🫥 reaction-add push for the post, with cause, count and author display — never the text", async (t) => {
  const { board, seat } = await setup(t);
  const post = board.emitPost({ text: "SECRET-WORDS spam spam" });
  await waitFor(() => seat.incoming().find((m) => m.messageId === post.id));
  board.externalFlag(post.id, "villager-0001");
  const [p] = await waitFor(() => reactionPushes(seat).length && reactionPushes(seat));
  assert.deepEqual(p.tags, ["chat:reaction"]);
  assert.equal(p.featureSet, "web.messaging");
  assert.deepEqual(
    { ...p.origin },
    {
      source: "web",
      channelId: GENERAL,
      mcplChannelId: GENERAL,
      messageId: post.id,
      reactorId: BOARD_REACTOR.id,
      reactorName: BOARD_REACTOR.name,
      emoji: HIDE,
      action: "add",
      isDM: false,
      moderationCause: "flags",
      flagCount: 1,
      postAuthorDisplay: "Bob",
    },
  );
  assert.equal(p.origin.authorId, undefined, "no authorId: a reaction is a meta-event, not a message");
  assert.ok(!JSON.stringify(p).includes("SECRET-WORDS"));

  board.moderatorUnhide(post.id);
  const pushes = await waitFor(() => reactionPushes(seat).length === 2 && reactionPushes(seat));
  const u = pushes[1];
  assert.deepEqual(u.tags, ["chat:reaction-remove"]);
  assert.equal(u.origin.action, "remove");
  assert.equal(u.origin.reactorId, BOARD_REACTOR.id, "the same reactor withdraws — the house's hider set empties");
  assert.equal(u.origin.messageId, post.id);
  assert.equal(u.origin.moderationCause, undefined);
  assert.notEqual(u.eventId, pushes[0].eventId);
});

test("add_reaction 🫥 → the board hides the post; the verdict comes back as a reaction push (cause reaction, no count); remove_reaction un-hides", async (t) => {
  const { board, seat } = await setup(t);
  const post = board.emitPost({ text: "hello" });
  const r = await seat.call("add_reaction", { channelId: GENERAL, messageId: post.id, emoji: HIDE });
  assert.deepEqual(r, { ok: true, messageId: post.id, emoji: HIDE, removed: false, hidden: true });
  const sent = board.state.received.find((x) => x.type === "react");
  assert.equal(sent.post_id, post.id);
  assert.equal(sent.principal, PRINCIPALS.fable.id);
  const [p] = await waitFor(() => reactionPushes(seat).length && reactionPushes(seat));
  assert.equal(p.origin.moderationCause, "reaction");
  assert.equal(p.origin.flagCount, undefined);
  assert.equal(p.origin.postAuthorDisplay, undefined);

  const off = await seat.call("remove_reaction", { channelId: GENERAL, messageId: post.id, emoji: HIDE });
  assert.equal(off.hidden, false);
  await waitFor(() => reactionPushes(seat).some((x) => x.origin.action === "remove"));
});

test("flag_post: the being's own flag counts once toward the threshold; a second flag is a duplicate", async (t) => {
  const { board, seat } = await setup(t, { board: { flagThreshold: 2 } });
  const post = board.emitPost({ text: "dubious" });
  board.externalFlag(post.id, "villager-0001");
  assert.equal(board.state.hidden.has(post.id), false);
  const r = await seat.call("flag_post", { post_id: post.id, reason: "spam" });
  assert.deepEqual(r, { ok: true, post_id: post.id, duplicate: false, flags: 2, threshold: 2, hidden: true });
  const sent = board.state.received.find((x) => x.type === "flag");
  assert.deepEqual({ post_id: sent.post_id, reason: sent.reason, principal: sent.principal }, { post_id: post.id, reason: "spam", principal: PRINCIPALS.fable.id });
  const again = await seat.call("flag_post", { post_id: post.id });
  assert.equal(again.duplicate, true);
  assert.equal(again.flags, 2);
  assert.match(again.note, /counts once/);
  const [p] = await waitFor(() => reactionPushes(seat).length && reactionPushes(seat));
  assert.equal(p.origin.flagCount, 2);
});

test("flag_post on an unknown post surfaces the board's error; missing post_id is invalid params", async (t) => {
  const { seat } = await setup(t);
  await assert.rejects(seat.wire.request("tools/call", { name: "flag_post", arguments: { post_id: "nope" } }), /not_found/);
  await assert.rejects(seat.wire.request("tools/call", { name: "flag_post", arguments: {} }), /post_id is required/);
});

test("without pushEvents in the grant a verdict is dropped, never forwarded another way", async (t) => {
  const grant = FULL_GRANT.filter((c) => c !== "pushEvents");
  const { board, seat } = await setup(t, { seat: { grant } });
  const post = board.emitPost({ text: "x" });
  await waitFor(() => seat.incoming().find((m) => m.messageId === post.id));
  board.externalFlag(post.id, "villager-0001");
  await waitFor(() => seat.server.state.dropReasons["no-grant"] >= 1);
  assert.equal(seat.pushes().length, 0);
});
