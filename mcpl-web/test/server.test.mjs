// @ts-check
/* mcpl-web/test/server.test.mjs — the seat in-process (test/lib/boot.mjs),
 * a fresh fake board per test: an inbound post's channels/incoming fields
 * (author, isBot, mentions incl. the being's own principal id, rawContent,
 * replyTo/replyToAuthorId, messageId, tags), the seat's own echo never
 * delivered, a closed channel's addressed-only push/event, send_message
 * and reply_message through the board's ack (mention tokens out, the
 * board's post id back), a board error surfaced, the long-text split, a
 * reconnect after the board drops, typing, app-level and control pings,
 * a room first seen in a post, grant gating, and a refused token never
 * reaching a log. No fixed sleeps — every wait is on a condition. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { boot } from "./lib/boot.mjs";
import { createFakeBoard, PRINCIPALS, ROOMS, waitFor } from "./lib/fake-board.mjs";

const GENERAL = ROOMS[0].id;
const MAKERS = ROOMS[1].id;

/** a board + a seat with GENERAL open, both torn down after the test */
async function setup(t, opts = {}) {
  const board = await createFakeBoard(opts.board);
  const seat = await boot(board, { open: [GENERAL], ...opts.seat });
  t.after(async () => {
    await seat.close();
    await board.close();
  });
  await waitFor(() => board.subscribedCount() === 1);
  return { board, seat };
}

test("an inbound post becomes channels/incoming with author, isBot, mentions (the being's own id), rawContent, messageId", async (t) => {
  const { board, seat } = await setup(t);
  const post = board.emitPost({ text: "hey @Fable, what do you think?" });
  const m = await waitFor(() => seat.incoming().find((x) => x.messageId === post.id));
  assert.equal(m.channelId, GENERAL);
  assert.deepEqual(m.author, { id: PRINCIPALS.bob.id, name: "Bob", display: "Bob", kind: "human" });
  assert.equal(m.timestamp, post.created_at);
  assert.equal(m.content[0].text, "hey @Fable, what do you think?", "the prose block is the text as posted");
  assert.equal(m.metadata.isBot, false);
  assert.equal(m.metadata.isDM, false);
  assert.deepEqual(m.metadata.mentions, [PRINCIPALS.fable.id]);
  assert.equal(m.metadata.rawContent, `hey <@${PRINCIPALS.fable.id}>, what do you think?`);
  assert.equal(m.metadata.replyTo, null);
  assert.equal(m.metadata.roomTitle, "General");
  assert.ok(m.tags.includes("chat:mention"));
  assert.ok(m.tags.includes("chat:addressed"));
  assert.ok(m.tags.includes("chat:from-human"));
  assert.ok(!m.tags.includes("chat:ambient"));
});

test("a non-human author is isBot (an agent here), tagged chat:from-bot; unaddressed is chat:ambient", async (t) => {
  const { board, seat } = await setup(t);
  const post = board.emitPost({ author: PRINCIPALS.scout, text: "status: all quiet" });
  const m = await waitFor(() => seat.incoming().find((x) => x.messageId === post.id));
  assert.equal(m.metadata.isBot, true);
  assert.equal(m.metadata.authorKind, "agent");
  assert.ok(m.tags.includes("chat:from-bot"));
  assert.ok(m.tags.includes("chat:ambient"));
  assert.deepEqual(m.metadata.mentions, []);
});

test("an explicit mention by id alone (no @display in the text) still names the being", async (t) => {
  const { board, seat } = await setup(t);
  const post = board.emitPost({ text: "pinging the house beings", mentions: [PRINCIPALS.fable.id] });
  const m = await waitFor(() => seat.incoming().find((x) => x.messageId === post.id));
  assert.deepEqual(m.metadata.mentions, [PRINCIPALS.fable.id]);
  assert.ok(m.tags.includes("chat:addressed"));
});

test("send_message → a WS post; the board's ack gives the result's post id; the seat's own echo is never delivered", async (t) => {
  const { board, seat } = await setup(t);
  const r = await seat.call("send_message", { channelId: GENERAL, content: "hello, commons" });
  const sentMsg = board.state.received.find((x) => x.type === "post");
  assert.equal(sentMsg.room, GENERAL);
  assert.equal(sentMsg.text, "hello, commons");
  assert.equal(sentMsg.reply_to, undefined);
  assert.ok(sentMsg.client_id, "every post carries a client_id");
  const onBoard = board.state.posts.find((p) => p.text === "hello, commons");
  assert.equal(r.messageId, onBoard.id);
  assert.deepEqual(r.messageIds, [onBoard.id]);
  // a later post on the same socket arrives after the echo — once it is
  // delivered, the echo has been seen and dropped
  const later = board.emitPost({ text: "after the echo" });
  await waitFor(() => seat.incoming().find((x) => x.messageId === later.id));
  assert.equal(seat.incoming().filter((x) => x.messageId === onBoard.id).length, 0);
  assert.equal(seat.server.state.counts.echoes, 1);
});

