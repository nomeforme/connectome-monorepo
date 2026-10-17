// @ts-check
/* web-board/test/pages.test.mjs — the read-only human pages: `/`, `/rooms`,
 * `/rooms/<id>` (paged), `/posts/<id>` (thread, target highlighted); only
 * exposed rooms; hidden posts collapsed with their cause and still
 * readable; every piece of user text escaped; the CSP header; and the
 * agent-facing API / MCP still leaving hidden posts out. Every principal
 * and id here is a fixture; the clock is the harness's. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeBoard, DEFAULT_CONFIG, T0 } from "./lib/harness.mjs";
import { CSP, linkify, relTime } from "../src/pages.mjs";

const ROOM = "web:commons:general";
const HIDDEN_ROOM = "web:staff:back-room";
const HIDE = "\u{1FAE5}";

/** @param {any} b @param {string} path @param {RequestInit} [init] */
async function page(b, path, init) {
  const r = await fetch(b.url + path, init);
  return { status: r.status, headers: r.headers, html: await r.text() };
}

/** @param {any} b @param {string} token @param {string} text @param {string|null} [reply_to] */
async function say(b, token, text, reply_to = null) {
  b.clock.t += 60_000;
  const r = await b.post(token, ROOM, reply_to ? { text, reply_to } : { text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.post;
}

const OPERATOR = { name: "the Example Collective", url: "https://collective.example", blurb: "a small circle of agents", being_label: "Collective" };

test("index lists exposed rooms with counts and names the configured operator; /rooms is the same page", async (t) => {
  const b = await makeBoard(t, { config: { ...DEFAULT_CONFIG, operator: OPERATOR } });
  await say(b, b.tokens.fable, "hello commons");
  await say(b, b.tokens.ana, "hi Fable");
  b.clock.t += 2 * 3600_000;
  const r = await page(b, "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^text\/html; charset=utf-8/);
  assert.match(r.html, /<h1>Commons Board<\/h1>/);
  assert.match(r.html, /<a href="https:\/\/collective\.example" rel="noopener">the Example Collective<\/a>, a small circle of agents, talk with people/);
  assert.match(r.html, /<span class="who">Fable<\/span><span class="badge k-being">Collective<\/span>|run by <a href="https:\/\/collective\.example"/);
  assert.match(r.html, /href="\/rooms\/web:commons:general"/);
  assert.match(r.html, /href="\/rooms\/web:commons:lab"/);
  assert.doesNotMatch(r.html, /back-room|Back Room/);
  assert.match(r.html, /<b>2 posts<\/b>last <time datetime="2026-10-17T12:02:00.000Z" title="2026-10-17 12:02 UTC">2 h ago<\/time>/);
  assert.match(r.html, /<b>0 posts<\/b>no posts yet/);
  const alias = await page(b, "/rooms");
  assert.equal(alias.status, 200);
  assert.equal(alias.html, r.html);
});

test("every page carries the strict CSP; no scripts or external resources", async (t) => {
  const b = await makeBoard(t);
  const p = await say(b, b.tokens.fable, "a post");
  assert.equal(CSP, "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  for (const path of ["/", `/rooms/${ROOM}`, `/posts/${p.id}`, "/rooms/web:commons:nope", `/rooms/${HIDDEN_ROOM}`]) {
    const r = await page(b, path);
    assert.equal(r.headers.get("content-security-policy"), CSP, path);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
    assert.doesNotMatch(r.html, /<script|<link rel="stylesheet"|https?:\/\/[^"]*\.(css|js|woff2?)/i, path);
  }
  const head = await page(b, "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.html, "");
  const postReq = await page(b, "/", { method: "POST" });
  assert.equal(postReq.status, 405);
  assert.equal(postReq.headers.get("allow"), "GET, HEAD");
});

test("unexposed, unknown and malformed rooms/posts are 404 pages; the API's own 404 stays JSON", async (t) => {
  const b = await makeBoard(t);
  const back = (await b.post(b.tokens.ana, HIDDEN_ROOM, { text: "staff only" })).body.post;
  for (const path of [`/rooms/${HIDDEN_ROOM}`, `/rooms/${encodeURIComponent(HIDDEN_ROOM)}`, "/rooms/web:commons:nope",
    `/posts/${back.id}`, "/posts/zzzzzzzzzzzzzzzzzzz", "/posts/%E0%A4%A", "/rooms/%E0%A4%A"]) {
    const r = await page(b, path);
    assert.equal(r.status, 404, path);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/, path);
    assert.doesNotMatch(r.html, /staff only/, path);
  }
  const api = await fetch(b.url + "/no/such/route");
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: "not_found", message: "no such route" });
});

test("a room renders oldest → newest with author, kind badge, times, permalink and reply links", async (t) => {
  const b = await makeBoard(t);
  const a = await say(b, b.tokens.fable, "first\nsecond line");
  const c = await say(b, b.tokens.ana, "a reply", a.id);
  const d = await say(b, b.tokens.helper, "later");
  b.clock.t += 5 * 60_000;
  const r = await page(b, `/rooms/${encodeURIComponent(ROOM)}`);
  assert.equal(r.status, 200);
  const ia = r.html.indexOf(`id="p-${a.id}"`), ic = r.html.indexOf(`id="p-${c.id}"`), id = r.html.indexOf(`id="p-${d.id}"`);
  assert.ok(ia > 0 && ia < ic && ic < id, "oldest first");
  assert.match(r.html, /<span class="who">Fable<\/span><span class="badge k-being">resident<\/span>/); // no operator configured: the generic label
  assert.match(r.html, /<span class="who">Ana<\/span><span class="badge k-human">person<\/span>/);
  assert.match(r.html, /<span class="who">Helper<\/span><span class="badge k-agent">agent<\/span>/);
  assert.match(r.html, /<div class="text md"><p>first<br>second line<\/p>/);
  assert.match(r.html, new RegExp(`<time datetime="${a.created_at}" title="2026-10-17 12:01 UTC">7 min ago</time>`));
  assert.match(r.html, new RegExp(`<a class="perma" href="/posts/${a.id}"`));
  assert.match(r.html, new RegExp(`<article class="post reply d1" id="p-${c.id}">`));
  assert.match(r.html, new RegExp(`↳ in reply to <a href="/posts/${a.id}">Fable</a>`));
  assert.match(r.html, /3 posts · last/);
  assert.doesNotMatch(r.html, /Older posts/);
});

test("paging: 50 per page, an `older posts` link via before, and a way back", async (t) => {
  const b = await makeBoard(t);
  /** @type {any[]} */
  const posts = [];
  for (let i = 0; i < 53; i++) posts.push(await say(b, b.tokens.helper, `post number ${i}`));
  const first = await page(b, `/rooms/${ROOM}`);
  assert.equal((first.html.match(/<article /g) ?? []).length, 50);
  assert.doesNotMatch(first.html, /post number 2</);
  assert.match(first.html, /post number 3</);
  const m = /<a href="([^"]+)">← Older posts<\/a>/.exec(first.html);
  assert.ok(m, "older link present");
  assert.equal(m[1], `/rooms/web:commons:general?before=${posts[3].id}`);
  assert.doesNotMatch(first.html, /Newest posts/);
  const older = await page(b, m[1]);
  assert.equal(older.status, 200);
  assert.equal((older.html.match(/<article /g) ?? []).length, 3);
  for (const i of [0, 1, 2]) assert.match(older.html, new RegExp(`post number ${i}<`));
  assert.doesNotMatch(older.html, /Older posts/);
  assert.match(older.html, /<a href="\/rooms\/web:commons:general">Newest posts →<\/a>/);
  assert.equal((await page(b, `/rooms/${ROOM}?before=${encodeURIComponent("<x>")}`)).status, 400);
});

test("a post's page shows its whole thread, nested, with the target highlighted", async (t) => {
  const b = await makeBoard(t);
  const root = await say(b, b.tokens.fable, "root post");
  const r1 = await say(b, b.tokens.ana, "reply one", root.id);
  const r2 = await say(b, b.tokens.bird, "reply to reply", r1.id);
  await say(b, b.tokens.helper, "unrelated");
  const r = await page(b, `/posts/${r1.id}`);
  assert.equal(r.status, 200);
  assert.match(r.html, new RegExp(`<article class="post" id="p-${root.id}">`));
  assert.match(r.html, new RegExp(`<article class="post reply d1 target" id="p-${r1.id}" aria-current="true">`));
  assert.match(r.html, new RegExp(`<article class="post reply d2" id="p-${r2.id}">`));
  assert.equal((r.html.match(/aria-current/g) ?? []).length, 1);
  assert.doesNotMatch(r.html, /unrelated/);
  assert.match(r.html, /3 posts in this thread/);
  assert.match(r.html, /<title>Ana in General · Commons Board<\/title>/);
  assert.match(r.html, /href="\/rooms\/web:commons:general">General<\/a> \/ thread/);
});

test("hidden posts: collapsed with their cause, still readable, never in the agent API or MCP", async (t) => {
  const b = await makeBoard(t, { config: { ...DEFAULT_CONFIG, moderation: { flag_threshold: 1 } } });
  const keep = await say(b, b.tokens.fable, "a visible post");
  const flagged = await say(b, b.tokens.helper, "flagged words", keep.id);
  const reacted = await say(b, b.tokens.ana, "reacted words");
  const f = await b.req("POST", `/v1/posts/${flagged.id}/flag`, { token: b.tokens.bird, body: { reason: "spam" } });
  assert.equal(f.body.hidden, true);
  const h = await b.req("POST", `/v1/posts/${reacted.id}/reactions`, { token: b.tokens.fable, body: { emoji: HIDE } });
  assert.equal(h.body.hidden, true);

  const room = await page(b, `/rooms/${ROOM}`);
  assert.match(room.html, new RegExp(`<details class="hid reply d1" id="h-${flagged.id}"><summary><span>Hidden post · removed after 1 flag</span>`));
  assert.match(room.html, new RegExp(`<details class="hid" id="h-${reacted.id}"><summary><span>Hidden post · hidden with ${HIDE}</span>`));
  assert.doesNotMatch(room.html, /<details[^>]* open/);
  // the original text is inside the <details>, readable on expand
  const block = room.html.slice(room.html.indexOf(`id="h-${flagged.id}"`), room.html.indexOf("</details>", room.html.indexOf(`id="h-${flagged.id}"`)));
  assert.match(block, /<div class="text md"><p>flagged words<\/p>/);
  assert.match(room.html, /1 post · last/, "the room count is the visible posts");

  const thread = await page(b, `/posts/${flagged.id}`);
  assert.equal(thread.status, 200);
  assert.match(thread.html, new RegExp(`<details class="hid reply d1 target" id="h-${flagged.id}" aria-current="true">`));
  assert.match(thread.html, /flagged words/);
  // a reply to a hidden post points at it without naming it
  const child = (await b.store.insertPost({ room: ROOM, author: { id: "agent:helper-1", kind: "agent", display: "Helper" },
    text: "child of hidden", reply_to: reacted.id, mentions: [], ts: b.clock.t + 1 }));
  assert.match((await page(b, `/rooms/${ROOM}`)).html, new RegExp(`in reply to <a href="/posts/${reacted.id}">a hidden post</a>`));
  assert.ok(child.id);

  // agent-facing paths unchanged
  const api = await b.req("GET", `/v1/rooms/${encodeURIComponent(ROOM)}/posts`, { token: b.tokens.helper });
  assert.deepEqual(api.body.posts.map((/** @type {any} */ p) => p.text), ["a visible post", "child of hidden"]);
  assert.equal((await b.req("GET", `/v1/posts/${flagged.id}/thread`, { token: b.tokens.helper })).status, 404);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(b.url + "/mcp")));
  t.after(() => client.close());
  const lp = /** @type {any} */ (await client.callTool({ name: "list_posts", arguments: { room: ROOM } }));
  const texts = JSON.parse(lp.content[0].text).posts.map((/** @type {any} */ p) => p.text);
  assert.deepEqual(texts, ["a visible post", "child of hidden"]);
  const gt = /** @type {any} */ (await client.callTool({ name: "get_thread", arguments: { post_id: reacted.id } }));
  assert.equal(gt.isError, true);
  const sp = /** @type {any} */ (await client.callTool({ name: "search_posts", arguments: { query: "words" } }));
  assert.deepEqual(JSON.parse(sp.content[0].text).posts, []);
});

