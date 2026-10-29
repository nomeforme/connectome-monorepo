// @ts-check
/* The one place a resident's covenant (testament frontmatter,
 * testaments.mjs's testamentFor) is read with defaults applied, plus the
 * HOUSE_RESIDENTS allowlist and a rate-limited logger. Before this,
 * several readers each carried their own copy of the same defaults —
 * `normalizeCovenant` now logs (once per handle+key) the first time a
 * field is actually missing.
 *
 * `posture` and `dispatch` are covenant data, never code paths: a
 * `present` being (reachable in its rooms, owes a turn when addressed)
 * beside `resident` (sleeps, owes nothing); the dispatch rules are read by
 * dispatch.mjs's `decideActivation`. `roomPostureFor` layers a per-room
 * override (<PRIVATE_DIR>/<handle>/rooms.json) over the testament's own
 * covenant. The defaults make a testament that names neither read as
 * `posture: resident`, unchanged. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { houseConfig } from "./house-config.mjs";
import { PRIVATE_ROOT } from "./serve-paths.mjs";
import { testamentFor } from "./testaments.mjs";

/** Defaults for every covenant field a testament's frontmatter may omit.
 * `Infinity` (wakings_per_day, budget_usd_per_day) means uncapped on that
 * axis. `wakings_per_day` caps the day's PERIODS — wakings and the
 * resident's own walks together (alarm-store.mjs's countPeriodsToday), not
 * wakings alone. `life_budget_tokens`/`life_tail_tokens` size the life's
 * compiled context (resident-life.mjs's openLife/compileFor) and its
 * verbatim tail. `life_trunk_share` is the fraction of the budget the
 * TRUNK's own compile gets; the remainder splits equally across any
 * `life-with/<key>` partitions mounted, each with no response reserve
 * (only the trunk reserves room for the turn's response). 0.75 is a first
 * number, not a tuned one. */
export const COVENANT_DEFAULTS = {
  floor_h: 6,
  ceiling_d: 3,
  default_h: 24,
  open_hours_max_h: 2,
  reserved_human_slots: 0,
  wakings_per_day: Infinity,
  keeper_presence: "defer",
  budget_usd_per_day: Infinity,
  life_budget_tokens: 120_000,
  // 30000 since 2026-10-17 (was 60000): connectome-host's recentWindowTokens
  // default. The tail is the one part of a life that never folds, so half
  // the trunk's budget held verbatim left the fold planner too little room:
  // a backlog of only a few thousand unsummarized tokens put opus-4-8 over
  // budget. A partition's tail stays a quarter of this (7500). When even
  // this doesn't fit, resident-life.mjs's over-budget ladder narrows it for
  // that compile and drains the backlog — the tail is a ceiling, not a
  // promise.
  life_tail_tokens: 30_000,
  life_trunk_share: 0.75,
  // how many elective returns (task_continue) a resident may take in one
  // period before the house asks it to say where the thread stands — a
  // ceiling on spend, not a pacing device. A visitor's line resets the count.
  returns_per_period: 30,
  // `resident` sleeps and owes nothing (the clock/allowlist apply);
  // `present` is reachable in its rooms and owes a turn when addressed —
  // no clock needed, alarms/allowlist irrelevant to it.
  posture: "resident",
  // dispatch rules as data, read by dispatch.mjs's decideActivation:
  // `random_reply` is a 1-in-N chance to answer an
  // unaddressed message (0 = never); `bot_mention_budget` is how many
  // consecutive bot-to-bot mentions this being answers before a human
  // must speak. An unaddressed message always enters the room's record;
  // whether it also enters THIS being's own context is not a covenant
  // flag yet (plan §6 R6 — a per-being observe filter in the child).
  dispatch: {
    mention: true,
    reply: true,
    dm: true,
    random_reply: 0,
    bot_mention_budget: 1,
  },
};

/** rate-limited skip/status logging (no log storms): at most once per
 * (handle, text) pair every LOG_ONCE_MS. Shared by every resident-side
 * module — one Map here, so a handle+text logged from any of them is
 * throttled against every other caller, not just its own. */
export const LOG_ONCE_MS = 60_000;
const lastLogAt = new Map(); // `${handle}|${text}` -> ms
export function logOnce(handle, text) {
  const key = `${handle}|${text}`;
  const now = Date.now();
  if (now - (lastLogAt.get(key) ?? 0) < LOG_ONCE_MS) return;
  lastLogAt.set(key, now);
  console.error(`[alarms] ${handle}: ${text}`);
}

