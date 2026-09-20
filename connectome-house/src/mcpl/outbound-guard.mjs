// @ts-check
/* connectome-house/src/mcpl/outbound-guard.mjs — the hard outbound
 * guardrail (docs/harness-port/25-outbound-guardrail.md), born the night
 * of 2026-09-20: minutes after 21 beings were switched onto the house
 * right after a full history restore, one Signal group received ~500
 * replayed messages (old speech, attachments from unrelated rooms,
 * replies to months-old messages). This module is the fence that makes
 * such a cascade physically impossible regardless of which bug put a bad
 * frame in front of a seat: every real outbound call (speak.mjs's
 * speak()/speakMedia(), redeliver.mjs's own resend, the typing signal)
 * asks THIS module first.
 *
 * Four independent checks, in order — any one refusing is enough:
 *   1. the house-wide kill switch (env, read once at boot, PLUS a file
 *      polled every 2s so the keeper can flip it with no restart)
 *   2. the age fence (never outbound a frame older than this seat's own
 *      attach time, nor older than HOUSE_OUTBOUND_MAX_AGE_MS)
 *   3. the import-origin fence (a restored/retrofitted frame's own
 *      `origin: "import"` marker — write.mjs/slice.mjs — is never eligible)
 *   4. token buckets (seat+stream, being, house-global) with a latching
 *      circuit breaker per scope, reset only by `!unmute` (seat.mjs) or a
 *      house restart (this module's own in-memory state)
 *
 * Pure decision state; this file never touches a wire or a room's own
 * record — the caller (almost always speak.mjs) makes the actual
 * send/skip choice and records the refusal however that caller already
 * records every other kind of refusal. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_DIR } from "../serve-paths.mjs";

// ---------- rule 1: the kill switch ----------
// env read ONCE at module load (= house boot) — a live flip needs the file.
const envOff = () => String(process.env.HOUSE_OUTBOUND || "").trim().toLowerCase() === "off";
let houseOutboundEnvOff = envOff();

const OFF_FILE_POLL_MS = 2000;
function offFilePath() {
  return join(PRIVATE_DIR, "outbound.off");
}
let houseOutboundFileOff = false;
function pollOffFile() {
  try {
    houseOutboundFileOff = existsSync(offFilePath());
  } catch {
    houseOutboundFileOff = false; // an unreadable private root is not a mute — fail open on the FILE half only; the env half still gates
  }
}
pollOffFile();
const offFileTimer = setInterval(pollOffFile, OFF_FILE_POLL_MS);
offFileTimer.unref?.();

/** true when no seat may issue a send/attachment/typing call right now,
 * house-wide — env `HOUSE_OUTBOUND=off` (read once at boot) OR the polled
 * `<HOUSE_PRIVATE_DIR>/outbound.off` file (checked at most 2s stale).
 * @returns {boolean} */
export function isOutboundOff() {
  return houseOutboundEnvOff || houseOutboundFileOff;
}

/** test-only: force an immediate re-read of the off-file rather than
 * waiting up to OFF_FILE_POLL_MS for the timer, and re-read the env var
 * (a test sets `process.env.HOUSE_OUTBOUND` after this module already
 * loaded). Never called by production code. */
export function _pollOutboundOffNow() {
  houseOutboundEnvOff = envOff();
  pollOffFile();
}

// ---------- rule 2: the age fence ----------
export const HOUSE_OUTBOUND_MAX_AGE_MS = Number(process.env.HOUSE_OUTBOUND_MAX_AGE_MS ?? 10 * 60 * 1000);

/** a frame is too old to go outward when its own `t` predates the seat's
 * own attach time to this room, OR is simply older than `maxAgeMs` right
 * now — whichever is stricter. A frame with no parseable `t` is never
 * blocked on age alone (this fence's job is "born before this seat
 * existed" / "too old right now", never "has no timestamp at all").
 * @param {string|undefined|null} frameT @param {number} [attachedAt]
 * @param {number} [maxAgeMs] @returns {boolean} */
export function isFrameTooOld(frameT, attachedAt = 0, maxAgeMs = HOUSE_OUTBOUND_MAX_AGE_MS) {
  const ft = typeof frameT === "string" ? Date.parse(frameT) : Number.NaN;
  if (Number.isNaN(ft)) return false;
  if (typeof attachedAt === "number" && attachedAt > 0 && ft < attachedAt) return true;
  return Date.now() - ft > maxAgeMs;
}

// ---------- rule 3: the import-origin fence ----------
/** the history importer's own marker (write.mjs/slice.mjs: every frame
 * either module writes carries `origin: "import"`) — such a frame is
 * ineligible for any outbound call, ever, regardless of age or offset.
 * @param {{origin?: string}|null|undefined} frame @returns {boolean} */
export function isImportOrigin(frame) {
  return !!frame && frame.origin === "import";
}

// ---------- rule 5: token buckets + a latching circuit breaker ----------
export const HOUSE_OUTBOUND_RATE_SEAT = Number(process.env.HOUSE_OUTBOUND_RATE_SEAT ?? 6);
export const HOUSE_OUTBOUND_RATE_BEING = Number(process.env.HOUSE_OUTBOUND_RATE_BEING ?? 30);
export const HOUSE_OUTBOUND_RATE_HOUSE = Number(process.env.HOUSE_OUTBOUND_RATE_HOUSE ?? 120);

