// @ts-check
/**
 * The board's domain operations, shared by the HTTP routes, the WebSocket
 * hub and the public read MCP: rooms, posting (validation, rate limit,
 * mentions), paging, threads, search, retention, and moderation (🫥
 * reactions, flags with a threshold, a moderator's unhide).
 *
 * Visibility: a post is hidden while at least one 🫥 stands on it OR its
 * uncleared flags reach `moderation.flag_threshold`. Every transition
 * emits `hidden` / `unhidden` (the WS hub broadcasts them) and is written
 * to the moderation log — never with the post's text.
 */
import { EventEmitter } from "node:events";
import { resolveMentions } from "./mentions.mjs";
import { createRateLimiter } from "./ratelimit.mjs";
import { HIDE_EMOJI } from "./store.mjs";

export const MAX_TEXT = 8000;
export const MAX_EXPLICIT_MENTIONS = 50;
export const MAX_EMOJI = 32;
export const MAX_REASON = 500;
/** a partner's opaque per-villager id */
export const FLAGGER_ID_RE = /^[\x21-\x7e]{8,128}$/;

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

  const iso = () => new Date(now()).toISOString();

  /** any post the board holds (hidden ones included — a 🫥 must be removable) @param {unknown} id */
  function postOrThrow(id) {
    const post = typeof id === "string" ? store.getPost(id) : null;
    if (!post || !rooms.has(post.room)) throw new BoardError(404, "not_found", `no post ${String(id)}`);
    return post;
  }

  /** @param {string} id */
  const isHidden = (id) => !!store.visibility(id)?.hidden;

  /** @param {any} body @returns {string|null} */
  function parseReason(body) {
    if (body === undefined || body === null) return null;
    if (typeof body !== "object") throw new BoardError(400, "bad_request", "body must be an object");
    const r = body.reason;
    if (r === undefined || r === null) return null;
    if (typeof r !== "string" || r.length > MAX_REASON) throw new BoardError(400, "bad_request", `reason must be a string of at most ${MAX_REASON} chars`);
    return r.trim() || null;
  }

  /**
   * Recompute a post's visibility after a moderation act; emit and log a
   * transition. `trigger` names what just happened ("reaction" | "flags" |
   * "moderator"), `actor` who did it.
   * @param {import("./store.mjs").Post} post @param {string} trigger @param {string} actor
   */
  function settle(post, trigger, actor) {
    const hides = store.reactionCounts(post.id)[HIDE_EMOJI] ?? 0;
    const flags = store.activeFlags(post.id);
    const byFlags = flags >= config.moderation.flag_threshold;
    const should = hides > 0 || byFlags;
    const vis = store.visibility(post.id);
    if (!vis) return;
    const cause = byFlags && (trigger === "flags" || hides === 0) ? "flags" : "reaction";
    if (should && !vis.hidden) {
      store.setHidden(post.id, true, cause);
      store.log({ post_id: post.id, room: post.room, kind: "hide", actor, reason: cause }, iso());
      events.emit("hidden", { post_id: post.id, room: post.room, cause, flags, author: { ...post.author } });
    } else if (!should && vis.hidden) {
      store.setHidden(post.id, false, null);
      // a moderator's unhide is already logged as their own act
      if (trigger !== "moderator") store.log({ post_id: post.id, room: post.room, kind: "unhide", actor, reason: trigger }, iso());
      events.emit("unhidden", { post_id: post.id, room: post.room });
    } else if (should && vis.cause !== cause && !(trigger === "reaction" && vis.cause === "flags" && byFlags)) {
      store.setHidden(post.id, true, cause); // still hidden; what keeps it hidden changed
    }
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
        const parent = store.getVisiblePost(reply_to);
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

    /** @param {string} roomId @param {{before?: unknown, limit?: unknown}} q @param {number} [maxLimit]
     * @param {boolean} [includeHidden] the human archive: hidden posts kept, marked */
    page(roomId, q, maxLimit = 100, includeHidden = false) {
      roomOrThrow(roomId);
      const before = q.before === undefined || q.before === null || q.before === "" ? null : q.before;
      if (before !== null && typeof before !== "string") throw new BoardError(400, "bad_request", "before must be a post id");
      return store.page(roomId, { before, limit: parseLimit(q.limit, 50, maxLimit), includeHidden });
    },

    /** @param {string} postId @param {boolean} [includeHidden] the human archive */
    thread(postId, includeHidden = false) {
      const t = store.thread(postId, 1000, includeHidden);
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

    /**
     * Add or remove one reaction. 🫥 hides the post while any stands.
     * @param {import("./auth.mjs").Principal} principal
     * @param {string} postId @param {any} body {emoji, remove?}
     */
    react(principal, postId, body) {
      if (!body || typeof body !== "object") throw new BoardError(400, "bad_request", "body must be an object");
      const { emoji, remove = false } = body;
      if (typeof emoji !== "string" || !emoji || [...emoji].length > MAX_EMOJI || /[\s\p{Cc}]/u.test(emoji)) {
        throw new BoardError(400, "bad_request", `emoji must be a non-empty string of at most ${MAX_EMOJI} chars, no spaces`);
      }
      if (typeof remove !== "boolean") throw new BoardError(400, "bad_request", "remove must be a boolean");
      const post = postOrThrow(postId);
      const changed = store.react(post.id, principal.id, emoji, remove, iso());
      if (changed) {
        const by = { id: principal.id, kind: principal.kind, display: principal.display };
        events.emit("reaction", { post_id: post.id, room: post.room, emoji, remove, by });
        if (emoji === HIDE_EMOJI) {
          store.log({ post_id: post.id, room: post.room, kind: remove ? "unreact_hide" : "react_hide", actor: principal.id }, iso());
          settle(post, "reaction", principal.id);
        }
      }
      return { post_id: post.id, emoji, removed: remove, reactions: store.reactionCounts(post.id), hidden: isHidden(post.id) };
    },

    /**
     * One flag from a distinct flagger (a principal id, or
     * `partner:<name>:<flagger_id>`); a repeat is a no-op (`duplicate`).
     * @param {string} flagger dedupe key @param {string} postId @param {any} body {reason?}
     */
    flag(flagger, postId, body) {
      const reason = parseReason(body);
      const post = postOrThrow(postId);
      const added = store.addFlag(post.id, flagger, reason, iso());
      if (added) {
        store.log({ post_id: post.id, room: post.room, kind: "flag", actor: flagger, reason }, iso());
        settle(post, "flags", flagger);
      }
      return {
        post_id: post.id,
        duplicate: !added,
        flags: store.activeFlags(post.id),
        threshold: config.moderation.flag_threshold,
        hidden: isHidden(post.id),
      };
    },

    /**
     * A moderator's unhide: clears the post's flags (a cleared flagger
     * can't flag it again) and every 🫥 on it.
     * @param {import("./auth.mjs").Principal} principal @param {string} postId @param {any} body {reason?}
     */
    unhide(principal, postId, body) {
      const reason = parseReason(body);
      const post = postOrThrow(postId);
      const flags_cleared = store.clearFlags(post.id);
      const reactions_removed = store.clearHideReactions(post.id);
      store.log({ post_id: post.id, room: post.room, kind: "unhide", actor: principal.id, reason }, iso());
      settle(post, "moderator", principal.id);
      return { post_id: post.id, hidden: isHidden(post.id), flags_cleared, reactions_removed };
    },

    /** @param {unknown} limit */
    moderationLog(limit) {
      return store.moderationLog(parseLimit(limit, 50, 500));
    },

    /** @param {unknown} limit */
    hiddenPosts(limit) {
      return store.hiddenPosts(parseLimit(limit, 50, 500));
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
