// @ts-check
/* harness/src/mcpl/typing.mjs — keep a platform's typing indicator alive
 * for the length of one being's turn: an immediate send plus a re-send
 * every `intervalMs` (a platform's own indicator lapses well under a
 * minute — Discord's around 10s), stopped the moment the turn produces
 * speech or ends without one (seat.mjs's onFrame is the only caller of
 * `stop`, on the same frames it already watches to know a turn ended).
 * Keyed so a room never carries two loops; starting/stopping an
 * already-started/unstarted key is a no-op. No platform knowledge here —
 * `tick`/`onStop` are the caller's own wire calls (seat.mjs passes
 * `host.typing(stream, …)`). */

const DEFAULT_INTERVAL_MS = 8000;

/** @param {{intervalMs?: number}} [opts] */
export function createTypingLoop({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  /** @type {Map<string, ReturnType<typeof setInterval>>} */
  const timers = new Map();
  return {
    /** @param {string} key @param {() => void} tick sends one "still typing" */
    start(key, tick) {
      if (timers.has(key)) return;
      tick();
      const t = setInterval(tick, intervalMs);
      t.unref?.();
      timers.set(key, t);
    },
    /** @param {string} key @param {(() => void)} [onStop] sends one "stopped" */
    stop(key, onStop) {
      const t = timers.get(key);
      if (!t) return;
      clearInterval(t);
      timers.delete(key);
      onStop?.();
    },
    /** every loop still running, cleared with no stop signal (house shutdown) */
    stopAll() {
      for (const t of timers.values()) clearInterval(t);
      timers.clear();
    },
    running: (key) => timers.has(key),
  };
}
