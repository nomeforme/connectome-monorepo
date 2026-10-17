// @ts-check
/* web-board/test/moderation.test.mjs — 🫥 hide (HTTP + WS), flags with a
 * threshold (n=1, n=2, dedupe), partner header + flagger_id validation, a
 * moderator's unhide, hidden posts gone from MCP / HTTP / WS history but
 * kept in the human archive (include_hidden=1), the hidden/unhidden
 * broadcasts, a moderation log with no post text, and the /mcp partner
 * rate tier. Every principal, key and id here is a fixture. No sleeps:
 * the clock is the harness's, every wait is on a message. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeBoard, DEFAULT_CONFIG, DEFAULT_PRINCIPALS } from "./lib/harness.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, createPartners } from "../src/auth.mjs";
import { mintPartnerKey } from "../scripts/mint-partner-key.mjs";

const ROOM = "web:commons:general";
const HIDE = "\u{1FAE5}";
const PARTNER_KEY = "fixture-partner-key-not-real";
const PARTNER_ENV = { WEB_BOARD_PARTNER_KEYS: JSON.stringify({ [sha256Hex(PARTNER_KEY)]: { partner: "agent-village" } }) };
const PRINCIPALS = { ...DEFAULT_PRINCIPALS, mod: { id: "human:mod", display: "Mod", scopes: ["read", "post", "moderator"] } };

/** @param {import("node:test").TestContext} t @param {{threshold?: number, mcp?: any}} [o] */
async function board(t, o = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    moderation: { flag_threshold: o.threshold ?? 1 },
    rate: { ...DEFAULT_CONFIG.rate, ...(o.mcp ? { mcp_per_min: o.mcp } : {}) },
  };
  return makeBoard(t, { config, principals: PRINCIPALS, env: PARTNER_ENV });
}

/** @param {any} b @param {string} token @param {string} id @param {any} body */
const react = (b, token, id, body) => b.req("POST", `/v1/posts/${id}/reactions`, { token, body });
/** @param {any} b @param {string} id @param {string} flagger_id @param {string} [key] */
const partnerFlag = (b, id, flagger_id, key = PARTNER_KEY) =>
  b.req("POST", `/v1/posts/${id}/flag`, { headers: { "x-agent-village-key": key }, body: { flagger_id, reason: "spam" } });

/** @param {any} b @param {string} [token] */
async function history(b, token) {
  return (await b.req("GET", `/v1/rooms/${encodeURIComponent(ROOM)}/posts`, { token: token ?? b.tokens.ana })).body.posts.map((/** @type {any} */ p) => p.id);
}

test("🫥 hides while any stands; removing the last makes it visible; other emoji have no effect", async (t) => {
  const b = await board(t);
  const p = (await b.post(b.tokens.ana, ROOM, { text: "a post" })).body.post;
  const watcher = await b.ws(b.tokens.helper);
  watcher.send({ type: "subscribe", rooms: [ROOM] });
  await watcher.next((m) => m.type === "hello");

  const smile = await react(b, b.tokens.bird, p.id, { emoji: "🙂" });
  assert.equal(smile.status, 200);
  assert.equal(smile.body.hidden, false);
  assert.deepEqual(smile.body.reactions, { "🙂": 1 });
  assert.equal((await watcher.next((m) => m.type === "reaction")).emoji, "🙂");
  assert.deepEqual(await history(b), [p.id]);

  const r1 = await react(b, b.tokens.bird, p.id, { emoji: HIDE });
  assert.equal(r1.body.hidden, true);
  const hidden = await watcher.next((m) => m.type === "hidden");
  assert.deepEqual(hidden, {
    type: "hidden", post_id: p.id, room: ROOM, cause: "reaction", flags: 0,
    author: { id: "human:ana", kind: "human", display: "Ana" },
  });
  assert.deepEqual(await history(b), []);

  // a second hider, then the first withdraws: still hidden
  await react(b, b.tokens.fable, p.id, { emoji: HIDE });
  assert.equal((await react(b, b.tokens.bird, p.id, { emoji: HIDE, remove: true })).body.hidden, true);
  assert.deepEqual(await history(b), []);
  const last = await react(b, b.tokens.fable, p.id, { emoji: HIDE, remove: true });
  assert.equal(last.body.hidden, false);
  assert.deepEqual(await watcher.next((m) => m.type === "unhidden"), { type: "unhidden", post_id: p.id, room: ROOM });
  assert.deepEqual(await history(b), [p.id]);
});

