// @ts-check
/* connectome-house/src/walk-frame.mjs — one membrane ToolCall -> ToolResult,
 * executed by round-tripping through the house's tool.exec/tool.result
 * (the seat wire, seat/protocol.mjs's message set): the house is the
 * record's sole writer (docs/harness-port/03-house-design.md §1), and
 * room-turn.mjs's handleToolExec already appends the reach/reach.result
 * pair itself and answers "not offered here" for any tool with no
 * registered platform executor — a walker never frames its own reach, it
 * only ever asks and waits.
 *
 * Adapted from the reference harness's walk-frame.mjs (traceReach, a
 * LOCAL trace.mjs writer): that shape assumed the walker itself owned the
 * record. Here every tool call takes this one remote path, registered or
 * not — there is no wire event a being can emit for a reach it resolved
 * itself that also carries a result (seat-protocol's EVENT_SCHEMA has
 * only "reach", never a matching "reach.result"), so self-resolution is
 * not offered as a walker-side option this round. */

/** one in-flight tool.exec, keyed by callId, resolved by the turn loop's
 * own tool.result dispatch (walker.mjs's onMessage). */
export function makePendingToolCalls() {
  const pending = new Map();
  return {
    /** @param {string} callId @param {(msg: {ok: boolean, content: any}) => void} resolve */
    add(callId, resolve) {
      pending.set(callId, resolve);
    },
    /** @param {{callId: string, ok: boolean, content: any}} msg @returns {boolean} handled */
    settle(msg) {
      const resolve = pending.get(msg.callId);
      if (!resolve) return false;
      pending.delete(msg.callId);
      resolve(msg);
      return true;
    },
    size() {
      return pending.size;
    },
  };
}

/** send one tool.exec and resolve to membrane's own ToolResult shape once
 * this call's tool.result arrives.
 * @param {{send: (msg: object) => boolean}} seat @param {string} turnId
 * @param {{id: string, name: string, input: Record<string, unknown>}} call
 * @param {ReturnType<typeof makePendingToolCalls>} pending
 * @returns {Promise<{toolUseId: string, content: any, isError?: boolean}>} */
export function execViaHouse(seat, turnId, call, pending) {
  return new Promise((resolve) => {
    pending.add(call.id, (msg) => {
      resolve({ toolUseId: call.id, content: msg.content, isError: !msg.ok });
    });
    seat.send({ type: "tool.exec", turnId, callId: call.id, tool: call.name, input: call.input ?? {} });
  });
}
