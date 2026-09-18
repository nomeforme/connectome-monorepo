// @ts-check
/* connectome-house/src/alarm-store.mjs — the one reader/writer of a
 * resident handle's alarm.json and intent.json (<PRIVATE_DIR>/<handle>/),
 * shared by the house's own tick logic (resident-alarms.mjs) and a
 * resident being's own tools (resident-tools.mjs's `rest`). Two sides
 * touch these files, so every write is atomic (temp + rename,
 * atomic-write.mjs); alarm.json writes go through `patchAlarm`, which
 * re-reads immediately before merging so a concurrent write from the
 * other side is never clobbered.
 *
 * Field ownership: the being's `rest` writes until/reason/wake_on/
 * open_until/set_by/set_t; the house owns awake/paused and history
 * entries. Unknown fields are always preserved on write.
 *
 * `privateRoot` is always caller-resolved, so a sandboxed serve and its
 * sandboxed being agree on where the files live.
 *
 * Ported from a private deployment (2026-09-18): the source's own module
 * was already this generic (no archive vocabulary) — only import paths
 * changed, and two doc comments that named a private feature ("walk",
 * this port's own archive-specific concept, dropped per
 * docs/harness-port/03-house-design.md §3.1) are generalized to "a
 * pending resident-initiated action" so the mechanism stays reusable
 * without implying a feature this port doesn't ship.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJSONSync } from "./atomic-write.mjs";

/** @param {string} privateRoot @param {string} handle */
export const alarmPath = (privateRoot, handle) => join(privateRoot, handle, "alarm.json");

/** the alarm as it stands, or null when absent/unparseable (an honest
 * absence — never a fabricated default). */
export function readAlarm(privateRoot, handle) {
  const p = alarmPath(privateRoot, handle);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** atomic whole-file write (temp + rename) — a reader never sees a torn
 * file. Prefer `patchAlarm` for any write that isn't the initial one. */
export function writeAlarm(privateRoot, handle, alarm) {
  atomicWriteJSONSync(alarmPath(privateRoot, handle), alarm);
  return alarm;
}

/** Re-reads, applies `patch` (object of owned fields, or a function
 * `(current) => next`), then writes atomically. The re-read matters: the
 * window since the caller's last read may hold another process's write.
 * Returns the written alarm. */
export function patchAlarm(privateRoot, handle, patch) {
  const current = readAlarm(privateRoot, handle) ?? {};
  const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
  return writeAlarm(privateRoot, handle, next);
}

/* ---------- pure derivations over an already-read alarm shape ---------- */

/** the ms timestamp of the most recent CLOSED history entry (one carrying
 * `woke_t`) — null when the resident has never actually woken. This is the
 * covenant's own anchor for "no sooner than floor_h after the last waking",
 * distinct from `set_t` (when the CURRENT alarm episode was written). */
export function lastWokeTime(alarm) {
  const hist = Array.isArray(alarm?.history) ? alarm.history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (typeof hist[i]?.woke_t === "string") {
      const t = Date.parse(hist[i].woke_t);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/** History entries landed TODAY (UTC), wakings and the resident's own
 * periods together — an own-initiated period's own entry (`kind:"walk"`)
 * counts the same as a waking's, so `wakings_per_day` now caps the day's
 * PERIODS. `refunded: true` (keeper-set only, never by the house) excludes
 * an entry from the count without rewriting history. */
export function countWakingsToday(alarm) {
  const today = new Date().toISOString().slice(0, 10);
  return (alarm?.history ?? []).filter(
    (h) => typeof h.woke_t === "string" && h.woke_t.slice(0, 10) === today && !h.refunded,
  ).length;
}

/** Same as countWakingsToday, under the name that reads truthfully now
 * that it covers wakings and own-initiated periods together — prefer this
 * name in new code. */
export const countPeriodsToday = countWakingsToday;

/** Of today's period-entries, how many were the resident's OWN
 * (`kind: "walk"`) — the complement within countPeriodsToday's total. */
export function countWalksToday(alarm) {
  const today = new Date().toISOString().slice(0, 10);
  return (alarm?.history ?? []).filter(
    (h) =>
      h.kind === "walk" &&
      typeof h.woke_t === "string" &&
      h.woke_t.slice(0, 10) === today &&
      !h.refunded,
  ).length;
}

/* ---------- model-switch recording ----------
 * Every resident-owned period records the covenant's current `speaks_for`
 * as alarm.json.last_model when it opens. The keeper may repoint a
 * testament's voice at a new model without the being being told unless
 * this names it; the first-ever record is silent (nothing to compare). */

/** `{from, to}` when `currentModel` differs from the alarm's own recorded
 * `last_model` — null when they match, OR when there is no `last_model` yet
 * (first-ever record: silent by design, per this section's own header).
 * Pure — reads only the values passed in. */
export function modelSwitch(alarm, currentModel) {
  const last = typeof alarm?.last_model === "string" ? alarm.last_model : null;
  if (last == null || last === currentModel) return null;
  return { from: last, to: currentModel };
}

/** the one house-voice line a period's own opening turn carries when
 * `modelSwitch` found a real change — named exactly this way so it never
 * dresses up as the resident's own words. */
export function modelSwitchLine({ from, to }) {
  return (
    `[since your last period, the voice you speak through changed: ${from} → ${to} — ` +
    "the keeper's change, recorded in the testament; your memory is carried unchanged]"
  );
}

/* ---------- the pending own-initiated-period intent ----------
 * <PRIVATE_DIR>/<handle>/intent.json: at most ONE pending-or-running
 * resident-initiated period, `{walk: {class?, question?, why, set_t,
 * set_by, from_run, origin, run, reported}}`. `run: null` while pending,
 * filled in once the house starts it. `reported: false` until the
 * finished period is narrated back, once. A deployment's own resident
 * tool writes this (this port ships no such tool — see this module's own
 * header); read/patched by the house. Same atomic temp+rename discipline
 * as alarm.json. */
export const intentPath = (privateRoot, handle) => join(privateRoot, handle, "intent.json");

/** the intent as it stands, or null when absent/unparseable — an honest
 * absence, never a fabricated default (same posture as readAlarm). */
export function readIntent(privateRoot, handle) {
  const p = intentPath(privateRoot, handle);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** Atomic whole-file write. No `patchIntent`: both writers always hold
 * the intent's full current shape (via readIntent) before writing back. */
export function writeIntent(privateRoot, handle, intent) {
  atomicWriteJSONSync(intentPath(privateRoot, handle), intent);
  return intent;
}
