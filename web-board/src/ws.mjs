// @ts-check
/**
 * WebSocket hub at `/v1/ws?token=<token>`. The token is checked on the
 * upgrade: unknown/absent → HTTP 401, no `read` scope → HTTP 403 (the
 * socket is never opened). Posting and typing need the `post` scope;
 * without it the client gets `{type:"error", code:"forbidden"}`.
 *
 * Every new post (from HTTP or WS) goes to every socket subscribed to its
 * room — the sender's own included, so a seat sees its echo.
 *
 * Moderation: `react` / `flag` need the `post` scope (answered `reacted` /
 * `flagged` with the request's client_id); every reaction is broadcast as
 * `reaction`, and a post leaving or returning to view as `hidden` /
 * `unhidden` — to every socket subscribed to its room. `history` never
 * carries a hidden post.
 */
import { WebSocketServer } from "ws";
import { BoardError } from "./board.mjs";

export const PING_INTERVAL_MS = 30_000;
export const MAX_WS_MESSAGE = 64 * 1024;
const TYPING_MIN_INTERVAL_MS = 3_000;

/**
 * @param {{board: import("./board.mjs").Board, auth: import("./auth.mjs").Auth, pingIntervalMs?: number}} deps
 */
export function createWsHub({ board, auth, pingIntervalMs = PING_INTERVAL_MS }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE });

  /**
   * @typedef {{ws: import("ws").WebSocket, principal: import("./auth.mjs").Principal,
   *   rooms: Set<string>, all: boolean, alive: boolean, typingAt: Map<string, number>}} Client
   */
  /** @type {Set<Client>} */
  const clients = new Set();

  /** @param {Client} c @param {unknown} msg */
  function send(c, msg) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  /** @param {Client} c @param {string} room */
  const subscribed = (c, room) => c.all || c.rooms.has(room);

  /** @param {import("./store.mjs").Post} post */
  function onPost(post) {
    for (const c of clients) if (subscribed(c, post.room)) send(c, { type: "post", post });
  }
  board.events.on("post", onPost);

  /** @param {{room: string}} ev @param {string} type @param {(ev: any) => object} shape */
  const fanout = (type, shape) => (/** @type {any} */ ev) => {
    for (const c of clients) if (subscribed(c, ev.room)) send(c, { type, ...shape(ev) });
  };
  const onReaction = fanout("reaction", (ev) => ev);
  const onHidden = fanout("hidden", (ev) => ({
    post_id: ev.post_id, room: ev.room, cause: ev.cause, flags: ev.flags, author: ev.author,
  }));
  const onUnhidden = fanout("unhidden", (ev) => ({ post_id: ev.post_id, room: ev.room }));
  board.events.on("reaction", onReaction);
  board.events.on("hidden", onHidden);
  board.events.on("unhidden", onUnhidden);

  /** @param {Client} c @param {BoardError|Error} err @param {Record<string, unknown>} [ids] */
  function sendError(c, err, ids = {}) {
    if (err instanceof BoardError) send(c, { type: "error", code: err.code, message: err.message, ...err.extra, ...ids });
    else {
      console.error("[web-board] ws error:", err);
      send(c, { type: "error", code: "internal", message: "internal error", ...ids });
    }
  }

  /** @param {Client} c @param {string} cap */
  function requireScope(c, cap) {
    if (!c.principal.scopes.includes(cap)) throw new BoardError(403, "forbidden", `token lacks scope ${cap}`);
  }

  /** @param {Client} c @param {any} msg */
  function handleMessage(c, msg) {
    /** @type {Record<string, unknown>} */
    const ids = {};
    if (msg && typeof msg === "object") {
      if (msg.client_id !== undefined) ids.client_id = msg.client_id;
      if (msg.req_id !== undefined) ids.req_id = msg.req_id;
    }
    try {
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        throw new BoardError(400, "bad_request", "message must be an object with a type");
      }
      switch (msg.type) {
        case "subscribe": {
          if (msg.rooms === "*") {
            c.all = true;
            return;
          }
          if (!Array.isArray(msg.rooms)) throw new BoardError(400, "bad_request", 'rooms must be an array of room ids or "*"');
          const unknown = [];
          for (const r of msg.rooms) {
            if (typeof r === "string" && board.getRoom(r)) c.rooms.add(r);
            else unknown.push(r);
          }
          if (unknown.length) throw new BoardError(404, "not_found", `no room(s): ${unknown.map(String).join(", ")}`);
          return;
        }
        case "post": {
          requireScope(c, "post");
          if (typeof msg.room !== "string") throw new BoardError(400, "bad_request", "room required");
          const post = board.post(c.principal, msg.room, { text: msg.text, reply_to: msg.reply_to ?? null, mentions: msg.mentions });
          send(c, { type: "ack", client_id: msg.client_id ?? null, post });
          return;
        }
        case "typing": {
          requireScope(c, "post");
          if (typeof msg.room !== "string" || !board.getRoom(msg.room)) throw new BoardError(404, "not_found", `no room ${msg.room}`);
          const t = Date.now();
          if (t - (c.typingAt.get(msg.room) ?? 0) < TYPING_MIN_INTERVAL_MS) return;
          c.typingAt.set(msg.room, t);
          const author = { id: c.principal.id, kind: c.principal.kind, display: c.principal.display };
          for (const o of clients) if (o !== c && subscribed(o, msg.room)) send(o, { type: "typing", room: msg.room, author });
          return;
        }
        case "react": {
          requireScope(c, "post");
          const r = board.react(c.principal, msg.post_id, { emoji: msg.emoji, remove: msg.remove ?? false });
          send(c, { type: "reacted", client_id: msg.client_id ?? null, ...r });
          return;
        }
        case "flag": {
          requireScope(c, "post");
          const r = board.flag(c.principal.id, msg.post_id, msg.reason === undefined ? undefined : { reason: msg.reason });
          send(c, { type: "flagged", client_id: msg.client_id ?? null, ...r });
          return;
        }
        case "history": {
          if (typeof msg.room !== "string") throw new BoardError(400, "bad_request", "room required");
          const page = board.page(msg.room, { before: msg.before, limit: msg.limit });
          send(c, { type: "history", req_id: msg.req_id ?? null, room: msg.room, posts: page.posts, next_before: page.next_before });
          return;
        }
        default:
          throw new BoardError(400, "bad_request", `unknown type ${msg.type}`);
      }
    } catch (err) {
      sendError(c, /** @type {Error} */ (err), ids);
    }
  }

  wss.on("connection", (/** @type {import("ws").WebSocket} */ ws, /** @type {import("./auth.mjs").Principal} */ principal) => {
    /** @type {Client} */
    const c = { ws, principal, rooms: new Set(), all: false, alive: true, typingAt: new Map() };
    clients.add(c);
    ws.on("pong", () => { c.alive = true; });
    ws.on("close", () => clients.delete(c));
    ws.on("error", () => clients.delete(c));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendError(c, new BoardError(400, "bad_request", "text frames only"));
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return sendError(c, new BoardError(400, "bad_json", "message is not valid JSON"));
      }
      handleMessage(c, msg);
    });
    send(c, {
      type: "hello",
      principal: { id: principal.id, kind: principal.kind, display: principal.display },
      rooms: board.listRooms(),
    });
  });

  const pinger = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        clients.delete(c);
        continue;
      }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing */ }
    }
  }, pingIntervalMs);
  pinger.unref();

  return {
    /**
     * Handle an HTTP upgrade for /v1/ws.
     * @param {import("node:http").IncomingMessage} req @param {import("node:stream").Duplex} socket @param {Buffer} head
     */
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? "/", "http://board.invalid");
      /** @param {number} status @param {string} text */
      const reject = (status, text) => {
        socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
      };
      if (url.pathname !== "/v1/ws") return reject(404, "Not Found");
      const principal = auth.lookup(url.searchParams.get("token"));
      if (!principal) return reject(401, "Unauthorized");
      if (!principal.scopes.includes("read")) return reject(403, "Forbidden");
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, principal));
    },

    clientCount() {
      return clients.size;
    },

    close() {
      clearInterval(pinger);
      board.events.off("post", onPost);
      board.events.off("reaction", onReaction);
      board.events.off("hidden", onHidden);
      board.events.off("unhidden", onUnhidden);
      for (const c of clients) c.ws.terminate();
      clients.clear();
      wss.close();
    },
  };
}
