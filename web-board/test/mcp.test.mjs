// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeBoard, DEFAULT_PRINCIPALS } from "./lib/harness.mjs";
import { MAX_RESULT_BYTES } from "../src/mcp.mjs";

const ROOM = "web:commons:general";
const HIDDEN = "web:staff:back-room";

/** @param {import("node:test").TestContext} t @param {string} url */
async function mcpClient(t, url) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
  t.after(() => client.close());
  return client;
}

/** @param {any} res */
function parse(res) {
  assert.equal(res.isError ?? false, false, JSON.stringify(res.content));
  assert.equal(res.content.length, 2);
  return { payload: JSON.parse(res.content[0].text), source: res.content[1].text };
}

test("exactly four tools with closed schemas", async (t) => {
  const b = await makeBoard(t);
  const c = await mcpClient(t, b.url);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ["get_thread", "list_posts", "list_rooms", "search_posts"]);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  const lp = tools.find((x) => x.name === "list_posts");
  assert.deepEqual(lp?.inputSchema.required, ["room"]);
  assert.deepEqual(/** @type {any} */ (lp?.inputSchema.properties)?.limit, { type: "integer", minimum: 1, maximum: 50, default: 20 });
});

test("only expose rooms are visible", async (t) => {
  const b = await makeBoard(t);
  const pub = (await b.post(b.tokens.ana, ROOM, { text: "public words" })).body.post;
  const hid = (await b.post(b.tokens.ana, HIDDEN, { text: "secret words" })).body.post;
  const c = await mcpClient(t, b.url);

  const rooms = parse(await c.callTool({ name: "list_rooms", arguments: {} }));
  assert.deepEqual(rooms.payload.rooms.map((/** @type {any} */ r) => r.id).sort(), ["web:commons:general", "web:commons:lab"]);
  const g = rooms.payload.rooms.find((/** @type {any} */ r) => r.id === ROOM);
  assert.equal(g.post_count, 1);
  assert.equal(g.latest_post_at, pub.created_at);
  assert.equal(g.title, "General");
  assert.match(rooms.source, /^Source: Commons Board, all rooms, https:\/\/board\.example\/rooms$/);

  for (const [name, args] of /** @type {const} */ ([
    ["list_posts", { room: HIDDEN }],
    ["get_thread", { post_id: hid.id }],
    ["search_posts", { query: "words", room: HIDDEN }],
    ["list_posts", { room: "web:commons:nope" }],
  ])) {
    const r = /** @type {any} */ (await c.callTool({ name, arguments: args }));
    assert.equal(r.isError, true, name);
    assert.equal(r.content[0].text, "not found");
  }
  const s = parse(await c.callTool({ name: "search_posts", arguments: { query: "words" } }));
  assert.deepEqual(s.payload.posts.map((/** @type {any} */ p) => p.id), [pub.id]);
});

test("list_posts, get_thread and search_posts return the public post view and a source line", async (t) => {
  const b = await makeBoard(t);
  const root = (await b.post(b.tokens.ana, ROOM, { text: "root @Fable" })).body.post;
  b.clock.t += 1000;
  const reply = (await b.post(b.tokens.fable, ROOM, { text: "reply", reply_to: root.id })).body.post;
  const c = await mcpClient(t, b.url);

  const lp = parse(await c.callTool({ name: "list_posts", arguments: { room: ROOM, limit: 5 } }));
  assert.deepEqual(lp.payload.posts.map((/** @type {any} */ p) => p.id), [root.id, reply.id]);
  assert.deepEqual(Object.keys(lp.payload.posts[0]).sort(),
    ["author_display", "author_kind", "created_at", "id", "reply_to", "room", "text", "url"]);
  assert.equal(lp.payload.posts[1].reply_to, root.id);
  assert.equal(lp.payload.posts[0].url, `https://board.example/posts/${root.id}`);
  assert.equal(lp.source, "Source: Commons Board, General, https://board.example/rooms/web:commons:general");

  const th = parse(await c.callTool({ name: "get_thread", arguments: { post_id: reply.id } }));
  assert.equal(th.payload.root.id, root.id);
  assert.deepEqual(th.payload.replies.map((/** @type {any} */ p) => p.id), [reply.id]);
  assert.equal(th.source, `Source: Commons Board, General, https://board.example/posts/${root.id}`);

  const sp = parse(await c.callTool({ name: "search_posts", arguments: { query: "REPLY", room: ROOM } }));
  assert.deepEqual(sp.payload.posts.map((/** @type {any} */ p) => p.id), [reply.id]);
  assert.match(sp.source, /^Source: Commons Board, General, /);
});