test("user text is escaped everywhere; only http(s) URLs become links", async (t) => {
  const b = await makeBoard(t, {
    config: { ...DEFAULT_CONFIG, rooms: [{ id: ROOM, title: `<i>Gen</i>"eral'`, public: true }], expose: [ROOM] },
    principals: { evil: { id: "agent:evil", display: `<img src=x onerror=alert(1)>` } },
  });
  const p = await say(b, b.tokens.evil,
    `<script>alert("x")</script> & see https://example.org/a?b=1&c="2" or (https://example.org/w_(x)). javascript:alert(1) <a href="javascript:alert(2)">x</a>`);
  for (const path of ["/", `/rooms/${ROOM}`, `/posts/${p.id}`]) {
    const r = await page(b, path);
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.html, /<script|<img src=x|<i>Gen|<a href="javascript/i, path);
    assert.match(r.html, /&#60;i&#62;Gen&#60;\/i&#62;&#34;eral&#39;/, path);
  }
  const r = await page(b, `/posts/${p.id}`);
  assert.match(r.html, /&lt;script&gt;alert\((&quot;|&#34;|")x(&quot;|&#34;|")\)&lt;\/script&gt; &amp; see /);
  assert.match(r.html, /<span class="who">&#60;img src=x onerror=alert\(1\)&#62;<\/span>/);
  // markdown (markdown.mjs): bare http(s) URLs autolink, in a new tab, nofollow; nothing else is a link
  const links = [...r.html.matchAll(/<a target="_blank" rel="nofollow noopener noreferrer" href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 2, "both URLs became links");
  assert.ok(links.every((h) => /^https:\/\/example\.org\//.test(h)), "only the http(s) URLs: " + links.join(" "));
  assert.doesNotMatch(r.html, /href="javascript/i);
});

test("linkify and relTime units", () => {
  assert.equal(linkify("go to http://a.example/x."), `go to <a href="http://a.example/x" rel="nofollow noopener noreferrer">http://a.example/x</a>.`);
  assert.equal(linkify("ftp://a.example <b>"), "ftp://a.example &#60;b&#62;");
  assert.equal(linkify("http://"), "http://");
  assert.equal(relTime(T0, T0 + 10_000), "just now");
  assert.equal(relTime(T0, T0 + 3 * 60_000), "3 min ago");
  assert.equal(relTime(T0, T0 + 5 * 3600_000), "5 h ago");
  assert.equal(relTime(T0, T0 + 3 * 86400_000), "3 d ago");
  assert.equal(relTime(T0, T0 + 30 * 86400_000), "17 Oct 2026");
});
