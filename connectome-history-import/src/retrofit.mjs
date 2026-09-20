// @ts-check
/* connectome-history-import/src/retrofit.mjs — Step 2 of the restore
 * cutover (docs/harness-port/21-restore-rehearsal.md §6) as a flag, not a
 * hand script: for every room `cli.mjs`'s own sweep found already on disk
 * (the house's own `findRoom`) whose VEIL history was never fully
 * appended, calls `slice.mjs`'s `sliceRoom` against the SAME `group` the
 * sweep's own buckets -> facets -> streams pass already built — no second
 * read of state, no second identity map.
 *
 * `retrofitCandidates` needs no identity at all (only `findRoom` and a
 * room's own `class.json`), so it runs identically for a real run and a
 * `--dry-run`. `previewRetrofit`'s `dryRun` path uses a throwaway identity
 * stand-in (`previewIdentity`, below) that returns a value for every
 * `.human()`/`.bot()` call but writes NOTHING to the house's real identity
 * map — `slice.mjs`'s own `sliceRoom(..., dryRun: true)` then builds the
 * exact same frames and reports their count without ever acquiring the
 * room's import lock or calling `appendSlice`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { reportMarkdown } from "./report.mjs";
import { sliceRoom } from "./slice.mjs";

/** a room's own class.json, or null (missing/unreadable — never fatal). */
function readCls(runsDir, id) {
  try {
    return JSON.parse(readFileSync(join(runsDir, id, "class.json"), "utf8"));
  } catch {
    return null;
  }
}

/** cli.mjs's `--retrofit`/`--retrofit-only`/`--rooms <id,id>`, parsed once. */
export function retrofitFlags(argv) {
  const retrofitOnly = argv.includes("--retrofit-only");
  const i = argv.indexOf("--rooms");
  const raw = i !== -1 && argv[i + 1] != null ? argv[i + 1] : "";
  const namedRooms = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return { retrofit: argv.includes("--retrofit") || retrofitOnly, retrofitOnly, namedRooms };
}

/** a stand-in for `identity.mjs`'s `makeIdentity()` that never touches the
 * house's real identity map: every call returns SOME stable-enough string
 * so `slice.mjs`'s frame-building yields the real frame count, but no
 * platform id is ever looked up or persisted. Dry-run preview only. */
function previewIdentity() {
  let n = 0;
  const next = () => `preview-${(n += 1)}`;
  return {
    human: () => next(),
    bot: (name) => String(name ?? "bot"),
    humanFromSpeechAuthor: () => next(),
    scrubMentions: (text) => ({ text: String(text ?? ""), scrubbed: 0 }),
  };
}

/**
 * Every room worth retrofitting: found via the house's own `findRoom` for
 * a group in `ordered` (the sweep's own `--streams`/`--limit` selection),
 * plus any room named in `namedRooms` (an explicit `--rooms` override,
 * searched across the WHOLE `groups` map so a caller can name a room the
 * sweep's own `--streams` filter excluded). A room already fully imported
 * (`imported.last_seq === group.lastSeq`) is not a candidate.
 * @param {{ordered: import("./streams.mjs").StreamGroup[], groups: Map<string, import("./streams.mjs").StreamGroup>,
 *   namedRooms: string[], runsDir: string}} args
 * @returns {Promise<Array<{id: string, group: import("./streams.mjs").StreamGroup}>>}
 */
export async function retrofitCandidates({ ordered, groups, namedRooms, runsDir }) {
  const { findRoom } = await import("connectome-house/src/room-index.mjs");
  const out = [];
  const seen = new Set();
  const add = (id, group) => {
    if (seen.has(id)) return;
    const cls = readCls(runsDir, id);
    if (!cls) return;
    if ((cls.imported?.last_seq ?? null) === group.lastSeq) return; // fully imported already
    seen.add(id);
    out.push({ id, group });
  };
  for (const g of ordered) {
    const existing = findRoom({ platform: g.platform, stream: g.stream });
    if (existing) add(existing.id, g);
  }
  if (namedRooms.length) {
    const wanted = new Set(namedRooms);
    for (const g of groups.values()) {
      const existing = findRoom({ platform: g.platform, stream: g.stream });
      if (existing && wanted.has(existing.id)) add(existing.id, g);
    }
  }
  return out;
}