test("schema rejection: extra args, wrong types, out-of-range, missing required", async (t) => {
  const b = await makeBoard(t);
  const c = await mcpClient(t, b.url);
  for (const [name, args] of /** @type {const} */ ([
    ["list_rooms", { extra: 1 }],
    ["list_posts", { room: ROOM, limit: 20, author: "x" }],
    ["list_posts", { room: ROOM, limit: 51 }],
    ["list_posts", { room: ROOM, limit: 1.5 }],
    ["list_posts", {}],
    ["get_thread", { post_id: 5 }],
    ["search_posts", { query: "a" }],
    ["search_posts", { query: "x".repeat(201) }],
    ["search_posts", { query: "ok", limit: 21 }],
  ])) {
    const r = /** @type {any} */ (await c.callTool({ name, arguments: args }));
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, /^invalid arguments: /);
  }
  await assert.rejects(c.callTool({ name: "post_message", arguments: {} }));
});

test("responses are capped at 200 KB by dropping whole posts, and say so", async (t) => {
  const b = await makeBoard(t);
  const author = { id: "being:fable-5", kind: /** @type {const} */ ("being"), display: "Fable", scopes: ["read", "post"] };
  const text = "é".repeat(7999) + "!"; // 8000 chars, ~16 KB of UTF-8 each
  for (let i = 0; i < 50; i++) {
    b.clock.t += 1;
    b.board.post(author, ROOM, { text });
  }
  const c = await mcpClient(t, b.url);
  const res = /** @type {any} */ (await c.callTool({ name: "list_posts", arguments: { room: ROOM, limit: 50 } }));
  const bytes = Buffer.byteLength(JSON.stringify(res.content));
  assert.ok(bytes <= MAX_RESULT_BYTES, `${bytes} > ${MAX_RESULT_BYTES}`);
  const { payload, source } = parse(res);
  assert.equal(payload.truncated, true);
  assert.match(payload.note, /truncated to \d+ of 50/);
  assert.ok(payload.posts.length > 0 && payload.posts.length < 50);
  for (const p of payload.posts) assert.equal(p.text, text);
  // the newest posts are kept; next_before pages back to the dropped ones
  assert.equal(payload.next_before, payload.posts[0].id);
  assert.match(source, /^Source: /);

  const s = /** @type {any} */ (await c.callTool({ name: "search_posts", arguments: { query: "é!", limit: 20 } }));
  assert.ok(Buffer.byteLength(JSON.stringify(s.content)) <= MAX_RESULT_BYTES);
  assert.equal(parse(s).payload.truncated, true);
});

test("no principal ids, mentions or tokens in any MCP output", async (t) => {
  const b = await makeBoard(t);
  const root = (await b.post(b.tokens.ana, ROOM, { text: "hello @Fable @big_bird", mentions: ["agent:helper-1"] })).body.post;
  await b.post(b.tokens.fable, ROOM, { text: "hello back", reply_to: root.id });
  const c = await mcpClient(t, b.url);
  const outputs = [
    await c.callTool({ name: "list_rooms", arguments: {} }),
    await c.callTool({ name: "list_posts", arguments: { room: ROOM } }),
    await c.callTool({ name: "get_thread", arguments: { post_id: root.id } }),
    await c.callTool({ name: "search_posts", arguments: { query: "hello" } }),
  ];
  const all = JSON.stringify(outputs);
  for (const p of Object.values(DEFAULT_PRINCIPALS)) assert.ok(!all.includes(p.id), `leaked ${p.id}`);
  for (const tok of Object.values(b.tokens)) assert.ok(!all.includes(tok), "leaked a token");
  assert.ok(!all.includes("mentions"));
  assert.ok(all.includes("Fable")); // display names are public
});

test("GET /mcp is refused (stateless, POST only)", async (t) => {
  const b = await makeBoard(t);
  const r = await fetch(b.url + "/mcp");
  assert.equal(r.status, 405);
});
