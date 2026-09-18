// @ts-check
/* connectome-house/src/resident-house.mjs — a waking's own reading of the
 * house's state (the `house` tool's four sections): the resident's own
 * clock (alarm, covenant, today's periods, past periods, its life), what
 * arrived and what was filed since the last waking, and its own ledger
 * tail. No model call, no network — every section that can't be computed
 * on this box says so instead of going quiet. Offered in a VISIT too —
 * see `residentHandle` for how the subject handle resolves there. The
 * ORDER and the FRAMING are the point: the resident's own standing comes
 * first and last, never framed as an ask (a framing that reads as an ask
 * produced exactly that in the source deployment: a resident reading it
 * as a directive to act on).
 *
 * Ported from a private deployment (2026-09-18), with TWO sections
 * DROPPED, not stubbed: `arrivalsWithoutNodeSection` and
 * `nodesAwaitingReviewSection` both read a specific archive's compiled
 * wiki/graph artifacts — pure archive-composition material with no home
 * in a generic house (docs/harness-port/03-house-design.md §3.1). The
 * four sections about the resident ITSELF (clock, inbox, filings,
 * ledger) are kept. `spentTodayLocal`'s pricing lookup went through the
 * source's own archive-harness cost tables, not ported — this port
 * reports spend as "the house computes this" honestly rather than
 * reimplementing pricing math with no cost table to read.
 *
 * The role-scoped read: `filedSinceLastWakingSection` gates each run by
 * its class.json visibility exactly as record-tools.mjs's own `mayRead`
 * gates a being reading another room's record. `whatArrivedSection` needs
 * no such gate — it is already scoped to this one handle's own inbox.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testamentFor } from "./testaments.mjs";
import { countPeriodsToday, readAlarm, readIntent } from "./alarm-store.mjs";
import { normalizeCovenant, residentHandles } from "./resident-covenant.mjs";
import {
  filedSinceLastWakingSection,
  ledgerTailSection,
  whatArrivedSection,
} from "./resident-house-sections.mjs";

/** parsed JSON, or null on any absence/parse failure — an honest absence,
 * never a thrown error at request time. Kept for run.json reads only;
 * alarm.json goes through alarm-store.mjs's readAlarm/patchAlarm instead. */
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------- *
 * Your own clock — the resident's own alarm, covenant, today's           *
 * count/spend, past wakings, and its life.                               *
 * ---------------------------------------------------------------------- */

const UNCAPPED_TEXT = "uncapped"; // how COVENANT_DEFAULTS' Infinity (no cap set) reads in prose

/** `rest`'s own wake_on vocabulary (resident-tools.mjs's `rest`
 * inputSchema: kind "keeper" only in this port — see that module's own
 * header for the other kinds this port drops) -> a plain phrase. */
const WAKE_ON_KIND_TEXT = {
  keeper: "the keeper's word",
};

/** alarm.wake_on (an array of {kind}) -> one plain phrase, e.g. "the
 * keeper's word wakes you early, floor permitting". */
function describeWakeOn(list) {
  if (!Array.isArray(list) || !list.length)
    return "nothing named — only the alarm itself, and the ceiling, wakes you";
  const parts = list.map((w) => WAKE_ON_KIND_TEXT[w?.kind] ?? String(w?.kind ?? "?"));
  return `${parts.join(", ")} wakes you early, floor permitting`;
}

