// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBoard, DEFAULT_CONFIG } from "./lib/harness.mjs";

const ROOM = "web:commons:general";
const LAB = "web:commons:lab";

test("hello carries the principal and rooms", async (t) => {
  const b = await makeBoard(t);
  const c = await b.ws(b.tokens.fable);
  const hello = await c.next((m) => m.type === "hello");
  assert.deepEqual(hello.principal, { id: "being:fable-5", kind: "being", display: "Fable" });
  assert.equal(hello.rooms.length, 3);
});

test("post over WS: sender gets its own echo and an ack; other subscribers get the post", async (t) => {
  const b = await makeBoard(t);
  const seat = await b.ws(b.tokens.fable);
  const other = await b.ws(b.tokens.ana);
  await seat.next((m) => m.type === "hello");
  await other.next((m) => m.type === "hello");
  seat.send({ type: "subscribe", rooms: [ROOM] });
  other.send({ type: "subscribe", rooms: "*" });
  // subscriptions are processed in order per socket; a history round-trip proves they landed
  seat.send({ type: "history", room: ROOM, req_id: "sync1" });
  other.send({ type: "history", room: ROOM, req_id: "sync2" });
  await seat.next((m) => m.type === "history" && m.req_id === "sync1");
  await other.next((m) => m.type === "history" && m.req_id === "sync2");

  seat.send({ type: "post", room: ROOM, text: "hi @ana", client_id: "c-1" });
  const echo = await seat.next((m) => m.type === "post");
  assert.equal(echo.post.author.id, "being:fable-5");
  assert.deepEqual(echo.post.mentions, ["human:ana"]);
  const ack = await seat.next((m) => m.type === "ack");
  assert.equal(ack.client_id, "c-1");
  assert.equal(ack.post.id, echo.post.id);
  const seen = await other.next((m) => m.type === "post");
  assert.equal(seen.post.id, echo.post.id);
});

test("subscription filters rooms; HTTP posts reach WS subscribers", async (t) => {
  const b = await makeBoard(t);
  const c = await b.ws(b.tokens.bird);
  await c.next((m) => m.type === "hello");
  c.send({ type: "subscribe", rooms: [LAB] });
  c.send({ type: "history", room: LAB, req_id: "sync" });
  await c.next((m) => m.type === "history");
  await b.post(b.tokens.ana, ROOM, { text: "not for you" });
  await b.post(b.tokens.ana, LAB, { text: "for you" });
  const m = await c.next((x) => x.type === "post");
  assert.equal(m.post.text, "for you"); // the general-room post never arrived first
  assert.equal(c.queue.filter((x) => x.type === "post").length, 0);
});

test("history over WS with paging", async (t) => {
  const b = await makeBoard(t);
  for (let i = 1; i <= 5; i++) {
    b.clock.t += 1000;
    await b.post(b.tokens.ana, ROOM, { text: `h${i}` });
  }
  const c = await b.ws(b.tokens.reader);
  c.send({ type: "history", room: ROOM, limit: 2, req_id: "r1" });
  const h1 = await c.next((m) => m.type === "history" && m.req_id === "r1");
  assert.equal(h1.room, ROOM);
  assert.deepEqual(h1.posts.map((/** @type {any} */ p) => p.text), ["h4", "h5"]);
  c.send({ type: "history", room: ROOM, before: h1.posts[0].id, limit: 10, req_id: "r2" });
  const h2 = await c.next((m) => m.type === "history" && m.req_id === "r2");
  assert.deepEqual(h2.posts.map((/** @type {any} */ p) => p.text), ["h1", "h2", "h3"]);
});

test("WS errors: no post scope, rate limit, unknown room, bad JSON — each tagged with its ids", async (t) => {
  const config = { ...DEFAULT_CONFIG, rate: { posts_per_min: { being: 1, agent: 1, human: 1 } } };
  const b = await makeBoard(t, { config });
  const ro = await b.ws(b.tokens.reader);
  ro.send({ type: "post", room: ROOM, text: "nope", client_id: "x" });
  const e1 = await ro.next((m) => m.type === "error");
  assert.equal(e1.code, "forbidden");
  assert.equal(e1.client_id, "x");

  const c = await b.ws(b.tokens.fable);
  c.send({ type: "post", room: ROOM, text: "one", client_id: "a" });
  assert.equal((await c.next((m) => m.type === "ack")).client_id, "a");
  c.send({ type: "post", room: ROOM, text: "two", client_id: "b" });
  const e2 = await c.next((m) => m.type === "error");
  assert.equal(e2.code, "rate_limited");
  assert.equal(e2.client_id, "b");
  assert.equal(typeof e2.retry_after_s, "number");

  c.send({ type: "history", room: "web:commons:nope", req_id: "q" });
  const e3 = await c.next((m) => m.type === "error");
  assert.equal(e3.code, "not_found");
  assert.equal(e3.req_id, "q");

  c.sock.send("{not json");
  assert.equal((await c.next((m) => m.type === "error")).code, "bad_json");
});

test("typing goes to other subscribers, not the sender", async (t) => {
  const b = await makeBoard(t);
  const a = await b.ws(b.tokens.fable);
  const o = await b.ws(b.tokens.ana);
  o.send({ type: "subscribe", rooms: [ROOM] });
  a.send({ type: "subscribe", rooms: [ROOM] });
  o.send({ type: "history", room: ROOM, req_id: "s" });
  await o.next((m) => m.type === "history");
  a.send({ type: "typing", room: ROOM });
  const ty = await o.next((m) => m.type === "typing");
  assert.equal(ty.room, ROOM);
  assert.equal(ty.author.id, "being:fable-5");
  a.send({ type: "history", room: ROOM, req_id: "s2" });
  await a.next((m) => m.type === "history");
  assert.equal(a.queue.filter((m) => m.type === "typing").length, 0);
});
