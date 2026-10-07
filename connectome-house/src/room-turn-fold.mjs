// @ts-check
/* connectome-house/src/room-turn-fold.mjs — turn.event -> record fold,
 * extracted from room-turn.mjs (harness-port W3-A, 2026-09-18) to keep
 * that file under its own line-length ratchet.
 *
 * The 2026-09-18 defect (a real probe, docs/harness-port/13-walker-port.md):
 * a 60-token turn produced 30 `speech` frames, one per streamed `tokens`
 * event, every one `interim: true`, no final. `tokens` now writes NO frame
 * — the walker already folds a streamed segment into its own `final`
 * (walk-turn.mjs's `segText`). A `final` segment isn't provably the turn's
 * last word when it arrives (a tool round may still follow), so it's held
 * in `turn.pendingFinal` until a tool call proves it was interim, or the
 * turn's own close (room-turn.mjs's `closeTurn`) proves it was the true
 * final. */

/** flush a buffered final segment as a `speech` frame — interim (a tool
 * call or a new segment followed it) or the turn's true final (the turn
 * closed with nothing pending after it). A no-op with nothing buffered.
 * @param {(rec: any, fields: object) => object} appendTurnFrame
 * @param {any} rec @param {{handle: string, pendingFinal: string|null, producedSpeech: boolean}} turn
 * @param {boolean} interim */
export function flushPendingFinal(appendTurnFrame, rec, turn, interim) {
  if (turn.pendingFinal == null) return;
  appendTurnFrame(rec, { type: "speech", by: turn.handle, ...(interim ? { interim: true } : {}), inline: turn.pendingFinal });
  // a whitespace-only segment is not `!autotrigger`'s (C14) own "produced real speech" fact.
  if (turn.pendingFinal.trim()) turn.producedSpeech = true;
  turn.pendingFinal = null;
}

/** one `turn.event` folded into the record — see this module's own header.
 * `reach` flushes any pending final first (the same "a tool call proves it
 * wasn't the last word" reasoning as a real `tool.exec`).
 * @param {(rec: any, fields: object) => object} appendTurnFrame
 * @param {any} rec @param {{handle: string, pendingFinal: string|null, producedSpeech: boolean}} turn
 * @param {any} event */
export function foldTurnEvent(appendTurnFrame, rec, turn, event) {
  if (event?.kind === "tokens") return; // in-memory on the wire already (walk-turn.mjs's segText)
  if (event?.kind === "final") {
    flushPendingFinal(appendTurnFrame, rec, turn, true); // defensive: a new segment before a tool boundary
    turn.pendingFinal = String(event.text ?? "");
  } else if (event?.kind === "reach") {
    flushPendingFinal(appendTurnFrame, rec, turn, true);
    appendTurnFrame(rec, {
      type: "reach",
      by: turn.handle,
      tool: event.name,
      input: event.input ?? {},
      ...(typeof event.id === "string" ? { callId: event.id } : {}),
    });
  }
}
