// @ts-check
// harness/src/mcpl/room-tails.mjs — a seat's own room tracking: mint,
// reuse, or reopen a room live, retried past a transient lock (409).
import { join } from "node:path";
import { tailOffsetFor } from "./cursor.mjs";

const RETRY_MS = 1500;

// a stream lock outlasting ensureLive's own retry budget — the platform
// already got accepted:true, so the caller parks rather than drops it.
export class StillLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "StillLockedError";
    this.code = 409;
  }
}

/** @param {{cfg: {platform: string, being: string, mock?: boolean}, RUNS: string,
 *   openRoom: (opts: object) => Promise<any>,
 *   roomsOpen: (stream: string) => {id: string, beings: string[], live: boolean}|null}} deps */
export function createRoomTails({ cfg, RUNS, openRoom, roomsOpen }) {
  /** @type {Map<string, {stream: string, runDir: string, offset: number}>} */
  const tails = new Map();

  /** tail from the cursor: after the last frame this seat handled.
   * @param {string} id @param {string} stream */
  function trackRoom(id, stream) {
    if (tails.has(id)) return;
    const runDir = join(RUNS, id);
    tails.set(id, { stream, runDir, offset: tailOffsetFor(runDir) });
  }

  /** the room for `stream`, live — minted, returned as-is, or reopened.
   * @param {string} stream @param {{title?: string|null, beings?: string[]|null}} [opts]
   * @param {number} [tries] @returns {Promise<string>} */
  async function ensureLive(stream, { title = null, beings = null } = {}, tries = 4) {
    const known = roomsOpen(stream);
    const roster = beings?.length ? beings : known?.beings?.length ? known.beings : [cfg.being];
    const r = await openRoom({
      platform: cfg.platform,
      stream,
      title,
      beings: roster,
      who: { handle: roster[0], home: cfg.platform },
      mock: cfg.mock,
    });
    if (r.error && r.code === 409 && tries > 1) {
      await new Promise((res) => setTimeout(res, RETRY_MS));
      return ensureLive(stream, { title, beings }, tries - 1);
    }
    if (r.error && r.code === 409) throw new StillLockedError(`openRoom ${stream}: ${r.error}`);
    if (r.error) throw new Error(`openRoom ${stream}: ${r.error}`);
    trackRoom(r.id, stream);
    return r.id;
  }

  return { tails, trackRoom, ensureLive };
}
