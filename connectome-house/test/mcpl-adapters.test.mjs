// @ts-check
/* harness/test/mcpl-adapters.test.mjs — the mention/surface additions to
 * adapters.mjs (platform-reach, builder D): rewriteSelfMention (inbound,
 * literal display-name text → the being's handle), genericMentionToken
 * (outbound, the `<@id>` shape every registered platform's inbound regex
 * matches), and each platform's `surface()` (the room's platform section —
 * present for discord/signal, null for the generic/mock default). Also
 * `roomDescriptor`/`titleFor` (platform-reach R2b, "a room's title comes
 * from the platform"): every shape, per platform. Pure; nothing touches
 * disk. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discordAdapter,
  genericAdapter,
  genericMentionToken,
  genericSurface,
  rewriteSelfMention,
  signalAdapter,
} from "../src/mcpl/adapters.mjs";
import { normalizeIncoming, normalizePush } from "../src/mcpl/normalize.mjs";

test("rewriteSelfMention: a literal @<displayName> becomes @<handle>, case-insensitively, word-bounded", () => {
  assert.equal(rewriteSelfMention("@vallynn hi", "vallynn", "resident"), "@resident hi");
  assert.equal(rewriteSelfMention("hey @Vallynn!", "vallynn", "resident"), "hey @resident!");
  assert.equal(
    rewriteSelfMention("@vallynnite is not @vallynn", "vallynn", "resident"),
    "@vallynnite is not @resident",
    "a longer word containing the name is left alone; the exact bounded match is rewritten",
  );
});

test("rewriteSelfMention: an unknown displayName (null) is a no-op — never guessed", () => {
  assert.equal(rewriteSelfMention("@vallynn hi", null, "resident"), "@vallynn hi");
});

test("rewriteSelfMention: a display name with regex-special characters is escaped, not interpreted", () => {
  assert.equal(rewriteSelfMention("@a.b* hi", "a.b*", "resident"), "@resident hi");
});

test("genericMentionToken: the <@id> shape, the outbound inverse of the inbound token regex", () => {
  assert.equal(genericMentionToken("12345"), "<@12345>");
});

test("genericSurface / genericAdapter: no platform section by default (mock, an unregistered platform)", () => {
  assert.equal(genericSurface({ being: "resident", displayName: null, roster: [] }), null);
  assert.equal(
    genericAdapter("mock").surface({ being: "resident", displayName: null, roster: [] }),
    null,
  );
  assert.equal(
    genericAdapter("some-future-platform").surface({ being: "x", displayName: null, roster: [] }),
    null,
  );
});

test("discordAdapter.surface: names the being, the platform, and its formatting conditions; the display-name clause only when known", () => {
  const withName = discordAdapter.surface({ being: "resident", displayName: "vallynn", roster: [] });
  assert.match(withName, /Discord/);
  assert.match(withName, /@resident/);
  assert.match(withName, /'vallynn'/);
  assert.match(withName, /2000/);
  const bare = discordAdapter.surface({ being: "resident", displayName: null, roster: [] });
  assert.match(bare, /@resident/);
  assert.doesNotMatch(bare, /see you as/);
});

test("discordAdapter.surface: at most 8 lines", () => {
  const text = discordAdapter.surface({ being: "resident", displayName: "vallynn", roster: [] });
  assert.ok(text.split("\n").length <= 8, `${text.split("\n").length} lines`);
});

test("signalAdapter.surface: names the being and Signal's own conditions, no markdown clause borrowed from Discord", () => {
  const text = signalAdapter.surface({ being: "resident", displayName: null, roster: [] });
  assert.match(text, /Signal/);
  assert.match(text, /@resident/);
  assert.match(text, /4096/);
  assert.doesNotMatch(text, /Discord/);
  assert.doesNotMatch(text, /account is named/);
  assert.ok(text.split("\n").length <= 8);
});

test("signalAdapter.surface: the display-name clause is factual, same shape as Discord's, only when known", () => {
  const withName = signalAdapter.surface({ being: "resident", displayName: "vallynn", roster: [] });
  assert.match(withName, /On Signal this account is named 'vallynn'\./);
  assert.doesNotMatch(withName, /display name only/);
  assert.doesNotMatch(withName, /just a label/);
  assert.ok(withName.split("\n").length <= 8, `${withName.split("\n").length} lines`);
});

test("discordAdapter.mentionToken / signalAdapter.mentionToken: the generic <@id> form (both platforms' own inbound regex matches it)", () => {
  assert.equal(discordAdapter.mentionToken("42"), "<@42>");
  assert.equal(signalAdapter.mentionToken("uuid-1"), "<@uuid-1>");
});

/* ---------------------------------------------------------------------- */
/* roomDescriptor / titleFor: "a room's title comes from the platform"    */
/* ---------------------------------------------------------------------- */