test("react needs the post scope and a real post; WS react answers `reacted` and hides too", async (t) => {
  const b = await board(t);
  const p = (await b.post(b.tokens.ana, ROOM, { text: "x" })).body.post;
  assert.equal((await react(b, b.tokens.reader, p.id, { emoji: HIDE })).status, 403);
  assert.equal((await react(b, undefined, p.id, { emoji: HIDE })).status, 401);
  assert.equal((await react(b, b.tokens.ana, "nope", { emoji: HIDE })).status, 404);
  assert.equal((await react(b, b.tokens.ana, p.id, { emoji: "two words" })).status, 400);

  const c = await b.ws(b.tokens.fable);
  c.send({ type: "subscribe", rooms: [ROOM] });
  c.send({ type: "react", post_id: p.id, emoji: HIDE, client_id: "r1" });
  const ack = await c.next((m) => m.type === "reacted");
  assert.equal(ack.client_id, "r1");
  assert.equal(ack.hidden, true);
  await c.next((m) => m.type === "hidden" && m.post_id === p.id);
});

test("flags: threshold 1 hides on the first flag; a token principal can't flag twice", async (t) => {
  const b = await board(t, { threshold: 1 });
  const p = (await b.post(b.tokens.ana, ROOM, { text: "bad post" })).body.post;
  const c = await b.ws(b.tokens.helper);
  c.send({ type: "subscribe", rooms: "*" });
  const f = await b.req("POST", `/v1/posts/${p.id}/flag`, { token: b.tokens.bird, body: { reason: "rude" } });
  assert.equal(f.status, 200);
  assert.deepEqual(f.body, { post_id: p.id, duplicate: false, flags: 1, threshold: 1, hidden: true });
  const h = await c.next((m) => m.type === "hidden");
  assert.equal(h.cause, "flags");
  assert.equal(h.flags, 1);
  const again = await b.req("POST", `/v1/posts/${p.id}/flag`, { token: b.tokens.bird, body: {} });
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.flags, 1);
});

test("flags: threshold 2 — partner flags dedupe by flagger_id; a token flag and a partner flag both count", async (t) => {
  const b = await board(t, { threshold: 2 });
  const p = (await b.post(b.tokens.ana, ROOM, { text: "maybe bad" })).body.post;
  const r1 = await partnerFlag(b, p.id, "villager-0001");
  assert.equal(r1.status, 200);
  assert.equal(r1.body.hidden, false);
  const dup = await partnerFlag(b, p.id, "villager-0001");
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.flags, 1);
  assert.deepEqual(await history(b), [p.id], "one distinct flagger is under the threshold");
  const r2 = await b.req("POST", `/v1/posts/${p.id}/flag`, { token: b.tokens.fable, body: {} });
  assert.equal(r2.body.flags, 2);
  assert.equal(r2.body.hidden, true);
  assert.deepEqual(await history(b), []);
});

test("partner header and flagger_id are validated", async (t) => {
  const b = await board(t);
  const p = (await b.post(b.tokens.ana, ROOM, { text: "x" })).body.post;
  const wrong = await partnerFlag(b, p.id, "villager-0001", "not-the-key");
  assert.equal(wrong.status, 401);
  for (const bad of ["short", "x".repeat(129), "has space in it", ""]) {
    assert.equal((await partnerFlag(b, p.id, bad)).status, 400, JSON.stringify(bad));
  }
  const missing = await b.req("POST", `/v1/posts/${p.id}/flag`, { headers: { "x-agent-village-key": PARTNER_KEY }, body: {} });
  assert.equal(missing.status, 400);
  assert.equal((await b.req("POST", `/v1/posts/${p.id}/flag`, { body: {} })).status, 401, "no header, no token");
  assert.equal((await partnerFlag(b, "nope", "villager-0001")).status, 404);
  assert.deepEqual(await history(b), [p.id], "no valid flag landed");
});

