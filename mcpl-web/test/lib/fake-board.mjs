// @ts-check
/* mcpl-web/test/lib/fake-board.mjs — enough of the web board's WebSocket
 * contract (web-board contract v0) for the tests, in-process, no
 * dependency: an HTTP server whose `GET /v1/ws?token=` upgrades (RFC 6455
 * hand-framed: server→client frames unmasked, the client's masked frames
 * unmasked here; close and ping answered) for a known token and answers
 * 401 otherwise. On connect: `hello {principal, rooms}`. Client → board:
 * `subscribe`, `post` (→ a `post` broadcast to every subscribed socket,
 * the sender's own included, then an `ack` with the client_id — or a
 * scripted `error`; a `reply_to` outside the room is `bad_reply_to`;
 * unknown explicit mention ids are dropped), `subscribe` (additive,
 * unknown rooms → `not_found`), `typing` (at most one per room per
 * connection every 3 s, recorded and broadcast to the others), `pong`
 * (recorded) — the refinements the real board pinned (web-board contract
 * v0.1). Board → client on demand: `emitPost` (a post by any
 * principal), `ping` (a control ping) / `appPing` (`{type:"ping"}`),
 * `dropAll` (every socket destroyed — a board restart). Moderation:
 * `react` / `flag` (answered `reacted` / `flagged`; 🫥 or flags at
 * `flagThreshold` hide, broadcast as `hidden` / `unhidden`), and on demand
 * `externalFlag` (a partner villager's flag) / `moderatorUnhide`. Every principal
 * and token here is a fixture; none is real. Also imported by
 * connectome-house's own web seat tests. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HIDE = "\u{1FAE5}";

/** one unmasked frame @param {number} opcode @param {Buffer} payload */
function frame(opcode, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) head = Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** parse as many complete client frames as `buf` holds; returns the rest */
function readFrames(buf, onFrame) {
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length < p + 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length < p + len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    onFrame(b0 & 0x0f, payload);
    off = p + len;
  }
  return buf.subarray(off);
}

export const PRINCIPALS = {
  fable: { id: "being:fable-test", kind: "being", display: "Fable" },
  bob: { id: "human:bob-test", kind: "human", display: "Bob" },
  scout: { id: "agent:scout-test", kind: "agent", display: "Scout Bot" },
};
export const TOKENS = { fable: "tok-fable-fixture", bob: "tok-bob-fixture" };
export const ROOMS = [
  { id: "web:commons:general", title: "General", community: "commons", public: true, created_at: "2026-10-01T00:00:00.000Z" },
  { id: "web:commons:makers", title: "Makers", community: "commons", public: false, created_at: "2026-10-01T00:00:00.000Z" },
];

/** @param {{tokens?: Record<string, {id: string, kind: string, display: string}>,
 *   rooms?: any[], ackFirst?: boolean, flagThreshold?: number}} [opts] */
