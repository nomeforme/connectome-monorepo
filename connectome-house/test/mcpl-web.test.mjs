// @ts-check
/* connectome-house/test/mcpl-web.test.mjs — the web-board adapter
 * (src/mcpl/web.mjs, registered in adapters.mjs as `web`), pure-ish:
 * the registry answers it; roomKey takes only `web:<community>:<slug>`;
 * every room is a channel; principal-id mention tokens (they carry a
 * colon) are read and rewritten; reply threading on, limit 8000, a text
 * surface, a `<community> #<title>` title, audience external. Then
 * routeIncoming with the being's own principal id already christened (the
 * seat's createSelfTracker, exercised live in web-seat-e2e.test.mjs): a
 * mention wakes the being by handle; and the real speaker (speak.mjs):
 * a being's speech goes out as send_message, a reply as reply_message,
 * `@<display>` of a known web identity as the board principal's token. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "mcpl-web-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "mcpl-web-test-salt-0123456789";
for (const d of [process.env.HOUSE_RUNS_DIR, process.env.HOUSE_PRIVATE_DIR, process.env.HOUSE_COVENANTS_DIR])
  mkdirSync(d, { recursive: true });

const BEING = "zz-web-being";
const BEING_ID = "being:zz-web-being";
const BOB_ID = "human:bob-test";
const STREAM = "web:commons:general";
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "web" });

const { adapterFor, isDMStream, webAdapter } = await import("../src/mcpl/adapters.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");
const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { createSpeaker } = await import("../src/mcpl/speak.mjs");
const { openRoom } = await import("../src/serve-rooms.mjs");
const { identityFor } = await import("../src/identity-map.mjs");

/** a channels/incoming message as mcpl-web sends it */
function post({ id = "p1", text, mentions = [], rawContent = text, replyTo = null, replyToAuthorId = null, author = { id: BOB_ID, name: "Bob" }, kind = "human" }) {
  return normalizeIncoming({
    channelId: STREAM,
    messageId: id,
    author: { ...author, display: author.name, kind },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text }],
    metadata: { channelType: "channel", isDM: false, isBot: kind !== "human", authorKind: kind, mentions, rawContent, replyTo, replyToAuthorId, roomTitle: "General" },
    tags: [kind === "human" ? "chat:from-human" : "chat:from-bot", ...(mentions.includes(BEING_ID) ? ["chat:mention", "chat:addressed"] : ["chat:ambient"])],
  });
}

test("the registry answers the web adapter: limit 8000, reply threading, generic typing, audience external, moderation being tools", () => {
  const a = adapterFor("web");
  assert.equal(a, webAdapter);
  assert.equal(a.platform, "web");
  assert.equal(a.limit, 8000);
  assert.equal(a.replyThreading, true);
  assert.equal(a.audience, "external");
  assert.deepEqual(a.defaultBeingTools, ["add_reaction", "remove_reaction", "flag_post", "open_room", "close_room", "reopen_room"]);
  assert.equal(a.typing(STREAM, true).capability, "channels.typing");
  assert.deepEqual(a.split("short"), ["short"]);
  assert.equal(a.split(`${"a".repeat(5000)}\n\n${"b".repeat(5000)}`).length, 2);
});

test("roomKey takes web room ids only; every room is a channel, never a DM", () => {
  const m = post({ text: "hi" });
  assert.equal(webAdapter.roomKey(m), STREAM);
  assert.equal(webAdapter.roomKey({ ...m, channelId: "signal:group:abc" }), null);
  assert.equal(webAdapter.roomKey({ ...m, channelId: "web:nocolon" }), null);
  assert.equal(webAdapter.roomKind(m), "channel");
  assert.equal(isDMStream(webAdapter, STREAM), false);
  assert.deepEqual(webAdapter.sender(m), { platform: "web", id: BOB_ID, display: "Bob" });
  assert.deepEqual(webAdapter.historyToKept([{ any: 1 }]), []);
});

test("principal-id mention tokens (with a colon) are read from rawContent and rewritten to handles", () => {
  const m = post({ text: "@Zed hi", rawContent: `<@${BEING_ID}> hi and <@agent:scout-1>`, mentions: [BEING_ID] });
  assert.deepEqual(webAdapter.mentions(m), [BEING_ID, "agent:scout-1"]);
  assert.equal(webAdapter.rewriteMentions(webAdapter.text(m), (id) => (id === BEING_ID ? BEING : "scout")), `@${BEING} hi and @scout`);
  assert.equal(webAdapter.mentionToken(BOB_ID), `<@${BOB_ID}>`);
  assert.deepEqual(webAdapter.reply(post({ text: "x", replyTo: "p0", replyToAuthorId: BEING_ID })), { messageId: "p0", authorId: BEING_ID });
});

