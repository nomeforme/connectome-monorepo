// @ts-check
/* connectome-house/src/seat/socket-seat.mjs — the house side of the
 * being's-turn SOCKET transport (docs/harness-port/03-house-design.md
 * §2.3's recommendation): listens with `@connectome/seat-protocol`'s
 * `SocketSeatServer` on `HOUSE_SEAT_ADDR`, and on a being's handshake
 * attaches it to EVERY open room whose roster already names that being
 * (open-rooms.mjs's `seatBeing` — harness-port W4-A, 2026-09-19: one
 * always-on seat per BEING now, not per room; see that module's own
 * header for the fleet-scale problem this answers). A room named nowhere
 * open yet simply gets nothing today (it still gets the seat the moment
 * it opens — `attachRegisteredSeat`, serve-rooms.mjs) — this file never
 * mints a room as a side effect of a being connecting.
 *
 * The wrapped seat matches `open-rooms.mjs`'s `OpenRoomRec.seat` shape
 * closely enough for `seat/protocol.mjs`'s senders (`sendLine` et al.,
 * transport-aware) to drive it exactly as they drive a stdio seat; it
 * additionally carries `.being` (the handshake's own handle) so
 * `roomInput`'s activation decision (serve-rooms.mjs) knows which
 * present being, if any, actually holds this room's one seat. */
import { PLATFORM_ROOM, SocketSeatServer } from "@connectome/seat-protocol";
import {
  open,
  remoteHostFor,
  remoteHostsFor,
  roomsFor,
  seatBeing,
  seatFor,
  unregisterSeat,
} from "../open-rooms.mjs";
import { activeFork } from "../room-fork.mjs";
import { handleSeatMessage } from "../room-turn.mjs";
import { handleSeatExit, handleSeatReturn } from "../room-seats.mjs";

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
 * round, not a silent gap; see this task's own report.
 *
 * harness-port W4-A, 2026-09-19: this ring is keyed by the message's own
 * EXPLICIT `room` field now (`msg.room ?? raw.room`) rather than always
 * `raw.room` — a multi-room seat's own send() carries a different `room`
 * per outgoing message (room-turn.mjs/seat/protocol.mjs now stamp it
 * explicitly, since one connection's `raw.room` can no longer be trusted
 * to name every room it serves); `resumeFromSeq`'s own replay (below)
 * still only ever reads `raw.room`'s own ring — correct for the LEGACY
 * single-room handshake (where `raw.room` IS the one real room), a known,
 * named gap for a multi-room seat's reconnect (not exercised by this
 * round's own tests — see this task's report). */
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
 * added, `runIds` a live Set of every room this seat currently serves
 * (harness-port W4-A: was a single-element set fixed at handshake time;
 * now set to whatever `seatBeing` actually attached, kept for `seat/
 * protocol.mjs`'s own `retireSeatBranch` — see that function's own
 * header; nothing in this port calls it yet, so this is correctness for
 * a future caller, not a behaviour change today). Every send is also
 * pushed onto ITS OWN TARGET room's resume ring (above) before it goes
 * out over the wire, so a later reconnect's replay (onSeat, below) has it
 * on hand regardless of whether THIS particular raw connection is still
 * the one attached by then.
 * @param {import("@connectome/seat-protocol").SocketSeat} raw @param {string} being */
