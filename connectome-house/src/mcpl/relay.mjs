// @ts-check
// harness/src/mcpl/relay.mjs — a human's app-typed line into a platform
// room relays out there too, house-voiced. Narrative: app/log.md 2026-09-15.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlatformRoom } from "../serve-identity.mjs";
import { CATCHUP_MS } from "./redeliver.mjs";

const STAGE_RE = /^\s*\/stage\b/i;
const MAX_MARKS = 50;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
// a row's own identity for the consumed-set below.
const rowKey = (r) => `${r.t}|${r.message_id ?? ""}`;

/** every `direction:"in"` row in this room's external.jsonl.
 * @param {string} runDir @returns {any[]} */
function inboundRows(runDir) {
  const p = join(runDir, "external.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r?.direction === "in");
}

/** a human's app-typed frame fell outside the catch-up window — replaces
 * the old boot-time guard. Check this BEFORE textFor; never true for a
 * house line, so a true here always names a real relay candidate.
 * @param {any} f @param {number} [windowMs] @returns {boolean} */
export function tooOldToRelay(f, windowMs = CATCHUP_MS) {
  if (f.type !== "message" || f.by === "house") return false;
  const ft = typeof f.t === "string" ? Date.parse(f.t) : Number.NaN;
  return !Number.isNaN(ft) && Date.now() - ft > windowMs;
}

/** @param {{readCls: (runDir: string) => object}} deps */
export function createRelay({ readCls }) {
  /** @type {Map<string, {by: string, text: string}[]>} per room, oldest first */
  const marks = new Map();
  /** @type {Map<string, {by: string, path: string}[]>} a platform-origin
   * attachment, per room — the outbound leg never echoes it back. */
  const mediaMarks = new Map();
  /** @type {Map<string, Set<string>>} per room, which "in" rows this
   * relay has already matched to a frame. */
  const consumedRows = new Map();

  /** the persistent fallback once the in-memory mark is gone (a
   * restart): a platform "in" row matched by content (`text_sha`), never
   * merely by author — an author-wide match would silence a linked
   * person's own later, different app lines forever. A row from before
   * text_sha existed falls back to author + a narrow time window.
   * @param {string} roomId @param {string} runDir @param {string} by
   * @param {string} text @param {string} t @returns {boolean} */
  function matchesInboundRow(roomId, runDir, by, text, t) {
    const sha = sha256(text);
    const ft = Date.parse(t);
    const consumed = consumedRows.get(roomId) ?? new Set();
    const hit = inboundRows(runDir).find(
      (r) =>
        r.author === by &&
        !consumed.has(rowKey(r)) &&
        (r.text_sha
          ? r.text_sha === sha
          : !Number.isNaN(ft) && Math.abs(Date.parse(r.t) - ft) <= 5000),
    );
    if (!hit) return false;
    consumed.add(rowKey(hit));
    consumedRows.set(roomId, consumed);
    return true;
  }

  return {
    /** apply()'s own roomInput() success (never a duplicate); skips a line
     * walk.mjs's own trim would never turn into a frame (empty text only).
     * @param {string} roomId @param {string} by @param {string} text */
    markPlatformOrigin(roomId, by, text) {
      const t = String(text ?? "").trim();
      if (!t) return;
      const list = marks.get(roomId) ?? [];
      list.push({ by, text: t });
      marks.set(roomId, list.slice(-MAX_MARKS));
    },
    /** mark a platform-origin attachment so the outbound leg can
     * recognize its own arrival and skip it.
     * @param {string} roomId @param {string} by @param {string} path */
    markPlatformMedia(roomId, by, path) {
      if (!path) return;
      const list = mediaMarks.get(roomId) ?? [];
      list.push({ by, path });
      mediaMarks.set(roomId, list.slice(-MAX_MARKS));
    },
    /** is `media.attached` frame (by, path) a platform-origin mark for
     * this room? Consumed on match, like textFor's own marks.
     * @param {string} roomId @param {string} by @param {string} path
     * @returns {boolean} */
    isPlatformMedia(roomId, by, path) {
      const list = mediaMarks.get(roomId);
      const i = list?.findIndex((m) => m.by === by && m.path === path) ?? -1;
      if (i === -1) return false;
      list?.splice(i, 1);
      return true;
    },
    /** the relay text for a human's app-typed frame, or null (a matched
     * mark, a house/`/stage`/empty line, or no platform place at all —
     * check tooOldToRelay first; this never re-checks the window itself).
     * @param {string} roomId @param {string} runDir @param {any} f
     * @returns {string|null} */
    textFor(roomId, runDir, f) {
      if (f.type !== "message" || f.by === "house") return null;
      const list = marks.get(roomId);
      const i = list?.findIndex((m) => m.by === f.by && m.text === f.text) ?? -1;
      if (i !== -1) {
        list?.splice(i, 1);
        return null;
      }
      if (typeof f.text !== "string" || !f.text.trim() || STAGE_RE.test(f.text)) return null;
      if (matchesInboundRow(roomId, runDir, f.by, f.text.trim(), f.t)) return null;
      let cls;
      try {
        cls = readCls(runDir);
      } catch {
        return null;
      }
      return isPlatformRoom(cls) ? `@${f.by} (in the app): ${f.text}` : null;
    },
  };
}
