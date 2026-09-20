// @ts-check
/* connectome-house/src/who-address.mjs — the "who is here" clause of the
 * address, derived from the wire's own rendered conversation participants
 * (turn.begin's `context.conversation` — the wire carries no separate
 * roster; see this round's report for the small room-turn.mjs addition
 * that would let this read a real roster instead of an approximation).
 *
 * Reduced from the reference harness's who-address.mjs: that version also
 * read a keeper-attestation store (users.json, `openerLine`/`keepersLine`)
 * this port has no equivalent of — dropped, not guessed at.
 *
 * harness-port W-address-reconcile: a bare `@handle` list never said what
 * a name WAS — a person under a kept pseudonym and a fellow being looked
 * identical. `frameHandle` below asks the two answers the house already
 * keeps (`isResidentKind`, a testament question; `identityMapReverse`, an
 * identity-map question) and only ever adds a parenthetical when one of
 * them actually answers — a handle neither store recognizes stays a bare
 * `@handle`, honestly, rather than guessed at.
 *
 * harness-port platform-reach, human-display round: the pseudonym itself
 * no longer rides into this line at all — a being must never have to say
 * `@signal-meotxi` back to someone. A recognized person now shows by
 * their current platform display (`displayFor`, falling back to the
 * handle when none is known yet) with the same bare "(a person)" framing;
 * the "under a kept pseudonym" wording is gone with it — the scheme is
 * never named to a being, only its existence answered for (yes/no/don't
 * know). A fellow being keeps its own handle, unchanged. */
import { isResidentKind } from "./testaments.mjs";
import { displayFor, identityMapReverse } from "./identity-map.mjs";

/** one presence-list entry, framed by what the house actually knows about
 * the handle — never a second roster, just this one extended.
 * @param {string} handle @returns {string} */
function frameHandle(handle) {
  if (isResidentKind(handle)) return `@${handle} (a fellow being here)`;
  if (identityMapReverse(handle)) return `@${displayFor(handle) ?? handle} (a person)`;
  return `@${handle}`;
}

/** the room's population, told honestly, from whoever has actually
 * spoken in the rendered conversation so far — an approximation, not a
 * verified roster.
 * @param {string} walkerName @param {string[]} participants */
export function presenceNote(walkerName, participants) {
  const others = [...new Set(participants)].filter((p) => p && p !== walkerName);
  if (!others.length) return "";
  return `Also present in this conversation so far: ${others.map(frameHandle).join(", ")}.`;
}