/** @param {number} capacityPerMinute */
function makeBucket(capacityPerMinute) {
  return { tokens: capacityPerMinute, capacity: capacityPerMinute, refillPerMs: capacityPerMinute / 60000, last: Date.now() };
}
function refill(bucket) {
  const now = Date.now();
  const elapsed = now - bucket.last;
  if (elapsed > 0) {
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.last = now;
  }
}
/** @returns {boolean} true when `weight` tokens were available and spent */
function take(bucket, weight) {
  refill(bucket);
  if (bucket.tokens < weight) return false;
  bucket.tokens -= weight;
  return true;
}
function bucketFor(map, key, capacityPerMinute) {
  let b = map.get(key);
  if (!b) {
    b = makeBucket(capacityPerMinute);
    map.set(key, b);
  }
  return b;
}

const streamBuckets = new Map();
const beingBuckets = new Map();
const houseBucket = makeBucket(HOUSE_OUTBOUND_RATE_HOUSE);
/** scope keys currently tripped — cleared only by unmuteAll() or a house restart. */
const tripped = new Set();
/** a key announced once already (the mute banner, a breaker's own trip
 * line) — callers ask `announceOnce` before writing their own house line
 * or stderr line, so a flood of suppressed sends produces exactly one. */
const announced = new Set();

/** @param {string} key @returns {boolean} true only the FIRST time this
 *   exact key is asked — a caller then, and only then, actually announces. */
export function announceOnce(key) {
  if (announced.has(key)) return false;
  announced.add(key);
  return true;
}

/** the `!unmute` command's own effect (seat.mjs, keeper-only, checked
 * before the ordinary route — commands/registry.mjs has no slot for a
 * NEW command name in this task's own file budget): clears every tripped
 * breaker AND its one-time announcement, and tops every bucket back up to
 * its own capacity so sends resume at once rather than waiting on a
 * partial natural refill.
 * @returns {number} how many scopes were cleared */
export function unmuteAll() {
  const n = tripped.size;
  for (const key of tripped) announced.delete(`breaker:${key}`);
  tripped.clear();
  for (const b of streamBuckets.values()) b.tokens = b.capacity;
  for (const b of beingBuckets.values()) b.tokens = b.capacity;
  houseBucket.tokens = houseBucket.capacity;
  return n;
}

/** test-only: drop every bucket, trip, and announcement — a fresh
 * process would start here too. Never called by production code. */
export function _resetOutboundGuardForTest() {
  streamBuckets.clear();
  beingBuckets.clear();
  houseBucket.tokens = houseBucket.capacity;
  houseBucket.last = Date.now();
  tripped.clear();
  announced.clear();
  houseOutboundEnvOff = envOff();
  pollOffFile();
}

/** @param {{seatKey: string, being: string, weight?: number}} args
 * @returns {{ok: true}|{ok: false, reason: string, scope: string, justTripped: boolean}} */
function tryConsume({ seatKey, being, weight = 1 }) {
  const scopes = [
    { scope: `stream:${seatKey}`, bucket: bucketFor(streamBuckets, seatKey, HOUSE_OUTBOUND_RATE_SEAT) },
    { scope: `being:${being}`, bucket: bucketFor(beingBuckets, being, HOUSE_OUTBOUND_RATE_BEING) },
    { scope: "house", bucket: houseBucket },
  ];
  for (const s of scopes) {
    if (tripped.has(s.scope)) return { ok: false, reason: `breaker:${s.scope}`, scope: s.scope, justTripped: false };
  }
  for (const s of scopes) {
    if (!take(s.bucket, weight)) {
      tripped.add(s.scope);
      return { ok: false, reason: `breaker:${s.scope}`, scope: s.scope, justTripped: true };
    }
  }
  return { ok: true };
}

/** the one gate every real outbound call asks first (rules 1, 2, 3, 5 —
 * rule 4's own cursor-at-attach and rule 6's own bot-chain fence live at
 * their own sites, room-tails.mjs and dispatch.mjs respectively, since
 * neither is a "should this frame go outward" decision this module
 * makes). Never writes anything; the caller records the refusal and
 * decides whether/how to announce it (via `announceOnce`, above), so the
 * shape of that record stays whatever that caller already uses.
 * @param {{seatKey: string, being: string, frame?: {t?: string, origin?: string}|null,
 *   attachedAt?: number, weight?: number}} args
 * @returns {{ok: true}|{ok: false, reason: string, scope?: string, justTripped?: boolean}} */
export function checkOutbound({ seatKey, being, frame = null, attachedAt = 0, weight = 1 }) {
  if (isOutboundOff()) return { ok: false, reason: "muted" };
  if (isImportOrigin(frame)) return { ok: false, reason: "import-origin" };
  if (frame && isFrameTooOld(frame.t, attachedAt)) return { ok: false, reason: "stale" };
  return tryConsume({ seatKey, being, weight });
}