export async function createFakeBoard(opts = {}) {
  const tokens = opts.tokens ?? {
    [TOKENS.fable]: PRINCIPALS.fable,
    [TOKENS.bob]: PRINCIPALS.bob,
  };
  const state = {
    rooms: opts.rooms ?? ROOMS,
    ackFirst: opts.ackFirst === true,
    connections: 0,
    unauthorized: 0,
    /** @type {any[]} every client→board message, in order, with its principal */
    received: [],
    /** @type {any[]} posts made over the socket */
    posts: [],
    /** @type {any[]} */ typing: [],
    pongs: 0,
    /** next post gets this error instead of an ack (then cleared) */
    /** @type {{code: string, message: string}|null} */ rejectNext: null,
    /** next post gets no answer at all (then cleared) */
    swallowNext: false,
    /** @type {Set<{socket: import("node:net").Socket, principal: any, subscribed: any}>} */
    clients: new Set(),
    /** moderation: post id → emoji → principal ids; post id → flagger ids; hidden post ids */
    /** @type {Map<string, Map<string, Set<string>>>} */ reactions: new Map(),
    /** @type {Map<string, Set<string>>} */ flags: new Map(),
    /** @type {Set<string>} */ hidden: new Set(),
    flagThreshold: opts.flagThreshold ?? 1,
  };
  let seq = 0;
  const nextId = () => `p${String(Date.now()).padStart(14, "0")}-${String(++seq).padStart(6, "0")}`;

  const send = (c, obj) => {
    try {
      c.socket.write(frame(0x1, Buffer.from(JSON.stringify(obj), "utf8")));
    } catch {
      /* gone */
    }
  };
  const subscribed = (c, room) => c.subscribed === "*" || (Array.isArray(c.subscribed) && c.subscribed.includes(room));

  /** the board's own mention resolution: known explicit ids first (unknown
   * ones dropped) ∪ `@display` tokens */
  function resolveMentions(text, explicit = []) {
    const all = [...Object.values(tokens), ...Object.values(PRINCIPALS)];
    const out = new Set(explicit.map(String).filter((id) => all.some((p) => p.id === id)));
    for (const m of String(text).matchAll(/@([^\s@]+)/g)) {
      const key = m[1].toLowerCase().replace(/[_-]/g, " ").replace(/[.,!?;:]+$/, "");
      const hit = all.find((p) => p.display.toLowerCase() === key);
      if (hit) out.add(hit.id);
    }
    return [...out];
  }

  /** a full post, broadcast to every subscribed socket */
  function broadcast(post) {
    for (const c of state.clients) if (subscribed(c, post.room)) send(c, { type: "post", post });
  }
  function makePost({ room, author, text, reply_to = null, mentions = [] }) {
    const now = Date.now();
    return {
      id: nextId(),
      room,
      author: { id: author.id, kind: author.kind, display: author.display },
      text,
      reply_to: reply_to ?? null,
      mentions: resolveMentions(text, mentions),
      created_at: new Date(now).toISOString(),
      ts: now,
    };
  }

  /** the board's visibility rule: hidden while a 🫥 stands or flags reach the threshold */
  function settle(post, trigger) {
    const hides = state.reactions.get(post.id)?.get(HIDE)?.size ?? 0;
    const flags = state.flags.get(post.id)?.size ?? 0;
    const byFlags = flags >= state.flagThreshold;
    const should = hides > 0 || byFlags;
    if (should && !state.hidden.has(post.id)) {
      const cause = byFlags && (trigger === "flags" || hides === 0) ? "flags" : "reaction";
      verdict("hidden", post, { cause, flags });
    } else if (!should && state.hidden.has(post.id)) verdict("unhidden", post);
  }
  /** broadcast a hide/unhide like the real board */
  function verdict(type, post, { cause = "reaction", flags = 0 } = {}) {
    if (type === "hidden") state.hidden.add(post.id);
    else state.hidden.delete(post.id);
    const ev =
      type === "hidden"
        ? { type, post_id: post.id, room: post.room, cause, flags, author: post.author }
        : { type, post_id: post.id, room: post.room };
    for (const c of state.clients) if (subscribed(c, post.room)) send(c, ev);
  }

  function onMessage(c, msg) {
    state.received.push({ ...msg, principal: c.principal.id });
    if (msg.type === "subscribe") {
      // additive; unknown ids → one not_found error, the known ones still subscribed
      if (msg.rooms === "*") c.subscribed = "*";
      else if (Array.isArray(msg.rooms)) {
        const known = msg.rooms.filter((r) => state.rooms.some((x) => x.id === r));
        if (c.subscribed !== "*") c.subscribed = [...new Set([...(c.subscribed ?? []), ...known])];
        if (known.length < msg.rooms.length) send(c, { type: "error", code: "not_found", message: "no such room(s)" });
      }
    } else if (msg.type === "open_room" || msg.type === "close_room" || msg.type === "reopen_room") {
      // like the real board: beings only; every socket hears the change
      if (c.principal.kind !== "being") return send(c, { type: "error", code: "forbidden", message: "only beings", client_id: msg.client_id });
      let room;
      if (msg.type === "open_room") {
        room = { id: `web:commons:${String(msg.title).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title: msg.title, community: "commons", public: true, archived: false };
        state.rooms = [...state.rooms, room];
      } else {
        room = state.rooms.find((r) => r.id === msg.room);
        if (!room) return send(c, { type: "error", code: "not_found", message: `no room ${msg.room}`, client_id: msg.client_id });
        room.archived = msg.type === "close_room";
      }
      const change = msg.type === "open_room" ? "opened" : msg.type === "close_room" ? "archived" : "reopened";
      send(c, { type: { opened: "room_opened", archived: "room_closed", reopened: "room_reopened" }[change], client_id: msg.client_id ?? null, room });
      for (const o of state.clients) send(o, { type: "room", room, change, by: c.principal });
    } else if (msg.type === "pong") state.pongs += 1;
    else if (msg.type === "typing") {
      // at most one per room per connection every 3 s; extras dropped silently
      const now = Date.now();
      if (now - (c.typingAt.get(msg.room) ?? 0) < 3000) return;
      c.typingAt.set(msg.room, now);
      state.typing.push({ room: msg.room, author: c.principal.id });
      for (const o of state.clients)
        if (o !== c && subscribed(o, msg.room)) send(o, { type: "typing", room: msg.room, author: c.principal });
    } else if (msg.type === "react" || msg.type === "flag") {
      const post = state.posts.find((p) => p.id === msg.post_id);
      if (!post) {
        send(c, { type: "error", code: "not_found", message: `no post ${msg.post_id}`, client_id: msg.client_id });
        return;
      }
      if (msg.type === "react") {
        const byEmoji = state.reactions.get(post.id) ?? new Map();
        state.reactions.set(post.id, byEmoji);
        const who = byEmoji.get(msg.emoji) ?? new Set();
        byEmoji.set(msg.emoji, who);
        if (msg.remove) who.delete(c.principal.id);
        else who.add(c.principal.id);
        settle(post, "reaction");
        send(c, { type: "reacted", client_id: msg.client_id ?? null, post_id: post.id, emoji: msg.emoji, removed: !!msg.remove, hidden: state.hidden.has(post.id) });
      } else {
        const flaggers = state.flags.get(post.id) ?? new Set();
        state.flags.set(post.id, flaggers);
        const duplicate = flaggers.has(c.principal.id);
        flaggers.add(c.principal.id);
        if (!duplicate) settle(post, "flags");
        send(c, {
          type: "flagged", client_id: msg.client_id ?? null, post_id: post.id, duplicate,
          flags: flaggers.size, threshold: state.flagThreshold, hidden: state.hidden.has(post.id),
        });
      }
    } else if (msg.type === "post") {
      if (state.swallowNext) {
        state.swallowNext = false;
        return;
      }
      if (state.rejectNext) {
        const e = state.rejectNext;
        state.rejectNext = null;
        send(c, { type: "error", code: e.code, message: e.message, client_id: msg.client_id });
        return;
      }
      if (msg.reply_to && !state.posts.some((p) => p.id === msg.reply_to && p.room === msg.room)) {
        send(c, { type: "error", code: "bad_reply_to", message: "reply_to must name a post in this room", client_id: msg.client_id });
        return;
      }
      const post = makePost({ room: msg.room, author: c.principal, text: msg.text, reply_to: msg.reply_to, mentions: msg.mentions ?? [] });
      state.posts.push(post);
      // the real board sends the echo first, then the ack; `ackFirst` inverts
      // that only to prove the seat doesn't depend on the order
      const ack = { type: "ack", client_id: msg.client_id ?? null, post };
      if (state.ackFirst) send(c, ack);
      broadcast(post);
      if (!state.ackFirst) send(c, ack);
    }
  }

  const server = createServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "fake board: websocket only" }));
  });
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const key = req.headers["sec-websocket-key"];
    const principal = tokens[url.searchParams.get("token") ?? ""];
    if (url.pathname !== "/v1/ws" || typeof key !== "string") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    if (!principal) {
      state.unauthorized += 1;
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    state.connections += 1;
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const c = { socket, principal, subscribed: /** @type {any} */ (null), typingAt: new Map() };
    state.clients.add(c);
    send(c, { type: "hello", principal, rooms: state.rooms });
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = readFrames(Buffer.concat([buf, chunk]), (opcode, payload) => {
        if (opcode === 0x1) {
          try {
            onMessage(c, JSON.parse(payload.toString("utf8")));
          } catch {
            /* not JSON */
          }
        } else if (opcode === 0x8) {
          try {
            socket.write(frame(0x8, payload));
          } catch {
            /* gone */
          }
          socket.end();
        } else if (opcode === 0x9) {
          socket.write(frame(0xa, payload));
        } else if (opcode === 0xa) {
          state.pongs += 1;
        }
      });
    });
    const gone = () => state.clients.delete(c);
    socket.on("close", gone);
    socket.on("error", gone);
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

  return {
    state,
    port,
    url: `http://127.0.0.1:${port}`,
    /** a room another being opened, announced like the real board @param {{id: string, title: string}} room */
    emitRoom(room) {
      const r = { community: "commons", public: true, archived: false, ...room };
      state.rooms = [...state.rooms, r];
      for (const o of state.clients) send(o, { type: "room", room: r, change: "opened", by: PRINCIPALS.bob });
      return r;
    },
    /** a post by any principal, broadcast like a real one; returns it
     * @param {{room?: string, author?: any, text: string, reply_to?: string|null, mentions?: string[]}} p */
    emitPost({ room = state.rooms[0].id, author = PRINCIPALS.bob, text, reply_to = null, mentions = [] }) {
      const post = makePost({ room, author, text, reply_to, mentions });
      state.posts.push(post);
      broadcast(post);
      return post;
    },
    /** a flag from outside the socket contract (a partner's villager), counted like any other
     * @param {string} postId @param {string} flaggerId */
    externalFlag(postId, flaggerId) {
      const post = state.posts.find((p) => p.id === postId);
      if (!post) throw new Error(`fake board: no post ${postId}`);
      const flaggers = state.flags.get(post.id) ?? new Set();
      state.flags.set(post.id, flaggers);
      flaggers.add(`partner:agent-village:${flaggerId}`);
      settle(post, "flags");
    },
    /** a reaction by a principal not on any socket here (a human in a browser)
     * @param {string} postId @param {string} principalId @param {string} emoji @param {boolean} [remove] */
    externalReact(postId, principalId, emoji, remove = false) {
      const post = state.posts.find((p) => p.id === postId);
      if (!post) throw new Error(`fake board: no post ${postId}`);
      const byEmoji = state.reactions.get(post.id) ?? new Map();
      state.reactions.set(post.id, byEmoji);
      const who = byEmoji.get(emoji) ?? new Set();
      byEmoji.set(emoji, who);
      if (remove) who.delete(principalId);
      else who.add(principalId);
      settle(post, "reaction");
    },
    /** a moderator's unhide: flags and 🫥 cleared @param {string} postId */
    moderatorUnhide(postId) {
      const post = state.posts.find((p) => p.id === postId);
      if (!post) throw new Error(`fake board: no post ${postId}`);
      state.flags.delete(post.id);
      state.reactions.get(post.id)?.delete(HIDE);
      settle(post, "moderator");
    },
    /** how many sockets have subscribed (to anything) */
    subscribedCount: () => [...state.clients].filter((c) => c.subscribed != null).length,
    ping() {
      for (const c of state.clients) c.socket.write(frame(0x9, Buffer.from("hb")));
    },
    appPing() {
      for (const c of state.clients) send(c, { type: "ping" });
    },
    dropAll() {
      for (const c of state.clients) c.socket.destroy();
      state.clients.clear();
    },
    async close() {
      this.dropAll();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

/** poll `fn` until it returns something truthy; generous by default
 * @template T @param {() => T|Promise<T>} fn @param {number} [ms] @returns {Promise<T>} */
export async function waitFor(fn, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