test("discordAdapter: a guild channel titles `<server> #<channel>`, from the message's own live-rendered names", () => {
  const msg = normalizeIncoming({
    channelId: "discord:g1:c1",
    messageId: "m1",
    author: { id: "1", name: "kai" },
    content: [{ type: "text", text: "hi" }],
    metadata: { guildName: "Alpha", channelName: "general" },
  });
  const d = discordAdapter.roomDescriptor(msg, { dmHandle: null });
  assert.deepEqual(d, { kind: "channel", serverName: "Alpha", channelName: "general", threadName: null, dmHandle: null });
  assert.equal(discordAdapter.titleFor(d), "Alpha #general");
});

test("discordAdapter: a thread titles `<server> #<parent> › <thread>`", () => {
  const msg = normalizeIncoming({
    channelId: "discord:g1:c1",
    messageId: "m1",
    threadId: "t1",
    author: { id: "1", name: "kai" },
    content: [{ type: "text", text: "hi" }],
    metadata: { guildName: "Alpha", channelName: "general", threadName: "bug-123" },
  });
  const d = discordAdapter.roomDescriptor(msg, { dmHandle: null });
  assert.equal(d.threadName, "bug-123");
  assert.equal(discordAdapter.titleFor(d), "Alpha #general › bug-123");
});

test("discordAdapter: a DM titles `DM · @<handle>` — the house handle only, never a platform id or a real name", () => {
  const msg = normalizePush({
    eventId: "e1",
    origin: { mcplChannelId: "discord:dm:c9", authorId: "1", authorName: "kai", isDM: true },
    payload: { content: [{ type: "text", text: "hi" }] },
  });
  const d = discordAdapter.roomDescriptor(msg, { dmHandle: "zz-someone" });
  assert.deepEqual(d, { kind: "dm", serverName: null, channelName: null, threadName: null, dmHandle: "zz-someone" });
  assert.equal(discordAdapter.titleFor(d), "DM · @zz-someone");
  assert.ok(!discordAdapter.titleFor(d).includes("kai"), "never the platform's own display name");
});

test("discordAdapter: unknown facts (a DM with no dmHandle yet, or a channel with no names learned) title null — the caller keeps the room's own title", () => {
  const dm = discordAdapter.roomDescriptor(
    normalizePush({ eventId: "e2", origin: { mcplChannelId: "discord:dm:c9", isDM: true }, payload: { content: [] } }),
    { dmHandle: null },
  );
  assert.equal(discordAdapter.titleFor(dm), null);
  const chan = discordAdapter.roomDescriptor(
    normalizeIncoming({
      channelId: "discord:g1:c1",
      messageId: "m1",
      author: { id: "1", name: "kai" },
      content: [],
      metadata: {},
    }),
    { dmHandle: null },
  );
  assert.equal(discordAdapter.titleFor(chan), null, "no guildName/channelName known yet");
});

test("signalAdapter: a group titles its own name — \"signal will only have group name\" (the keeper)", () => {
  const msg = normalizeIncoming({
    channelId: "signal:group:g1",
    messageId: "m1",
    author: { id: "uuid-1", name: null },
    content: [{ type: "text", text: "hi" }],
    metadata: { groupName: "The Porch" },
  });
  const d = signalAdapter.roomDescriptor(msg, { dmHandle: null });
  assert.deepEqual(d, { kind: "group", serverName: null, channelName: "The Porch", threadName: null, dmHandle: null });
  assert.equal(signalAdapter.titleFor(d), "The Porch");
});

test("signalAdapter: a DM titles `DM · @<handle>`, same rule as Discord's", () => {
  const msg = normalizePush({
    eventId: "e1",
    origin: { mcplChannelId: "signal:dm:uuid-2", isDM: true },
    payload: { content: [{ type: "text", text: "hi" }] },
  });
  const d = signalAdapter.roomDescriptor(msg, { dmHandle: "zz-alice" });
  assert.equal(d.kind, "dm");
  assert.equal(signalAdapter.titleFor(d), "DM · @zz-alice");
});

test("genericAdapter (mock / an unregistered platform): no naming facts, no computed title — the servers file's own title, or the room's existing one, carries it", () => {
  const mock = genericAdapter("mock");
  const msg = normalizeIncoming({
    channelId: "mock:g1:c1",
    messageId: "m1",
    author: { id: "1", name: "kai" },
    content: [{ type: "text", text: "hi" }],
    metadata: { guildName: "Alpha", channelName: "general" },
  });
  const d = mock.roomDescriptor(msg, { dmHandle: null });
  assert.deepEqual(d, { kind: "channel", serverName: null, channelName: null, threadName: null, dmHandle: null });
  assert.equal(mock.titleFor(d), null);
});
