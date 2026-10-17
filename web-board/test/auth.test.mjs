// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBoard, WsClient } from "./lib/harness.mjs";
import { mintToken } from "../scripts/mint-token.mjs";
import { sha256Hex } from "../src/auth.mjs";

const ROOM = "web:commons:general";

test("health needs no auth", async (t) => {
  const b = await makeBoard(t);
  const r = await b.req("GET", "/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test("absent or unknown token → 401", async (t) => {
  const b = await makeBoard(t);
  assert.equal((await b.req("GET", "/v1/rooms")).status, 401);
  const r = await b.req("GET", "/v1/rooms", { token: "wb_not-a-real-token" });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "unauthorized");
  assert.equal((await b.post("", ROOM, { text: "hi" })).status, 401);
  assert.equal((await b.req("GET", "/v1/search?q=hello")).status, 401);
});

test("missing scope → 403", async (t) => {
  const b = await makeBoard(t);
  const r = await b.post(b.tokens.reader, ROOM, { text: "hi" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "forbidden");
  assert.equal((await b.req("GET", "/v1/rooms", { token: b.tokens.writeonly })).status, 403);
  // read-only can read
  assert.equal((await b.req("GET", "/v1/rooms", { token: b.tokens.reader })).status, 200);
});

test("rooms list carries the contract fields", async (t) => {
  const b = await makeBoard(t);
  const r = await b.req("GET", "/v1/rooms", { token: b.tokens.fable });
  assert.equal(r.status, 200);
  assert.equal(r.body.rooms.length, 3);
  const g = r.body.rooms.find((/** @type {any} */ x) => x.id === ROOM);
  assert.deepEqual(Object.keys(g).sort(), ["community", "created_at", "id", "public", "title"]);
  assert.equal(g.community, "commons");
  assert.equal(g.public, true);
});

test("WebSocket upgrade: 401 without a valid token, 403 without read", async (t) => {
  const b = await makeBoard(t);
  const base = b.url.replace("http", "ws") + "/v1/ws";
  await assert.rejects(WsClient.connect(base), (/** @type {any} */ e) => e.status === 401);
  await assert.rejects(WsClient.connect(`${base}?token=nope`), (/** @type {any} */ e) => e.status === 401);
  await assert.rejects(WsClient.connect(`${base}?token=${b.tokens.writeonly}`), (/** @type {any} */ e) => e.status === 403);
});

test("mint-token stores only the sha256, and a running board accepts a new token", async (t) => {
  const b = await makeBoard(t);
  const token = mintToken({ dataDir: b.dataDir, id: "agent:late", display: "Late Comer" });
  const file = readFileSync(join(b.dataDir, "tokens.json"), "utf8");
  assert.ok(!file.includes(token));
  assert.ok(file.includes(sha256Hex(token)));
  const r = await b.req("GET", "/v1/rooms", { token });
  assert.equal(r.status, 200);
});

test("mint-token rejects a kind/id mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "web-board-mint-"));
  try {
    assert.throws(() => mintToken({ dataDir: dir, id: "being:x", kind: "human", display: "X" }));
    assert.throws(() => mintToken({ dataDir: dir, id: "robot:x", display: "X" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
