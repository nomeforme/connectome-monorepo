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
 * isolation (test/autotrigger.test.mjs) with plain spies.
 *
 * harness-port W6-R3 (K3 fix, 2026-09-19) — the pacing schedule: the
 * fleet's own numbers (`bot-runtime/src/bot-runtime.ts:914`
 * `AUTOTRIGGER_DEFAULT_DELAY = 2000`, `:919` `AUTOTRIGGER_BACKOFF = 2`,
 * `:917` `AUTOTRIGGER_MAX_DELAY = 300_000`, i.e. 2s -> 4s -> 8s ... capped
 * at 5min; `bot-runtime.ts`'s own `scheduleAutotrigger` always waits
 * `at.delayMs` before a reactivation, win or lose, and re-checks
 * `autotriggerState?.enabled` the moment the timer fires rather than
 * cancelling it directly — "cancelled (disabled during delay)"). Ported
 * as a straight per-cycle PACING device here, not the fleet's own
 * error-only retry: bot-runtime.ts only DOUBLES the delay on a failed
 * reactivation call and resets to 2s on a successful one (a grpc retry
 * backoff), because the fleet's `activateAgent` call can itself fail;
 * the house's turn model has no equivalent success/fail signal at the
 * point a turn simply closes, so every successive reactivation here
 * backs off in turn — an argued addition matching the fleet's OWN
 * numbers and its OWN re-check-at-fire-time cancellation shape, not a
 * byte-identical port of the condition that triggers it. `!autotrigger
 * off` needs no direct timer cancellation because of that same re-check;
 * `resetAutotriggerPacing` (called by `mcpl/room-tails.mjs`'s
 * `applyInputAction` on any human input) is this port's own addition for
 * "reset on a human message" — no fleet citation names that trigger
 * explicitly, so it is named here as argued, not ported. */
import { decideAutotriggerReactivation } from "./dispatch.mjs";
import { memoryGet, memorySet } from "./commands/store.mjs";

const DEFAULT_DELAY_MS = 2000;
const MAX_DELAY_MS = 300_000;
const BACKOFF = 2;

/** per-room pending reactivation timers, room-scoped so a second room's
 * schedule never collides; test-only `_resetAutotriggerTimers` below
 * drops them all (a fresh process starts here too). */
const pendingTimers = new Map();

/** any human input into `roomId` resets the room's own pacing back to
 * the base cadence for its NEXT reactivation — called by
 * `mcpl/room-tails.mjs`'s `applyInputAction` on every human message,
 * whether or not that message itself activates a being. A `null` roomId
 * (a synthetic room `!autotrigger` could never have armed) is a no-op.
 * @param {string|null} roomId */
export function resetAutotriggerPacing(roomId) {
  if (roomId != null) memorySet(roomId, "autotrigger.delay_ms", DEFAULT_DELAY_MS);
}

/** schedule one reactivation `delay` ms out (the room's own current
 * pacing), then double that pacing (capped) for whichever reactivation
 * comes after THIS one. Re-checks `autotrigger.on` the moment the timer
 * fires — `!autotrigger off` (or a room that was simply never re-armed)
 * during the wait cancels this reactivation without any direct timer
 * handling, matching the fleet's own shape.
 * @param {string} roomId @param {() => void} reactivate */
function scheduleReactivation(roomId, reactivate) {
  const delay = memoryGet(roomId, "autotrigger.delay_ms", DEFAULT_DELAY_MS);
  memorySet(roomId, "autotrigger.delay_ms", Math.min(delay * BACKOFF, MAX_DELAY_MS));
  const timer = setTimeout(() => {
    pendingTimers.delete(roomId);
    if (memoryGet(roomId, "autotrigger.on", false)) reactivate();
  }, delay);
  pendingTimers.set(roomId, timer);
}

/** @param {string|null} roomId the command room key (room-turn.mjs's own
 *   `commandRoomKeyFor`), never a run's own `id` — `null` for a synthetic
 *   room no `!autotrigger` could ever have armed.
 * @param {{handle: string, calledContinueSubstream?: boolean, producedSpeech?: boolean}} turn
 *   the just-closed turn: `calledContinueSubstream` (a `continue_substream`
 *   tool.exec this cycle) and `producedSpeech` (a non-empty `final` speech
 *   event) are both tracked live by room-turn.mjs as the turn ran.
 * @param {{reactivate: () => void, notice: (text: string) => void}} actions
 *   `reactivate` begins the being's next turn (scheduled, per this file's
 *   own pacing, above — a fresh `turn.begin`, not `!continue`'s no-tool
 *   continuation — the being decides what to do next from its own
 *   rendered context, exactly like any other activation); `notice` appends
 *   a house-authored line to the record, used only on the idle-cycle
 *   safety net firing (O30: "system notices... emitted by the house verbs
 *   that cause them"). No fork text exists for this specific notice
 *   (unlike the byte-exact enabled/disabled strings, fork-replies.mjs) —
 *   this wording is this port's own, named here as an argued addition,
 *   not a ported one.
 * @returns {{reactivated: boolean, ejected: boolean}|null} `null` when
 *   this room has no stream at all, or autotrigger was never armed here —
 *   an honest no-op, distinct from `{reactivated:false, ejected:false}`
 *   (armed, but this cycle's own rule said stop). `reactivated: true`
 *   means a reactivation was SCHEDULED, not that it has fired yet. */
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
    memorySet(roomId, "autotrigger.delay_ms", DEFAULT_DELAY_MS); // the next `!autotrigger on` starts fresh
    notice(`[autotrigger stopped for @${turn.handle} — ${decision.idleCycles} idle cycles in a row]`);
  } else if (decision.reactivate) {
    scheduleReactivation(roomId, reactivate);
  }
  return { reactivated: decision.reactivate, ejected: decision.ejected };
}

/** test-only: drop every pending timer and its memory (a fresh process
 * would start here too — lets one test file's rooms not bleed timers
 * into another's). Never called by production code. */
export function _resetAutotriggerTimers() {
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
}
