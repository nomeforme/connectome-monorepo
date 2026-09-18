// @ts-check
/* connectome-house/src/resident-alarms.mjs — the resident's autonomous
 * ticks: the house honors what a being sets. Exported as plain functions,
 * NOT wired to a setInterval or an HTTP route here — that mounting is
 * W-C's own concern (serve-*.mjs); this module owns only the LOGIC. Owns:
 *
 *   - `tickDueScan`: every caller-chosen interval, each allowed resident
 *     handle's alarm.json is read and, if due (and every gate below
 *     clears), `deps.wake(handle, alarm, cov)` is called to start a
 *     waking as that handle.
 *   - `tickEndOfWaking`: a waking whose room has closed gets its `awake`
 *     cleared, and — if the being never called `rest` itself — a default
 *     next alarm.
 *   - `tickWakeOnMatch`: a KEEPER message that mentions a sleeping
 *     resident by @handle wakes it early, floor permitting.
 *
 * Ported from a private deployment (2026-09-18), SUBSTANTIALLY narrowed:
 *
 *   - The grace timer (a waking that fell silent for N minutes is rested
 *     by the house) and `summonIfOpen` (a mention carried into an
 *     open-door waking as a live turn) are NOT ported here — both depend
 *     on per-room fields (`rec.lastWasFinalSpeech`, `rec.lastFrameAt`,
 *     `rec.gracedRested`) that no round of THIS port has stamped onto
 *     open-rooms.mjs's OpenRoomRec yet (the source stamped them from its
 *     own serve-sse.mjs pollFrames loop, which this port's room-turn.mjs
 *     does not yet mirror). Named here as a real gap, not silently
 *     dropped: a follow-up wiring `turn.event` handling in room-turn.mjs
 *     to stamp those two fields would let a caller add both back with
 *     the same shape this module already uses for the other three ticks.
 *   - The `keeper_presence: "defer"` gate (skip a wake while the keeper is
 *     live) is dropped: this house tracks no live human-presence signal
 *     the way the source's browser-SSE `presentHandles()` did (a chat
 *     platform has no equivalent notion of "a tab is open"). `deps.wake`
 *     is always allowed to fire once every OTHER gate clears.
 *   - `wake_on` matching is narrowed to `kind: "keeper"` only — the other
 *     three kinds the source supported (`sealed`, `mention`, `flag`) each
 *     named archive/citation-specific concepts this port has nothing to
 *     match against (resident-tools.mjs's own header makes the same cut).
 *   - Spend/budget gating (`spentTodayUsd`) is dropped with it — no
 *     pricing table is ported (resident-house.mjs's own header, same
 *     reasoning); `budget_usd_per_day` rides in the covenant unenforced
 *     here, same honest gap resident-house.mjs's `house` tool names.
 */
import { isStanding, readCls } from "./room-policy.mjs";
import { PRIVATE_DIR, maxLive } from "./serve-paths.mjs";
import { open } from "./open-rooms.mjs";
import { mayView } from "./serve-identity.mjs";
import { keeperHandlesFromEnv } from "./commands/permissions.mjs";
import { tailFrames } from "./frames-io.mjs";
import { countPeriodsToday, lastWokeTime, patchAlarm, readAlarm } from "./alarm-store.mjs";
import { covenantFor, logOnce, residentHandles, sleepTerms } from "./resident-covenant.mjs";
import { testamentFor } from "./testaments.mjs";

/** how many of `open`'s rooms are actually live right now (never rested
 * or aborted) — this house's own stand-in for the source's
 * `liveTreeCount()`, computed from open-rooms.mjs's own registry rather
 * than a second counter. */
function liveTreeCount() {
  let n = 0;
  for (const rec of open.values()) if (rec.status === "open") n += 1;
  return n;
}

/* ---------- the due scan ---------- */

/** @param {{ wake: (handle: string, alarm: any, cov: any) => Promise<any> }} deps */
export function tickDueScan(deps) {
  for (const handle of residentHandles()) {
    const t = testamentFor(handle);
    if (!t) {
      logOnce(handle, "no testament found — not a known resident, skipped");
      continue;
    }
    const cov = covenantFor(handle) ?? {};
    const alarm = readAlarm(PRIVATE_DIR, handle);
    if (!alarm) {
      logOnce(handle, "no alarm.json yet — nothing to honor");
      continue;
    }
    if (alarm.paused) {
      logOnce(handle, "paused — the keeper's pause holds");
      continue;
    }
    if (alarm.awake) continue; // already mid-waking, nothing to log
    const ownsBranch = (r) => r.scope?.owner === handle && !isStanding(readCls(r.runDir));
    if ([...open.values()].some(ownsBranch)) {
      logOnce(handle, "already owns an open room"); // a standing room is never a period
      continue;
    }
    if (liveTreeCount() >= maxLive() - cov.reserved_human_slots) {
      logOnce(handle, `reserved human slots (${cov.reserved_human_slots}) would be exceeded`);
      continue;
    }
    if (countPeriodsToday(alarm) >= cov.wakings_per_day) {
      logOnce(handle, `today's wakings_per_day (${cov.wakings_per_day}) is spent`);
      continue;
    }
    if (typeof alarm.until !== "string") continue;
    const t2 = Date.parse(alarm.until);
    if (!Number.isFinite(t2) || t2 > Date.now()) continue;
    deps
      .wake(handle, alarm, cov)
      .catch((e) => console.error(`[resident-alarms] ${handle}: wake attempt failed — ${e.message}`));
  }
}