/** the allowlist, read fresh every call (never cached — a test sets it once
 * before boot; a real box could in principle change it without a restart,
 * and re-reading process.env costs nothing). A definite WALKER-kind
 * testament is filtered out — a model's own derived testament must never
 * wake, however it got into this env var — but a handle with no testament
 * at all still passes through unfiltered, exactly as before this round
 * (downstream readers already require a real testament too, e.g.
 * serve-house.mjs's `enabled = ... && !!t`; this only ever removes a
 * DEFINITE walker, never invents a refusal). */
export function residentHandles() {
  return String(process.env.HOUSE_RESIDENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((h) => testamentFor(h)?.kind !== "walker");
}

function pick(obj, key, def, applied, label) {
  const v = obj?.[key];
  if (typeof v === typeof def) return v;
  applied.push(label ?? key);
  return def;
}

/** Raw covenant (testament frontmatter, or {}) -> same shape with every
 * field below defaulted. `handle` null/undefined normalizes silently (for
 * a pure unit test). Every other covenant key rides through unchanged. */
export function normalizeCovenant(raw, handle) {
  const cov = raw && typeof raw === "object" ? raw : {};
  const sleepRaw = cov.sleep && typeof cov.sleep === "object" ? cov.sleep : {};
  const applied = [];
  const floor_h = pick(sleepRaw, "floor_h", COVENANT_DEFAULTS.floor_h, applied, "sleep.floor_h");
  const ceiling_d = pick(
    sleepRaw,
    "ceiling_d",
    COVENANT_DEFAULTS.ceiling_d,
    applied,
    "sleep.ceiling_d",
  );
  const default_h = pick(
    sleepRaw,
    "default_h",
    COVENANT_DEFAULTS.default_h,
    applied,
    "sleep.default_h",
  );
  const open_hours_max_h = pick(
    cov,
    "open_hours_max_h",
    COVENANT_DEFAULTS.open_hours_max_h,
    applied,
  );
  const reserved_human_slots = pick(
    cov,
    "reserved_human_slots",
    COVENANT_DEFAULTS.reserved_human_slots,
    applied,
  );
  const wakings_per_day = pick(cov, "wakings_per_day", COVENANT_DEFAULTS.wakings_per_day, applied);
  const keeper_presence = pick(cov, "keeper_presence", COVENANT_DEFAULTS.keeper_presence, applied);
  const budget_usd_per_day = pick(
    cov,
    "budget_usd_per_day",
    COVENANT_DEFAULTS.budget_usd_per_day,
    applied,
  );
  const life_budget_tokens = pick(
    cov,
    "life_budget_tokens",
    COVENANT_DEFAULTS.life_budget_tokens,
    applied,
  );
  const life_tail_tokens = pick(
    cov,
    "life_tail_tokens",
    COVENANT_DEFAULTS.life_tail_tokens,
    applied,
  );
  const life_trunk_share = pick(
    cov,
    "life_trunk_share",
    COVENANT_DEFAULTS.life_trunk_share,
    applied,
  );
  const returns_per_period = pick(
    cov,
    "returns_per_period",
    COVENANT_DEFAULTS.returns_per_period,
    applied,
  );
  const posture = pick(cov, "posture", COVENANT_DEFAULTS.posture, applied);
  const dispatchRaw = cov.dispatch && typeof cov.dispatch === "object" ? cov.dispatch : {};
  const dispatch = {
    mention: pick(
      dispatchRaw,
      "mention",
      COVENANT_DEFAULTS.dispatch.mention,
      applied,
      "dispatch.mention",
    ),
    reply: pick(dispatchRaw, "reply", COVENANT_DEFAULTS.dispatch.reply, applied, "dispatch.reply"),
    dm: pick(dispatchRaw, "dm", COVENANT_DEFAULTS.dispatch.dm, applied, "dispatch.dm"),
    random_reply: pick(
      dispatchRaw,
      "random_reply",
      COVENANT_DEFAULTS.dispatch.random_reply,
      applied,
      "dispatch.random_reply",
    ),
    bot_mention_budget: pick(
      dispatchRaw,
      "bot_mention_budget",
      COVENANT_DEFAULTS.dispatch.bot_mention_budget,
      applied,
      "dispatch.bot_mention_budget",
    ),
    // optional, no default here: dispatch.mjs falls back to
    // HOUSE_BEING_TURN_MAX (6) — speech turns without a human message
    // before non-human traffic stops waking this being
    ...(Number.isInteger(dispatchRaw.max_turns_without_human) && dispatchRaw.max_turns_without_human >= 0
      ? { max_turns_without_human: dispatchRaw.max_turns_without_human }
      : {}),
  };
  if (applied.length && handle) logOnce(handle, `covenant defaulted: ${applied.join(", ")}`);
  return {
    ...cov,
    sleep: { floor_h, ceiling_d, default_h },
    open_hours_max_h,
    reserved_human_slots,
    wakings_per_day,
    returns_per_period,
    keeper_presence,
    budget_usd_per_day,
    life_budget_tokens,
    life_tail_tokens,
    life_trunk_share,
    posture,
    dispatch,
  };
}

/** the one normalized covenant for `handle`, or null when it holds no
 * testament at all (distinct from a testament that merely omits fields,
 * which normalizeCovenant defaults instead of refusing). */
export function covenantFor(handle) {
  const t = testamentFor(handle);
  return t ? normalizeCovenant(t.covenant ?? {}, handle) : null;
}

/** the sleep terms alone (floor/ceiling/default), already defaulted — kept
 * as its own reader since most call sites only ever want these three. */
export function sleepTerms(cov) {
  return (
    cov?.sleep ?? {
      floor_h: COVENANT_DEFAULTS.floor_h,
      ceiling_d: COVENANT_DEFAULTS.ceiling_d,
      default_h: COVENANT_DEFAULTS.default_h,
    }
  );
}

/* ---------- per-room posture/dispatch overrides ----------
 * <PRIVATE_DIR>/<handle>/rooms.json: { "<platform>:<slug8>": { posture?,
 * dispatch? } } — a room may narrow or loosen one being's posture/dispatch
 * without touching its testament. Absent file or key is an honest empty
 * override (the testament's own covenant stands unchanged). Keeper-owned,
 * same private-root discipline as alarm.json/intent.json. */

function roomsPath(handle) {
  return join(PRIVATE_ROOT(handle), "rooms.json");
}

function readRoomOverrides(handle) {
  const p = roomsPath(handle);
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** whether a spawn for these being handles mounts the archive — off only
 * when houseConfig().archive.enabled is false, or EVERY handle's covenant
 * names a `mounts` list excluding "archive" (placeholder policy).
 * @param {string|string[]|null|undefined} handles @returns {boolean} */
export function archiveMountedFor(handles) {
  if (!houseConfig().archive.enabled) return false;
  const list = Array.isArray(handles) ? handles : handles ? [handles] : [];
  if (!list.length) return true;
  return list.some((h) => {
    const mounts = testamentFor(h)?.covenant?.mounts;
    return !Array.isArray(mounts) || mounts.includes("archive");
  });
}

/** the being's own EXPLICIT `dispatch.random_reply` -- the testament's raw
 * covenant, or a per-room override, never `normalizeCovenant`'s own 0
 * fallback (route.mjs's platform-default precedence, harness-port W6-R3
 * K1 fix, needs to tell "the testament truly said 0" from "nobody said
 * anything" apart -- this reads the raw shape directly, no defaulting at
 * all). Room override wins over the testament's own base, matching
 * `roomPostureFor`. `undefined` when neither names a number -- the
 * caller's own next tier (a `!rr` runtime setting, then the platform's
 * own default, then `COVENANT_DEFAULTS.dispatch.random_reply` last)
 * decides from there (mcpl/seat.mjs's `covenants` wiring).
 * @param {string} handle @param {string} roomKey @returns {number|undefined} */
export function explicitRandomReply(handle, roomKey) {
  const raw = testamentFor(handle)?.covenant?.dispatch?.random_reply;
  const override = readRoomOverrides(handle)[roomKey];
  const overrideDispatch = override && typeof override === "object" ? override.dispatch : null;
  const overrideVal =
    overrideDispatch && typeof overrideDispatch === "object"
      ? overrideDispatch.random_reply
      : undefined;
  const v = overrideVal !== undefined ? overrideVal : raw;
  return typeof v === "number" ? v : undefined;
}

/** `handle`'s covenant view IN `roomKey` (e.g. "discord:1234"): the
 * testament's own covenant (already defaulted), with any per-room override
 * merged over it. `dispatch` merges key-by-key — a room may override just
 * `random_reply` without losing the covenant's `mention`/`reply`/`dm`;
 * `posture` replaces wholesale when the room names one. A handle with no
 * testament still gets the bare defaults (never a throw) so a brand-new
 * platform sender (identity-map.mjs's fresh pseudonym) has SOME posture to
 * read before any testament is ever written for it.
 * @param {string} handle @param {string} roomKey
 * @returns {{posture: "resident"|"present", dispatch: Record<string, any>}} */
export function roomPostureFor(handle, roomKey) {
  const cov = covenantFor(handle) ?? normalizeCovenant({}, handle);
  const override = readRoomOverrides(handle)[roomKey];
  const dispatchOverride =
    override &&
    typeof override === "object" &&
    override.dispatch &&
    typeof override.dispatch === "object"
      ? override.dispatch
      : null;
  return {
    posture: (override && typeof override === "object" && override.posture) || cov.posture,
    dispatch: dispatchOverride ? { ...cov.dispatch, ...dispatchOverride } : cov.dispatch,
  };
}
