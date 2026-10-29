// @ts-check
/* mcpl-web/src/board-client.mjs — the seat's one connection to the web
 * board: a WebSocket on `/v1/ws?token=` (Node's global WebSocket — no
 * dependency), reconnected forever with backoff 1 s → 60 s (doubling,
 * reset by a successful `hello`). Board → seat: `hello` (who this token
 * is, which rooms it sees — answered with `subscribe "*"`), `post`,
 * `ack`, `typing`, `error`, and an application-level `ping` (answered
 * `pong`; a WebSocket control ping is answered by the runtime itself).
 * Seat → board: `post` with a `client_id`, resolved by the matching
 * `ack` (or rejected by a matching `error`, the socket dropping, or the
 * send timeout), `react` / `flag` the same way (answered `reacted` /
 * `flagged`), and `typing`. Moderation from the board: `hidden` /
 * `unhidden` (a post left / returned to view) are handed on; `reaction`
 * frames are not (only the board's verdict matters to the house). A post made while the socket is down
 * waits for the next `hello`, inside the same timeout — never queued
 * past it, never retried after a drop (an unacked post may have landed;
 * resending could double it). The token rides only in the connect URL
 * and is never logged. */

/** the board's typing rate: one per room per connection every 3 s */
const TYPING_MIN_INTERVAL_MS = 3000;

/** @typedef {{id: string, kind: string, display: string}} Principal */
/** @typedef {{id: string, room: string, author: Principal, text: string,
 *   reply_to: string|null, mentions: string[], created_at: string, ts: number}} Post */

/**
 * @param {{wsUrl: string, token: string, log?: (line: string) => void,
 *   reconnectMinMs?: number, reconnectMaxMs?: number, sendTimeoutMs?: number,
 *   WebSocketImpl?: typeof WebSocket}} opts
 */