/* ---------- the end-of-waking sweep ---------- */

export function tickEndOfWaking() {
  for (const handle of residentHandles()) {
    const alarm = readAlarm(PRIVATE_DIR, handle);
    if (!alarm?.awake?.run) continue;
    if (open.has(alarm.awake.run)) continue; // still going
    const cov = covenantFor(handle) ?? {};
    const { default_h } = sleepTerms(cov);
    patchAlarm(PRIVATE_DIR, handle, (current) => {
      const next = { ...current, awake: null };
      const dueOrUnset = typeof next.until !== "string" || Date.parse(next.until) <= Date.now();
      if (dueOrUnset) {
        // the being never called `rest` itself — the house rests it with
        // the default sleep: nothing is lost.
        const now = new Date().toISOString();
        next.until = new Date(Date.now() + default_h * 3_600_000).toISOString();
        next.reason = "(default — the house rested you)";
        next.set_by = "house";
        next.set_t = now;
        next.history = Array.isArray(next.history) ? [...next.history] : [];
        next.history.push({ set_t: now, until: next.until, reason: next.reason, set_by: "house" });
        console.error(`[resident-alarms] ${handle}: no rest call — defaulted next until to ${next.until}`);
      }
      return next;
    });
  }
}

/* ---------- wake_on: a keeper's own word ---------- */

const wakeOnBookmarks = new Map(); // roomId -> {offset, staleTicks}
const STALE_TICKS_LIMIT = 3;

/** does a fresh `message` frame from a keeper actually @mention `handle`? */
function keeperMentionsHandle(f, handle) {
  if (f.type !== "message" || typeof f.by !== "string") return false;
  if (!keeperHandlesFromEnv().includes(f.by)) return false;
  return new RegExp(`@${handle}\\b`).test(String(f.text ?? ""));
}

/** a `kind: "keeper"` wake_on match: `until` becomes now, respecting the
 * floor from the last actual waking (never sooner). */
function triggerEarlyWake(handle, alarm, cov) {
  const { floor_h } = sleepTerms(cov);
  const lastWoke = lastWokeTime(alarm);
  const earliest = lastWoke != null ? lastWoke + floor_h * 3_600_000 : null;
  const untilMs = Math.max(Date.now(), earliest ?? 0);
  const iso = new Date(untilMs).toISOString();
  if (alarm.until === iso) return;
  patchAlarm(PRIVATE_DIR, handle, { until: iso });
  logOnce(handle, `wake_on 'keeper' matched — until set to ${iso}`);
}

/** the wake_on tick, narrowed to `kind: "keeper"` (this module's own
 * header explains the other three kinds this port drops). */
export function tickWakeOnMatch() {
  const residents = residentHandles()
    .map((handle) => ({ handle, alarm: readAlarm(PRIVATE_DIR, handle), cov: covenantFor(handle) }))
    .filter(
      (r) =>
        r.alarm &&
        !r.alarm.paused &&
        !r.alarm.awake &&
        Array.isArray(r.alarm.wake_on) &&
        r.alarm.wake_on.some((w) => w?.kind === "keeper"),
    );
  if (!residents.length) return;

  for (const [id, rec] of open) {
    if (!wakeOnBookmarks.has(id)) wakeOnBookmarks.set(id, { offset: 0, staleTicks: 0 });
    const bm = wakeOnBookmarks.get(id);
    const fp = `${rec.runDir}/frames.jsonl`;
    const { frames, offset } = tailFrames(fp, bm.offset);
    bm.offset = offset;
    bm.staleTicks = 0;
    for (const f of frames) {
      for (const { handle, alarm, cov } of residents) {
        if (!mayView({ handle, roles: [] }, rec.scope)) continue;
        if (keeperMentionsHandle(f, handle)) triggerEarlyWake(handle, alarm, cov);
      }
    }
  }
  for (const [id, bm] of [...wakeOnBookmarks]) {
    if (open.has(id)) continue;
    bm.staleTicks += 1;
    if (bm.staleTicks > STALE_TICKS_LIMIT) wakeOnBookmarks.delete(id);
  }
}
