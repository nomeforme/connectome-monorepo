// @ts-check
/* connectome-house/src/seat/protocol.mjs — one typed sender per
 * house→seat wire verb. This file names the message SHAPES (§2.2 of
 * docs/harness-port/03-house-design.md); `stdio-seat.mjs` is one
 * transport that carries them (a child process's stdin, matching the
 * source deployment this was ported from); `socket-seat.mjs` (this
 * package, 2026-09-17) is the other, wrapping `@connectome/seat-protocol`'s
 * `SocketSeatServer` — every sender below is now transport-aware
 * (`rec.seat.transport === "socket"` sends the SAME verb as a structured
 * object matching messages.mjs's schema, instead of a stdio-wrapped
 * string), per this file's own prior invitation: "wire it in here by
 * giving `rec.seat` a `.send(line)` (or, for a structured transport, a
 * `.send(msg)`) that speaks the same verbs." `sendSeatVerb`/`sendSummon`/
 * `sendWalkReport`/`sendFork` have no socket counterpart yet (they carry
 * fork/multi-walker concepts messages.mjs's message set doesn't model) —
 * calling them on a socket seat logs and no-ops rather than sending
 * something the protocol would reject. */

const verb = (msg) => `\x01${JSON.stringify(msg)}\n`;
const isSocket = (rec) => rec?.seat?.transport === "socket";

/** an attributed line — a keeper's input, a room message, or a house line.
 * @param {{id: string, seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {{by: string, text: string, branch?: string, stage?: boolean,
 *   targets?: string[], observe?: boolean, attachments?: string[]}} opts */
export function sendLine(rec, { by, text, branch = rec.id, stage, targets, observe, attachments }) {
  const fields = {
    by,
    text,
    branch,
    ...(stage ? { stage: true } : {}),
    ...(Array.isArray(targets) ? { targets } : {}),
    ...(observe === true ? { observe: true } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
  if (isSocket(rec)) return rec.seat.send({ type: "line", ...fields });
  return rec.seat.send(verb(fields));
}

/** abort the in-flight turn; the branch stays open.
 * @param {{id: string, seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {string} by */
export function sendInterrupt(rec, by) {
  if (isSocket(rec)) return rec.seat.send({ type: "interrupt", by });
  return rec.seat.send(verb({ kind: "interrupt", id: rec.id, by }));
}

/** close a branch gently: "rest" (reopenable) or "seal" (final).
 * @param {{id: string, seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {"rest"|"seal"} mode */
export function sendClose(rec, mode) {
  if (isSocket(rec)) return rec.seat.send({ type: "close", mode });
  return rec.seat.send(verb({ kind: "close", id: rec.id, mode }));
}

/** a participant joined the branch.
 * @param {{id: string, seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {{handle: string, participantKind: "human"|"walker"|"resident"}} opts */
export function sendParticipant(rec, { handle, participantKind }) {
  if (isSocket(rec)) return rec.seat.send({ type: "participant", action: "joined", handle, participantKind });
  return rec.seat.send(
    verb({
      kind: "participant",
      action: "joined",
      handle,
      participant_kind: participantKind,
      branch: rec.id,
    }),
  );
}

/** a being that joined mid-run becomes an active walker.
 * @param {{seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {{handle: string, life: object}} opts */
export function sendSeatVerb(rec, { handle, life }) {
  if (isSocket(rec)) {
    console.error(`[seat/protocol] sendSeatVerb has no socket-transport counterpart yet — dropped for @${handle}`);
    return false;
  }
  return rec.seat.send(verb({ kind: "seat", handle, life }));
}

/** a house-authored world-fact, routed to this branch only.
 * @param {{id: string, seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {object} frame */
export function sendHouseFrame(rec, frame) {
  if (isSocket(rec)) return rec.seat.send({ type: "house.frame", frame });
  return rec.seat.send(verb({ kind: "house", branch: rec.id, frame }));
}

/** a word left at an open door.
 * @param {{id: string, seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {{by: string|null, text: string}} opts */
export function sendSummon(rec, { by, text }) {
  if (isSocket(rec)) {
    console.error("[seat/protocol] sendSummon has no socket-transport counterpart yet — dropped");
    return false;
  }
  return rec.seat.send(verb({ kind: "summon", branch: rec.id, by: by ?? null, text }));
}

/** a resident's own walk, narrated back into its still-open origin room.
 * @param {{id: string, seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {string} text */
export function sendWalkReport(rec, text) {
  if (isSocket(rec)) {
    console.error("[seat/protocol] sendWalkReport has no socket-transport counterpart yet — dropped");
    return false;
  }
  return rec.seat.send(verb({ kind: "walk-report", branch: rec.id, text }));
}

/** a keeper fork: `rec` is the PARENT's rec — the verb names the new
 * branch's dir directly, not `rec.id`.
 * @param {{seat: import("./stdio-seat.mjs").Seat}} rec
 * @param {{id: string, dir: string, seq: number, note?: string|null, by: string}} opts */
export function sendFork(rec, { id, dir, seq, note, by }) {
  if (isSocket(rec)) {
    console.error(`[seat/protocol] sendFork has no socket-transport counterpart yet — dropped for ${id}`);
    return false;
  }
  return rec.seat.send(verb({ kind: "fork", id, dir, seq, ...(note ? { note } : {}), by }));
}

// Cut in this port: the source's `sendAuto` carried a walk-child's own
// auto-orchestration scheduler control line (auto.mjs — a self-pacing
// multi-walker turn loop, out of scope here; see house-design.md §1's
// "clock and dispatch" for what the house itself owns instead).

/** a seat's platform secret/tmp dir must outlive every sibling branch
 * still open under it — fires only once this branch was the last id left
 * in `seat.runIds` (dynamic import sidesteps a cycle back through
 * serve-sse.mjs).
 * @param {{id: string, seat?: import("./stdio-seat.mjs").Seat}} rec */
export function retireSeatBranch(rec) {
  if (!rec.seat) return;
  rec.seat.runIds.delete(rec.id);
  if (rec.seat.runIds.size > 0) return;
  import("../mcpl/being-tools.mjs")
    .then(({ cleanupPlatformRun }) => cleanupPlatformRun(rec.seat.id))
    .catch((e) => console.error(`[seat] platform cleanup failed: ${e.message}`));
}
