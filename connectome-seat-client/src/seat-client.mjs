// @ts-check
/* connectome-seat-client/src/seat-client.mjs — the being-side half of a
 * seat: connects to a house's SocketSeatServer over a unix socket
 * (in-box) or TCP (cross-box, `HOUSE_SEAT_ADDR`), sends the handshake, and
 * exposes house->being messages both as named handlers (`on(type, fn)`)
 * and as an async iterator — a bot runtime can implement either shape,
 * whichever fits its own turn loop.
 *
 * Wired for real use (06-rounds.md R2-A, 2026-09-17): optional
 * reconnect-with-backoff and a `.lastSeqSeen` resume marker, on top of
 * R1-B's original connect/send/handshake — every existing caller that
 * never passes `reconnect` sees identical behaviour to before (a dropped
 * socket just goes quiet). See the constructor's own doc for exactly what
 * "resume by last seq" does and doesn't do yet (the wire field it would
 * ride on is not in @connectome/seat-protocol's schema this round). */
import { connect } from "node:net";
import { encodeMessage, NdjsonReader, SeatProtocolError } from "@connectome/seat-protocol";

/** parse a `HOUSE_SEAT_ADDR` value: `"unix:/path/to.sock"`,
 * `"tcp://host:port"`, or a bare `"host:port"` (treated as tcp).
 * @param {string} addr
 * @returns {{path: string}|{host: string, port: number}} */
export function parseSeatAddr(addr) {
  if (addr.startsWith("unix:")) return { path: addr.slice("unix:".length) };
  const tcp = addr.startsWith("tcp://") ? addr.slice("tcp://".length) : addr;
  const at = tcp.lastIndexOf(":");
  if (at === -1) {
    throw new Error(`HOUSE_SEAT_ADDR must be "unix:<path>", "tcp://host:port" or "host:port": ${addr}`);
  }
  return { host: tcp.slice(0, at), port: Number(tcp.slice(at + 1)) };
}

/** default reconnect backoff: doubling from `initialDelayMs` up to
 * `maxDelayMs`, reset to `initialDelayMs` after any connection that stayed
 * live at least `resetAfterMs`. */
const DEFAULT_RECONNECT = { initialDelayMs: 200, maxDelayMs: 10_000, resetAfterMs: 5_000 };

export class SeatClient {
  /** @param {{path?: string, host?: string, port?: number, seatId: string, being: string, protocolVersion?: number, room: string,
   *   reconnect?: boolean | {initialDelayMs?: number, maxDelayMs?: number, resetAfterMs?: number}}} opts
   * `reconnect`: `false` (default) behaves exactly as before — a dropped
   * socket just goes quiet, matching every existing caller/test. `true` (or
   * an options object) turns on automatic reconnect-with-backoff on an
   * UNEXPECTED close (never after `.close()`), re-sending the handshake
   * each time — carrying `resumeFromSeq` (this client's own highest seen
   * house->being `seq`) so a house that understands the field can skip
   * redelivering what this seat already has. `resumeFromSeq` is NOT yet a
   * declared field in @connectome/seat-protocol's `handshake` schema
   * (NO-TOUCH package for this builder) — sent only when a future schema
   * version accepts it; a house running today's schema simply never sees
   * it (present-day `encodeMessage` would reject an extra key, so this
   * client omits the field entirely until the protocol package adds it —
   * see this round's report). */
  constructor({ path, host, port, seatId, being, protocolVersion = 1, room, reconnect = false }) {
    this.path = path;
    this.host = host;
    this.port = port;
    this.seatId = seatId;
    this.being = being;
    this.protocolVersion = protocolVersion;
    this.room = room;
    this.seq = 0;
    /** @type {Map<string, Array<(msg: Record<string, unknown>) => void>>} */
    this.handlers = new Map();
    /** @type {Record<string, unknown>[]} */
    this.queue = [];
    /** @type {Array<(v: IteratorResult<Record<string, unknown>>) => void>} */
    this.waiters = [];
    /** @type {import("node:net").Socket|null} */
    this.socket = null;
    this.live = false;
    // resume-by-seq bookkeeping: the highest `seq` this client has SEEN
    // from the house on this room, tracked whether or not reconnect is
    // enabled — cheap, and useful to a caller inspecting `.lastSeqSeen`
    // even without auto-reconnect.
    this.lastSeqSeen = -1;
    this._reconnectOpts =
      reconnect === true
        ? DEFAULT_RECONNECT
        : reconnect && typeof reconnect === "object"
          ? { ...DEFAULT_RECONNECT, ...reconnect }
          : null;
    this._closing = false; // set by close(): tells the close handler never to reconnect
    this._reconnectDelay = this._reconnectOpts?.initialDelayMs ?? 0;
    this._connectedAt = 0;
    this._reconnectTimer = null;
  }

