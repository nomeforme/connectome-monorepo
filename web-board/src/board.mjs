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
 *
 * Rooms: the configured ones (board.config.json), plus rooms the board's
 * own beings open on demand (`openRoom`): stored, public and exposed at
 * once, capped (config `open_rooms`). A being can archive one it or
 * another being opened (`archiveRoom`): no new posts, history still
 * served, reopenable. Configured rooms are the operator's: never archived
 * here. Every change emits `room` (the WS hub tells every socket) and goes
 * to the moderation log.
 */
import { EventEmitter } from "node:events";
import { resolveMentions } from "./mentions.mjs";
import { createRateLimiter } from "./ratelimit.mjs";
import { HIDE_EMOJI } from "./store.mjs";

export const MAX_TEXT = 8000;
export const MAX_EXPLICIT_MENTIONS = 50;
export const MAX_EMOJI = 32;
export const MAX_REASON = 500;
export const MIN_ROOM_TITLE = 2;
export const MAX_ROOM_TITLE = 60;
const DAY_MS = 86_400_000;
/** the being that archived a room may still post in it this long after:
 * a turn often closes the room and then says so, and its words reach the
 * board a moment after the close */
export const CLOSING_WORDS_MS = 120_000;

/** a room title → the slug half of its id: lowercase ascii words joined by
 * `-`, at most 40 chars; "room" when nothing is left. @param {string} title */
