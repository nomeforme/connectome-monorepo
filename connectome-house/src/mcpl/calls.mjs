// @ts-check
/* harness/src/mcpl/calls.mjs — the gate in front of every tools/call the
 * host makes, and the dedupe window in front of every inbound id. SPEC
 * §5.4: the grant is the sole allowlist and absence is denial — so a call
 * is refused HERE, typed, before it reaches the wire, when the server is
 * not ready|degraded, when `tools` is outside the grant, or when the
 * server never listed the tool. The caller (seat.mjs's speak) turns a
 * refusal into a record, never a silent drop. Pure. */

/** the states a tools/call may be attempted in */
export const CALLABLE_STATES = ["ready", "degraded"];

export class GrantRefused extends Error {
  /** @param {{reason: string, message: string}} r */
  constructor(r) {
    super(r.message);
    this.name = "GrantRefused";
    this.reason = r.reason;
  }
}

/** why `name` may not be called right now, or null when it may
 * @param {{state: string, grant: string[], tools: string[]}} st
 * @param {string} name
 * @returns {{reason: "not-ready"|"capability-not-granted"|"tool-not-offered", message: string}|null} */
export function callRefusal(st, name) {
  if (!CALLABLE_STATES.includes(st.state))
    return { reason: "not-ready", message: `the server is ${st.state}` };
  if (!st.grant.includes("tools"))
    return { reason: "capability-not-granted", message: "`tools` is not in the grant" };
  if (st.tools.length && !st.tools.includes(name))
    return { reason: "tool-not-offered", message: `the server lists no tool named ${name}` };
  return null;
}

/** the per-connection dedupe window on eventId/messageId (§9.4): a
 * `remember(id)` that answers false the second time it sees an id, and
 * forgets the oldest past `cap`; a missing id is never a duplicate
 * @param {number} [cap] @returns {(id: string|null|undefined) => boolean} */
export function seenWindow(cap = 2000) {
  const seen = new Set();
  return (id) => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > cap) seen.delete(seen.values().next().value);
    return true;
  };
}
