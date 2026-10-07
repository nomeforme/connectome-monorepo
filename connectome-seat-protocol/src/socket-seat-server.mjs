// @ts-check
/* connectome-seat-protocol/src/socket-seat-server.mjs — the house-side
 * helper that seats a socket being: accept a connection, read its
 * handshake line, and hand back a Seat-shaped object (send/isLive/
 * onEvent/onExit/kill) so a room worker can drive a socket being the same
 * way the reference `wrapStdioSeat()` drives a stdio child. `send`/
 * `onExit`/`kill`/`isLive` are named identically to the reference Seat
 * interface; `onEvent` stands in for the reference's `onTokens`/`onLog`/
 * `onMessage` trio — a socket being has no raw stdout to demux, only
 * already-parsed protocol messages, so one event stream covers what the
 * stdio seat needed three callbacks for. */
import { createServer, connect } from "node:net";
import { lstatSync, unlinkSync } from "node:fs";
import { encodeMessage, NdjsonReader } from "./codec.mjs";
import { SeatProtocolError } from "./validators.mjs";

/** @typedef {{
 *   id: string,
 *   room: string,
 *   transport: "socket",
 *   send: (msg: Record<string, unknown>) => boolean,
 *   isLive: () => boolean,
 *   onEvent: (fn: (msg: Record<string, unknown>) => void) => void,
 *   onExit: (fn: (hadError: boolean) => void) => void,
 *   kill: () => void,
 *   raw: import("node:net").Socket,
 * }} SocketSeat */

/** @param {import("node:net").Socket} socket
 * @param {{onError?: (e: Error) => void}} [opts]
 * @returns {Promise<{seat: SocketSeat, handshake: Record<string, unknown>}>} */
function seatConnection(socket, opts = {}) {
  return new Promise((resolve, reject) => {
    let seq = 0;
    let settled = false;
    let live = true;
    /** @type {Array<(msg: Record<string, unknown>) => void>} */
    const eventFns = [];
    /** @type {Array<(hadError: boolean) => void>} */
    const exitFns = [];

    const reader = new NdjsonReader({
      onMessage(msg) {
        if (!settled) {
          if (msg.type !== "handshake") {
            const e = new SeatProtocolError(`expected a handshake message first, got "${msg.type}"`);
            reject(e);
            socket.destroy();
            return;
          }
          settled = true;
          const room = /** @type {string} */ (msg.room);
          /** @type {SocketSeat} */
          const seat = {
            id: /** @type {string} */ (msg.seatId),
            room,
            transport: "socket",
            send(m) {
              if (!live) return false;
              try {
                socket.write(encodeMessage({ room, ...m, seq: seq++ }));
                return true;
              } catch (e) {
                opts.onError?.(e instanceof Error ? e : new Error(String(e)));
                return false;
              }
            },
            isLive: () => live,
            onEvent(fn) {
              eventFns.push(fn);
            },
            onExit(fn) {
              exitFns.push(fn);
            },
            kill() {
              socket.destroy();
            },
            raw: socket,
          };
          resolve({ seat, handshake: msg });
          return;
        }
        for (const fn of eventFns) fn(msg);
      },
      onError(e) {
        opts.onError?.(e);
      },
    });
    socket.on("data", (b) => reader.push(b));
    socket.on("error", (e) => opts.onError?.(e));
    socket.on("close", (hadError) => {
      live = false;
      for (const fn of exitFns) fn(hadError);
      if (!settled) reject(new SeatProtocolError("connection closed before handshake"));
    });
  });
}

/** a small house-side server that seats one socket being per connection —
 * a socket counterpart to the reference `wrapStdioSeat()`, for the case
 * where the house drives a being over a unix socket or TCP rather than a
 * spawned child's stdio. */
export class SocketSeatServer {
  /** @param {{onSeat: (seat: SocketSeat, handshake: Record<string, unknown>) => void, onError?: (e: Error) => void}} opts */
  constructor({ onSeat, onError }) {
    this.onSeat = onSeat;
    this.onError = onError ?? (() => {});
    this.server = createServer((socket) => {
      seatConnection(socket, { onError: this.onError }).then(
        ({ seat, handshake }) => this.onSeat(seat, handshake),
        (e) => this.onError(e instanceof Error ? e : new Error(String(e))),
      );
    });
  }

  /** @param {{path?: string, port?: number, host?: string}} opts
   * @returns {Promise<import("node:net").AddressInfo|string|null>} */
  async listen(opts) {
    if (opts.path) await clearStaleSocket(opts.path);
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      const done = () => {
        this.server.removeListener("error", reject);
        resolve(this.server.address());
      };
      if (opts.path) this.server.listen(opts.path, done);
      else this.server.listen(opts.port, opts.host, done);
    });
  }

  /** @returns {Promise<void>} */
  close() {
    return new Promise((resolve) => this.server.close(() => resolve(undefined)));
  }
}

/** A unix socket file left behind by a process that died without closing
 * its server (Node unlinks it on a clean `server.close()`, never on a
 * crash) makes the next `listen()` fail with EADDRINUSE — and the house
 * then ran with NO seat server at all, refusing every being (2026-10-03
 * restart incident, docs/harness-port/38). Probe first: if something
 * answers, it is a live server and we leave it alone (listen will fail
 * loudly, as it should); if the connect is refused, nothing owns the file
 * and it is removed. */
async function clearStaleSocket(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return; // nothing there
  }
  // only ever a SOCKET: a regular file also answers ECONNREFUSED on Linux,
  // and must never be deleted — listen() reports it instead
  if (!st.isSocket()) return;
  const live = await new Promise((resolve) => {
    const probe = connect({ path });
    const done = (v) => {
      probe.destroy();
      resolve(v);
    };
    probe.once("connect", () => done(true));
    probe.once("error", (e) => done(/** @type {any} */ (e).code !== "ECONNREFUSED" && /** @type {any} */ (e).code !== "ENOENT"));
    setTimeout(() => done(true), 1000).unref?.();
  });
  if (!live) {
    try {
      unlinkSync(path);
    } catch {
      /* raced with someone else's cleanup — listen will report whatever is left */
    }
  }
}
