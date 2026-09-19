// @ts-check
/* connectome-house/src/mcpl/seat-bus.mjs — one seat's own frame-delivery
 * plumbing (harness-port W7-b, 2026-09-19), extracted from seat.mjs (446
 * lines, already over its own cap, may not grow) to keep that file under
 * its own line-length ratchet: subscribes ONCE to frames-io.mjs's
 * house-wide `frameBus`, so a room this seat tails is drained the INSTANT
 * the house appends a frame to it, through the exact same offset-cursor
 * step the old 250ms poll used — never a second delivery path, only a
 * faster trigger for the one that existed. `checkSelf`/`redeliverCheck`
 * keep their OWN pre-bus cadence (`FAST_MS`) — neither reacts to
 * frames.jsonl, so the bus doesn't touch them.
 *
 * The idempotence guard is the byte offset itself: whichever caller
 * drains a room first (the bus event, or `sweepTails`' own tick) advances
 * `t.offset` past whatever it just read, so the other can never re-read
 * those same bytes — both run synchronously (one thread, sync fs calls),
 * so there is no window for the two to race over the same frame.
 */
import { basename, join } from "node:path";
import { frameBus } from "../frames-io.mjs";

const FAST_MS = 250;
const SWEEP_MS = 5000;

/** @param {{tails: Map<string, {runDir: string, stream: string, offset: number, forkName?: string|null}>,
 *   tailFrames: (path: string, offset: number) => {frames: any[], offset: number},
 *   onFrame: (roomId: string, stream: string, runDir: string, f: any, forkName?: string|null) => void,
 *   checkSelf: () => void, redeliverCheck: (tails: Map<string, any>) => void}} deps
 * @returns {{startupSweep: () => void, drainOne: (roomId: string) => void, stop: () => void}} */
export function createFrameDelivery({ tails, tailFrames, onFrame, checkSelf, redeliverCheck }) {
  /** one room's own tail-then-dispatch step — the ONE place either the
   * bus or the sweep advances `t.offset`, so neither can hand the same
   * frame to `onFrame` twice. */
  function drainRoom(roomId, t) {
    const { frames, offset } = tailFrames(join(t.runDir, "frames.jsonl"), t.offset);
    t.offset = offset;
    for (const f of frames) onFrame(roomId, t.stream, t.runDir, f, t.forkName);
  }
  /** every tailed room's own catch-up sweep — a startup pass
   * (`startupSweep`, seat.mjs's own start()) plus a slow (SWEEP_MS)
   * safety net for anything the bus missed (a writer that doesn't route
   * through frames-io.mjs's `appendHouseFrame` yet, or a frame appended
   * before this seat's own subscribe below). */
  function sweepTails() {
    for (const [roomId, t] of tails) drainRoom(roomId, t);
  }
  /** `runDir` is always `join(RUNS, roomId)` (mcpl/room-tails.mjs's own
   * `trackRoom`) — `basename` recovers the roomId this seat tracks it
   * under, no reverse scan of `tails` needed.
   * @param {{runDir: string}} ev */
  const onBusFrame = ({ runDir }) => {
    const roomId = basename(runDir);
    const t = tails.get(roomId);
    if (t) drainRoom(roomId, t);
  };
  frameBus.on("frame", onBusFrame);
  const sweepTimer = setInterval(sweepTails, SWEEP_MS);
  sweepTimer.unref();
  const fastTimer = setInterval(() => {
    checkSelf();
    redeliverCheck(tails);
  }, FAST_MS);
  fastTimer.unref();
  return {
    startupSweep: sweepTails,
    /** a caller that's about to stop tracking one room (mcpl/room-tails.mjs's
     * own `!stream out`) drains it once first — the sweep might not reach
     * it again before the room is gone from `tails` entirely. */
    drainOne(roomId) {
      const t = tails.get(roomId);
      if (t) drainRoom(roomId, t);
    },
    stop() {
      frameBus.off("frame", onBusFrame);
      clearInterval(sweepTimer);
      clearInterval(fastTimer);
    },
  };
}
