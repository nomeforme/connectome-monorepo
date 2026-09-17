// @ts-check
/* connectome-house/src/seat/socket-seat.mjs — the house side of the
 * being's-turn SOCKET transport (docs/harness-port/03-house-design.md
 * §2.3's recommendation): listens with `@connectome/seat-protocol`'s
 * `SocketSeatServer` on `HOUSE_SEAT_ADDR`, and on a being's handshake
 * attaches it to the room the handshake itself names (open-rooms.mjs's
 * `attachSeat` — "or to a room on demand", house-design.md §2.1's third
 * option: a room worker, not the whole house process, holds the turn).
 * A room named in the handshake that this process doesn't hold open is
 * refused, not minted on the spot — this port's `openRoom` is the one
 * place a room is born (serve-rooms.mjs), never a side effect of a being
 * connecting.
 *
 * The wrapped seat matches `open-rooms.mjs`'s `OpenRoomRec.seat` shape
 * closely enough for `seat/protocol.mjs`'s senders (`sendLine` et al.,
 * transport-aware) to drive it exactly as they drive a stdio seat; it
 * additionally carries `.being` (the handshake's own handle) so
 * `roomInput`'s activation decision (serve-rooms.mjs) knows which
 * present being, if any, actually holds this room's one seat. */
import { SocketSeatServer } from "@connectome/seat-protocol";
import { attachSeat, open } from "../open-rooms.mjs";
import { handleSeatExit, handleSeatMessage } from "../room-turn.mjs";

/** parse `HOUSE_SEAT_ADDR`: `"unix:/path/to.sock"`, `"tcp://host:port"`,
 * or a bare `"host:port"` (treated as tcp) — the being-side counterpart
 * lives in connectome-seat-client's own `parseSeatAddr`; duplicated here
 * (a few lines) rather than adding a being-side package as a house
 * runtime dependency.
 * @param {string} addr @returns {{path: string}|{host: string, port: number}} */
export function parseHouseSeatAddr(addr) {
  if (addr.startsWith("unix:")) return { path: addr.slice("unix:".length) };
  const tcp = addr.startsWith("tcp://") ? addr.slice("tcp://".length) : addr;
  const at = tcp.lastIndexOf(":");
  if (at === -1) {
    throw new Error(`HOUSE_SEAT_ADDR must be "unix:<path>", "tcp://host:port" or "host:port": ${addr}`);
  }
  return { host: tcp.slice(0, at), port: Number(tcp.slice(at + 1)) };
}

/** harness-port R2-W, 2026-09-17: a bounded per-room ring of every message
 * this house has sent a room's socket seat, keyed by `roomId` (not by any
 * one connection's own id — the whole point is to survive the seat
 * dropping and a NEW connection re-attaching). Each entry carries this
 * ring's OWN monotonic `seq` — deliberately NOT the wire's per-connection
 * `seq` (`@connectome/seat-protocol`'s `socket-seat-server.mjs`, a NO-TOUCH
 * package, restarts that counter at 0 on every new accepted socket, so it
 * cannot itself serve as a cross-reconnect resume marker). `SeatClient`'s
 * own `lastSeqSeen` (connectome-seat-client, tracked off that same
 * wire-level field) lines up with this ring's `seq` exactly across a
 * SINGLE reconnect — both start at 0 for a fresh room and advance by
 * exactly one per send with no gap — which is what `resumeFromSeq`'s one
 * documented use (this file's own onSeat, below) relies on. A being that
 * drops and reconnects MORE than once before its buffered window empties
 * could see the two numbering schemes drift (the wire's own counter keeps
 * restarting; this ring's does not) — a known, named limitation of this
 * round, not a silent gap; see this task's own report. */
const RESUME_RING_CAP = 200;
/** @type {Map<string, {seq: number, ring: {seq: number, msg: Record<string, unknown>}[]}>} */
const resumeRings = new Map();
/** @param {string} roomId */
function ringFor(roomId) {
  let r = resumeRings.get(roomId);
  if (!r) {
    r = { seq: 0, ring: [] };
    resumeRings.set(roomId, r);
  }
  return r;
}

/** wrap a raw `SocketSeat` (connectome-seat-protocol's own shape) as an
 * `open-rooms.mjs` Seat: same `send`/`isLive`/`kill` surface, `.being`
 * added, `runIds` a single-element set (this port seats one being's turn
 * per room, never a fork tree over the socket transport yet — see
 * room-turn.mjs's own header for that documented limitation). Every send
 * is also pushed onto this room's own resume ring (above) before it goes
 * out over the wire, so a later reconnect's replay (onSeat, below) has it
 * on hand regardless of whether THIS particular raw connection is still
 * the one attached by then.
 * @param {import("@connectome/seat-protocol").SocketSeat} raw
 * @param {string} being */
function wrapSocketSeat(raw, being) {
  const ring = ringFor(raw.room);
  return {
    id: raw.id,
    transport: "socket",
    being,
    runIds: new Set([raw.room]),
    send: (msg) => {
      const seq = ring.seq++;
      ring.ring.push({ seq, msg });
      if (ring.ring.length > RESUME_RING_CAP) ring.ring.shift();
      return raw.send(msg);
    },
    isLive: () => raw.isLive(),
    kill: () => raw.kill(),
    raw,
  };
}

/** @param {{log?: (line: string) => void}} [opts]
 * @returns {SocketSeatServer} */
export function createHouseSeatServer({ log = console.error } = {}) {
  const server = new SocketSeatServer({
    onSeat(raw, handshake) {
      const roomId = raw.room;
      const being = /** @type {any} */ (handshake?.being)?.handle;
      const rec = open.get(roomId);
      if (!rec) {
        log(`[seat] a being (@${being ?? "?"}) named room ${roomId}, which this house doesn't hold open — refused`);
        raw.kill();
        return;
      }
      if (rec.seat) {
        log(`[seat] room ${roomId} already has a seat attached — refusing a second one (@${being ?? "?"})`);
        raw.kill();
        return;
      }
      const seat = wrapSocketSeat(raw, being);
      attachSeat(roomId, seat);
      log(`[seat] @${being} seated to room ${roomId} over the socket transport`);
      // an OPTIONAL resumeFromSeq (the being's own lastSeqSeen from before
      // this connection): replay whatever this room's ring still holds
      // past that point, in order, via raw.send — never seat.send, which
      // would re-buffer the replay as though it were new (see the ring's
      // own header comment for why this matters across more than one
      // reconnect). A malformed/negative value (a stale client, or one
      // running an older schema) is silently not a resume — no replay, no
      // error; the seat still seats.
      const resumeFromSeq = /** @type {any} */ (handshake)?.resumeFromSeq;
      if (Number.isInteger(resumeFromSeq) && resumeFromSeq >= 0) {
        const missed = ringFor(roomId).ring.filter((e) => e.seq > resumeFromSeq);
        for (const e of missed) raw.send(e.msg);
        if (missed.length)
          log(`[seat] replayed ${missed.length} line(s) to @${being} in room ${roomId} since seq ${resumeFromSeq}`);
      }
      raw.onEvent((msg) => handleSeatMessage(rec, msg));
      raw.onExit(() => {
        log(`[seat] @${being}'s socket left room ${roomId}`);
        handleSeatExit(rec);
      });
    },
    onError(e) {
      log(`[seat] socket seat server error: ${e.message}`);
    },
  });
  return server;
}

export { parseHouseSeatAddr as parseSeatAddr };