  /** @returns {Promise<SeatClient>} */
  connect() {
    this._closing = false;
    return this._connectOnce();
  }

  /** one connection attempt + handshake; on success also arms the
   * reconnect-on-close behaviour (if enabled) for every FUTURE close.
   * @returns {Promise<SeatClient>} */
  _connectOnce() {
    return new Promise((resolve, reject) => {
      const sock = this.path ? connect({ path: this.path }) : connect({ host: this.host, port: this.port });
      const reader = new NdjsonReader({
        onMessage: (msg) => this._deliver(msg),
        onError: (e) => this._deliver({ type: "__error__", error: e }),
      });
      sock.on("data", (b) => reader.push(b));
      sock.once("connect", () => {
        this.socket = sock;
        this.live = true;
        this._connectedAt = Date.now();
        this.send({
          type: "handshake",
          seatId: this.seatId,
          being: { handle: this.being },
          protocolVersion: this.protocolVersion,
        });
        resolve(this);
      });
      // `.on`, not `.once`: a long-lived (reconnecting) socket may error
      // more than once over its life; only the FIRST error before "connect"
      // settles the connect() promise, every later one is just swallowed
      // here (Node requires an "error" listener at all, or it throws) —
      // the "close" handler below is what actually drives reconnect.
      sock.on("error", (e) => {
        if (this.live) return; // a post-connect socket error surfaces via "close" below
        reject(e);
      });
      sock.on("close", () => {
        this.live = false;
        const done = this.waiters.splice(0);
        for (const w of done) w({ value: undefined, done: true });
        this._maybeReconnect();
      });
    });
  }

  /** schedule a reconnect attempt after the current backoff delay, unless
   * `.close()` asked for a clean shutdown or reconnect isn't enabled. The
   * delay resets to its initial value once a connection has stayed up at
   * least `resetAfterMs`; otherwise it doubles, capped at `maxDelayMs` — a
   * flapping house never gets hammered at a fixed short interval. */
  _maybeReconnect() {
    if (this._closing || !this._reconnectOpts) return;
    const { initialDelayMs, maxDelayMs, resetAfterMs } = this._reconnectOpts;
    const stayedUpLongEnough = this._connectedAt && Date.now() - this._connectedAt >= resetAfterMs;
    this._reconnectDelay = stayedUpLongEnough
      ? initialDelayMs
      : Math.min(maxDelayMs, (this._reconnectDelay || initialDelayMs) * 2);
    const delay = this._reconnectDelay;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectOnce().catch(() => this._maybeReconnect());
    }, delay);
    if (typeof this._reconnectTimer.unref === "function") this._reconnectTimer.unref();
  }

  /** @param {Record<string, unknown>} msg */
  _deliver(msg) {
    if (typeof msg.seq === "number" && msg.seq > this.lastSeqSeen) this.lastSeqSeen = msg.seq;
    for (const fn of this.handlers.get(/** @type {string} */ (msg.type)) ?? []) fn(msg);
    for (const fn of this.handlers.get("*") ?? []) fn(msg);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.queue.push(msg);
  }

  /** @param {string} type @param {(msg: Record<string, unknown>) => void} fn
   * @returns {() => void} unsubscribe */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    const arr = /** @type {Array<(msg: Record<string, unknown>) => void>} */ (this.handlers.get(type));
    arr.push(fn);
    return () => {
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    };
  }

  /** send one being->house message; `room` and `seq` are stamped here.
   * @param {Record<string, unknown>} msg
   * @returns {boolean} */
  send(msg) {
    if (!this.socket) return false;
    try {
      this.socket.write(encodeMessage({ room: this.room, ...msg, seq: this.seq++ }));
      return true;
    } catch (e) {
      if (e instanceof SeatProtocolError) throw e;
      return false;
    }
  }

  isLive() {
    return this.live;
  }

  /** a clean, deliberate close: never reconnects afterward, whether or not
   * `reconnect` was enabled. Cancels a pending reconnect attempt too, so a
   * caller that closes mid-backoff doesn't see a surprise connection
   * appear after it believed the client was done. */
  close() {
    this._closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.socket?.end();
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: /** @type {Record<string, unknown>} */ (this.queue.shift()), done: false });
        if (!this.live) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