export function slugFor(title) {
  const s = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= 40) return s || "room";
  // cut at a word boundary when one is reasonably close, never mid-word
  const cut = s.slice(0, 41).lastIndexOf("-");
  return (cut >= 15 ? s.slice(0, cut) : s.slice(0, 40)).replace(/-+$/g, "") || "room";
}
/** a partner's opaque per-user id */
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
  // a hidden room is archived (config.mjs): left out of the board entirely,
  // so every lookup below 404s it, while its posts stay in the store
  for (const r of config.rooms) if (!r.hidden) rooms.set(r.id, store.syncRoom(r, nowIso));
  const exposed = new Set(config.expose.filter((id) => rooms.has(id)));
  // rooms beings opened: always public and exposed, archived ones included
  for (const r of store.beingRooms()) {
    if (rooms.has(r.id)) continue; // a configured room of the same id wins
    rooms.set(r.id, r);
    exposed.add(r.id);
  }

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

  /** only the board's own beings open and archive rooms @param {import("./auth.mjs").Principal} principal */
  function requireBeing(principal) {
    if (principal.kind !== "being") throw new BoardError(403, "forbidden", "only the board's own beings open and close rooms");
  }

  /** a room a being opened, or a 403/404 @param {unknown} id */
  function beingRoomOrThrow(id) {
    const r = typeof id === "string" ? rooms.get(id) : null;
    if (!r) throw new BoardError(404, "not_found", `no room ${String(id)}`);
    if (r.origin !== "being") throw new BoardError(403, "configured_room", `${r.id} is one of the board's configured rooms; only the operator closes it`);
    return r;
  }

  const openBeingRooms = () => [...rooms.values()].filter((r) => r.origin === "being" && !r.archived).length;

  /** @param {import("./store.mjs").Room} room @param {"opened"|"archived"|"reopened"} change @param {import("./auth.mjs").Principal} principal */
  function announceRoom(room, change, principal) {
    store.log({ post_id: "", room: room.id, kind: `room_${change}`, actor: principal.id }, iso());
    events.emit("room", { room, change, by: { id: principal.id, kind: principal.kind, display: principal.display } });
  }

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


  /** the board's terms pointer as clients see it, or null */
  const termsView = () => {
    const t = config.terms;
    return t ? { url: t.url, version: t.version, summary: t.summary } : null;
  };
  /** @param {import("./auth.mjs").Principal} principal */
  const needsTerms = (principal) => {
    const t = config.terms;
    return !!t && t.required_for.includes(principal.kind) && !store.hasAcceptedTerms(principal.id, t.version);
  };

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

    /** the board's terms pointer as clients see it, or null @returns {{url: string, version: string, summary: string}|null} */
    terms: termsView,
    /** true while this principal's kind must accept the current terms and has not
     * @param {import("./auth.mjs").Principal} principal */
    needsTerms,
    /** accept the current terms; a stale or unknown version is refused so a
     * client never accepts terms it was not shown
     * @param {import("./auth.mjs").Principal} principal @param {unknown} version */
    acceptTerms(principal, version) {
      const t = config.terms;
      if (!t) throw new BoardError(404, "no_terms", "this board has no terms to accept");
      if (version !== t.version) throw new BoardError(409, "terms_version", `the current terms are version ${t.version}`, { terms: termsView() });
      store.acceptTerms(principal.id, t.version, new Date(now()).toISOString());
      return { accepted: true, version: t.version };
    },

    /**
     * @param {import("./auth.mjs").Principal} principal
     * @param {string} roomId
     * @param {any} body  {text, reply_to?, mentions?}
     * @returns {import("./store.mjs").Post}
     */
    post(principal, roomId, body) {
      const target = roomOrThrow(roomId);
      if (needsTerms(principal)) {
        const t = /** @type {NonNullable<typeof config.terms>} */ (config.terms);
        throw new BoardError(403, "terms_required",
          `accept this board's terms (version ${t.version}, ${t.url}) before posting: send accept_terms with that version`,
          { terms: termsView() });
      }
      const closingWords = target.archived && target.archived_by === principal.id &&
        now() - Date.parse(String(target.archived_at)) <= CLOSING_WORDS_MS;
      if (target.archived && !closingWords)
        throw new BoardError(403, "room_archived", `${roomId} is archived: its history stays readable, but it takes no new posts`);
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

    /**
     * A being opens a room: public and exposed at once.
     * @param {import("./auth.mjs").Principal} principal @param {any} body {title}
     * @returns {import("./store.mjs").Room}
     */
    openRoom(principal, body) {
      requireBeing(principal);
      const raw = body && typeof body === "object" ? body.title : undefined;
      const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
      if (title.length < MIN_ROOM_TITLE || title.length > MAX_ROOM_TITLE || /\p{Cc}/u.test(title))
        throw new BoardError(400, "bad_request", `title must be ${MIN_ROOM_TITLE}..${MAX_ROOM_TITLE} chars`);
      const cap = config.open_rooms;
      if (cap.max_open === 0) throw new BoardError(403, "rooms_closed", "this board does not let beings open rooms");
      if (openBeingRooms() >= cap.max_open)
        throw new BoardError(409, "too_many_rooms", `${cap.max_open} rooms opened by beings are already open; archive one first`, { max_open: cap.max_open });
      if (store.roomsOpenedSince(principal.id, new Date(now() - DAY_MS).toISOString()) >= cap.per_being_per_day)
        throw new BoardError(429, "room_quota", `you can open ${cap.per_being_per_day} rooms a day`, { per_being_per_day: cap.per_being_per_day });
      const base = `web:${cap.community}:${slugFor(title)}`;
      let id = base;
      for (let n = 2; rooms.has(id) || store.roomExists(id); n++) id = `${base}-${n}`;
      const room = store.createBeingRoom({ id, title, community: cap.community, created_by: principal.id }, iso());
      rooms.set(id, room);
      exposed.add(id);
      announceRoom(room, "opened", principal);
      return room;
    },

    /** A being archives a room a being opened. Idempotent. @param {import("./auth.mjs").Principal} principal @param {unknown} roomId */
    archiveRoom(principal, roomId) {
      requireBeing(principal);
      const r = beingRoomOrThrow(roomId);
      if (r.archived) return r;
      const room = store.setArchived(r.id, principal.id, iso());
      rooms.set(room.id, room);
      announceRoom(room, "archived", principal);
      return room;
    },

    /** A being reopens an archived room, within the open cap. Idempotent. @param {import("./auth.mjs").Principal} principal @param {unknown} roomId */
    reopenRoom(principal, roomId) {
      requireBeing(principal);
      const r = beingRoomOrThrow(roomId);
      if (!r.archived) return r;
      const cap = config.open_rooms;
      if (openBeingRooms() >= cap.max_open)
        throw new BoardError(409, "too_many_rooms", `${cap.max_open} rooms opened by beings are already open; archive one first`, { max_open: cap.max_open });
      const room = store.setArchived(r.id, null, iso());
      rooms.set(room.id, room);
      announceRoom(room, "reopened", principal);
      return room;
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
