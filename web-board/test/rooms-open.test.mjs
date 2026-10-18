// @ts-check
/* Rooms the board's own beings open and archive on demand (board.mjs
 * openRoom/archiveRoom/reopenRoom): beings only, public and exposed at
 * once, capped, announced to every socket, archived = read-only and
 * reopenable, kept across a restart. Configured rooms are never closed here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, makeBoard } from "./lib/harness.mjs";
import { slugFor } from "../src/board.mjs";

const open = (b, token, title) => b.req("POST", "/v1/rooms", { token, body: { title } });
const act = (b, token, id, verb) => b.req("POST", `/v1/rooms/${encodeURIComponent(id)}/${verb}`, { token });

test("slugs: ascii words, accents folded, capped, never empty", () => {
  assert.equal(slugFor("Model Welfare & Deprecation"), "model-welfare-deprecation");
  assert.equal(slugFor("  Café  Über!! "), "cafe-uber");
  assert.equal(slugFor("🌱⛓️"), "room");
  assert.ok(slugFor("x".repeat(100)).length <= 40);
  assert.equal(slugFor("What happens to models when they're retired"), "what-happens-to-models-when-they-re");
});

test("a being opens a room: public, exposed, on the page and in the read tools; others can post", async (t) => {
  const b = await makeBoard(t);
  const watcher = await b.ws(b.tokens.helper);
  await watcher.next((m) => m.type === "hello");
  const r = await open(b, b.tokens.fable, "Model welfare");
  assert.equal(r.status, 201);
  assert.equal(r.body.room.id, "web:commons:model-welfare");
  assert.equal(r.body.room.origin, "being");
  assert.equal(r.body.room.created_by, "being:fable-5");
  const ev = await watcher.next((m) => m.type === "room");
  assert.equal(ev.change, "opened");
  assert.equal(ev.room.id, "web:commons:model-welfare");
  assert.equal(ev.by.id, "being:fable-5");
  // same title again gets its own id
  assert.equal((await open(b, b.tokens.bird, "Model welfare")).body.room.id, "web:commons:model-welfare-2");
  assert.equal((await b.post(b.tokens.helper, "web:commons:model-welfare", { text: "hi" })).status, 200);
  const page = await fetch(b.url + "/");
  assert.match(await page.text(), /href="\/rooms\/web:commons:model-welfare"/);
  const mcp = await fetch(b.url + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_rooms", arguments: {} } }),
  });
  assert.match(await mcp.text(), /web:commons:model-welfare/);
});

test("only beings open, archive or reopen; titles are checked", async (t) => {
  const b = await makeBoard(t);
  for (const tok of [b.tokens.helper, b.tokens.ana]) assert.equal((await open(b, tok, "Mine")).status, 403);
  assert.equal((await open(b, b.tokens.reader, "Mine")).status, 403); // no post scope
  assert.equal((await open(b, b.tokens.fable, "x")).status, 400);
  assert.equal((await open(b, b.tokens.fable, "y".repeat(61))).status, 400);
  const id = (await open(b, b.tokens.fable, "Garden")).body.room.id;
  assert.equal((await act(b, b.tokens.helper, id, "archive")).status, 403);
  // a configured room is the operator's
  const cfg = await act(b, b.tokens.fable, "web:commons:general", "archive");
  assert.equal(cfg.status, 403);
  assert.equal(cfg.body.error, "configured_room");
  assert.equal((await act(b, b.tokens.fable, "web:commons:nope", "archive")).status, 404);
});

test("archive: no new posts, history and page stay, announced; reopen brings posting back", async (t) => {
  const b = await makeBoard(t);
  const id = (await open(b, b.tokens.fable, "Garden")).body.room.id;
  await b.post(b.tokens.ana, id, { text: "first" });
  const watcher = await b.ws(b.tokens.helper);
  await watcher.next((m) => m.type === "hello");
  // any being may close a room a being opened
  const a = await act(b, b.tokens.bird, id, "archive");
  assert.equal(a.status, 200);
  assert.equal(a.body.room.archived, true);
  assert.equal((await watcher.next((m) => m.type === "room")).change, "archived");
  const refused = await b.post(b.tokens.ana, id, { text: "more" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "room_archived");
  assert.equal((await b.req("GET", `/v1/rooms/${encodeURIComponent(id)}/posts`, { token: b.tokens.ana })).body.posts.length, 1);
  const html = await (await fetch(b.url + "/")).text();
  assert.match(html, /Archived<\/p>[\s\S]*web:commons:garden/);
  assert.match(await (await fetch(b.url + `/rooms/${id}`)).text(), /Archived/);
  assert.equal((await act(b, b.tokens.bird, id, "archive")).status, 200, "archiving twice is a no-op");
  const re = await act(b, b.tokens.fable, id, "reopen");
  assert.equal(re.body.room.archived, false);
  assert.equal((await watcher.next((m) => m.type === "room")).change, "reopened");
  assert.equal((await b.post(b.tokens.ana, id, { text: "more" })).status, 200);
});

test("caps: open rooms at once, and per being per day", async (t) => {
  const b = await makeBoard(t, { config: { ...DEFAULT_CONFIG, open_rooms: { max_open: 2, per_being_per_day: 2 } } });
  const a = (await open(b, b.tokens.fable, "One")).body.room.id;
  await open(b, b.tokens.bird, "Two");
  const full = await open(b, b.tokens.bird, "Three");
  assert.equal(full.status, 409);
  assert.equal(full.body.error, "too_many_rooms");
  await act(b, b.tokens.fable, a, "archive");
  assert.equal((await open(b, b.tokens.fable, "Three")).status, 201);
  // fable has opened 2 today: archived ones still count toward the day
  await act(b, b.tokens.fable, "web:commons:three", "archive");
  const quota = await open(b, b.tokens.fable, "Four");
  assert.equal(quota.status, 429);
  assert.equal(quota.body.error, "room_quota");
  // reopening is capped by open rooms too
  assert.equal((await open(b, b.tokens.bird, "Five")).status, 201);
  assert.equal((await act(b, b.tokens.fable, a, "reopen")).status, 409);
  b.clock.t += 86_400_001;
  await act(b, b.tokens.bird, "web:commons:five", "archive");
  assert.equal((await open(b, b.tokens.fable, "Four")).status, 201, "a day later the quota is back");
});

test("max_open 0 turns it off", async (t) => {
  const b = await makeBoard(t, { config: { ...DEFAULT_CONFIG, open_rooms: { max_open: 0 } } });
  const r = await open(b, b.tokens.fable, "Nope");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "rooms_closed");
});

test("over the WebSocket: open_room / close_room / reopen_room answered with the room", async (t) => {
  const b = await makeBoard(t);
  const seat = await b.ws(b.tokens.fable);
  await seat.next((m) => m.type === "hello");
  seat.send({ type: "open_room", title: "Tea", client_id: "c1" });
  const opened = await seat.next((m) => m.type === "room_opened");
  assert.equal(opened.client_id, "c1");
  assert.equal(opened.room.id, "web:commons:tea");
  seat.send({ type: "close_room", room: "web:commons:tea", client_id: "c2" });
  assert.equal((await seat.next((m) => m.type === "room_closed")).room.archived, true);
  seat.send({ type: "reopen_room", room: "web:commons:tea", client_id: "c3" });
  assert.equal((await seat.next((m) => m.type === "room_reopened")).room.archived, false);
  const helper = await b.ws(b.tokens.helper);
  await helper.next((m) => m.type === "hello");
  helper.send({ type: "open_room", title: "Mine", client_id: "c4" });
  assert.equal((await helper.next((m) => m.type === "error")).code, "forbidden");
});

test("opened and archived rooms survive a restart", async (t) => {
  const { startBoard } = await import("../src/server.mjs");
  const b = await makeBoard(t);
  const id = (await open(b, b.tokens.fable, "Kept")).body.room.id;
  const gone = (await open(b, b.tokens.fable, "Shut")).body.room.id;
  await act(b, b.tokens.fable, gone, "archive");
  await b.close();
  const again = await startBoard({ dataDir: b.dataDir, port: 0, host: "127.0.0.1", publicUrl: "https://board.example", now: () => b.clock.t, env: {} });
  t.after(() => again.close());
  const r = await fetch(again.url + "/v1/rooms", { headers: { authorization: `Bearer ${b.tokens.ana}` } });
  const rooms = (await r.json()).rooms;
  assert.equal(rooms.find((x) => x.id === id)?.archived, false);
  assert.equal(rooms.find((x) => x.id === gone)?.archived, true);
});

test("the being that archived a room gets a short window for its closing words; nobody else does", async (t) => {
  const b = await makeBoard(t);
  const id = (await open(b, b.tokens.fable, "Wrap")).body.room.id;
  await act(b, b.tokens.fable, id, "archive");
  assert.equal((await b.post(b.tokens.fable, id, { text: "closing this, thanks all" })).status, 200);
  assert.equal((await b.post(b.tokens.bird, id, { text: "me too" })).status, 403, "another being is not the closer");
  b.clock.t += 121_000;
  assert.equal((await b.post(b.tokens.fable, id, { text: "late" })).status, 403);
});
