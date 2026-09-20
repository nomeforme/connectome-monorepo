// @ts-check
// harness/src/mcpl/relay.mjs — a human's app-typed line into a platform
// room relays out there too, house-voiced. Narrative: app/log.md 2026-09-15.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlatformRoom } from "../serve-identity.mjs";
import { isFrameTooOld } from "./outbound-guard.mjs";
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

/** has ANY seat already relayed frame `seq` in this room? A ROOM-SHARED
 * ledger — external.jsonl's own `direction:"out"` rows are one record per
 * room, shared by every being present (redeliver.mjs's own header) —
 * rather than each seat's own process-local `marks`/`consumedRows` state.
 * Closes the 2026-09-20 incident's own §5 finding: with no such check,
 * 21 independent in-memory dedupe maps each missed the others' sends,
 * relaying the SAME 15 historical `message` frames 21-fold (315 rows).
 * A cheap, disk-truth FAST PATH, not the race's own fix: this only ever
 * proves a send that already fully completed (external.jsonl's own row is
 * written by `recordOutbound`, AFTER the platform call returns —
 * speak.mjs's own header). Two callers racing within the window BEFORE
 * either has written that row would both see `false` here and both
 * proceed — that race is what `claimRelay` (below) closes, atomically,
 * independent of this function's own read-then-decide timing. Kept as a
 * first check (seat.mjs still asks it first): most calls are NOT a race
 * at all — a re-tailed frame, a redeliver retry, an ordinary restart — and
 * this answers those for free, in one read, before ever touching the
 * claims directory.
 * @param {string} runDir @param {number} seq @returns {boolean} */
export function alreadyRelayedOut(runDir, seq) {
  const p = join(runDir, "external.jsonl");
  if (!existsSync(p) || typeof seq !== "number") return false;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.direction === "out" && r.seq === seq) return true;
    } catch {
      /* a torn line names no prior send */
    }
  }
  return false;
}

const CLAIMS_DIRNAME = ".relay-claims";

/** the actual close of the relay-ledger race this file's own header used
 * to name as an open, residual gap (docs/harness-port/25-outbound-
 * guardrail.md §4/§"Known gaps" — "the relay-ledger race … is real, if
 * narrow"; 26-retro-stamp.md's own retro-stamp section records when this
 * closed). `alreadyRelayedOut` above is a read-then-decide check: it can
 * only ever prove a send that has ALREADY finished (a completed
 * `external.jsonl` row) — nothing stops two concurrent callers from both
 * reading "not yet sent" in the window before either one's send actually
 * lands. This function makes "one relay per (room, seq)" hold WITHOUT
 * depending on that timing at all: a claim file per seq, created with
 * `fs.openSync(path, "wx")` (`O_CREAT|O_EXCL`) — a single atomic
 * filesystem operation the kernel itself arbitrates, so of any number of
 * processes calling this for the same `(runDir, seq)` at the exact same
 * instant, exactly one `openSync` succeeds and every other one fails with
 * `EEXIST`, deterministically, with no read-then-write gap for a second
 * caller to land in. Call this BEFORE the platform call (seat.mjs's
 * `onFrame`, right after `isRelayOwner`/`alreadyRelayedOut`); a `false`
 * return means another caller already owns this seq's relay — skip
 * silently, the same shape `alreadyRelayedOut`'s own `false` already had.
 * Record the real outbound row (`recordOutbound`, inside `speak()`) only
 * AFTER a successful claim, never before — the claim is the gate, not a
 * receipt.
 *
 * The claim is permanent (this file is never removed): a seq that was
 * claimed but never actually got an `external.jsonl` row (a hard crash
 * between the claim and the send, or the owning seat's own `textFor`
 * deciding not to relay this particular line after all — a marked,
 * platform-origin, `/stage`, or empty line) stays claimed forever, and
 * this seq is never retried by anyone else. This is the deliberate
 * trade-off `isRelayOwner`'s own header already accepts for the same
 * reason `alreadyRelayedOut` never distinguishes "not yet attempted"
 * from "attempted and failed": once the room's single designated owner
 * has made its own decision about a given seq, that decision is final —
 * relaying is a best-effort echo of a human's app-typed line, not a
 * delivery guarantee `redeliver.mjs`'s own (separate, `external.jsonl`-
 * keyed) retry mechanism ever covered for this path either.
 * @param {string} runDir @param {number} seq @returns {boolean} true only
 *   for the ONE caller that won this seq's claim. */
export function claimRelay(runDir, seq) {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return false;
  const dir = join(runDir, CLAIMS_DIRNAME);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    // concurrent recursive mkdirs can race to EEXIST on some platforms —
    // that is success, not failure; anything else means this seat can't
    // even reach the claims directory, so fail safe: don't claim.
    if (e?.code !== "EEXIST") return false;
  }
  const claimPath = join(dir, `${seq}.claim`);
  try {
    closeSync(openSync(claimPath, "wx"));
    return true;
  } catch {
    // EEXIST (someone else already claimed it) or any other failure —
    // either way, this caller does not own the claim. Fail safe: skip.
    return false;
  }
}

/** only ONE being's seat ever attempts a room's own `message`-relay send —
 * unlike `speech`/`media.attached` (each gated by "is this MY OWN being's
 * output"), a human's app-typed line had no such ownership rule at all
 * before the 2026-09-20 incident, so every present seat relayed every
 * such line independently. The FIRST handle in the room's own (sorted)
 * roster is the deliberate, simple, documented convention — the exact
 * "ties broken by roster order" rule dispatch.mjs's own
 * `pickRandomReplyLotteryWinner` already uses for the same reason: every
 * seat computes it identically from the same on-disk roster, with no
 * coordination needed between processes.
 * @param {string[]|null|undefined} beings @param {string} being @returns {boolean} */
export function isRelayOwner(beings, being) {
  return !beings?.length || beings[0] === being;
}

/** a human's app-typed frame fell outside the catch-up window — replaces
 * the old boot-time guard. Check this BEFORE textFor; never true for a
 * house line, so a true here always names a real relay candidate.
 * `attachedAt` (rule 2, docs/harness-port/25-outbound-guardrail.md —
 * mcpl/room-tails.mjs's own `trackRoom` stamps it, seat.mjs passes it
 * through): a frame older than THIS seat's own attach to the room is
 * refused regardless of `windowMs`, independent of (and stricter than,
 * in that specific case) the ordinary 1-hour catch-up window this
 * function already enforced before this rule existed — defaults to 0
 * (no attach-time gate) so every pre-existing caller/test is unchanged.
 * @param {any} f @param {number} [attachedAt] @param {number} [windowMs]
 * @returns {boolean} */
export function tooOldToRelay(f, attachedAt = 0, windowMs = CATCHUP_MS) {
  if (f.type !== "message" || f.by === "house") return false;
  return isFrameTooOld(f.t, attachedAt, windowMs);
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
