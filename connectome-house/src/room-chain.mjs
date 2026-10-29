// @ts-check
/* connectome-house/src/room-chain.mjs — room-wide bot-chain state, one
 * per house process, keyed by room id (the run id). Replaces the per-seat
 * streak (mcpl/seat.mjs's `streaks`, one map per seat, updated only by the
 * seat that won the record race — ~21x looser than its budget with 21
 * seats).
 *
 * Updated once per recorded thing:
 *   - `noteMessage` — serve-rooms.mjs's `roomInput`, right after it appends
 *     a non-duplicate, non-echo `message` frame;
 *   - `noteBeingSpeech` — every final `speech` frame (the frame bus, see
 *     `installChainListener`; frames-io.mjs's `frameBus`).
 *
 * `chain` = consecutive non-human items (a being's speech, or a message
 * from an account marked `kind: "ai"`) since the last human message; a
 * human message resets it. A house being's own message frame does not
 * count again (its speech frame already did). `turns` = each being's
 * speech count since the last human message.
 *
 * Also the typing-speed heuristic (`notePossibleAI`): replies arriving
 * faster than a person types mark the sender as an AI account. */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { frameBus } from "./frames-io.mjs";
import { markAI } from "./identity-map.mjs";

/** chars/second above which a reply can't have been typed by hand */
export const TYPING_CPS_MAX = Number(process.env.HOUSE_AI_TYPING_CPS ?? 12);
/** fast replies in a row that flag an account */
export const FAST_REPLIES_TO_FLAG = 3;
/** the window those replies must fall within */
export const FAST_WINDOW_MS = 10 * 60_000;
/** replies shorter than this are never judged (a quick "ok" is human) */
export const FAST_MIN_CHARS = 20;
const SPEECH_HISTORY = 40;

/**
 * @typedef {Object} RoomChainState
 * @property {number} chain
 * @property {Map<string, number>} chainAtSpeech chain value just before a
 *   being's latest speech in the current chain
 * @property {Map<string, number>} turns being -> speech since last human
 * @property {{by: string, seq: number|null, at: number, len: number}[]} speech recent being speech
 * @property {Map<string, number[]>} fast sender -> times of consecutive fast replies
 * @property {number|null} lastHumanAt
 */

/** @type {Map<string, RoomChainState>} */
const rooms = new Map();

/** @param {string} roomId @returns {RoomChainState} */
function stateOf(roomId) {
  let s = rooms.get(roomId);
  if (!s) {
    s = { chain: 0, chainAtSpeech: new Map(), turns: new Map(), speech: [], fast: new Map(), lastHumanAt: null };
    rooms.set(roomId, s);
  }
  return s;
}

/** test-only: forget every room */
export function _resetRoomChains() {
  rooms.clear();
}

/** one recorded `message` frame. `kind`: "human" resets the chain;
 * "ai" adds one; "being" (a house being's own message frame) leaves the
 * chain alone — its speech frame already counted.
 * @param {string} roomId
 * @param {{by: string, kind: "human"|"ai"|"being", at?: number}} m */
export function noteMessage(roomId, { kind, at = Date.now() }) {
  const s = stateOf(roomId);
  if (kind === "human") {
    s.chain = 0;
    s.chainAtSpeech.clear();
    s.turns.clear();
    s.lastHumanAt = at;
    return;
  }
  if (kind === "ai") s.chain += 1;
}

/** one final speech frame by a house being.
 * @param {string} roomId @param {string} being
 * @param {{at?: number, len?: number, seq?: number|null}} [opts] */
export function noteBeingSpeech(roomId, being, { at = Date.now(), len = 0, seq = null } = {}) {
  const s = stateOf(roomId);
  s.chainAtSpeech.set(being, s.chain);
  s.chain += 1;
  s.turns.set(being, (s.turns.get(being) ?? 0) + 1);
  s.speech.push({ by: being, seq, at, len });
  if (s.speech.length > SPEECH_HISTORY) s.speech.splice(0, s.speech.length - SPEECH_HISTORY);
}

/** consecutive non-human items since the last human message.
 * @param {string} roomId */
export function chainOf(roomId) {
  return rooms.get(roomId)?.chain ?? 0;
}

/** the chain a decision about a message from `by` should read: the room's
 * chain as it stood before `by`'s own latest speech when `by` is a being
 * whose words are arriving back through another being's seat (the speech
 * frame was recorded before the platform copy arrives); otherwise the
 * room's chain as it stands (an inbound message is decided before it is
 * recorded).
 * @param {string} roomId @param {string} by */
export function chainFor(roomId, by) {
  const s = rooms.get(roomId);
  if (!s) return 0;
  return s.chainAtSpeech.has(by) ? /** @type {number} */ (s.chainAtSpeech.get(by)) : s.chain;
}

