// @ts-check
/* connectome-house/src/room-address.mjs — the room's own address
 * fragment: names the room (when the wire says which one — see this
 * round's report) and its posture.
 *
 * Reduced from the reference harness's room-address.mjs, which parsed a
 * private per-project layer file (evals/layers/room.md) into base/beings/
 * life/reopened blocks; this port has no such file (the house carries no
 * `evals/` at all), so the prose is inline, generic, and shorter — no
 * beings/reopened variants, since the wire's `turn.begin` doesn't yet
 * carry enough (a room id, a session ordinal) to tell them apart. */
import { roomPostureClause } from "./room-address-strings.mjs";

/** @param {{roomId: string|null, posture: string|null, hasLife: boolean}} f */
export function roomText(f) {
  if (!f.roomId) return "";
  return `## The room you're in\n\nYou are seated in room "${f.roomId}" through this house's own turn seat. ${roomPostureClause(f.posture)}${
    f.hasLife ? " Some of what you carry here is your own life, not only this room's record." : ""
  }`;
}
