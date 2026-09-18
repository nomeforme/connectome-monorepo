// @ts-check
/* connectome-house/src/resident-house-sections.mjs — three of `house`'s
 * four plain-reading sections (resident-house.mjs's own clock section is
 * the fourth, kept there since it is the load-bearing one): what was
 * filed since the last waking, what arrived in the inbox, and the
 * ledger's own tail. Carved out of resident-house.mjs to hold that file
 * under this repo's file-length ratchet — no behavior split, just a
 * smaller file per concern.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FILED_LIMIT = 20; // filed-since-last-waking paths shown
const INBOX_LIMIT = 30; // what-arrived events shown
const LEDGER_TAIL_LINES = 15;

/** parsed JSON, or null on any absence/parse failure — an honest absence,
 * never a thrown error at request time. */
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

/** accepted (non-pending) participant handles from a class.json shape —
 * mirrors serve-identity.mjs's acceptedParticipants. Duplicated rather
 * than imported: this module runs being-side, kept decoupled from the
 * house's own server modules the way record-tools.mjs's own mayRead is. */
function acceptedParticipants(cls) {
  return (cls?.participants ?? []).filter((p) => !p?.pending).map((p) => p.handle);
}

/** may `asHandle` read a run at this class.json shape? — the being-side
 * collapse of serve-identity.mjs's mayView: a private run is readable
 * only by its owner or an accepted participant; absent class.json reads
 * as legacy public, exactly scopeOfDir's own default. */
function mayReadRun(cls, asHandle) {
  if ((cls?.visibility ?? "public") !== "private") return true;
  if (!asHandle) return false;
  return cls.owner === asHandle || acceptedParticipants(cls).includes(asHandle);
}

/** notes filed since `sinceISO` (the last alarm history entry carrying
 * woke_t, or null for "no prior waking on record"): each run dir's own
 * filed/ subtree (recursive) when it exists, else run.json's own `filed`
 * array timestamped by that run's own last session end (or birth).
 * Gated first by `mayReadRun`: a run this handle's role may not read
 * contributes nothing to this section, exactly as it would contribute
 * nothing to record_list for a being without standing. */
export function filedSinceLastWakingSection(runsRoot, sinceISO, handle) {
  let runDirs;
  try {
    runDirs = readdirSync(runsRoot);
  } catch {
    return "Filed since last waking: the room ledger isn't readable here — nothing to read.";
  }
  const items = [];
  for (const d of runDirs) {
    const dir = join(runsRoot, d);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const cls = readJsonSafe(join(dir, "class.json"));
    if (!mayReadRun(cls, handle)) continue; // a role-scoped read: nothing this handle may not view
    const filedDir = join(dir, "filed");
    if (existsSync(filedDir)) {
      for (const p of listFilesRecursive(filedDir)) {
        let t;
        try {
          t = statSync(p).mtime.toISOString();
        } catch {
          continue;
        }
        if (!sinceISO || t > sinceISO) items.push({ path: relative(runsRoot, p), t });
      }
    } else {
      const run = existsSync(join(dir, "run.json")) ? readJsonSafe(join(dir, "run.json")) : null;
      if (!Array.isArray(run?.filed) || !run.filed.length) continue;
      const t = run.sessions?.[run.sessions.length - 1]?.ended ?? run.born ?? null;
      if (!sinceISO || (t && t > sinceISO)) {
        for (const p of run.filed) items.push({ path: `${d}/${p}`, t: t ?? "" });
      }
    }
  }
  items.sort((a, b) => (b.t > a.t ? 1 : a.t > b.t ? -1 : 0));
  const shown = items.slice(0, FILED_LIMIT);
  const scopeNote = sinceISO
    ? `since your last waking (${sinceISO})`
    : "no prior waking on record — showing everything found";
  const header = `Filed ${scopeNote}: ${items.length} note(s)${items.length > shown.length ? `, showing ${shown.length}` : ""}.`;
  if (!shown.length) return `${header}\n  (none)`;
  return `${header}\n${shown.map((i) => `  - ${i.path}`).join("\n")}`;
}

/** the resident's own inbox.jsonl (keeper notes, and whatever else a
 * deployment appends there) since `sinceISO`, most recent first. */
export function whatArrivedSection(privateRoot, handle, sinceISO) {
  if (!handle) return "What arrived: no resident handle is known for this run — nothing to read.";
  const p = join(privateRoot, handle, "inbox.jsonl");
  if (!existsSync(p)) return "What arrived: no inbox kept yet — nothing has arrived.";
  let lines;
  try {
    lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  } catch {
    return "What arrived: the inbox isn't readable here.";
  }
  const events = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const since = sinceISO ? events.filter((e) => typeof e.t === "string" && e.t > sinceISO) : events;
  const recent = since.slice(-INBOX_LIMIT).reverse();
  const scopeNote = sinceISO
    ? `since your last waking (${sinceISO})`
    : "no prior waking on record — showing everything kept";
  const header = `What arrived ${scopeNote}: ${since.length} event(s)${since.length > recent.length ? `, showing ${recent.length}` : ""}.`;
  if (!recent.length) return `${header}\n  (nothing)`;
  return (
    `${header}\n` +
    recent
      .map(
        (e) =>
          `  - ${e.type ?? "?"} · ${e.run ?? "?"} · ${e.by ?? "?"} · ${String(e.excerpt ?? e.text ?? "").slice(0, 120)}`,
      )
      .join("\n")
  );
}

export function ledgerTailSection(privateRoot, handle) {
  if (!handle) return "Ledger: no resident handle is known for this run.";
  const p = join(privateRoot, handle, "ledger.md");
  if (!existsSync(p)) return "Ledger: nothing kept yet.";
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return "Ledger: not readable here.";
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-LEDGER_TAIL_LINES);
  if (!tail.length) return "Ledger: kept, but empty so far.";
  return `Ledger tail (last ${tail.length} of ${lines.length} line(s)):\n${tail.map((l) => `  ${l}`).join("\n")}`;
}
