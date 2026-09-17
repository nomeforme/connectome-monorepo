// @ts-check
/* connectome-house/src/open-rooms.mjs — the live-room registry: which
 * rooms this house process currently holds open, and the being's-turn
 * SEAT (if any) attached to each. This is the "house-owned room worker"
 * registry docs/harness-port/03-house-design.md §2.1 recommends as the
 * first cut — bookkeeping only; it never itself speaks the seat wire
 * protocol (that's a separate package's job, attached here via
 * `attachSeat`).
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
 * @typedef {{
 *   id: string,
 *   runDir: string,
 *   cls: any,
 *   status: "open" | "rested" | "aborted",
 *   scope?: {visibility: string, owner: string|null, participants: string[]},
 *   standing?: boolean,
 *   seat?: import("./seat/stdio-seat.mjs").Seat | null,
 *   framesOffset?: number,
 * }} OpenRoomRec
 */

/** id -> OpenRoomRec — every room this process currently holds a record
 * for, live or resting. A room leaves this map only when its record is
 * dissolved; "rested" and "aborted" rooms stay here (reopenable) rather
 * than a separate registry, so `open.get(id)` is always the one place to
 * ask "does this house know this room right now". */
export const open = new Map();

/** CLEARLY-NAMED HOOK: attach a being's-turn seat to an already-open room
 * record. A room worker is usable with `seat: null` (the record still
 * accepts and stores input — the house is always the record's writer,
 * whether or not a being is currently seated to answer it); a caller
 * that actually wants a being to turn on this room's traffic calls this
 * once it has connected one (the socket transport is a separate
 * package's job — see seat/stdio-seat.mjs's own header). */
export function attachSeat(id, seat) {
  const rec = open.get(id);
  if (rec) rec.seat = seat;
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
