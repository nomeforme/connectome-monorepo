// @ts-check
/* connectome-house/src/open-rooms.mjs — the live-room registry: which
 * rooms this house process currently holds open, and the being's-turn
 * SEAT (if any) attached to each. This is the "house-owned room worker"
 * registry docs/harness-port/03-house-design.md §2.1 recommends as the
 * first cut — bookkeeping only; it never itself speaks the seat wire
 * protocol (that's a separate package's job, attached here via
 * `attachSeat`/`seatBeing`).
 *
 * Ported from a private deployment's serve-sse.mjs (2026-09-17): that
 * source fused this registry with a browser SSE broadcast hub and a
 * dissolve pipeline that shelled out to several corpus-composition
 * tools (a UI/product concern, out of scope for this port — see
 * house-design.md's list of what the entrypoint leaves out). What's kept
 * here is just the registry `open` and `foregrounds`/broadcast callers
 * elsewhere in the source depended on; a deployment wanting live UI
 * updates wires its own subscriber layer on top of `open`, or listens
 * for the `onFrame` hook below.
 *
 * harness-port W4-A, 2026-09-19 (the fleet's own problem: "each container
 * had bots that were always listening everywhere they were added" —
 * one process per (bot, room) doesn't scale to 21 beings present in many
 * rooms at once). `seatsByBeing` is the being-keyed source of truth: one
 * live seat per being, attached wherever that being is present.
 * `seatBeing`/`unregisterSeat`/`attachRegisteredSeat`/`roomsFor` are the
 * seam a transport (seat/socket-seat.mjs) and a room's own open/reopen
 * path (serve-rooms.mjs) both call into, so neither has to know how the
 * other finds "every room this being is in" itself.
 *
 * harness-port W7, 2026-09-19: `rec.seat` was a ROOM-singular slot (one
 * seat answers a room's turns at a time) — a second being present got no
 * seat at all once the room already held one, the exact bug this task
 * fixes (see room-seats.mjs's own header). `rec.seats: Map<being, Seat>`
 * replaces it — every being present may hold its own seat, independently;
 * `seatFor(rec, being)` is the one place that reads it. `room-seats.mjs`'s
 * `initSeatState` additionally installs a `rec.seat` GETTER (the room's
 * primary being's own seat, falling back to whichever one being holds one
 * — see that module) so every NO-TOUCH consumer reading the old singular
 * field keeps working unchanged.
 *
 * @typedef {{
 *   id: string,
 *   runDir: string,
 *   cls: any,
 *   status: "open" | "rested" | "aborted",
 *   scope?: {visibility: string, owner: string|null, participants: string[]},
 *   standing?: boolean,
 *   seats: Map<string, (import("./seat/stdio-seat.mjs").Seat | any)>,
 *   seat?: (import("./seat/stdio-seat.mjs").Seat | any) | null,
 *   framesOffset?: number,
 *   turns: Map<string, {turnId: string, handle: string, resolve: (v: any) => void}>,
 *   turn?: {turnId: string, handle: string, resolve: (v: any) => void} | null,
 * }} OpenRoomRec
 */
import { beingsOf } from "./beings.mjs";

/** id -> OpenRoomRec — every room this process currently holds a record
 * for, live or resting. A room leaves this map only when its record is
 * dissolved; "rested" and "aborted" rooms stay here (reopenable) rather
 * than a separate registry, so `open.get(id)` is always the one place to
 * ask "does this house know this room right now". */
export const open = new Map();

/** being handle -> its one live seat, whichever transport attached it —
 * the source of truth for "is this being seated at all right now", read
 * across every room its seat currently serves (`roomsFor`) rather than
 * any one room's own slot. A being drops its OWN entry here on exit
 * (`unregisterSeat`); a room never removes another being's entry. */
export const seatsByBeing = new Map();

/** being handle -> Map<server name, remote host> — every being-hosted
 * MCPL seat's host (mcpl/remote-host.mjs, harness-port W6, 2026-09-19)
 * waiting for, or already attached to, that being's own ONE seat
 * connection. Registered once at boot (mcpl/routes.mjs's `bootSeats`,
 * for every `hosted_by: "being"` server) — never re-registered, so a
 * being that connects later, or reconnects, finds the SAME instance
 * (`remoteHostFor`) rather than a fresh one. Looked up by
 * seat/socket-seat.mjs on every `platform.*` message a being's
 * connection carries — these have no real room, so this registry (keyed
 * by being + the message's own `server` field) stands in for `open`'s
 * room-keyed lookup. */
export const remoteHostsByBeing = new Map();

/** @param {string} being @param {string} serverName @param {any} host */
export function registerRemoteHost(being, serverName, host) {
  let m = remoteHostsByBeing.get(being);
  if (!m) {
    m = new Map();
    remoteHostsByBeing.set(being, m);
  }
  m.set(serverName, host);
}

