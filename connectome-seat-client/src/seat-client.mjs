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

/** thrown by `connect()` when `waitForReady` is set and no `seat.ready`
 * arrives within `readyTimeoutMs` (harness-port W8-A, 2026-09-19). */
export class SeatReadyTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeatReadyTimeoutError";
  }
}

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
   *   reconnect?: boolean | {initialDelayMs?: number, maxDelayMs?: number, resetAfterMs?: number},
   *   waitForReady?: boolean, readyTimeoutMs?: number, retryInitial?: boolean,
   *   onInitialRetry?: (err: Error, delayMs: number) => void}} opts
   * `reconnect`: `false` (default) behaves exactly as before — a dropped
   * socket just goes quiet, matching every existing caller/test. `true` (or
   * an options object) turns on automatic reconnect-with-backoff on an
   * UNEXPECTED close (never after `.close()`), re-sending the handshake
   * each time — carrying `resumeFromSeq` (this client's own highest seen
   * house->being `seq`) so a house that understands the field can skip
   * redelivering what this seat already has.
   *
   * harness-port R2-W, 2026-09-17: `resumeFromSeq` is now a declared
   * OPTIONAL field on @connectome/seat-protocol's `handshake` schema, so
   * this client sends it on EVERY connect (first or reconnect) whenever
   * `lastSeqSeen >= 0` — a fresh client's `-1` omits the field naturally
   * (nothing to resume yet), and a reconnect after seeing at least one
   * house->being message includes it. A house that predates this field
   * simply never named it in its own schema and would reject the message
   * outright (there is none such left in this repo); a house that
   * understands it (connectome-house/src/seat/socket-seat.mjs) replays
   * whatever it sent this room's seat after that point, from its own
   * bounded ring — see that module and this round's report for the one
   * documented limitation (the replay comparison is exact across a SINGLE
   * reconnect; the wire's own per-connection `seq` counter resets on every
   * new socket, which this client neither controls nor relies on here).
   *
   * harness-port W8-A, 2026-09-19: `waitForReady` (default `false` — a
   * client that doesn't wait still works, unchanged from before this
   * round) makes `connect()` resolve only once the house's own
   * `seat.ready` ack arrives (proof `onSeat` fully attached, closing the
   * window where a first send could be dropped), rejecting with
   * `SeatReadyTimeoutError` after `readyTimeoutMs` if it never does. */
  constructor({
    path,
    host,
    port,
    seatId,
    being,
    protocolVersion = 1,
    room,
    reconnect = false,
    waitForReady = false,
    readyTimeoutMs = 5000,
    retryInitial = false,
    onInitialRetry = undefined,
  }) {
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
    this._waitForReady = waitForReady;
    // see connect(): retry the first connection with the reconnect backoff
    // (requires `reconnect`); `onInitialRetry(err, delayMs)` is told each miss
    this._retryInitial = retryInitial;
    this._onInitialRetry = onInitialRetry;
    this._initialRetryFn = null;
    this._readyTimeoutMs = readyTimeoutMs;
    this.lastSeatReady = null; // the most recent seat.ready payload, if any has arrived
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
    // being->house messages sent while a reconnecting client is between
    // connections: held, in order, and flushed once the house acks the new
    // connection (seat.ready) — a turn's finished reply survives a blip
    // instead of vanishing (the house holds the turn open meanwhile)
    /** @type {Record<string, unknown>[]} */
    this._outbox = [];
    // between an unexpected close and the next seat.ready: keep holding,
    // so nothing sent on the new socket overtakes what's already held
    this._holding = false;
    this.on("seat.ready", () => this._flushOutbox());
  }

  _flushOutbox() {
    this._holding = false;
    const held = this._outbox.splice(0);
    for (const msg of held) {
      try {
        if (!this.send(msg)) this._outbox.push(msg);
      } catch {
        /* a message the protocol rejects would have thrown when first sent; dropped */
      }
    }
  }

  /** @returns {Promise<SeatClient>} */
  connect() {
    this._closing = false;
    if (!this._retryInitial || !this._reconnectOpts) return this._connectOnce();
    // `retryInitial`: the FIRST connection retries with the same backoff
    // as a reconnect instead of rejecting — a walker booting while the
    // house is down, restarting, or momentarily backlogged (EAGAIN /
    // ECONNREFUSED / no seat.ready yet) waits for it rather than exiting
    // and being restarted by its container into the same herd (the
    // 2026-10-03 restart storm's amplifier). Resolves on the first attempt
    // that succeeds; only `.close()` ends the wait (rejects).
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this._closing) return reject(new Error("seat client closed before the first connection"));
        this._connectOnce().then(resolve, (e) => {
          // the failed socket's own "close" usually schedules the retry
          // already; the single-flight guard makes this a no-op then
          this._maybeReconnectThen(attempt);
          this._onInitialRetry?.(e, this._reconnectDelay);
        });
      };
      attempt();
    });
  }

  /** `_maybeReconnect`, but the timer runs `fn` instead of a bare
   * `_connectOnce` — used only by `connect()`'s retryInitial loop, so the
   * initial wait shares the reconnect path's backoff and single timer. */
  _maybeReconnectThen(fn) {
    if (this._reconnectTimer) {
      this._initialRetryFn = fn; // the already-armed timer will run it
      return;
    }
    this._initialRetryFn = fn;
    this._maybeReconnect();
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

      // harness-port W8-A: settle this ONE attempt's promise exactly once,
      // whichever path gets there first — connect (the old default),
      // seat.ready (when waiting for it), a timeout, or a pre-ready close.
      let settled = false;
      let cleanupWait = () => {};
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        cleanupWait();
        fn(arg);
      };
      if (this._waitForReady) {
        const timer = setTimeout(() => {
          finish(reject, new SeatReadyTimeoutError(`no seat.ready within ${this._readyTimeoutMs}ms of connect`));
          sock.destroy(); // never leave a live-but-abandoned socket behind a rejected connect()
        }, this._readyTimeoutMs);
        timer.unref?.();
        const off = this.on("seat.ready", (msg) => {
          this.lastSeatReady = msg;
          finish(resolve, this);
        });
        cleanupWait = () => {
          clearTimeout(timer);
          off();
        };
      }

      sock.once("connect", () => {
        this.socket = sock;
        this.live = true;
        this._connectedAt = Date.now();
        this.send({
          type: "handshake",
          seatId: this.seatId,
          being: { handle: this.being },
          protocolVersion: this.protocolVersion,
          // omitted on a genuinely fresh client (lastSeqSeen starts at -1,
          // nothing to resume) — present on any connect after this client
          // has seen at least one house->being message, reconnect or not.
          ...(this.lastSeqSeen >= 0 ? { resumeFromSeq: this.lastSeqSeen } : {}),
        });
        // the old, still-default behaviour: resolve on the raw connect
        // alone, no house round trip awaited. `waitForReady` callers wait
        // for the "seat.ready" handler above instead.
        if (!this._waitForReady) finish(resolve, this);
      });
      // `.on`, not `.once`: a long-lived (reconnecting) socket may error
      // more than once over its life; only the FIRST error before "connect"
      // settles the connect() promise, every later one is just swallowed
      // here (Node requires an "error" listener at all, or it throws) —
      // the "close" handler below is what actually drives reconnect.
      sock.on("error", (e) => {
        if (this.live) return; // a post-connect socket error surfaces via "close" below
        finish(reject, e);
      });
      sock.on("close", () => {
        this.live = false;
        if (this._reconnectOpts && !this._closing) this._holding = true;
        const done = this.waiters.splice(0);
        for (const w of done) w({ value: undefined, done: true });
        // a waiting connect() whose socket closed before seat.ready ever
        // arrived has nothing left to wait for — reject it now rather than
        // hang past the timeout; a settled connect() (ready already seen,
        // or waitForReady off) is untouched, `finish` is already spent.
        finish(reject, new SeatReadyTimeoutError("socket closed before seat.ready arrived"));
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
    // single-flight: a failed attempt reaches here TWICE — once from its
    // socket's "close" handler, once from the attempt's own rejection
    // (`.catch` below, and `connect()`'s retryInitial loop). Before this
    // guard each failure scheduled two timers, so the number of parallel
    // retry chains doubled per failure: a seat that kept failing ended up
    // hammering the house hundreds of times a second whatever the per-chain
    // backoff said (being-opus-5, 2026-10-03: ~360 connects/s, the house's
    // seat backlog full, every other being refused with EAGAIN).
    if (this._reconnectTimer) return;
    const { initialDelayMs, maxDelayMs, resetAfterMs } = this._reconnectOpts;
    const stayedUpLongEnough = this._connectedAt && Date.now() - this._connectedAt >= resetAfterMs;
    this._reconnectDelay = stayedUpLongEnough
      ? initialDelayMs
      : Math.min(maxDelayMs, (this._reconnectDelay || initialDelayMs) * 2);
    const delay = this._reconnectDelay;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      const initial = this._initialRetryFn;
      this._initialRetryFn = null;
      if (initial) return initial(); // still inside connect()'s retryInitial wait
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
    if (!this.socket || ((!this.live || this._holding) && msg.type !== "handshake")) {
      // reconnecting: hold it for the next connection (bounded; oldest
      // dropped first). A client that never reconnects reports false.
      if (this._reconnectOpts && !this._closing && msg.type !== "handshake") {
        this._outbox.push(msg);
        if (this._outbox.length > 5000) this._outbox.shift();
        return true;
      }
      return false;
    }
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