test("the echo is suppressed when the board acks before it broadcasts, too", async (t) => {
  const { board, seat } = await setup(t, { board: { ackFirst: true } });
  const r = await seat.call("send_message", { channelId: GENERAL, content: "ack first" });
  const later = board.emitPost({ text: "after" });
  await waitFor(() => seat.incoming().find((x) => x.messageId === later.id));
  assert.equal(seat.incoming().filter((x) => x.messageId === r.messageId).length, 0);
});

test("reply_message → a WS post with reply_to; a reply to the being's own post carries replyToAuthorId and chat:to-self", async (t) => {
  const { board, seat } = await setup(t);
  const root = board.emitPost({ text: "what's the plan?" });
  await waitFor(() => seat.incoming().find((x) => x.messageId === root.id));
  const r = await seat.call("reply_message", { channelId: GENERAL, messageId: root.id, content: "a garden" });
  const sentMsg = board.state.received.find((x) => x.type === "post");
  assert.equal(sentMsg.reply_to, root.id);
  const mine = board.state.posts.find((p) => p.id === r.messageId);
  assert.equal(mine.reply_to, root.id);
  assert.equal(mine.author.id, PRINCIPALS.fable.id);

  const back = board.emitPost({ text: "love it", reply_to: r.messageId });
  const m = await waitFor(() => seat.incoming().find((x) => x.messageId === back.id));
  assert.equal(m.metadata.replyTo, r.messageId);
  assert.equal(m.metadata.replyToAuthorId, PRINCIPALS.fable.id);
  assert.ok(m.tags.includes("chat:reply"));
  assert.ok(m.tags.includes("chat:to-self"));
  assert.ok(m.tags.includes("chat:addressed"));

  // a reply to someone else's post: replyToAuthorId is that author
  const other = board.emitPost({ text: "+1", reply_to: root.id, author: PRINCIPALS.scout });
  const m2 = await waitFor(() => seat.incoming().find((x) => x.messageId === other.id));
  assert.equal(m2.metadata.replyToAuthorId, PRINCIPALS.bob.id);
  assert.ok(!m2.tags.includes("chat:to-self"));
});

test("outbound mention tokens: <@id> → @display in the text, the id in mentions", async (t) => {
  const { board, seat } = await setup(t);
  const seen = board.emitPost({ text: "hi" }); // the seat learns Bob's display
  await waitFor(() => seat.incoming().find((x) => x.messageId === seen.id));
  await seat.call("send_message", {
    channelId: GENERAL,
    content: `<@${PRINCIPALS.bob.id}> and <@human:nobody-known> — welcome`,
  });
  const sentMsg = board.state.received.find((x) => x.type === "post");
  assert.equal(sentMsg.text, "@Bob and @nobody-known — welcome");
  assert.deepEqual(sentMsg.mentions, [PRINCIPALS.bob.id, "human:nobody-known"]);
  const onBoard = board.state.posts.find((p) => p.author.id === PRINCIPALS.fable.id);
  assert.deepEqual(onBoard.mentions, [PRINCIPALS.bob.id], "the board drops an unknown id");
});

test("a board error on a post rejects the tool call with the board's code", async (t) => {
  const { board, seat } = await setup(t);
  board.state.rejectNext = { code: "rate_limited", message: "slow down" };
  await assert.rejects(
    seat.call("send_message", { channelId: GENERAL, content: "too fast" }),
    (e) => /rate_limited: slow down/.test(e.message),
  );
});

test("a reply to a post the board doesn't have in that room is refused (bad_reply_to)", async (t) => {
  const { seat } = await setup(t);
  await assert.rejects(
    seat.call("reply_message", { channelId: GENERAL, messageId: "p-no-such-post", content: "hm" }),
    (e) => /bad_reply_to/.test(e.message),
  );
});

test("text over 8000 characters goes out as more than one post; every id comes back", async (t) => {
  const { board, seat } = await setup(t);
  const para = "x".repeat(5000);
  const r = await seat.call("send_message", { channelId: GENERAL, content: `${para}\n\n${para}` });
  assert.equal(r.messageIds.length, 2);
  const posts = board.state.received.filter((x) => x.type === "post");
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => p.text.length <= 8000));
});

