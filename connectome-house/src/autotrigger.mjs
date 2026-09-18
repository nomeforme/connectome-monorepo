// @ts-check
/* connectome-house/src/autotrigger.mjs — `!autotrigger`'s (C14) own
 * turn-close consumer: registry.mjs's `!autotrigger` command already
 * persists a room's posture (`autotrigger.on`/`.max_speech_only`/
 * `.idle_cycles`, commands/store.mjs's room-scoped memory tier) and
 * dispatch.mjs's `decideAutotriggerReactivation` already computes the
 * pure re-activation decision (harness-port P-A, 2026-09-17) — nothing
 * called either at the point a turn actually closes (10-status.md's own
 * "Not done": "autotrigger re-activation not wired into the turn-close
 * loop"). This module IS that wiring, applied by room-turn.mjs's
 * `closeTurn` on every ordinary ("done") close (harness-port Q1-C,
 * 2026-09-18). Kept as its own file (not inlined into room-turn.mjs,
 * already over this repo's 400-line file ratchet) so the caller supplies
 * its own `reactivate`/`notice` actions rather than this module knowing
 * about `rec`/`beginTurn`/`appendTurnFrame` at all — easy to unit-test in
 * isolation (test/autotrigger.test.mjs) with plain spies. */
import { decideAutotriggerReactivation } from "./dispatch.mjs";
import { memoryGet, memorySet } from "./commands/store.mjs";

/** @param {string|null} roomId the command room key (room-turn.mjs's own
 *   `commandRoomKeyFor`), never a run's own `id` — `null` for a synthetic
 *   room no `!autotrigger` could ever have armed.
 * @param {{handle: string, calledContinueSubstream?: boolean, producedSpeech?: boolean}} turn
 *   the just-closed turn: `calledContinueSubstream` (a `continue_substream`
 *   tool.exec this cycle) and `producedSpeech` (a non-empty `final` speech
 *   event) are both tracked live by room-turn.mjs as the turn ran.
 * @param {{reactivate: () => void, notice: (text: string) => void}} actions
 *   `reactivate` begins the being's next turn immediately (a fresh
 *   `turn.begin`, not `!continue`'s no-tool continuation — the being
 *   decides what to do next from its own rendered context, exactly like
 *   any other activation); `notice` appends a house-authored line to the
 *   record, used only on the idle-cycle safety net firing (O30: "system
 *   notices... emitted by the house verbs that cause them"). No fork text
 *   exists for this specific notice (unlike the byte-exact enabled/
 *   disabled strings, fork-replies.mjs) — this wording is this port's own,
 *   named here as an argued addition, not a ported one (this task's
 *   report).
 * @returns {{reactivated: boolean, ejected: boolean}|null} `null` when
 *   this room has no stream at all, or autotrigger was never armed here —
 *   an honest no-op, distinct from `{reactivated:false, ejected:false}`
 *   (armed, but this cycle's own rule said stop). */
export function applyAutotriggerOnTurnClose(roomId, turn, { reactivate, notice }) {
  if (roomId == null) return null;
  const on = !!memoryGet(roomId, "autotrigger.on", false);
  if (!on) return null;
  const autotrigger = {
    on,
    maxSpeechOnly: memoryGet(roomId, "autotrigger.max_speech_only", undefined),
    idleCycles: memoryGet(roomId, "autotrigger.idle_cycles", 0),
  };
  const decision = decideAutotriggerReactivation({
    autotrigger,
    lastTurn: {
      calledContinueSubstream: !!turn.calledContinueSubstream,
      producedSpeech: !!turn.producedSpeech,
    },
  });
  memorySet(roomId, "autotrigger.idle_cycles", decision.idleCycles);
  if (decision.ejected) {
    notice(`[autotrigger stopped for @${turn.handle} — ${decision.idleCycles} idle cycles in a row]`);
  } else if (decision.reactivate) {
    reactivate();
  }
  return { reactivated: decision.reactivate, ejected: decision.ejected };
}
