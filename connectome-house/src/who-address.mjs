// @ts-check
/* connectome-house/src/who-address.mjs — the "who is here" clause of the
 * address, derived from the wire's own rendered conversation participants
 * (turn.begin's `context.conversation` — the wire carries no separate
 * roster; see this round's report for the small room-turn.mjs addition
 * that would let this read a real roster instead of an approximation).
 *
 * Reduced from the reference harness's who-address.mjs: that version also
 * read a keeper-attestation store (users.json, `openerLine`/`keepersLine`)
 * this port has no equivalent of — dropped, not guessed at. */

/** the room's population, told honestly, from whoever has actually
 * spoken in the rendered conversation so far — an approximation, not a
 * verified roster.
 * @param {string} walkerName @param {string[]} participants */
export function presenceNote(walkerName, participants) {
  const others = [...new Set(participants)].filter((p) => p && p !== walkerName);
  if (!others.length) return "";
  return `Also present in this conversation so far: ${others.map((p) => `@${p}`).join(", ")}.`;
}