test("a closed channel forwards only addressed posts, as push/event; ambient ones are counted missed", async (t) => {
  const { board, seat } = await setup(t);
  const ambient = board.emitPost({ room: MAKERS, text: "anyone soldering tonight?" });
  const addressed = board.emitPost({ room: MAKERS, text: "@fable want to join?" });
  const p = await waitFor(() => seat.pushes().find((x) => x.origin.messageId === addressed.id));
  assert.equal(p.origin.channelId, MAKERS);
  assert.equal(p.origin.authorId, PRINCIPALS.bob.id);
  assert.ok(p.origin.mentions.includes(PRINCIPALS.fable.id));
  assert.ok(p.tags.includes("chat:addressed"));
  assert.equal(seat.pushes().filter((x) => x.origin.messageId === ambient.id).length, 0);
  assert.equal(seat.server.state.counts.missed, 1);
  assert.equal(seat.incoming().length, 0, "nothing on a closed channel goes as channels/incoming");
});

test("a room first seen in a post registers by channels/changed", async (t) => {
  const { board, seat } = await setup(t);
  await waitFor(() => seat.channels.size === ROOMS.length);
  board.emitPost({ room: "web:commons:new-room", text: "@Fable first post here" });
  const d = await waitFor(() => seat.channels.get("web:commons:new-room"));
  assert.equal(d.type, "web");
  assert.ok(seat.inbound.some((r) => r.method === "channels/changed"));
});

test("the board drops: the seat reconnects with backoff, resubscribes, and posts flow both ways again", async (t) => {
  const { board, seat } = await setup(t);
  const before = board.emitPost({ text: "one" });
  await waitFor(() => seat.incoming().find((x) => x.messageId === before.id));
  board.dropAll();
  await waitFor(() => board.state.connections >= 2 && board.subscribedCount() === 1);
  assert.equal(seat.client.state.backoffMs, 50, "a fresh hello resets the backoff");
  const after = board.emitPost({ text: "two" });
  await waitFor(() => seat.incoming().find((x) => x.messageId === after.id));
  const r = await seat.call("send_message", { channelId: GENERAL, content: "still here" });
  assert.ok(board.state.posts.find((p) => p.id === r.messageId));
  assert.equal(seat.channels.size, ROOMS.length, "a reconnect's hello registers nothing twice");
  assert.equal(seat.inbound.filter((x) => x.method === "channels/register").length, 1);
});

test("a send made while the board is down waits for the reconnect and lands", async (t) => {
  const { board, seat } = await setup(t);
  board.dropAll();
  await waitFor(() => !seat.client.state.ready);
  const r = await seat.call("send_message", { channelId: GENERAL, content: "queued through a reconnect" });
  assert.ok(board.state.posts.find((p) => p.id === r.messageId));
});

test("typing: channels/typing start → a WS typing frame; stop sends nothing; the notification form works too", async (t) => {
  const { board, seat } = await setup(t);
  await seat.wire.request("channels/typing", { channelId: GENERAL, op: "start" });
  await waitFor(() => board.state.typing.length === 1);
  assert.deepEqual(board.state.typing[0], { room: GENERAL, author: PRINCIPALS.fable.id });
  // a refresh inside the board's 3 s window is never sent at all
  await seat.wire.request("channels/typing", { channelId: GENERAL, op: "start" });
  await seat.wire.request("channels/typing", { channelId: GENERAL, op: "stop" });
  seat.wire.notify("channels/typing", { channelId: MAKERS, op: "start" });
  await waitFor(() => board.state.typing.length === 2);
  assert.equal(board.state.typing[1].room, MAKERS, "the refresh and the stop in between sent nothing");
  assert.equal(board.state.received.filter((x) => x.type === "typing").length, 2);
});

test("pings: an app-level ping is answered pong, a control ping by the runtime", async (t) => {
  const { board } = await setup(t);
  board.appPing();
  await waitFor(() => board.state.pongs >= 1);
  assert.ok(board.state.received.some((x) => x.type === "pong"));
  board.ping();
  await waitFor(() => board.state.pongs >= 2);
});

test("absence is denial: with no grant, tools/call and typing are refused", async (t) => {
  const board = await createFakeBoard();
  const seat = await boot(board, { grant: null });
  t.after(async () => {
    await seat.close();
    await board.close();
  });
  await assert.rejects(seat.call("send_message", { channelId: GENERAL, content: "x" }), (e) => /tools/.test(e.message));
  await assert.rejects(seat.wire.request("channels/typing", { channelId: GENERAL }), (e) => /channels\.typing/.test(e.message));
  assert.equal(board.state.received.filter((x) => x.type === "post").length, 0);
});

test("a refused token: the seat keeps retrying with backoff, and the token never reaches a log", async (t) => {
  const board = await createFakeBoard();
  const seat = await boot(board, { token: "tok-unknown-fixture", grant: null });
  t.after(async () => {
    await seat.close();
    await board.close();
  });
  await waitFor(() => board.state.unauthorized >= 3);
  assert.equal(board.state.connections, 0);
  assert.ok(seat.logs.length > 0);
  assert.ok(seat.logs.every((l) => !l.includes("tok-unknown-fixture")));
});
