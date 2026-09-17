// @ts-check
/* connectome-seat-client/src/seat-client.mjs — the being-side half of a
 * seat: connects to a house's SocketSeatServer over a unix socket
 * (in-box) or TCP (cross-box, `HOUSE_SEAT_ADDR`), sends the handshake, and
 * exposes house->being messages both as named handlers (`on(type, fn)`)
 * and as an async iterator — a bot runtime can implement either shape,
 * whichever fits its own turn loop. */
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

export class SeatClient {
  /** @param {{path?: string, host?: string, port?: number, seatId: string, being: string, protocolVersion?: number, room: string}} opts */
  constructor({ path, host, port, seatId, being, protocolVersion = 1, room }) {
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
  }

  /** @returns {Promise<SeatClient>} */
  connect() {
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
        this.send({
          type: "handshake",
          seatId: this.seatId,
          being: { handle: this.being },
          protocolVersion: this.protocolVersion,
        });
        resolve(this);
      });
      sock.once("error", reject);
      sock.on("close", () => {
        this.live = false;
        const done = this.waiters.splice(0);
        for (const w of done) w({ value: undefined, done: true });
      });
    });
  }

  /** @param {Record<string, unknown>} msg */
  _deliver(msg) {
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

  close() {
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