test("title and surface: `<community> #<room title>`, and a plain platform section", () => {
  const d = webAdapter.roomDescriptor(post({ text: "x" }), { dmHandle: null });
  assert.deepEqual(d, { kind: "channel", serverName: "commons", channelName: "General", threadName: null, dmHandle: null });
  assert.equal(webAdapter.titleFor(d), "commons #General");
  assert.equal(webAdapter.titleFor({ ...d, channelName: null }), null);
  const s = webAdapter.surface({ being: BEING, displayName: "Zed", roster: [] });
  assert.match(s ?? "", /^## This room is on the web board/);
  assert.match(s ?? "", /named 'Zed'/);
  assert.match(s ?? "", /8000 characters/);
});

test("routeIncoming: with the being's principal id christened, a mention of that id wakes the being by handle", () => {
  const identity = ({ platform, id }) =>
    platform === "web" && id === BEING_ID ? { handle: BEING, known: true } : { handle: `web-${String(id).slice(-4)}`, known: false };
  const actions = routeIncoming({
    msg: post({ text: "@Zed are you there?", rawContent: `<@${BEING_ID}> are you there?`, mentions: [BEING_ID] }),
    server: { name: "web-zz", platform: "web", being: BEING, rooms: [{ stream: STREAM, title: null, beings: [BEING], public: true }] },
    roomsOpen: () => null,
    identityFor: identity,
    isBeing: (h) => h === BEING,
    covenants: () => ({ posture: "present", dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 } }),
    roomKeyOf: (s) => s,
    awakeOf: () => true,
    streakOf: () => 0,
  });
  const open = actions.find((a) => a.kind === "open-room");
  assert.ok(open && open.kind === "open-room");
  assert.equal(open.platform, "web");
  assert.equal(open.title, "commons #General");
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.deepEqual(input.targets, [BEING]);
  assert.equal(input.reasons[BEING], "mention");
  assert.equal(input.text, `@${BEING} are you there?`);
});

test("speak: plain speech → send_message; a pending reply → reply_message; @Display of a known web identity → its principal token", async () => {
  identityFor({ platform: "web", id: BOB_ID, display: "Bob" }); // the house has seen Bob on the board
  const { id: roomId } = await openRoom({ platform: "web", stream: STREAM, title: "General", beings: [BEING] });
  const calls = [];
  let n = 0;
  const speaker = createSpeaker({
    cfg: { platform: "web", limit: 8000, being: BEING, being_id: null, observe_only: false },
    host: {
      state: { tools: ["send_message", "reply_message"] },
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: JSON.stringify({ messageId: `p-out-${++n}` }) }] };
      },
    },
    stats: { sent: 0, undelivered: 0 },
    say: () => {},
    RUNS: process.env.HOUSE_RUNS_DIR,
    getAttachedAt: undefined,
  });
  await speaker.speak(roomId, STREAM, "thanks @Bob for that", { by: BEING, seq: 1 });
  await speaker.speak(roomId, STREAM, "a reply", { by: BEING, seq: 2, replyTo: "p-in-7" });
  assert.deepEqual(calls[0], { name: "send_message", args: { channelId: STREAM, content: `thanks <@${BOB_ID}> for that` } });
  assert.deepEqual(calls[1], { name: "reply_message", args: { channelId: STREAM, messageId: "p-in-7", content: "a reply" } });
  const rows = readFileSync(join(process.env.HOUSE_RUNS_DIR, roomId, "external.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.platform, r.message_id]), [["web", "p-out-1"], ["web", "p-out-2"]]);
});

test("the servers-file entry mcpl-web/README.md documents validates as a being-hosted web seat", async () => {
  const { validateServer } = await import("../src/mcpl/config.mjs");
  const readme = readFileSync(join(import.meta.dirname, "..", "..", "mcpl-web", "README.md"), "utf8");
  const block = /```json\n([\s\S]*?)\n```/.exec(readme);
  assert.ok(block, "the README carries the entry as a json block");
  const v = validateServer(JSON.parse(block[1]));
  assert.ok(typeof v !== "string", String(v));
  assert.equal(v.platform, "web");
  assert.equal(v.hosted_by, "being");
  assert.equal(v.limit, 8000, "the web adapter's own limit");
  assert.equal(v.rooms_policy, "listed");
  assert.deepEqual(v.env, ["WEB_BOARD_URL", "WEB_BOARD_TOKEN=WEB_BOARD_TOKEN_CLAUDE_OPUS_4_8"]);
  assert.equal(v.being, "claude-opus-4-8");
  assert.deepEqual(v.rooms.map((r) => r.stream), ["web:commons:general"]);
});
