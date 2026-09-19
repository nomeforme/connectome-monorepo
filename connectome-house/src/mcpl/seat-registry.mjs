// @ts-check
/* connectome-house/src/mcpl/seat-registry.mjs — every live MCPL seat's own
 * room-tracking hook, keyed by (platform, being): the house-side answer to
 * the second-consumer lag (2026-09-19 two-beings-on-Signal incident, bug
 * A) — a seat's own `trackRoom` (room-tails.mjs) used to fire only once
 * THAT seat's own platform child delivered its copy of a message, so a
 * slow second delivery (the known upstream drop risk) delayed a sibling
 * being's reply by however long its own copy took to land.
 * `trackRoomOnAllSeats`, called from room-tails.mjs's `ensureLive` the
 * moment ANY seat opens or records into a room, starts every OTHER
 * matching seat tracking that same room AT ONCE, house-side — a slow
 * duplicate then affects only its own dedup record (serve-rooms.mjs's
 * `roomInput`), never a reply's timing.
 *
 * Also closes bug B (rooms_policy: "any"): a sibling seat whose OWN being
 * isn't yet a participant, but whose own server's `rooms_policy` is
 * "any" (serves every stream on this platform by definition — axon
 * parity, config-policy.mjs's `isPublicRoom`), joins the room as a
 * resident here too — the same `addParticipant(..., "config", "resident")`
 * openRoom's own `mergeConfiguredBeings` uses, just reached proactively
 * rather than waiting for that being's own (possibly late, or never)
 * copy to trigger it. Idempotent both ways — safe to call on every
 * incoming message, not just a room's first. */
import { join } from "node:path";
import { beingsOf } from "../beings.mjs";
import { readCls } from "../room-policy.mjs";
import { addParticipant } from "../serve-rooms.mjs";
import { RUNS } from "../serve-paths.mjs";

/** `${platform}:${being}` -> {platform, being, roomsPolicy, trackRoom} */
const registry = new Map();

/** a seat's own `trackRoom` (room-tails.mjs's `createRoomTails`), offered
 * for `trackRoomOnAllSeats` to reach on every OTHER seat's behalf —
 * registered once per seat at creation; a restart just replaces the key.
 * @param {string} platform @param {string} being @param {"listed"|"any"|undefined} roomsPolicy
 * @param {(id: string, stream: string) => void} trackRoom */
export function registerSeatTracking(platform, being, roomsPolicy, trackRoom) {
  registry.set(`${platform}:${being}`, { platform, being, roomsPolicy, trackRoom });
}

/** boot/test hygiene: drop every registration (routes.mjs's `stopSeats`). */
export function clearSeatRegistry() {
  registry.clear();
}

/** every OTHER registered seat on `platform` that should already be
 * tracking `roomId` right now: already present in its roster, or its own
 * server's `rooms_policy` is "any". A policy-"any" sibling not yet a
 * participant joins as a resident first (bug B), then tracks (bug A).
 * @param {string} roomId @param {string} stream @param {string} platform
 * @param {string} excludeBeing the calling seat's own being — never re-enters itself */
export function trackRoomOnAllSeats(roomId, stream, platform, excludeBeing) {
  const runDir = join(RUNS, roomId);
  let roster;
  try {
    roster = beingsOf(readCls(runDir));
  } catch {
    roster = [];
  }
  for (const entry of registry.values()) {
    if (entry.platform !== platform || entry.being === excludeBeing) continue;
    const present = roster.includes(entry.being);
    if (!present && entry.roomsPolicy !== "any") continue;
    if (!present) addParticipant(runDir, roomId, entry.being, "local", "config", "resident");
    entry.trackRoom(roomId, stream);
  }
}
