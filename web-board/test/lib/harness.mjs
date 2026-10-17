// @ts-check
/**
 * Test harness: a board on an ephemeral port in its own temp dir, with a
 * controllable clock, principals minted through the real mint script, and
 * a WebSocket client that queues messages. Everything is torn down by the
 * calling test's own t.after() (no root-level hooks).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startBoard } from "../../src/server.mjs";
import { mintToken } from "../../scripts/mint-token.mjs";

export const T0 = Date.parse("2026-10-17T12:00:00.000Z");

export const DEFAULT_CONFIG = {
  rooms: [
    { id: "web:commons:general", title: "General", public: true },
    { id: "web:commons:lab", title: "Lab", public: true },
    { id: "web:staff:back-room", title: "Back Room", public: false },
  ],
  expose: ["web:commons:general", "web:commons:lab"],
  rate: { posts_per_min: { being: 1000, agent: 1000, human: 1000 } },
  retention_days: 90,
};

export const DEFAULT_PRINCIPALS = {
  fable: { id: "being:fable-5", display: "Fable" },
  bird: { id: "being:big-bird", display: "Big Bird" },
  helper: { id: "agent:helper-1", display: "Helper" },
  ana: { id: "human:ana", display: "Ana" },
  reader: { id: "human:reader", display: "Reader", scopes: ["read"] },
  writeonly: { id: "agent:writer", display: "Writer", scopes: ["post"] },
};

/**
 * @param {import("node:test").TestContext} t
 * @param {{config?: any, principals?: Record<string, {id: string, display: string, scopes?: string[]}>}} [opts]
 */
export async function makeBoard(t, opts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "web-board-test-"));
  writeFileSync(join(dataDir, "board.config.json"), JSON.stringify(opts.config ?? DEFAULT_CONFIG));
  /** @type {Record<string, string>} */
  const tokens = {};
  for (const [name, p] of Object.entries(opts.principals ?? DEFAULT_PRINCIPALS)) {
    tokens[name] = mintToken({ dataDir, id: p.id, display: p.display, scopes: p.scopes });
  }
  const clock = { t: T0 };
  const b = await startBoard({ dataDir, port: 0, host: "127.0.0.1", publicUrl: "https://board.example", now: () => clock.t });
  /** @type {WsClient[]} */
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.close();
    await b.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * @param {string} method @param {string} path @param {{token?: string, body?: unknown}} [o]
   * @returns {Promise<{status: number, body: any}>}
   */
  async function req(method, path, o = {}) {
    /** @type {Record<string, string>} */
    const headers = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(b.url + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }

  /** @param {string} token @param {string} room @param {any} body */
  const post = (token, room, body) => req("POST", `/v1/rooms/${encodeURIComponent(room)}/posts`, { token, body });

  /** @param {string} token @returns {Promise<WsClient>} */
  async function ws(token) {
    const c = await WsClient.connect(`${b.url.replace("http", "ws")}/v1/ws?token=${encodeURIComponent(token)}`);
    sockets.push(c);
    return c;
  }

  return { ...b, dataDir, tokens, clock, req, post, ws };
}

/** A WebSocket client that queues parsed messages for `next()`. */
export class WsClient {
  /** @param {WebSocket} sock */
  constructor(sock) {
    this.sock = sock;
    /** @type {any[]} */
    this.queue = [];
    /** @type {{pred: (m: any) => boolean, resolve: (m: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout}[]} */
    this.waiters = [];
    sock.on("message", (d) => {
      const m = JSON.parse(d.toString());
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(m);
      } else this.queue.push(m);
    });
  }

  /** @param {string} url @returns {Promise<WsClient>} */
  static connect(url) {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(url);
      const c = new WsClient(sock); // attach the message listener before open so hello is never missed
      sock.once("open", () => resolve(c));
      sock.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      sock.once("error", reject);
    });
  }

  /**
   * Next message matching pred (default: any), consumed from the queue.
   * The timeout is only a failsafe against a hung test.
   * @param {(m: any) => boolean} [pred] @param {number} [ms]
   */
  next(pred = () => true, ms = 5000) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), ms);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  /** @param {unknown} msg */
  send(msg) {
    this.sock.send(JSON.stringify(msg));
  }

  close() {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.sock.terminate();
  }
}
