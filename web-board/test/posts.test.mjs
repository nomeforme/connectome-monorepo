// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBoard, DEFAULT_CONFIG, T0 } from "./lib/harness.mjs";
import { resolveMentions } from "../src/mentions.mjs";

const ROOM = "web:commons:general";
const LAB = "web:commons:lab";

test("a post has the contract shape", async (t) => {
  const b = await makeBoard(t);
  const r = await b.post(b.tokens.fable, ROOM, { text: "hello board" });
  assert.equal(r.status, 200);
  const p = r.body.post;
  assert.deepEqual(Object.keys(p).sort(), ["author", "created_at", "id", "mentions", "reply_to", "room", "text", "ts"]);
  assert.equal(p.room, ROOM);
  assert.deepEqual(p.author, { id: "being:fable-5", kind: "being", display: "Fable" });
  assert.equal(p.reply_to, null);
  assert.deepEqual(p.mentions, []);
  assert.equal(p.ts, T0);
  assert.equal(p.created_at, new Date(T0).toISOString());
});

test("post validation: empty, too long, unknown room, bad reply_to, bad JSON", async (t) => {
  const b = await makeBoard(t);
  assert.equal((await b.post(b.tokens.fable, ROOM, { text: "   " })).status, 400);
  assert.equal((await b.post(b.tokens.fable, ROOM, { text: "x".repeat(8000) })).status, 200);
  const long = await b.post(b.tokens.fable, ROOM, { text: "x".repeat(8001) });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, "text_too_long");
  assert.equal((await b.post(b.tokens.fable, "web:commons:nope", { text: "hi" })).status, 404);
  const lab = (await b.post(b.tokens.fable, LAB, { text: "in lab" })).body.post;
  const cross = await b.post(b.tokens.fable, ROOM, { text: "reply", reply_to: lab.id });
  assert.equal(cross.status, 400);
  assert.equal(cross.body.error, "bad_reply_to");
  assert.equal((await b.post(b.tokens.fable, ROOM, { text: "hi", mentions: "being:big-bird" })).status, 400);
  const raw = await fetch(`${b.url}/v1/rooms/${ROOM}/posts`, {
    method: "POST", headers: { authorization: `Bearer ${b.tokens.fable}` }, body: "{nope",
  });
  assert.equal(raw.status, 400);
});

test("rate limit per principal kind → 429 with retry_after_s, then recovers", async (t) => {
  const config = { ...DEFAULT_CONFIG, rate: { posts_per_min: { being: 2, agent: 1, human: 3 } } };
  const b = await makeBoard(t, { config });
  assert.equal((await b.post(b.tokens.fable, ROOM, { text: "1" })).status, 200);
  b.clock.t += 10_000;
  assert.equal((await b.post(b.tokens.fable, ROOM, { text: "2" })).status, 200);
  const r = await b.post(b.tokens.fable, ROOM, { text: "3" });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "rate_limited");
  assert.equal(r.body.retry_after_s, 50); // the first post leaves the window 50 s from now

  // another being has its own window; an agent's cap is its kind's
  assert.equal((await b.post(b.tokens.bird, ROOM, { text: "b1" })).status, 200);
  assert.equal((await b.post(b.tokens.helper, ROOM, { text: "a1" })).status, 200);
  assert.equal((await b.post(b.tokens.helper, ROOM, { text: "a2" })).status, 429);

  // rejected posts were not stored
  const page = await b.req("GET", `/v1/rooms/${ROOM}/posts`, { token: b.tokens.fable });
  assert.deepEqual(page.body.posts.map((/** @type {any} */ p) => p.text), ["1", "2", "b1", "a1"]);

  b.clock.t += 50_000;
  assert.equal((await b.post(b.tokens.fable, ROOM, { text: "4" })).status, 200);
});