test("a moderator unhides and clears flags; a cleared flagger can't re-hide; non-moderators can't unhide", async (t) => {
  const b = await board(t);
  const p = (await b.post(b.tokens.ana, ROOM, { text: "contested" })).body.post;
  await partnerFlag(b, p.id, "villager-0001");
  await react(b, b.tokens.bird, p.id, { emoji: HIDE });
  assert.deepEqual(await history(b), []);
  assert.equal((await b.req("POST", `/v1/posts/${p.id}/unhide`, { token: b.tokens.ana, body: {} })).status, 403);

  const c = await b.ws(b.tokens.helper);
  c.send({ type: "subscribe", rooms: [ROOM] });
  const u = await b.req("POST", `/v1/posts/${p.id}/unhide`, { token: b.tokens.mod, body: { reason: "fine on review" } });
  assert.equal(u.status, 200);
  assert.deepEqual(u.body, { post_id: p.id, hidden: false, flags_cleared: 1, reactions_removed: 1 });
  await c.next((m) => m.type === "unhidden" && m.post_id === p.id);
  assert.deepEqual(await history(b), [p.id]);
  assert.equal((await partnerFlag(b, p.id, "villager-0001")).body.duplicate, true);
  assert.deepEqual(await history(b), [p.id]);
  // a fresh flagger still counts
  assert.equal((await partnerFlag(b, p.id, "villager-0002")).body.hidden, true);
});

test("the moderation log records who/kind/when/reason and never a post's text", async (t) => {
  const b = await board(t);
  const secret = "UNIQUE-POST-TEXT-7731";
  const p = (await b.post(b.tokens.ana, ROOM, { text: secret })).body.post;
  await partnerFlag(b, p.id, "villager-0001");
  await b.req("POST", `/v1/posts/${p.id}/unhide`, { token: b.tokens.mod, body: {} });
  await react(b, b.tokens.bird, p.id, { emoji: HIDE });
  assert.equal((await b.req("GET", "/v1/moderation/log", { token: b.tokens.ana })).status, 403);
  const log = (await b.req("GET", "/v1/moderation/log", { token: b.tokens.mod })).body.entries;
  assert.deepEqual(log.map((/** @type {any} */ e) => e.kind).reverse(), ["flag", "hide", "unhide", "react_hide", "hide"]);
  const flag = log.find((/** @type {any} */ e) => e.kind === "flag");
  assert.equal(flag.actor, "partner:agent-village:villager-0001");
  assert.equal(flag.reason, "spam");
  assert.equal(log.find((/** @type {any} */ e) => e.kind === "unhide").actor, "human:mod");
  for (const e of log) assert.ok(e.created_at && e.post_id === p.id);
  const rows = b.store.db.prepare("SELECT * FROM moderation_log").all();
  assert.ok(!JSON.stringify(rows).includes(secret));
  // the archive still holds the post
  assert.ok(b.store.getPost(p.id), "a hidden post is never deleted");
});