/** @param {string} being @param {string} serverName @returns {any} */
export function remoteHostFor(being, serverName) {
  return remoteHostsByBeing.get(being)?.get(serverName) ?? null;
}

/** every remote host registered for `being`, whichever server(s) it names
 * — a dropped connection (`wireDetached`) touches all of them at once.
 * @param {string} being @returns {any[]} */
export function remoteHostsFor(being) {
  return [...(remoteHostsByBeing.get(being)?.values() ?? [])];
}

/** boot-time only: every registered remote host, for `stopSeats()` to
 * clear alongside the ordinary seats map. */
export function clearRemoteHosts() {
  remoteHostsByBeing.clear();
}

/** `rec.seats.get(being)`, honest null off no map, no being, or no entry —
 * the ONE place every caller reads "does this being hold a seat HERE".
 * @param {OpenRoomRec|any} rec @param {string|null|undefined} being */
export function seatFor(rec, being) {
  return (being && rec?.seats?.get(being)) || null;
}

/** CLEARLY-NAMED HOOK: attach a being's-turn seat to an already-open room
 * record directly, by room id, keyed by the seat's own `.being` — the
 * single-room primitive every transport still has (the house is always
 * the record's writer whether or not a being is currently seated to
 * answer it). `seatBeing` (below) is the being-keyed counterpart most
 * callers actually want now; this stays for a caller that already knows
 * the exact room and seat (no production call site today; kept for a
 * caller that does, and for tests). */
export function attachSeat(id, seat) {
  const rec = open.get(id);
  if (rec && seat?.being) rec.seats.set(seat.being, seat);
}

/** every open room `being` currently holds A seat in (its own turns AND
 * any fork/child room that inherited the same seat object at fork time,
 * room-tails.mjs's `applyCommandAction`) — the one place both the attach
 * and the detach path ask "which rooms does this affect". */
export function roomsFor(being) {
  return [...open.values()].filter((rec) => rec.seats?.has(being));
}

/** register `being`'s live seat and attach it to every currently open
 * room whose roster (`beingsOf`) already names it — harness-port W7's own
 * rule (the bug this answers): EVERY room the being is present in gets
 * its own seat entry, regardless of who else already holds a seat there
 * (the pre-W7 "a room already holding SOME seat is left alone" rule is
 * exactly what silenced a second being). Skipped only when THIS being
 * already has an entry there (idempotent re-registration). Returns the
 * room ids actually attached (for a caller's own log line). */
export function seatBeing(being, seat) {
  seatsByBeing.set(being, seat);
  const attached = [];
  for (const rec of open.values()) {
    if (rec.seats?.has(being)) continue;
    if (beingsOf(rec.cls).includes(being)) {
      rec.seats.set(being, seat);
      attached.push(rec.id);
    }
  }
  return attached;
}

/** drop a being's registration (its seat has gone away) — never touches
 * any room's own `rec.seats` entries itself; the caller (socket-seat.mjs's
 * onExit) still owns closing each affected room's in-flight turn via
 * `roomsFor(being)` BEFORE calling this, then clearing that being's own
 * `rec.seats` entry there (room-seats.mjs's `handleSeatExit` does both in
 * one step). Ordered this way so a fresh reconnect racing the drop never
 * sees a stale "already seated" entry outlive the rooms that named it. */
export function unregisterSeat(being) {
  seatsByBeing.delete(being);
}

/** a room just opened, reopened, or gained a participant: every one of
 * its own beings that already has a LIVE registered seat and no seat of
 * its OWN in this room yet gets attached now — harness-port W7: every
 * present being, not just the first found (the mission's own rule: "a
 * room opened AFTER the seat attached... gets the seat too", for EVERY
 * being, not one). Returns whether anything was attached.
 * @param {OpenRoomRec} rec @returns {boolean} */
export function attachRegisteredSeat(rec) {
  let attachedAny = false;
  for (const being of beingsOf(rec.cls)) {
    if (rec.seats?.has(being)) continue;
    const seat = seatsByBeing.get(being);
    if (seat && (typeof seat.isLive !== "function" || seat.isLive())) {
      rec.seats.set(being, seat);
      attachedAny = true;
    }
  }
  return attachedAny;
}

/* ---------- a simple named-key mutex ---------- */
const lifecycleBusy = new Set();
/** @param {string} key @returns {boolean} true iff the lock was free and is now held */
export function lifecycleLock(key) {
  if (lifecycleBusy.has(key)) return false;
  lifecycleBusy.add(key);
  return true;
}
/** @param {string} key */
export function lifecycleUnlock(key) {
  lifecycleBusy.delete(key);
}
