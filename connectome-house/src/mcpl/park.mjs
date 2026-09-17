// @ts-check
// harness/src/mcpl/park.mjs — a message that met a still-locked room
// (StillLockedError) is queued here and replayed once the room opens.
import { StillLockedError } from "./room-tails.mjs";

const CAP = 50; // a dead stream's queue never grows past this

/** @param {{apply: (msg: any, actions: any[]) => Promise<void>,
 *   say: (line: string) => void, retryMs?: number}} deps */
export function createPark({ apply, say, retryMs = 30_000 }) {
  /** @type {Map<string, {msg: any, actions: any[]}[]>} */
  const queues = new Map();

  function push(stream, entry) {
    const q = queues.get(stream) ?? [];
    q.push(entry);
    queues.set(stream, q.slice(-CAP));
  }

  /** apply(), parking on lock exhaustion instead of throwing past the
   * caller — the platform already got accepted:true.
   * @param {any} msg @param {any[]} actions @param {string} stream */
  async function guarded(msg, actions, stream) {
    try {
      await apply(msg, actions);
    } catch (e) {
      if (!(e instanceof StillLockedError)) throw e;
      push(stream, { msg, actions });
      say(`parked a message for ${stream} — the room would not open; applying once it does`);
    }
  }

  /** every parked job for `stream`, oldest first; a repeat lock stops the
   * drain, leaving the rest queued for next time.
   * @param {string} stream */
  async function drain(stream) {
    const q = queues.get(stream);
    if (!q?.length) return;
    while (q.length) {
      const { msg, actions } = q[0];
      try {
        await apply(msg, actions);
      } catch (e) {
        if (e instanceof StillLockedError) break;
        say(`a parked message for ${stream} failed again, dropped: ${e.message}`);
      }
      q.shift();
    }
    if (!q.length) queues.delete(stream);
  }

  const timer = setInterval(() => {
    for (const stream of queues.keys()) void drain(stream);
  }, retryMs);
  timer.unref();

  return {
    guarded,
    stop: () => clearInterval(timer),
    size: (stream) => queues.get(stream)?.length ?? 0,
  };
}