/** @param {string} roomId @param {string} being */
export function turnsSinceHuman(roomId, being) {
  return rooms.get(roomId)?.turns.get(being) ?? 0;
}

/** every being's speech count since the last human message — the shape
 * dispatch.mjs reads as `room.turns_since_human`.
 * @param {string} roomId @returns {Record<string, number>} */
export function turnsSinceHumanAll(roomId) {
  return Object.fromEntries(rooms.get(roomId)?.turns ?? []);
}

/** the latest speech by `being` in this room, or the speech frame `seq`
 * when given and still remembered.
 * @param {string} roomId @param {{being?: string|null, seq?: number|null}} q */
export function recentSpeech(roomId, { being = null, seq = null }) {
  const list = rooms.get(roomId)?.speech ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (seq != null ? e.seq === seq : e.by === being) return e;
  }
  return null;
}

/** The typing-speed heuristic. Call for a message from a sender that is
 * not a being, not a keeper and not already marked, which quote-replies
 * or addresses `being`. When `len / Δt` (Δt = seconds since that being's
 * speech it answers) exceeds TYPING_CPS_MAX on FAST_REPLIES_TO_FLAG
 * consecutive such replies within FAST_WINDOW_MS, the sender is marked
 * `kind: "ai"` (by "house:heuristic") and the house line to post is
 * returned. A slower reply resets the run. `markAIFn` is injectable.
 * @param {string} roomId
 * @param {{by: string, display?: string|null, text: string, being?: string|null,
 *   replySeq?: number|null, at?: number, markAIFn?: typeof markAI}} m
 * @returns {{marked: boolean, cps?: number, run?: number, note?: string}} */
export function notePossibleAI(roomId, { by, display = null, text, being = null, replySeq = null, at = Date.now(), markAIFn = markAI }) {
  const s = stateOf(roomId);
  const answered = recentSpeech(roomId, { being, seq: replySeq });
  if (!answered) return { marked: false };
  const len = String(text ?? "").trim().length;
  const dt = (at - answered.at) / 1000;
  if (len < FAST_MIN_CHARS || dt <= 0) return { marked: false };
  const cps = len / dt;
  if (cps <= TYPING_CPS_MAX) {
    s.fast.delete(by);
    return { marked: false, cps, run: 0 };
  }
  const run = (s.fast.get(by) ?? []).filter((t) => at - t <= FAST_WINDOW_MS);
  run.push(at);
  s.fast.set(by, run);
  if (run.length < FAST_REPLIES_TO_FLAG) return { marked: false, cps, run: run.length };
  s.fast.delete(by);
  const r = markAIFn(by, {
    by: "house:heuristic",
    reason: `${FAST_REPLIES_TO_FLAG} replies within ${FAST_WINDOW_MS / 60_000} min at over ${TYPING_CPS_MAX} chars/s (last ${cps.toFixed(1)})`,
  });
  if (!r.ok || r.changed === false) return { marked: false, cps, run: run.length };
  const name = display || by;
  return {
    marked: true,
    cps,
    run: run.length,
    note: `[house: treating ${name} as an AI account (replies too fast for typing); a keeper can revoke with !human ${name}]`,
  };
}

/** the commands store's room key for a room record — the same
 * `<platform>:<sha256(stream)[0..8]>` mcpl/seat.mjs's `roomKeyOf` builds
 * (serve-room-open.mjs's `roomSlug`, re-derived here so this module stays
 * light); the room id itself for a room with no platform place.
 * @param {any} cls @param {string} roomId */
export function roomKeyForCls(cls, roomId) {
  const room = cls?.room;
  if (room?.platform && room?.stream != null)
    return `${room.platform}:${createHash("sha256").update(String(room.stream)).digest("hex").slice(0, 8)}`;
  return roomId;
}

let installed = false;
/** subscribe once to the frame bus: every final speech frame (not interim,
 * not a house notice such as "[Cycle stopped]") counts as that being's turn.
 * Called by serve-rooms.mjs at load; idempotent. */
export function installChainListener() {
  if (installed) return;
  installed = true;
  frameBus.on("frame", ({ runDir, frame }) => {
    if (frame?.type !== "speech" || frame.interim || frame.notice || !frame.by || frame.by === "house") return;
    if (typeof frame.inline === "string" && !frame.inline.trim()) return; // a turn that said nothing
    const at = Date.parse(frame.t);
    noteBeingSpeech(basename(runDir), frame.by, {
      at: Number.isNaN(at) ? Date.now() : at,
      len: typeof frame.inline === "string" ? frame.inline.length : 0,
      seq: typeof frame.seq === "number" ? frame.seq : null,
    });
  });
}
