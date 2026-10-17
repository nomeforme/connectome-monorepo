// @ts-check
/**
 * The board's domain operations, shared by the HTTP routes, the WebSocket
 * hub and the public read MCP: rooms, posting (validation, rate limit,
 * mentions), paging, threads, search, retention.
 */
import { EventEmitter } from "node:events";
import { resolveMentions } from "./mentions.mjs";
import { createRateLimiter } from "./ratelimit.mjs";

export const MAX_TEXT = 8000;
export const MAX_EXPLICIT_MENTIONS = 50;

export class BoardError extends Error {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    machine code (also the WS error code)
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * @param {{store: import("./store.mjs").Store, auth: import("./auth.mjs").Auth,
 *   config: import("./config.mjs").BoardConfig, now?: () => number}} deps
 */
export function createBoard({ store, auth, config, now = Date.now }) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const limiter = createRateLimiter(config.rate, now);

  /** @type {Map<string, import("./store.mjs").Room>} */
  const rooms = new Map();
  const nowIso = new Date(now()).toISOString();
  for (const r of config.rooms) rooms.set(r.id, store.syncRoom(r, nowIso));
  const exposed = new Set(config.expose);

  /** @param {string} id */
  function roomOrThrow(id) {
    const r = rooms.get(id);
    if (!r) throw new BoardError(404, "not_found", `no room ${id}`);
    return r;
  }

  /** @param {unknown} v @param {number} dflt @param {number} max */
  function parseLimit(v, dflt, max) {
    if (v === undefined || v === null || v === "") return dflt;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new BoardError(400, "bad_request", `limit must be an integer 1..${max}`);
    return n;
  }

  return {
    events,
    config,

    /** v0: every configured room is visible to every principal with read. */
    listRooms() {
      return [...rooms.values()];
    },

    /** @param {string} id */
    getRoom(id) {
      return rooms.get(id) ?? null;
    },

    /** @param {string} id */
    isExposed(id) {
      return exposed.has(id) && rooms.has(id);
    },

    exposedRooms() {
      return [...rooms.values()].filter((r) => exposed.has(r.id));
    },

    /**
     * @param {import("./auth.mjs").Principal} principal
     * @param {string} roomId
     * @param {any} body  {text, reply_to?, mentions?}
     * @returns {import("./store.mjs").Post}
     */
    post(principal, roomId, body) {
      roomOrThrow(roomId);
      if (!body || typeof body !== "object") throw new BoardError(400, "bad_request", "body must be an object");
      const { text, reply_to = null, mentions } = body;
      if (typeof text !== "string" || !text.trim()) throw new BoardError(400, "bad_request", "text must be a non-empty string");
      if (text.length > MAX_TEXT) throw new BoardError(400, "text_too_long", `text exceeds ${MAX_TEXT} chars`);
      if (reply_to !== null && typeof reply_to !== "string") throw new BoardError(400, "bad_request", "reply_to must be a post id");
      if (mentions !== undefined &&
        (!Array.isArray(mentions) || mentions.length > MAX_EXPLICIT_MENTIONS || !mentions.every((m) => typeof m === "string"))) {
        throw new BoardError(400, "bad_request", `mentions must be an array of at most ${MAX_EXPLICIT_MENTIONS} principal ids`);
      }
      if (reply_to) {
        const parent = store.getPost(reply_to);
        if (!parent || parent.room !== roomId) throw new BoardError(400, "bad_reply_to", `no post ${reply_to} in ${roomId}`);
      }
      const rl = limiter.take(principal);
      if (!rl.ok) {
        throw new BoardError(429, "rate_limited", `rate limit: ${config.rate[principal.kind]} posts/min for ${principal.kind}`,
          { retry_after_s: rl.retry_after_s });
      }
      const post = store.insertPost({
        room: roomId,
        author: { id: principal.id, kind: principal.kind, display: principal.display },
        text,
        reply_to,
        mentions: resolveMentions(text, mentions, auth.principals()),
        ts: now(),
      });
      events.emit("post", post);
      return post;
    },

    /** @param {string} roomId @param {{before?: unknown, limit?: unknown}} q @param {number} [maxLimit] */
    page(roomId, q, maxLimit = 100) {
      roomOrThrow(roomId);
      const before = q.before === undefined || q.before === null || q.before === "" ? null : q.before;
      if (before !== null && typeof before !== "string") throw new BoardError(400, "bad_request", "before must be a post id");
      return store.page(roomId, { before, limit: parseLimit(q.limit, 50, maxLimit) });
    },

    /** @param {string} postId */
    thread(postId) {
      const t = store.thread(postId);
      if (!t || !rooms.has(t.root.room)) throw new BoardError(404, "not_found", `no post ${postId}`);
      return t;
    },

    /**
     * @param {{q: unknown, room?: unknown, limit?: unknown}} params
     * @param {string[]} [scope]  rooms searched when no room is named (default: all)
     */
    search({ q, room, limit }, scope) {
      if (typeof q !== "string" || q.trim().length < 2 || q.length > 200) {
        throw new BoardError(400, "bad_request", "q must be 2..200 chars");
      }
      const n = parseLimit(limit, 10, 20);
      let searchRooms = scope ?? [...rooms.keys()];
      if (room !== undefined && room !== null && room !== "") {
        if (typeof room !== "string" || !searchRooms.includes(room)) throw new BoardError(404, "not_found", `no room ${room}`);
        searchRooms = [room];
      }
      return store.search({ query: q.trim(), rooms: searchRooms, limit: n });
    },

    /** @param {string} roomId */
    roomStats(roomId) {
      return store.roomStats(roomId);
    },

    /** Delete posts past retention. @returns {number} */
    prune() {
      return store.prune(now() - config.retention_days * 86_400_000);
    },

    sweep() {
      limiter.sweep();
    },
  };
}

/** @typedef {ReturnType<typeof createBoard>} Board */