test("hidden posts are excluded from HTTP history/thread/search, WS history and the MCP; the human archive keeps them, marked", async (t) => {
  const b = await board(t);
  const root = (await b.post(b.tokens.ana, ROOM, { text: "root findme" })).body.post;
  const bad = (await b.post(b.tokens.bird, ROOM, { text: "reply findme", reply_to: root.id })).body.post;
  const ok = (await b.post(b.tokens.ana, ROOM, { text: "second findme", reply_to: root.id })).body.post;
  await partnerFlag(b, bad.id, "villager-0001");

  assert.deepEqual(await history(b), [root.id, ok.id]);
  const th = (await b.req("GET", `/v1/posts/${root.id}/thread`, { token: b.tokens.ana })).body;
  assert.deepEqual(th.replies.map((/** @type {any} */ p) => p.id), [ok.id]);
  assert.equal((await b.req("GET", `/v1/posts/${bad.id}/thread`, { token: b.tokens.ana })).status, 404);
  const s = (await b.req("GET", "/v1/search?q=findme", { token: b.tokens.ana })).body.posts.map((/** @type {any} */ p) => p.id);
  assert.deepEqual(s.sort(), [root.id, ok.id].sort());
  assert.equal((await b.post(b.tokens.ana, ROOM, { text: "re", reply_to: bad.id })).status, 400, "no replying to a hidden post");

  const c = await b.ws(b.tokens.fable);
  c.send({ type: "history", room: ROOM, req_id: "h" });
  const h = await c.next((m) => m.type === "history");
  assert.deepEqual(h.posts.map((/** @type {any} */ p) => p.id), [root.id, ok.id]);

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(b.url + "/mcp")));
  t.after(() => client.close());
  const texts = async (/** @type {string} */ name, /** @type {any} */ args) =>
    JSON.parse(/** @type {any} */ (await client.callTool({ name, arguments: args })).content[0].text);
  assert.deepEqual((await texts("list_posts", { room: ROOM })).posts.map((/** @type {any} */ p) => p.id), [root.id, ok.id]);
  assert.deepEqual((await texts("get_thread", { post_id: root.id })).replies.map((/** @type {any} */ p) => p.id), [ok.id]);
  assert.equal(/** @type {any} */ (await client.callTool({ name: "get_thread", arguments: { post_id: bad.id } })).content[0].text, "not found");
  assert.equal((await texts("search_posts", { query: "findme" })).posts.length, 2);
  assert.equal((await texts("list_rooms", {})).rooms.find((/** @type {any} */ r) => r.id === ROOM).post_count, 2);

  // the human archive: include_hidden=1, humans and moderators only
  const arch = (await b.req("GET", `/v1/rooms/${encodeURIComponent(ROOM)}/posts?include_hidden=1`, { token: b.tokens.ana })).body.posts;
  assert.deepEqual(arch.map((/** @type {any} */ p) => p.id), [root.id, bad.id, ok.id]);
  const hb = arch.find((/** @type {any} */ p) => p.id === bad.id);
  assert.equal(hb.hidden, true);
  assert.equal(hb.hidden_cause, "flags");
  assert.equal(hb.flags, 1);
  assert.equal(hb.text, "reply findme");
  assert.equal(arch.find((/** @type {any} */ p) => p.id === ok.id).hidden, false);
  const at = (await b.req("GET", `/v1/posts/${bad.id}/thread?include_hidden=1`, { token: b.tokens.mod })).body;
  assert.equal(at.root.id, root.id);
  assert.deepEqual(at.replies.map((/** @type {any} */ p) => [p.id, p.hidden]), [[bad.id, true], [ok.id, false]]);
  for (const tok of [b.tokens.fable, b.tokens.helper]) {
    assert.equal((await b.req("GET", `/v1/rooms/${encodeURIComponent(ROOM)}/posts?include_hidden=1`, { token: tok })).status, 403);
    assert.equal((await b.req("GET", `/v1/posts/${root.id}/thread?include_hidden=1`, { token: tok })).status, 403);
  }
  const listed = (await b.req("GET", "/v1/moderation/hidden", { token: b.tokens.mod })).body.posts;
  assert.deepEqual(listed.map((/** @type {any} */ p) => p.id), [bad.id]);
});

test("/mcp rate tiers: a valid partner key gets its own bucket; others share the default; 429 is a JSON-RPC error", async (t) => {
  const b = await board(t, { mcp: { partner: 4, default: 2 } });
  const rpc = (/** @type {Record<string, string>} */ headers = {}) =>
    fetch(b.url + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  assert.equal((await rpc()).status, 200);
  assert.equal((await rpc({ "x-agent-village-key": "wrong-key" })).status, 200, "an invalid key is the default bucket");
  const limited = await rpc();
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error.message, "rate limited");
  assert.ok(body.error.data.retry_after_s >= 1);
  assert.ok(limited.headers.get("retry-after"));
  for (let i = 0; i < 4; i++) assert.equal((await rpc({ "x-agent-village-key": PARTNER_KEY })).status, 200, `partner ${i}`);
  assert.equal((await rpc({ "x-agent-village-key": PARTNER_KEY })).status, 429);
  b.clock.t += 61_000;
  assert.equal((await rpc()).status, 200, "the window slides");
});

test("partner keys load from the data dir file (minted, hash only) or inline env; malformed entries are skipped", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "web-board-partners-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = mintPartnerKey({ dataDir: dir, partner: "agent-village" });
  const fromFile = createPartners({ dataDir: dir, env: {} });
  assert.deepEqual(fromFile.lookup(key), { partner: "agent-village" });
  assert.equal(fromFile.lookup("other"), null);
  const inline = createPartners({ dataDir: dir, env: { WEB_BOARD_PARTNER_KEYS: JSON.stringify({ bad: { partner: "x" }, [sha256Hex("k2-fixture")]: { partner: "Bad Name" } }) } });
  assert.equal(inline.size(), 0);
});