function wrapSocketSeat(raw, being) {
  return {
    id: raw.id,
    transport: "socket",
    being,
    runIds: new Set(),
    send: (msg) => {
      const targetRoom = typeof msg.room === "string" && msg.room ? msg.room : raw.room;
      const ring = ringFor(targetRoom);
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

/** harness-port Q3-A, 2026-09-18 (the fork-turn gap): resolve THIS seat's
 * own turn traffic to the parent it handshook onto, or to the CHILD a
 * `!stream in <name>` has since made active (room-fork.mjs's `activeFork`)
 * — `onSeat` used to close over the parent for the connection's whole
 * life, so a turn begun on the fork had its turn.event/turn.done silently
 * dropped (the stale parent had no turn open to match). No fork active:
 * same `rec` as before, no behaviour change.
 * @param {string} roomId @param {{turn?: any}} rec */
function turnRecFor(roomId, rec) {
  const fork = activeFork(roomId);
  if (!fork) return rec;
  return open.get(fork.id) ?? rec;
}

/** @param {{log?: (line: string) => void}} [opts]
 * @returns {SocketSeatServer} */
export function createHouseSeatServer({ log = console.error } = {}) {
  const server = new SocketSeatServer({
    onSeat(raw, handshake) {
      const being = /** @type {any} */ (handshake?.being)?.handle;
      if (!being) {
        log("[seat] a handshake named no being — refused");
        raw.kill();
        return;
      }
      // one live seat per being at a time (the mission's own "always-on
      // walker per being" — a second simultaneous connection for the SAME
      // being is refused, never a second independent seat).
      if (roomsFor(being).some((r) => seatFor(r, being)?.isLive?.() !== false)) {
        log(`[seat] @${being} already has a live seat attached — refusing a second one`);
        raw.kill();
        return;
      }
      const seat = wrapSocketSeat(raw, being);
      const rooms = seatBeing(being, seat);
      seat.runIds = new Set(rooms);
      for (const id of rooms) {
        const rec = open.get(id);
        if (rec) handleSeatReturn(turnRecFor(id, rec), being);
      }
      log(
        `[seat] @${being} seated over the socket transport, attached to ${rooms.length} room(s)` +
          (rooms.length ? `: ${rooms.join(", ")}` : " (none open yet)"),
      );
      // an OPTIONAL resumeFromSeq (the being's own lastSeqSeen from before
      // this connection): replay whatever raw.room's own ring still holds
      // past that point, in order, via raw.send — never seat.send, which
      // would re-buffer the replay as though it were new. Correct for the
      // LEGACY single-room handshake (raw.room names a real room); see
      // this module's own header for the multi-room gap.
      const resumeFromSeq = /** @type {any} */ (handshake)?.resumeFromSeq;
      if (Number.isInteger(resumeFromSeq) && resumeFromSeq >= 0) {
        const missed = ringFor(raw.room).ring.filter((e) => e.seq > resumeFromSeq);
        for (const e of missed) raw.send(e.msg);
        if (missed.length)
          log(`[seat] replayed ${missed.length} line(s) to @${being} since seq ${resumeFromSeq}`);
      }
      raw.onEvent((msg) => {
        // harness-port W6, 2026-09-19: no real room to key `open` on (every
        // platform.* sender stamps the PLATFORM_ROOM sentinel instead,
        // messages.mjs's own note) — routed to the being-hosted seat's own
        // remote host, registered at boot by (being, this message's server).
        if (msg.room === PLATFORM_ROOM) {
          const host = remoteHostFor(being, /** @type {any} */ (msg).server);
          if (!host) {
            log(`[seat] @${being} sent ${msg.type} for an unregistered server ${msg.server} — dropped`);
            return;
          }
          host.receive(msg, seat.send);
          return;
        }
        const targetId = typeof msg.room === "string" && msg.room ? msg.room : raw.room;
        const rec = open.get(targetId);
        if (!rec) {
          log(`[seat] @${being} sent an event for an unknown room ${targetId} — dropped`);
          return;
        }
        handleSeatMessage(turnRecFor(targetId, rec), being, msg);
      });
      raw.onExit(() => {
        log(`[seat] @${being}'s socket left`);
        for (const host of remoteHostsFor(being)) host.wireDetached();
        const attachedRooms = roomsFor(being);
        unregisterSeat(being);
        for (const rec of attachedRooms) {
          const target = turnRecFor(rec.id, rec);
          handleSeatExit(target, being);
          if (target !== rec) rec.seats?.delete(being);
        }
      });
      // harness-port W8-A, 2026-09-19: the handshake ack — sent LAST, once
      // onEvent/onExit are attached above, so a being that waits for it
      // (SeatClient's own `waitForReady`) never has a first send dropped.
      // Through `seat.send` (the ring-tracked wrapper), NOT `raw.send`
      // directly: this module's own ring/wire-seq lockstep invariant
      // (this file's header, "both start at 0... advance by exactly one
      // per send with no gap") must hold for EVERY message on this
      // connection, or a reconnect's resume replay silently drops one
      // (found live, harness-port W8-A: an earlier draft sent this via
      // `raw.send`, skipping the ring, and a real resume then dropped the
      // first buffered line — test/seat-resume.test.mjs's own regression
      // guard is what caught it).
      seat.send({
        type: "seat.ready",
        being,
        ...(Number.isInteger(resumeFromSeq) && resumeFromSeq >= 0 ? { resumedFromSeq: resumeFromSeq } : {}),
      });
    },
    onError(e) {
      log(`[seat] socket seat server error: ${e.message}`);
    },
  });
  return server;
}

export { parseHouseSeatAddr as parseSeatAddr };