test("mentions: @display tokens resolve (case, _ and - for spaces) and merge with explicit ids", async (t) => {
  const b = await makeBoard(t);
  const r = await b.post(b.tokens.ana, ROOM, {
    text: "hey @big_bird and @FABLE, also @Big-Bird again; mail ana@fable.example; @nobody",
    mentions: ["agent:helper-1", "being:does-not-exist", "agent:helper-1"],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.post.mentions, ["agent:helper-1", "being:big-bird", "being:fable-5"]);
});

test("mention resolver: trailing punctuation and multi-match", () => {
  const ps = [
    { id: "being:a", display: "Echo" },
    { id: "human:b", display: "echo" },
    { id: "being:c", display: "Deep Thought" },
  ];
  assert.deepEqual(resolveMentions("@echo. and @deep-thought-", undefined, ps), ["being:a", "human:b", "being:c"]);
  assert.deepEqual(resolveMentions("email x@echo", undefined, ps), []);
  assert.deepEqual(resolveMentions("@@echo", undefined, ps), []);
});

test("history paging: newest-last pages walk back with next_before", async (t) => {
  const b = await makeBoard(t);
  for (let i = 1; i <= 7; i++) {
    b.clock.t += 1000;
    await b.post(b.tokens.fable, ROOM, { text: `m${i}` });
  }
  await b.post(b.tokens.fable, LAB, { text: "other room" });
  const get = (/** @type {string} */ q) => b.req("GET", `/v1/rooms/${ROOM}/posts${q}`, { token: b.tokens.reader });
  const p1 = (await get("?limit=3")).body;
  assert.deepEqual(p1.posts.map((/** @type {any} */ p) => p.text), ["m5", "m6", "m7"]);
  assert.equal(p1.next_before, p1.posts[0].id);
  const p2 = (await get(`?limit=3&before=${p1.next_before}`)).body;
  assert.deepEqual(p2.posts.map((/** @type {any} */ p) => p.text), ["m2", "m3", "m4"]);
  const p3 = (await get(`?limit=3&before=${p2.next_before}`)).body;
  assert.deepEqual(p3.posts.map((/** @type {any} */ p) => p.text), ["m1"]);
  assert.equal(p3.next_before, null);
  assert.equal((await get("")).body.posts.length, 7); // default 50
  assert.equal((await get("?limit=0")).status, 400);
  assert.equal((await get("?limit=101")).status, 400);
});

test("ids are time-ordered even within one millisecond", async (t) => {
  const b = await makeBoard(t);
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await b.post(b.tokens.fable, ROOM, { text: `same ms ${i}` })).body.post.id);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

test("thread: root and every nested reply, from any post in it", async (t) => {
  const b = await makeBoard(t);
  const root = (await b.post(b.tokens.ana, ROOM, { text: "root" })).body.post;
  const r1 = (await b.post(b.tokens.fable, ROOM, { text: "r1", reply_to: root.id })).body.post;
  const r2 = (await b.post(b.tokens.bird, ROOM, { text: "r2", reply_to: r1.id })).body.post;
  await b.post(b.tokens.bird, ROOM, { text: "unrelated" });
  const r3 = (await b.post(b.tokens.ana, ROOM, { text: "r3", reply_to: root.id })).body.post;
  for (const id of [root.id, r2.id]) {
    const th = await b.req("GET", `/v1/posts/${id}/thread`, { token: b.tokens.fable });
    assert.equal(th.status, 200);
    assert.equal(th.body.root.id, root.id);
    assert.deepEqual(th.body.replies.map((/** @type {any} */ p) => p.id), [r1.id, r2.id, r3.id]);
  }
  assert.equal((await b.req("GET", "/v1/posts/zzz/thread", { token: b.tokens.fable })).status, 404);
});

test("search: case-insensitive substring, room filter, limit, wildcards literal", async (t) => {
  const b = await makeBoard(t);
  await b.post(b.tokens.fable, ROOM, { text: "The Garden grows" });
  b.clock.t += 1;
  await b.post(b.tokens.fable, LAB, { text: "garden lab notes" });
  b.clock.t += 1;
  await b.post(b.tokens.fable, ROOM, { text: "100% sure" });
  b.clock.t += 1;
  await b.post(b.tokens.fable, ROOM, { text: "1000 sure" });
  const s = (/** @type {string} */ q) => b.req("GET", `/v1/search?${q}`, { token: b.tokens.reader });
  const all = (await s("q=GARDEN")).body.posts.map((/** @type {any} */ p) => p.text);
  assert.deepEqual(all, ["garden lab notes", "The Garden grows"]); // newest first
  const one = (await s(`q=garden&room=${encodeURIComponent(ROOM)}`)).body.posts;
  assert.deepEqual(one.map((/** @type {any} */ p) => p.text), ["The Garden grows"]);
  assert.equal((await s("q=garden&limit=1")).body.posts.length, 1);
  assert.deepEqual((await s(`q=${encodeURIComponent("0%")}`)).body.posts.map((/** @type {any} */ p) => p.text), ["100% sure"]);
  assert.equal((await s("q=a")).status, 400);
  assert.equal((await s("q=garden&limit=21")).status, 400);
  assert.equal((await s("q=garden&room=web:commons:nope")).status, 404);
});

test("retention prunes posts older than retention_days", async (t) => {
  const b = await makeBoard(t, { config: { ...DEFAULT_CONFIG, retention_days: 2 } });
  await b.post(b.tokens.fable, ROOM, { text: "old" });
  b.clock.t += 2 * 86_400_000 + 1;
  await b.post(b.tokens.fable, ROOM, { text: "new" });
  assert.equal(b.board.prune(), 1);
  const page = await b.req("GET", `/v1/rooms/${ROOM}/posts`, { token: b.tokens.fable });
  assert.deepEqual(page.body.posts.map((/** @type {any} */ p) => p.text), ["new"]);
});
