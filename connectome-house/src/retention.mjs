// @ts-check
/* connectome-house/src/retention.mjs — a keeper-confirmed retention sweep
 * for EXTERNAL rooms (seats with `audience: "external"`, the web board):
 * a board keeps posts for a set time (its own `retention_days`, 90 by
 * default) and tells its posters so; the house's record of those rooms
 * otherwise keeps every word forever. This file finds what is past that
 * time and, only when a keeper confirms, removes the words.
 *
 * Two steps, never one: `scanRetention` counts (no writes) and mints a short
 * confirm code bound to exactly that plan; `purgeRetention` runs only with
 * a code from a scan in the last 30 minutes. Nothing runs on a timer: the
 * timer only REMINDS (`retentionReminder`), at most once a day.
 *
 * What a purge does, per external run, to every content frame older than
 * the cutoff:
 *  - frames.jsonl: the frame stays (seq, type, by, to, t — the fact that
 *    something was said, by whom, when), its words go: `text` / `inline`
 *    become a short placeholder, `preview`, `blob`, `bytes`, `file`,
 *    `filename` and a reach's `input` are dropped, and `redacted` records
 *    when, why and on whose word. Rewritten atomically in this process,
 *    where every append to the record also happens, so no append is lost.
 *  - the run's own chronicle blobs that only those frames referenced are
 *    deleted (never when another run forks from this one: forks read their
 *    parent's blobs, lineage.mjs).
 *  - the chronicle's own frame log (a write-only copy nothing reads back)
 *    is cleared when the room is not open; trace.mjs rebuilds it from the
 *    remaining blobs on the next resume. An open room's is cleared by the
 *    next purge after it rests (`chronicle_pending` says which).
 *
 * Not touched (stated, not hidden): each being's life store, which holds
 * short excerpts and its own summaries of these rooms (rewriting memory is
 * a separate, later step); `external.jsonl` (message ids and text hashes,
 * no text); shared media blobs. Imported history (`class.json.imported`)
 * and private runs are never external, whatever their platform.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.mjs";
import { resolveBlobInLineage } from "./lineage.mjs";
import { adapterFor } from "./mcpl/adapters.mjs";
import { loadServersConfig } from "./mcpl/config.mjs";

export const DEFAULT_RETENTION_DAYS = 90;
const CONFIRM_TTL_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
/** per run: whether its chronicle frame log still holds removed words (the room was open) */
const MARKER = "retention.json";

/** frame types that carry someone's words */
const CONTENT_TYPES = new Set(["message", "speech", "edited", "house", "reach", "reach.result", "media.attached"]);
/** fields that hold words (or point at them) */
const DROP_KEYS = ["preview", "blob", "bytes", "file", "filename", "caption"];

/** the placeholder a removed frame's words become @param {number} days */
export const removedText = (days) => `[removed: older than this room's ${days}-day retention]`;

/** the retention days the house applies (env HOUSE_EXTERNAL_RETENTION_DAYS, else 90)
 * @param {Record<string, string|undefined>} [env] */
