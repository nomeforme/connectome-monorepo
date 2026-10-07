#!/usr/bin/env node
/* Re-fold one being's life in its OWN voice, in a sandbox — the restore
 * seeded every trunk with mock folds (docs/harness-port/38). Run INSIDE
 * that being's container (it holds the being's model credentials), from
 * /workspace/connectome-house:
 *
 *   node tools/fold-life.mjs <handle> <sandboxDir> [budgetTokens]
 *
 * <sandboxDir> must already hold `runs/<id>/{class.json,frames.jsonl,
 * external.jsonl}` copies of every room the being is in (the keeper-side
 * staging step copies them), and gets `private/<handle>/` — the new
 * trunk — plus a fresh `life.appended.<handle>.json` marker per room.
 * Nothing outside the sandbox is touched; the swap is a separate step.
 *
 * What it bakes in, each learned the hard way on opus-4-8 (2026-10-03):
 *  - rooms in chronological order (by first frame), never by id;
 *  - resident-life.mjs's own membrane: auth resolved per call (a fold
 *    outlives an OAuth token);
 *  - a rate limit waits and retries (minutes, backing off) — run ONE fold
 *    at a time; and the store is closed on any exit, since it only
 *    persists on a clean close;
 *  - appendPeriod marks a room before folding it; a room whose append
 *    still threw is resumed by draining + marking, never re-appended;
 *  - merge checks driven to exhaustion at the end (the scheduler only
 *    re-checks on new events);
 *  - a final compile at the target budget, so "done" means "usable".
 * Re-runnable: rooms already marked are no-ops. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openLife, appendPeriod, compileFor, closeAllLives, lifeStats, membraneForSpeaksFor } from "../src/resident-life.mjs";
import { readFramesJsonl, readAppendMarker, writeAppendMarker, advanceMarker } from "../src/life-entries.mjs";
import { testamentFor } from "../src/testaments.mjs";
import { normalizeCovenant } from "../src/resident-covenant.mjs";

const [handle, sandbox, budgetArg] = process.argv.slice(2);
if (!handle || !sandbox) {
  console.error("usage: fold-life.mjs <handle> <sandboxDir> [budgetTokens]");
  process.exit(2);
}
const budget = Number(budgetArg ?? 140000);
const privateRoot = join(sandbox, "private");
const runsRoot = join(sandbox, "runs");
const log = (...a) => console.error(`[fold @${handle}]`, ...a);

const t = testamentFor(handle);
if (!t) throw new Error(`no testament for ${handle}`);
const cov = { ...normalizeCovenant(t.covenant ?? {}, handle), life_budget_tokens: budget };
if (typeof cov.speaks_for !== "string") throw new Error(`${handle} has no speaks_for`);

const real = await membraneForSpeaksFor(cov.speaks_for);
let calls = 0;
let inTok = 0;
// a fold is meant to run slowly, one being at a time, on a subscription:
// a rate limit is a pause, never the end of the run
const isRateLimit = (e) => e?.httpStatus === 429 || /\b429\b|rate_limit|overloaded|\b529\b/i.test(String(e?.message ?? e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const membrane = {
  async complete(...a) {
    let r;
    for (let attempt = 1; ; attempt++) {
      try {
        r = await real.complete(...a);
        break;
      } catch (e) {
        if (!isRateLimit(e) || attempt >= 40) throw e;
        const wait = Math.min(15 * 60_000, 60_000 * attempt);
        log(`rate-limited (attempt ${attempt}) — waiting ${Math.round(wait / 60_000)} min`);
        await sleep(wait);
      }
    }
    calls++;
    inTok += r?.usage?.inputTokens ?? 0;
    if (calls % 10 === 0) log(`progress calls=${calls} in=${inTok}`);
    return r;
  },
};
const life = await openLife({ privateRoot, handle, speaksFor: cov.speaks_for, covenant: cov, membrane });
// the store only persists on a clean close: a crash used to lose every
// room folded so far (the 2026-10-04 parallel runs all ended this way)
const closeAndExit = (code, why) => {
  if (why) log(`STOP: ${why}`);
  try {
    closeAllLives();
  } catch {
    /* already failing */
  }
  process.exit(code);
};
process.on("uncaughtException", (e) => closeAndExit(1, e?.stack ?? String(e)));
process.on("unhandledRejection", (e) => closeAndExit(1, e?.stack ?? String(e)));
process.on("SIGTERM", () => closeAndExit(143, "SIGTERM"));
process.on("SIGINT", () => closeAndExit(130, "SIGINT"));
const strategy = life.getStrategy();

async function drain(max = 5000) {
  let n = 0;
  while (life.getPendingWork() && n < max) {
    await life.tick();
    n++;
    await new Promise((r) => setTimeout(r, 0));
  }
  return !life.getPendingWork();
}

const firstT = (id) => {
  try {
    return JSON.parse(readFileSync(join(runsRoot, id, "frames.jsonl"), "utf8").split("\n", 1)[0]).t ?? "9";
  } catch {
    return "9";
  }
};
const ids = readdirSync(runsRoot)
  .filter((id) => existsSync(join(runsRoot, id, "class.json")))
  .map((id) => [firstT(id), id])
  .sort()
  .map(([, id]) => id);
log(`${ids.length} rooms, voice ${cov.speaks_for}, budget ${budget}`, JSON.stringify(lifeStats(life)));

for (const id of ids) {
  const runDir = join(runsRoot, id);
  try {
    const r = await appendPeriod(life, runDir, { privateRoot });
    log(`room ${firstT(id).slice(0, 10)} ${id.slice(0, 44)} ${r.mode} msgs=${r.messages}${r.compress ? ` (${r.compress})` : ""}`);
    // a deferred fold (appendPeriod marks first, then folds) finishes here,
    // before the next room — chronological, as-of memories
    if (r.compress) await drain();
  } catch (e) {
    // messages already added; finish the compression, then mark — never re-append
    log(`room ${id} threw mid-append (${e.message.slice(0, 160)}) — resuming by drain`);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        ok = await drain();
      } catch (e2) {
        log(`  drain attempt ${attempt + 1} failed: ${e2.message.slice(0, 160)}`);
      }
    }
    if (!ok) {
      log(`  STOP: ${id} could not be drained — fix the cause and re-run (it will resume here)`);
      break;
    }
    const marker = readAppendMarker(runDir, handle);
    const prior = marker ? marker.through_seq : -1;
    const fresh = readFramesJsonl(runDir).filter((f) => typeof f.seq === "number" && f.seq > prior);
    writeAppendMarker(runDir, handle, advanceMarker(marker, fresh));
    log(`  resumed + marked through ${readAppendMarker(runDir, handle).through_seq}`);
  }
}

for (let round = 0; round < 200; round++) {
  strategy.checkMergeThreshold();
  if (!life.getPendingWork()) break;
  await drain(500);
  log(`merge round ${round}: summaries ${lifeStats(life).summaries}, merge-quarantined ${strategy.getMergeQuarantineStatus().count}`);
}

const probeRoom = ids[ids.length - 1];
const out = await compileFor(life, join(runsRoot, probeRoom), { runsRoot, outPath: join(sandbox, `compile-check.${handle}.json`) });
log(
  "DONE",
  JSON.stringify({
    calls,
    inTok,
    stats: lifeStats(life),
    mergeQuarantined: strategy.getMergeQuarantineStatus().count,
    compiled: out.messages.length,
    note: out.note,
    usable: out.messages.length > 0 && !out.note,
  }),
);
closeAndExit(0);
