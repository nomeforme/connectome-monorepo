// @ts-check
/* connectome-house/src/room-address-strings.mjs — the room's small pure
 * prose composers. Reduced from the reference harness's room-address-
 * strings.mjs: that version composed a fork-specific "own continuation"
 * address (a CLI-spawned run's own closing-message concept); this port's
 * room never closes that way (the house rests or dissolves it — see
 * room-turn.mjs, not this file), so only the posture clause carries over. */

/** the posture-specific paragraph — its own export so a test can check
 * it without the whole address.
 * @param {string|null} posture */
export function roomPostureClause(posture) {
  if (posture === "present")
    return "You are reachable here: an addressed word asks for an answer; an unaddressed one enters the room and asks nothing of you.";
  if (posture === "resident")
    return "You rest here unless woken: what wakes you reaches you as a real turn, never a message left waiting.";
  return "A turn that reaches you here is real and owed an answer, the same as anywhere else you are addressed.";
}
