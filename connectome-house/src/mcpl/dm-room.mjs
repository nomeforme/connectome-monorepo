// @ts-check
/* connectome-house/src/mcpl/dm-room.mjs — a DM is one seat's room, on every
 * platform (2026-11-06: a person DMed one Signal number and got a reply
 * from all 21 — every "any" seat had joined the room, and every Signal
 * number shared it, since the room was keyed by the person alone).
 *
 * The rule, applied as a function of what each platform's DM ids mean
 * (the adapter's `dmIdScope`):
 * - a DM holds exactly one being — the seat's own; no sibling seat joins,
 *   whatever its rooms_policy, and only that being is ever activated;
 * - "peer"-scoped ids (Signal: `signal:dm:<uuid>` is the same for every
 *   house number) are keyed by the receiving being —
 *   `signal:dm:<digest(being)>:<digest(peer)>` (stream-key.mjs's ownDMKey).
 *   A room minted under the bare id before this rule is still this seat's
 *   when its own being owns it;
 * - "account"-scoped ids (Discord: one DM channel per bot) already name
 *   one seat's room, so the id is used as is;
 * - a platform with no DMs (the web board, contract v0) is untouched. If
 *   it ever grows DMs, its adapter's roomKind says so and the rule applies.
 *
 * Outbound is unaffected: a seat always speaks to the raw platform id
 * (room-tails.mjs's trackRoom), whichever key the room was minted under. */
import { ownDMKey as signalDMKey } from "../stream-key.mjs";
import { adapterFor, isDMStream } from "./adapters.mjs";

/** whether `stream` is a DM on `platform` (the adapter's own roomKind).
 * @param {string} platform @param {string} stream */
export function isDM(platform, stream) {
  return !!stream && isDMStream(adapterFor(platform), stream);
}

/** the key `being`'s seat files `stream` under, when that differs from
 * the raw id: only a "peer"-scoped DM id. Null otherwise (use the id).
 * @param {string} platform @param {string} stream @param {string} being
 * @returns {string|null} */
export function ownDMKey(platform, stream, being) {
  if (!isDM(platform, stream) || adapterFor(platform).dmIdScope !== "peer") return null;
  return signalDMKey(platform, stream, being);
}

/** @typedef {{id: string, stream?: string, beings: string[], owner?: string|null, live?: boolean}} RoomRef */

/** the room `being`'s seat means by `stream`: a non-DM, or an
 * account-scoped DM, is whatever room the id names; a peer-scoped DM is
 * the being-keyed room, else a bare-keyed one only when this being owns it.
 * @param {{platform: string, stream: string, being: string, roomAt: (key: string) => RoomRef|null}} args
 * @returns {RoomRef|null} */
export function resolveOwnRoom({ platform, stream, being, roomAt }) {
  const own = ownDMKey(platform, stream, being);
  if (!own) return roomAt(stream);
  const keyed = roomAt(own);
  if (keyed) return keyed;
  const bare = roomAt(stream);
  return bare && bare.owner === being ? bare : null;
}