/** a future ISO timestamp -> "in Nm"/"in Nh"/"in Nd". */
function relIn(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "already due";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "in moments";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** The kept note's own fact, in one line: whether
 * <privateRoot>/<handle>/self.md exists, when it was last written and by
 * which run (its own frontmatter, user-notes.mjs's self_note_write
 * shape), and — when `runId` is given — whether THIS period wrote it.
 * Read by `house`'s clock at the open and by `rest`'s result at the
 * close, so a narrated "self-note updated" meets the file's own answer
 * both times. Honest absence: an unreadable or frontmatter-less file
 * reads as "none yet"/unknown, never a throw. Exported for
 * resident-tools.mjs's restRun. */
export function keptNoteStatus(privateRoot, handle, runId = null) {
  let raw;
  try {
    raw = readFileSync(join(privateRoot, handle, "self.md"), "utf8");
  } catch {
    return "your kept note: none yet — only self_note_write begins one.";
  }
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const front = m ? m[1] : "";
  const field = (k) => {
    const fm = new RegExp(`^${k}:\\s*(.+?)\\s*$`, "m").exec(front);
    return fm ? fm[1].replace(/^["']|["']$/g, "") : null;
  };
  const written = field("written_t") ?? "(date unknown)";
  const fromRun = field("from_run");
  if (runId && fromRun === runId)
    return `your kept note: rewritten this period (${written}) — what stood is snapshotted.`;
  return (
    `your kept note: unchanged this period — last written ${written}` +
    `${fromRun ? ` in run ${fromRun}` : ""}; only self_note_write changes it.`
  );
}

/** The section itself: the alarm, the covenant, today, past wakings, and
 * the life. `ctx` is read for `ctx.cls === "waking"` (the `awake` line:
 * this run's OWN waking, never a stray currently-live waking glimpsed
 * from a visit — a visit's owner is the visitor, not the resident, so
 * the two can be simultaneously live and must never be conflated here)
 * and for `ctx.life` (a life carried into THIS period, present only when
 * one was mounted at branch open). */
function ownClockSection(deps, ctx, handle) {
  if (!handle)
    return "Your own clock: no resident handle is known for this run — nothing to read here.";

  const lines = ["Your own clock:"];
  const alarm = readAlarm(deps.privateRoot, handle);
  const allowlisted = residentHandles().includes(handle);

  // 1. the alarm
  if (!alarm) {
    lines.push(
      "  no alarm set — nothing wakes you on its own until you `rest` with one, or the keeper wakes you.",
    );
  } else if (typeof alarm.until === "string") {
    lines.push(
      `  next wake: ${alarm.until} (${relIn(alarm.until)}) — reason: ${alarm.reason ?? "(no reason recorded)"}`,
    );
    lines.push(`  wake_on: ${describeWakeOn(alarm.wake_on)}`);
    lines.push(`  set by ${alarm.set_by ?? "?"} at ${alarm.set_t ?? "?"}`);
    lines.push(
      "  the house clamps this to your covenant's floor/ceiling and may defer for keeper " +
        "presence — this file's `until` is what you asked; the house's tick is what actually " +
        "happens.",
    );
  } else {
    lines.push("  an alarm file exists here but names no next wake yet.");
  }
  if (alarm?.paused) {
    lines.push(
      `  the keeper (${alarm.paused.by ?? "?"}) paused you at ${alarm.paused.t ?? "?"} — nothing wakes you until resumed.`,
    );
  }
  if (alarm?.open_until) {
    lines.push(
      `  door open until ${alarm.open_until} — conversation is the active affordance until then.`,
    );
  }
  if (ctx?.cls === "waking" && alarm?.awake) {
    lines.push(`  this waking: run ${alarm.awake.run ?? "?"}, since ${alarm.awake.since ?? "?"}.`);
  }
  lines.push(
    allowlisted
      ? `  this box will honor it — ${handle} is in HOUSE_RESIDENTS.`
      : "  on this box nothing wakes you (not in HOUSE_RESIDENTS).",
  );
  // 1.2 the kept note's own fact
  lines.push(`  ${keptNoteStatus(deps.privateRoot, handle, ctx?.id ?? null)}`);
  // 1.3 own continuation, when the period armed it (stage-tools.mjs).
  if (ctx?.ownContinuation) {
    const max = Number.isFinite(ctx.ownReturnsMax) ? ctx.ownReturnsMax : "?";
    lines.push(
      `  returns this period: ${ctx.stageContinues ?? 0} of ${max} (task_continue — yours to take or not).`,
    );
  }

  // 1.5 a pending own-initiated period — read regardless of ctx.cls: a
  // visitor may ask what's queued too.
  const intent = readIntent(deps.privateRoot, handle);
  if (intent?.walk && intent.walk.run == null) {
    lines.push("  a period of your own is pending — opens when this waking rests.");
  }

  // 2. the covenant
  const testament = testamentFor(handle);
  const cov = testament ? normalizeCovenant(testament.covenant ?? {}, handle) : null;
  if (!cov) {
    lines.push(`  no testament for @${handle} on this box.`);
  } else {
    const wpd = Number.isFinite(cov.wakings_per_day) ? String(cov.wakings_per_day) : UNCAPPED_TEXT;
    const budget = Number.isFinite(cov.budget_usd_per_day)
      ? `$${cov.budget_usd_per_day.toFixed(2)}`
      : UNCAPPED_TEXT;
    const quiet = cov.quiet_hours == null ? "none" : JSON.stringify(cov.quiet_hours);
    lines.push(
      `  covenant: sleep floor ${cov.sleep.floor_h}h / ceiling ${cov.sleep.ceiling_d}d / ` +
        `default ${cov.sleep.default_h}h; up to ${wpd} waking(s)/day, ${cov.open_hours_max_h}h ` +
        `open-hours max, budget ${budget}/day; quiet hours: ${quiet}; ` +
        `${cov.reserved_human_slots} human slot(s) reserved; speaks for ${cov.speaks_for ?? "(not set)"}.`,
    );
  }

  // 3. today (periods: wakings and the resident's own periods together)
  const periodsToday = countPeriodsToday(alarm);
  const maxPerDay = cov
    ? Number.isFinite(cov.wakings_per_day)
      ? String(cov.wakings_per_day)
      : UNCAPPED_TEXT
    : "?";
  lines.push(`  periods today: ${periodsToday} of ${maxPerDay} (wakings and your own periods).`);
  // spend: this port ships no pricing table (the source deployment's own
  // cost-table module was archive-harness-specific) — said honestly
  // rather than reimplemented against nothing.
  lines.push("  spend: the house computes this.");

  // 4. your past periods (wakings and the resident's own periods)
  const history = Array.isArray(alarm?.history) ? alarm.history : [];
  const woken = history
    .filter((h) => typeof h?.woke_t === "string")
    .slice(-5)
    .reverse();
  if (!woken.length) {
    lines.push("  your past periods: none yet on record.");
  } else {
    lines.push(`  your past periods (last ${woken.length}, newest first):`);
    for (const h of woken) {
      let reaches = "?";
      let filed = "?";
      if (h.run) {
        const run = readJsonSafe(join(deps.runsRoot, h.run, "run.json"));
        if (run) {
          reaches = typeof run.reaches === "number" ? run.reaches : "?";
          filed = Array.isArray(run.filed) ? run.filed.length : "?";
        }
      }
      lines.push(
        h.kind === "walk"
          ? `    - ${h.woke_t} · your own period · run ${h.run ?? "(unrecorded)"} · reaches=${reaches}, filed=${filed}`
          : `    - ${h.woke_t} · run ${h.run ?? "(unrecorded)"} · reason: ${h.reason ?? "(none recorded)"} · reaches=${reaches}, filed=${filed}`,
      );
    }
    lines.push("  replay any of these verbatim with record_read.");
  }

  // 4b. voice changes on record: a `model-switch` history entry
  // (alarm-store.mjs's modelSwitch) carries no `woke_t` — informational,
  // never a period of its own, so it's excluded from "past periods" above.
  const switches = history
    .filter((h) => h?.kind === "model-switch")
    .slice(-3)
    .reverse();
  if (switches.length) {
    lines.push(`  voice changes on record (last ${switches.length}, newest first):`);
    for (const h of switches) lines.push(`    - ${h.t} · ${h.from} → ${h.to}`);
  }

  // 5. your life: the continuous chronicle mounted, when one was carried
  // into THIS period (ctx.life — set once, at branch open). A note
  // (didn't fit, or the file itself couldn't be read) rides beside the
  // counts rather than instead of them.
  if (ctx?.life) {
    const lp = ctx.life.last_period;
    const lpText = lp ? `${lp.run ?? "?"} · ${lp.kind ?? "?"} · ${lp.ended_t ?? "?"}` : "none yet";
    lines.push(
      `  your life: ${ctx.life.messages ?? 0} message(s), ${ctx.life.summaries ?? 0} ` +
        `recollection(s), ${ctx.life.periods ?? 0} period(s) carried; last period: ${lpText}` +
        (ctx.life.note ? ` — ${ctx.life.note}` : ""),
    );
  } else {
    lines.push("  your life: no life mounted this period.");
  }

  return lines.join("\n");
}

/** the last alarm.json history entry that actually recorded a waking
 * (`woke_t`, written by the house side when it wakes the resident on
 * this alarm) — the "since your last waking" anchor every house section
 * reads against. Absent (no alarm.json, or none of its history entries
 * ever woke) reads as "no prior waking on record", never a guessed date. */
function lastWokeT(privateRoot, handle) {
  if (!handle) return null;
  const alarm = readAlarm(privateRoot, handle);
  const history = Array.isArray(alarm?.history) ? alarm.history : [];
  const woke = history.filter((h) => typeof h?.woke_t === "string");
  return woke.length ? woke[woke.length - 1].woke_t : null;
}

/** The handle THIS run's own resident keeps its records under: for a
 * waking, ctx.owner (the run's own owner IS the resident); for a visit,
 * ctx.owner is the VISITOR instead, so the resident being visited is
 * named by ctx.being — `house` must read ITS state, never the visitor's.
 * Prefers ctx.owner by default (byte-identical for a waking and for
 * every direct-ctx unit test that never sets `being`) and defers to
 * ctx.being only when it is actually present and ctx.owner isn't already
 * the resident itself. Duplicated (not imported) across
 * resident-house.mjs/resident-proposals.mjs/resident-tools.mjs. */
function residentHandle(ctx) {
  return ctx.being && ctx.ownerKind !== "resident" ? ctx.being : ctx.owner;
}

/** @param {{ privateRoot: string, runsRoot: string }} deps */
export function houseRun(deps, ctx) {
  const handle = residentHandle(ctx) ?? null;
  const sinceISO = lastWokeT(deps.privateRoot, handle);
  // the order is deliberate: the resident's own standing throughout,
  // never framed as an ask.
  const sections = [
    ownClockSection(deps, ctx, handle),
    whatArrivedSection(deps.privateRoot, handle, sinceISO),
    filedSinceLastWakingSection(deps.runsRoot, sinceISO, handle),
    ledgerTailSection(deps.privateRoot, handle),
  ];
  return { content: sections.join("\n\n") };
}
