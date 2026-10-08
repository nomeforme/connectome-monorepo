// @ts-check
/* connectome-house/src/mcpl/identity-gate.mjs — the ONE place the house
 * decides whether a sender must be a linked/known identity before they may
 * wake a being. Platform-agnostic by construction: nothing here names a
 * platform. Everything platform-shaped arrives as an argument — the room kind
 * (adapter.roomKind), the sender (identityFor over adapter.sender), the
 * platform noun for notices (adapter.label), how to send a bare reply
 * (adapter.bareReply).
 *
 * Two concerns used to ride on `rooms_policy`; they are now separate:
 *   ADMISSION      rooms_policy: "listed"|"any"  — which streams become rooms.
 *   IDENTITY GATE  identity_gate: "off"|"dm"|"rooms"|"all" — whether an
 *                  unlinked sender may wake a being, per room kind.
 * The gate is a dormant mechanism: DEFAULT "off" (the monorepo has no house
 * app where anyone could get a link code). Turn it on, globally or per
 * server, when an identity surface exists and some privacy is wanted:
 *   "off"   no interception, no unlinked notices, anyone may wake a being
 *   "dm"    1:1 conversations need a linked sender (or the keeper)
 *   "rooms" groups/channels need a linked sender, unless the room is
 *           `public: true` (or "any"-admitted, config-policy.mjs isPublicRoom)
 *   "all"   both
 * A string enum, not {dm, rooms}: one value reads at a glance in servers.json,
 * validates with one membership test, and "all" is the natural strict end.
 * Keeper exemption and bot exemption hold in every mode.
 *
 * `link <code>` redemption (link.mjs) is part of the mechanism: handled in
 * DMs whenever the gate is on in any mode, and plain text when it is off
 * (nobody can mint a code without an identity surface, and a dormant gate
 * should add no hidden command channel). */

/** the valid `identity_gate` values; "off" is the default everywhere. */
export const IDENTITY_GATES = new Set(["off", "dm", "rooms", "all"]);

/** @param {any} v @returns {"off"|"dm"|"rooms"|"all"} unset/unknown reads "off" */
export function gateMode(v) {
  return IDENTITY_GATES.has(v) ? v : "off";
}

/** whether `mode` gates this kind of room. @param {string|undefined} mode
 * @param {string} roomKind "dm" | "group" | "channel" @returns {boolean} */
export function gateCovers(mode, roomKind) {
  const m = gateMode(mode);
  return roomKind === "dm" ? m === "dm" || m === "all" : m === "rooms" || m === "all";
}

/** whether `mode` is anything but off. @param {string|undefined} mode */
export const gateIsOn = (mode) => gateMode(mode) !== "off";

/** a DM sender who is a known, linked identity or the keeper — the
 * predicate the DM gate shares with unlisted-DM admission.
 * @param {{messageKind: string, sender: {known: boolean, handle: string, linked?: boolean},
 *   isKeeper: (handle: string) => boolean}} args @returns {boolean} */
export function admitsUnlistedDM({ messageKind, sender, isKeeper }) {
  return (
    messageKind === "dm" && sender.known && (sender.linked === true || isKeeper(sender.handle))
  );
}

/** may this sender wake beings in this kind of room?
 * @param {{mode: string|undefined, roomKind: string, byKind?: string,
 *   sender: {known: boolean, handle: string, linked?: boolean},
 *   isKeeper: (handle: string) => boolean, publicRoom?: boolean}} args
 * @returns {{allowed: true}|{allowed: false, reason: "unlinked-dm"|"unlinked-room", notice: "dm"|"room"}} */
export function senderMayWake({ mode, roomKind, byKind = "human", sender, isKeeper, publicRoom = false }) {
  if (!gateCovers(mode, roomKind)) return { allowed: true };
  if (isKeeper(sender.handle)) return { allowed: true };
  if (roomKind === "dm") {
    return admitsUnlistedDM({ messageKind: "dm", sender, isKeeper })
      ? { allowed: true }
      : { allowed: false, reason: "unlinked-dm", notice: "dm" };
  }
  if (byKind !== "human" || publicRoom || sender.linked === true) return { allowed: true };
  return { allowed: false, reason: "unlinked-room", notice: "room" };
}

/** the fixed, never-routed notice for a refused sender. `label` is the
 * adapter's platform noun; with no `appUrl` nothing promises an app that
 * may not exist. @param {{kind: "dm"|"room", label: string, appUrl: string|null}} args */
export function gateNotice({ kind, label, appUrl }) {
  if (!appUrl)
    return kind === "room"
      ? `This house isn't accepting messages from unlinked ${label} accounts, so this room can't wake it for you.`
      : `This house isn't accepting messages from unlinked ${label} accounts.`;
  const tail = kind === "room" ? ", so this room can't wake it for you" : "";
  return `This ${label} account isn't connected to a house app account yet${tail}. Sign in at ${appUrl} and connect this account from your account settings.`;
}
