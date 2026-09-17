// @ts-check
// harness/src/mcpl/room-tails.mjs — a seat's own room tracking: mint,
// reuse, or reopen a room live, retried past a transient lock (409); and
// (harness-port R2-X, 2026-09-17, mission task 1) applying a routed
// `{kind:"command"}` action against that same live room.
import { join } from "node:path";
import { open } from "../open-rooms.mjs";
import { applyInterrupt, applySteer } from "../room-turn.mjs";
import { canonicalStream } from "../stream-key.mjs";
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

/** route.mjs's own primary/account computation (mission task 2), kept
 * here rather than imported from route.mjs (NO-TOUCH) — a short, pure
 * rule stream-key.mjs's own header already documents; duplicated
 * deliberately rather than reached for across that boundary.
 * @param {{primary?: boolean|((account: string) => boolean), being_id?: string|null,
 *   number_id?: string|null}} cfg */
function accountKeyOf(cfg) {
  const account = cfg.being_id ?? cfg.number_id ?? null;
  const flag = cfg.primary ?? true;
  const isPrimary = typeof flag === "function" ? flag(account) : flag;
  return { account, isPrimary };
}

/** @param {{cfg: {platform: string, being: string, mock?: boolean, primary?: boolean,
 *   being_id?: string|null, number_id?: string|null}, RUNS: string,
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
   * Looked up (and, for a non-primary Signal account, MINTED) by the same
   * canonical key route.mjs's own routeIncoming decides with — so two
   * Signal servers DMed by the same peer land in two rooms, never one
   * (mission task 2). The PRIMARY account (or any non-Signal-DM stream,
   * where canonicalStream is the identity) keeps minting under the exact
   * raw `stream`, unchanged — openRoomLocked's own comment: "a fresh mint
   * keeps the raw stream... never a rewrite at birth"; a non-primary
   * account mints under the canonical, account-scoped key instead — the
   * only seam available from an owned file that stops openRoom's own
   * (NO-TOUCH) findRoom from reusing the primary account's room for the
   * very same peer. `trackRoom` below always keys off the TRUE raw
   * `stream` regardless, so outbound delivery (speak.mjs's `channelId`)
   * is never affected by which key a room minted under.
   * @param {string} stream @param {{title?: string|null, beings?: string[]|null}} [opts]
   * @param {number} [tries] @returns {Promise<string>} */
  async function ensureLive(stream, { title = null, beings = null } = {}, tries = 4) {
    const { account, isPrimary } = accountKeyOf(cfg);
    const lookupStream = canonicalStream(cfg.platform, stream, { account, primary: isPrimary });
    const known = roomsOpen(lookupStream) ?? (isPrimary ? roomsOpen(stream) : null);
    const roster = beings?.length ? beings : known?.beings?.length ? known.beings : [cfg.being];
    const mintStream = isPrimary ? stream : lookupStream;
    const r = await openRoom({
      platform: cfg.platform,
      stream: mintStream,
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

/** a routed `{kind:"command"}` action (route.mjs, mission task 1) against
 * a live seat: ensures the room, records the raw command line observe-
 * only (no activation — `targets: []` bypasses roomInput's own activation
 * decision entirely), applies an `interrupt`/`steer` intent to the room's
 * open turn via room-turn.mjs's own hooks, then sends the command's
 * `reply` back through the seat's speak path AS THE HOUSE, quoting the
 * command message (`replyTo`). A `setting` intent needs nothing further
 * here — commands/store.mjs already persisted it before route.mjs ever
 * returned the action; `swallow`/`continue`/`input-trim`/`stream`/
 * `secret-*` have no live seat-side consumer yet (a named gap, not a
 * silent skip — see this task's own report).
 * @param {{cfg: {platform: string}, ensureLive: (stream: string, opts: object) => Promise<string>,
 *   roomInput: (args: object) => Promise<any>, speak: (roomId: string, stream: string,
 *   text: string, opts: object) => Promise<void>, say: (line: string) => void}} deps
 * @param {{stream: string, by: string, roomTitle: string|null, reply: string|null,
 *   intent: Record<string, any>|null}} action
 * @param {{messageId?: string|null, text: string}} msgCtx
 * @returns {Promise<string>} the room id the command was applied against */
export async function applyCommandAction({ cfg, ensureLive, roomInput, speak, say }, action, msgCtx) {
  const roomId = await ensureLive(action.stream, { title: action.roomTitle ?? null });
  const r = await roomInput({
    id: roomId,
    by: action.by,
    home: cfg.platform,
    text: msgCtx.text,
    targets: [],
    observe: true,
    external: { platform: cfg.platform, message_id: msgCtx.messageId ?? undefined },
  });
  if (r.error) say(`command from @${action.by} in ${action.stream} could not be recorded: ${r.error}`);
  if (action.intent) {
    const rec = open.get(roomId);
    if (rec) {
      if (action.intent.kind === "interrupt") applyInterrupt(rec);
      else if (action.intent.kind === "steer") applySteer(rec, { by: action.by, text: action.intent.message });
    }
  }
  if (action.reply)
    void speak(roomId, action.stream, action.reply, { by: "house", replyTo: msgCtx.messageId ?? null });
  return roomId;
}
