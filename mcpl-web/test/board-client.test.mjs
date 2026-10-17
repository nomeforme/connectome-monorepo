// @ts-check
/* mcpl-web/test/board-client.test.mjs — the board client alone: the
 * reconnect backoff doubles from its floor and caps at its ceiling (a
 * stand-in WebSocket that closes on arrival, so no network and no clock
 * assumptions beyond "eventually"), a post with no socket fails at its
 * deadline instead of hanging, and the config reader names what is
 * missing by variable, never by value. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardClient } from "../src/board-client.mjs";
import { readConfig } from "../src/config.mjs";
import { waitFor } from "./lib/fake-board.mjs";

/** a WebSocket that refuses every connection: close right after construction */
class RefusingSocket extends EventTarget {
  constructor(url) {
    super();
    RefusingSocket.urls.push(url);
    queueMicrotask(() => {
      this.dispatchEvent(new Event("error"));
      const ev = new Event("close");
      Object.assign(ev, { code: 1006 });
      this.dispatchEvent(ev);
    });
  }
  send() {
    throw new Error("not open");
  }
  close() {}
}
/** @type {string[]} */
RefusingSocket.urls = [];

test("backoff doubles from the floor and caps at the ceiling", async (t) => {
  const waits = [];
  const client = createBoardClient({
    wsUrl: "ws://board.invalid/v1/ws",
    token: "tok-fixture",
    reconnectMinMs: 5,
    reconnectMaxMs: 40,
    log: (l) => {
      const m = /reconnecting in (\d+) ms/.exec(l);
      if (m) waits.push(Number(m[1]));
    },
    WebSocketImpl: /** @type {any} */ (RefusingSocket),
  });
  t.after(() => client.stop());
  client.start();
  await waitFor(() => waits.length >= 6);
  assert.deepEqual(waits.slice(0, 6), [5, 10, 20, 40, 40, 40]);
  assert.ok(RefusingSocket.urls.every((u) => u === "ws://board.invalid/v1/ws?token=tok-fixture"));
});

test("a post with no board connection rejects at its deadline", async (t) => {
  const client = createBoardClient({
    wsUrl: "ws://board.invalid/v1/ws",
    token: "tok-fixture",
    reconnectMinMs: 1000,
    sendTimeoutMs: 100,
    WebSocketImpl: /** @type {any} */ (RefusingSocket),
  });
  t.after(() => client.stop());
  client.start();
  await assert.rejects(client.post({ room: "web:commons:general", text: "x" }), /not connected/);
});

test("readConfig names a missing variable, derives the socket URL, and bounds the backoff", () => {
  assert.equal(readConfig({}), "WEB_BOARD_URL is not set");
  assert.equal(readConfig({ WEB_BOARD_URL: "http://board:8090" }), "WEB_BOARD_TOKEN is not set");
  assert.equal(readConfig({ WEB_BOARD_URL: "board:8090", WEB_BOARD_TOKEN: "t" }), "WEB_BOARD_URL must be an http(s) URL");
  const c = readConfig({ WEB_BOARD_URL: "https://board.example/", WEB_BOARD_TOKEN: "t" });
  assert.ok(typeof c !== "string");
  assert.equal(c.wsUrl, "wss://board.example/v1/ws");
  assert.equal(c.reconnectMinMs, 1000);
  assert.equal(c.reconnectMaxMs, 60_000);
  assert.equal(c.policyGraceMs, 20_000);
});