export function retentionDays(env = process.env) {
  const n = Number(env.HOUSE_EXTERNAL_RETENTION_DAYS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

/** the house's own answer to "is this place external?": the platform's
 * adapter says so for every room on it (the web board), or a configured
 * seat on that platform carries `audience: "external"` for that stream.
 * @returns {(platform: string, stream: string) => boolean} */
export function externalPlaceFromConfig(env = process.env) {
  let servers = [];
  try {
    servers = loadServersConfig(env).servers;
  } catch {
    servers = [];
  }
  return (platform, stream) => {
    if (adapterFor(platform)?.audience === "external") return true;
    return servers.some((s) => s.platform === platform && s.audience === "external" &&
      (s.rooms_policy === "any" || (s.rooms ?? []).some((r) => r?.stream === stream)));
  };
}

/** @param {string} dir */
function readJson(dir, name) {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

/** is this run an external room's record? Imported history and private runs never are.
 * @param {any} cls @param {(platform: string, stream: string) => boolean} isExternalPlace */
export function isExternalRun(cls, isExternalPlace) {
  if (!cls || cls.imported || cls.visibility === "private") return false;
  const platform = cls.room?.platform;
  const stream = cls.room?.stream;
  return typeof platform === "string" && typeof stream === "string" && isExternalPlace(platform, stream);
}

/** @param {string} text */
function parseFrames(text) {
  /** @type {Array<{line: string, frame: any}>} */
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let frame = null;
    try {
      frame = JSON.parse(line);
    } catch {
      /* a torn line stays as it is */
    }
    out.push({ line, frame });
  }
  return out;
}

/** a frame whose words are past the cutoff and not yet removed @param {any} f @param {number} cutoff */
const isDue = (f, cutoff) =>
  !!f && CONTENT_TYPES.has(f.type) && !f.redacted && Date.parse(f.t) < cutoff;

/** runs that fork from `id` (they read its blobs) @param {string} runsDir @param {string} id */
function hasDescendants(runsDir, id) {
  for (const d of safeReaddir(runsDir)) {
    if (d === id) continue;
    if (readJson(join(runsDir, d), "class.json")?.forkedFrom?.run === id) return true;
  }
  return false;
}

/** @param {string} dir */
function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Count what is past the cutoff in every external run. No writes.
 * @param {{runsDir: string, days?: number, now?: number,
 *   isExternalPlace?: (platform: string, stream: string) => boolean,
 *   isOpen?: (runId: string) => boolean}} o
 */
export function scanRetention({ runsDir, days = retentionDays(), now = Date.now(), isExternalPlace = externalPlaceFromConfig(), isOpen = () => false }) {
  const cutoff = now - days * DAY_MS;
  const runs = [];
  for (const id of safeReaddir(runsDir).sort()) {
    const dir = join(runsDir, id);
    const cls = readJson(dir, "class.json");
    if (!isExternalRun(cls, isExternalPlace)) continue;
    const path = join(dir, "frames.jsonl");
    if (!existsSync(path)) continue;
    let due = 0;
    let oldest = null;
    for (const { frame } of parseFrames(readFileSync(path, "utf8"))) {
      if (!isDue(frame, cutoff)) continue;
      due += 1;
      if (!oldest || frame.t < oldest) oldest = frame.t;
    }
    const chronicleDirty = readJson(dir, MARKER)?.chronicle_pending === true;
    if (due || chronicleDirty) {
      runs.push({ run: id, stream: cls.room.stream, title: cls.room.title ?? null, due, oldest, open: isOpen(id), chronicle_pending: chronicleDirty && !due });
    }
  }
  const total = runs.reduce((n, r) => n + r.due, 0);
  const code = createHash("sha256")
    .update(JSON.stringify({ cutoff, runs: runs.map((r) => [r.run, r.due]) }))
    .digest("hex")
    .slice(0, 8);
  return { days, cutoff: new Date(cutoff).toISOString(), total, runs, code };
}


/**
 * Remove the words of every due frame in one run. Synchronous by design
 * (read → rewrite → rename in one tick of the house process).
 * @param {{runDir: string, runId: string, runsDir: string, cutoff: number, days: number, by: string,
 *   now?: number, open?: boolean}} o
 */
export function purgeRun({ runDir, runId, runsDir, cutoff, days, by, now = Date.now(), open = false }) {
  const path = join(runDir, "frames.jsonl");
  const rows = parseFrames(readFileSync(path, "utf8"));
  const placeholder = removedText(days);
  const stamp = { t: new Date(now).toISOString(), reason: "retention", days, by };
  /** @type {Set<string>} */ const freed = new Set();
  let removed = 0;
  for (const row of rows) {
    const f = row.frame;
    if (!isDue(f, cutoff)) continue;
    if (typeof f.blob === "string") freed.add(f.blob);
    for (const k of DROP_KEYS) delete f[k];
    if (typeof f.text === "string") f.text = placeholder;
    if (typeof f.inline === "string" || f.type === "speech" || f.type === "reach.result") f.inline = placeholder;
    if (f.input !== undefined) f.input = {};
    f.redacted = stamp;
    row.line = JSON.stringify(f);
    removed += 1;
  }
  if (removed) atomicWriteFileSync(path, rows.map((r) => r.line).join("\n") + "\n");

  // blobs only removed frames pointed at, from this run's own store
  let blobsDeleted = 0;
  if (freed.size && !hasDescendants(runsDir, runId)) {
    const stillUsed = new Set(rows.map((r) => r.frame?.blob).filter((b) => typeof b === "string"));
    const own = resolve(runDir) + sep;
    for (const sha of freed) {
      if (stillUsed.has(sha)) continue;
      const p = resolveBlobInLineage(runDir, sha).path;
      if (p && resolve(p).startsWith(own)) {
        try {
          unlinkSync(p);
          blobsDeleted += 1;
        } catch {
          /* already gone */
        }
      }
    }
  }

  // the chronicle's frame log keeps a copy of every frame: cleared (blobs
  // kept) when the room is not open; trace.mjs re-seeds on resume
  let chronicleCleared = false;
  let chroniclePending = false;
  const chron = join(runDir, "chronicle");
  const marker = join(runDir, MARKER);
  if (existsSync(join(chron, "MANIFEST")) && (removed || readJson(runDir, MARKER)?.chronicle_pending)) {
    if (open) {
      chroniclePending = true;
      atomicWriteFileSync(marker, JSON.stringify({ chronicle_pending: true, since: stamp.t }) + "\n");
    } else {
      for (const name of safeReaddir(chron)) {
        if (name === "blobs") continue;
        rmSync(join(chron, name), { recursive: true, force: true });
      }
      chronicleCleared = true;
    }
  }
  if (!chroniclePending) rmSync(marker, { force: true });
  return { run: runId, removed, blobs_deleted: blobsDeleted, chronicle_cleared: chronicleCleared, chronicle_pending: chroniclePending };
}

/** a scan a keeper can confirm, by code; one at a time per house
 * @type {{code: string, at: number, scan: ReturnType<typeof scanRetention>}|null} */
let pending = null;

/** scan, and remember the plan under its confirm code
 * @param {Parameters<typeof scanRetention>[0]} o */
export function proposeRetention(o) {
  const scan = scanRetention(o);
  pending = { code: scan.code, at: o.now ?? Date.now(), scan };
  return scan;
}

/**
 * Run the plan a keeper confirmed. Refuses an unknown or stale code, or a
 * plan the record has moved past (a fresh scan must give the same code).
 * @param {Parameters<typeof scanRetention>[0] & {confirm: string, by: string}} o
 */
export function purgeRetention(o) {
  const now = o.now ?? Date.now();
  if (!pending || pending.code !== o.confirm) return { ok: false, error: "no scan with that code; scan first" };
  if (now - pending.at > CONFIRM_TTL_MS) {
    pending = null;
    return { ok: false, error: "that scan is older than 30 minutes; scan again" };
  }
  const fresh = scanRetention({ ...o, days: pending.scan.days, now: pending.at });
  if (fresh.code !== o.confirm) return { ok: false, error: "the record changed since that scan; scan again" };
  pending = null;
  const cutoff = Date.parse(fresh.cutoff);
  const isOpen = o.isOpen ?? (() => false);
  const results = fresh.runs.map((r) =>
    purgeRun({ runDir: join(o.runsDir, r.run), runId: r.run, runsDir: o.runsDir, cutoff, days: fresh.days, by: o.by, now, open: isOpen(r.run) }));
  const removed = results.reduce((n, r) => n + r.removed, 0);
  return { ok: true, days: fresh.days, cutoff: fresh.cutoff, removed, runs: results };
}

/** a one-line reminder when anything is due, at most once per `everyMs`
 * (default a day); null otherwise. The caller decides where it goes.
 * @param {Parameters<typeof scanRetention>[0] & {everyMs?: number}} o */
export function retentionReminder(o) {
  const now = o.now ?? Date.now();
  if (now - lastReminder < (o.everyMs ?? DAY_MS)) return null;
  const s = scanRetention(o);
  if (!s.total) return null;
  lastReminder = now;
  return `${s.total} message${s.total === 1 ? "" : "s"} in ${s.runs.length} external room${s.runs.length === 1 ? "" : "s"} ` +
    `are past the ${s.days}-day retention (oldest ${s.runs.map((r) => r.oldest).filter(Boolean).sort()[0]?.slice(0, 10)}). ` +
    `A keeper can review and remove them: POST /api/retention {"verb":"scan"}.`;
}
let lastReminder = 0;

/** test seam: forget the pending plan and the reminder clock */
export function _resetRetention() {
  pending = null;
  lastReminder = 0;
}