export function createBoardClient({
  wsUrl,
  token,
  log = () => {},
  reconnectMinMs = 1000,
  reconnectMaxMs = 60_000,
  sendTimeoutMs = 15_000,
  WebSocketImpl = globalThis.WebSocket,
}) {
  const state = {
    connected: false,
    ready: false,
    connects: 0,
    hellos: 0,
    backoffMs: reconnectMinMs,
    lastError: /** @type {string|null} */ (null),
  };
  /** @type {{hello: ((h: any) => void)[], post: ((p: Post) => void)[], typing: ((t: any) => void)[],
   *   hidden: ((h: any) => void)[], unhidden: ((h: any) => void)[]}} */
  const handlers = { hello: [], post: [], typing: [], hidden: [], unhidden: [], room: [] };
  /** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, expect: string}>} */
  const pending = new Map();
  /** @type {(() => void)[]} */
  let readyWaiters = [];
  /** @type {WebSocket|null} */
  let ws = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let reconnectTimer = null;
  let stopped = false;
  let seq = 0;
  /** @type {Map<string, number>} room → last typing sent on THIS connection */
  const typingAt = new Map();

  const emit = (kind, v) => {
    for (const fn of handlers[kind]) {
      try {
        fn(v);
      } catch (e) {
        log(`${kind} handler failed: ${e?.message ?? e}`);
      }
    }
  };

  function connect() {
    if (stopped) return;
    reconnectTimer = null;
    state.connects += 1;
    let sock;
    try {
      sock = new WebSocketImpl(`${wsUrl}?token=${encodeURIComponent(token)}`);
    } catch (e) {
      state.lastError = e?.message ?? String(e);
      log(`connect failed: ${state.lastError}`);
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.addEventListener("open", () => {
      if (ws !== sock) return;
      state.connected = true;
    });
    sock.addEventListener("message", (ev) => {
      if (ws !== sock) return;
      onFrame(sock, typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    });
    sock.addEventListener("error", () => {
      // the close event follows; the error itself carries nothing useful
      // (and must never be logged with the URL — it holds the token)
      if (ws === sock) state.lastError = "socket error";
    });
    sock.addEventListener("close", (ev) => {
      if (ws !== sock) return;
      ws = null;
      const wasReady = state.ready;
      state.connected = false;
      state.ready = false;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("the board connection dropped before the post was acknowledged"));
        pending.delete(id);
      }
      if (stopped) return;
      log(`board socket closed (code ${ev?.code ?? "?"})${wasReady ? "" : " before hello"} — reconnecting in ${state.backoffMs} ms`);
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const wait = state.backoffMs;
    state.backoffMs = Math.min(state.backoffMs * 2, reconnectMaxMs);
    reconnectTimer = setTimeout(connect, wait);
    reconnectTimer.unref?.();
  }

  function sendRaw(sock, obj) {
    try {
      sock.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      log(`send failed: ${e?.message ?? e}`);
      return false;
    }
  }

  /** @param {WebSocket} sock @param {string} raw */
  function onFrame(sock, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log("non-JSON frame from the board — ignored");
      return;
    }
    switch (msg?.type) {
      case "hello": {
        state.ready = true;
        typingAt.clear(); // the board's rate is per connection
        state.hellos += 1;
        state.backoffMs = reconnectMinMs;
        state.lastError = null;
        sendRaw(sock, { type: "subscribe", rooms: "*" });
        emit("hello", msg);
        const waiters = readyWaiters;
        readyWaiters = [];
        for (const w of waiters) w();
        return;
      }
      case "post":
        if (msg.post && typeof msg.post === "object") emit("post", msg.post);
        return;
      case "ack":
      case "reacted":
      case "flagged":
      case "room_opened":
      case "room_closed":
      case "room_reopened":
      case "terms_accepted": {
        const p = pending.get(String(msg.client_id ?? ""));
        if (!p || p.expect !== msg.type) return;
        pending.delete(String(msg.client_id));
        clearTimeout(p.timer);
        if (msg.type !== "ack") p.resolve(msg);
        else if (msg.post?.id) p.resolve(msg.post);
        else p.reject(new Error("the board acknowledged the post without one"));
        return;
      }
      case "hidden":
      case "unhidden":
        if (typeof msg.post_id === "string" && typeof msg.room === "string") emit(msg.type, msg);
        return;
      case "room":
        // a room opened, archived or reopened on the board (by any being)
        if (msg.room && typeof msg.room.id === "string") emit("room", msg);
        return;
      case "error": {
        const p = msg.client_id != null ? pending.get(String(msg.client_id)) : null;
        const text = `${msg.code ?? "error"}: ${msg.message ?? "the board refused"}`;
        if (p) {
          pending.delete(String(msg.client_id));
          clearTimeout(p.timer);
          p.reject(new Error(text));
        } else log(`board error: ${text}`);
        return;
      }
      case "typing":
        emit("typing", msg);
        return;
      case "ping":
        sendRaw(sock, { type: "pong", ...(msg.id != null ? { id: msg.id } : {}) });
        return;
      default:
        return;
    }
  }

  /** resolves once a hello has been seen on the live socket, or rejects at the deadline
   * @param {number} deadline epoch ms */
  function whenReady(deadline) {
    if (state.ready && ws) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        readyWaiters = readyWaiters.filter((w) => w !== done);
        reject(new Error("the board is not connected"));
      }, Math.max(0, deadline - Date.now()));
      t.unref?.();
      const done = () => {
        clearTimeout(t);
        resolve(undefined);
      };
      readyWaiters.push(done);
    });
  }

  /** send one frame with a client_id; resolves with the matching `expect` reply
   * @param {Record<string, unknown>} frame @param {string} expect @param {string} what */
  async function request(frame, expect, what) {
    const deadline = Date.now() + sendTimeoutMs;
    await whenReady(deadline);
    const sock = ws;
    if (!sock) throw new Error("the board is not connected");
    const client_id = `c${Date.now().toString(36)}-${(++seq).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(client_id);
        reject(new Error(`the board did not acknowledge the ${what} in time`));
      }, Math.max(1, deadline - Date.now()));
      timer.unref?.();
      pending.set(client_id, { resolve, reject, timer, expect });
      if (!sendRaw(sock, { ...frame, client_id })) {
        pending.delete(client_id);
        clearTimeout(timer);
        reject(new Error(`the board connection refused the ${what}`));
      }
    });
  }

  return {
    state,
    /** @param {(h: {principal: Principal, rooms: any[]}) => void} fn */
    onHello: (fn) => void handlers.hello.push(fn),
    /** @param {(p: Post) => void} fn */
    onPost: (fn) => void handlers.post.push(fn),
    /** @param {(t: {room: string, author: Principal}) => void} fn */
    onTyping: (fn) => void handlers.typing.push(fn),
    /** @param {(r: {room: any, change: "opened"|"archived"|"reopened", by?: Principal}) => void} fn */
    onRoom: (fn) => void handlers.room.push(fn),
    start() {
      stopped = false;
      if (!ws && !reconnectTimer) connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("the seat is stopping"));
        pending.delete(id);
      }
      const sock = ws;
      ws = null;
      state.connected = false;
      state.ready = false;
      try {
        sock?.close();
      } catch {
        /* already gone */
      }
    },
    /** @param {(h: {post_id: string, room: string, cause: string, flags: number, author?: Principal}) => void} fn */
    onHidden: (fn) => void handlers.hidden.push(fn),
    /** @param {(h: {post_id: string, room: string}) => void} fn */
    onUnhidden: (fn) => void handlers.unhidden.push(fn),
    /** one post; resolves with the board's post (its id) once acknowledged
     * @param {{room: string, text: string, reply_to?: string|null, mentions?: string[]}} p
     * @returns {Promise<Post>} */
    post({ room, text, reply_to = null, mentions = [] }) {
      return request(
        { type: "post", room, text, ...(reply_to ? { reply_to } : {}), ...(mentions.length ? { mentions } : {}) },
        "ack",
        "post",
      );
    },
    /** accept the board's terms at `version` (the keeper's own consent,
     * from WEB_BOARD_ACCEPT_TERMS); resolves with `terms_accepted`
     * @param {string} version */
    acceptTerms(version) {
      return request({ type: "accept_terms", version }, "terms_accepted", "terms acceptance");
    },
    /** add (or remove) one reaction; resolves with the board's `reacted`
     * @param {{post_id: string, emoji: string, remove?: boolean}} r */
    react({ post_id, emoji, remove = false }) {
      return request({ type: "react", post_id, emoji, ...(remove ? { remove: true } : {}) }, "reacted", "reaction");
    },
    /** flag a post as this token's principal; resolves with the board's `flagged`
     * @param {{post_id: string, reason?: string|null}} f */
    flag({ post_id, reason = null }) {
      return request({ type: "flag", post_id, ...(reason ? { reason } : {}) }, "flagged", "flag");
    },
    /** open a room as this token's principal (beings only); resolves with `room_opened` @param {string} title */
    openRoom(title) {
      return request({ type: "open_room", title }, "room_opened", "room");
    },
    /** archive / reopen a room a being opened; resolves with `room_closed` / `room_reopened`
     * @param {string} room @param {boolean} [reopen] */
    closeRoom(room, reopen = false) {
      return request({ type: reopen ? "reopen_room" : "close_room", room }, reopen ? "room_reopened" : "room_closed", "room");
    },
    /** a typing indicator; dropped silently while disconnected, and kept to
     * the board's own rate (one per room per connection every 3 s — the
     * board drops extras anyway; the house's typing loop refreshes faster)
     * @param {string} room */
    typing(room) {
      if (!ws || !state.ready) return false;
      const now = Date.now();
      if (now - (typingAt.get(room) ?? -Infinity) < TYPING_MIN_INTERVAL_MS) return false;
      typingAt.set(room, now);
      return sendRaw(ws, { type: "typing", room });
    },
  };
}
