// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBoard } from "../src/server.mjs";
import { mintToken } from "../scripts/mint-token.mjs";
import { normalizeConfig } from "../src/config.mjs";

const OLD = "web:commons:old";
const NEW = "web:commons:village";

/** @param {boolean} hideOld */
const config = (hideOld) => ({
  rooms: [
    { id: OLD, title: "Old", public: true, ...(hideOld ? { hidden: true } : {}) },
    { id: NEW, title: "Village", public: true },
  ],
  expose: [OLD, NEW],
  rate: { posts_per_min: { being: 1000, agent: 1000, human: 1000 } },
});

/** a board on `dataDir` with `cfg`; returns helpers and a close */
async function boot(dataDir, cfg) {
  writeFileSync(join(dataDir, "board.config.json"), JSON.stringify(cfg));
  const b = await startBoard({ dataDir, port: 0, host: "127.0.0.1", publicUrl: "https://board.example", now: () => Date.parse("2026-10-17T12:00:00Z"), env: {} });
  /** @param {string} method @param {string} path @param {{token?: string, body?: unknown}} [o] */
  const req = async (method, path, o = {}) => {
    /** @type {Record<string, string>} */
    const headers = { accept: "application/json, text/event-stream" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(b.url + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, body };
  };
  /** @param {string} name @param {any} args */
  const mcp = async (name, args) =>
    (await req("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })).body;
  return { b, req, mcp };
}

test("a hidden room is archived: nothing served, nothing accepted, posts kept; unhiding restores it", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "web-board-hidden-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const tok = mintToken({ dataDir, id: "human:ana", display: "Ana" });
  /** @type {any} */
  let s = null;
  t.after(async () => { if (s && !s.closed) await s.b.close(); });
  const close = async () => { s.closed = true; await s.b.close(); };

  // 1. both rooms live; a post lands in the old one
  s = await boot(dataDir, config(false));
  const posted = await s.req("POST", `/v1/rooms/${encodeURIComponent(OLD)}/posts`, { token: tok, body: { text: "old words" } });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const postId = posted.body.post.id;
  await close();

  // 2. the old room hidden
  s = await boot(dataDir, config(true));
  const rooms = await s.req("GET", "/v1/rooms", { token: tok });
  assert.deepEqual(rooms.body.rooms.map((/** @type {any} */ r) => r.id), [NEW]);
  assert.equal((await s.req("GET", `/v1/rooms/${encodeURIComponent(OLD)}/posts`, { token: tok })).status, 404);
  assert.equal((await s.req("POST", `/v1/rooms/${encodeURIComponent(OLD)}/posts`, { token: tok, body: { text: "x" } })).status, 404);
  assert.equal((await s.req("GET", `/rooms/${OLD}`)).status, 404);
  assert.equal((await s.req("GET", `/posts/${postId}`)).status, 404);
  const home = await s.req("GET", "/");
  assert.doesNotMatch(String(home.body), /web:commons:old/);
  assert.match(String(home.body), /web:commons:village/);
  const listed = JSON.parse((await s.mcp("list_rooms", {})).result.content[0].text);
  assert.deepEqual(listed.rooms.map((/** @type {any} */ r) => r.id), [NEW]);
  assert.equal((await s.mcp("list_posts", { room: OLD })).result.isError, true);
  const found = JSON.parse((await s.mcp("search_posts", { query: "old words" })).result.content[0].text);
  assert.equal(found.posts.length, 0);
  await close();

  // 3. unhidden: the post is back, untouched
  s = await boot(dataDir, config(false));
  const back = await s.req("GET", `/v1/rooms/${encodeURIComponent(OLD)}/posts`, { token: tok });
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.posts.map((/** @type {any} */ p) => p.text), ["old words"]);
  await close();
});

test("config: hidden defaults to false; an expose entry naming a hidden room is accepted and ignored by the board", () => {
  const c = normalizeConfig(config(true));
  assert.equal(c.rooms.find((r) => r.id === NEW)?.hidden, false);
  assert.equal(c.rooms.find((r) => r.id === OLD)?.hidden, true);
  assert.deepEqual(c.expose, [OLD, NEW]);
});