/**
 * Retrofits (or, `dryRun`, previews) every candidate room, one `sliceRoom`
 * call each. Never mints a room — every candidate already exists.
 * @param {{runsDir: string, stateDir: string, candidates: Array<{id: string, group: any}>,
 *   identity: any, delivered: Map<string, any>, houseId: string, exportedT: string,
 *   knownBeings?: Map<string,string>|null, dryRun?: boolean, log?: (s: string) => void}} args
 * @returns {Promise<Array<{id: string, applied: boolean, frames: number, reason?: string, retrofit?: boolean}>>}
 */
export async function runRetrofit({
  runsDir,
  stateDir,
  candidates,
  identity,
  delivered,
  houseId,
  exportedT,
  knownBeings = null,
  dryRun = false,
  log,
}) {
  const useIdentity = dryRun ? previewIdentity() : identity;
  const results = [];
  for (const c of candidates) {
    const res = await sliceRoom({
      runsDir,
      stateDir,
      runId: c.id,
      group: c.group,
      identity: useIdentity,
      delivered,
      houseId,
      exportedT,
      knownBeings,
      dryRun,
    });
    const frames = res.applied ? (res.frames ?? 0) : 0;
    results.push({ id: c.id, applied: res.applied, frames, reason: res.reason, retrofit: res.retrofit });
    if (log)
      log(
        `  retrofit ${c.id}: ${res.applied ? `${frames} frame(s)${dryRun ? " (dry run — not written)" : ""}` : `skipped (${res.reason})`}`,
      );
  }
  return results;
}

/** the report/log summary both `applyRetrofit`/`previewRetrofit` share. */
export function retrofitSummary(results) {
  const applied = results.filter((r) => r.applied);
  return {
    rooms: applied.length,
    frames: applied.reduce((n, r) => n + r.frames, 0),
    perRoom: applied.map((r) => ({ id: r.id, frames: r.frames })),
    skipped: results.filter((r) => !r.applied).map((r) => ({ id: r.id, reason: r.reason })),
  };
}

/** a minimal report.mjs-shaped write, for the dry-run-only report (no
 * written/lives/skipped rows exist to show — only what retrofit found). */
function writeRetrofitReport({ reportPath, stats, t0, roots, beingsFile }, sum) {
  const report = {
    stats, counts: [], written: [], lives: [], skipped: [], t0, roots,
    dryRun: true, beingsFile, retrofitted: sum, systemNotices: 0, reclassed: [], aliasMatches: [],
  };
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), reportMarkdown(report));
}

/** cli.mjs's own `--retrofit`/`--retrofit-only` entry point: candidates,
 * real sliceRoom calls, the summary log line — one call for cli.mjs. */
export async function applyRetrofit(ctx) {
  const candidates = await retrofitCandidates(ctx);
  const results = await runRetrofit({ ...ctx, candidates, dryRun: false });
  const sum = retrofitSummary(results);
  if (ctx.log) ctx.log(`[history-import] Retrofitted: ${sum.rooms} rooms, ${sum.frames} frames`);
  return sum;
}

/** the `--dry-run --retrofit` twin of `applyRetrofit`: no real identity is
 * ever built (module header) — safe without HOUSE_IDENTITY_SALT; writes
 * its own report directly (`ctx.reportPath`) since a dry run's cli.mjs
 * never reaches the shape the ordinary write report is built from. */
export async function previewRetrofit(ctx) {
  const candidates = await retrofitCandidates(ctx);
  const results = await runRetrofit({ ...ctx, candidates, identity: null, dryRun: true });
  const sum = retrofitSummary(results);
  if (ctx.log)
    ctx.log(`[history-import] Retrofitted (dry run): ${sum.rooms} rooms, ${sum.frames} frames would land`);
  if (ctx.reportPath) writeRetrofitReport(ctx, sum);
  return sum;
}
