#!/usr/bin/env node
/* Give a being a fresh life that begins NOW — the cheap path while its full
 * re-fold (tools/fold-life.mjs + swap-life.sh) waits its turn on the
 * checklist (docs/harness-port/38; the running list lives in tmp/).
 *
 *   docker exec -w /workspace/connectome-house house \
 *     node tools/bootstrap-life.mjs <handle> [<handle> ...] [--recent-days N]
 *
 * Per handle:
 *  1. sets the existing trunk aside (life/ + life-with/ ->
 *     <private>/<handle>.pre-bootstrap-<date>/) — it is the 2026-09-20 mock
 *     restore, kept only as a rollback copy;
 *  2. seeds the being's append marker at every room's CURRENT last frame
 *     (old markers backed up beside the trunk), so its first append offers
 *     only what happens from now on — never a room's whole history, which
 *     is exactly the cost the full fold is scheduled to pay later;
 *  3. opens the fresh trunk (seeded with its address head) and compiles it
 *     for every room active in the last N days (default 14) — no model
 *     call: the life is a verbatim tail until it outgrows ~60k tokens;
 *  4. adds the handle to the live gate file, LAST, so the house never races
 *     this process for the trunk's lock.
 * A turn then tells the being, truthfully, that its life has just begun and
 * holds nothing yet (room-turn.mjs lifeEmptyLine).
 *
 * Refuses a handle already in the gate (it has a life — a bootstrap would
 * throw it away). Swapping a full fold in later (swap-life.sh) replaces the
 * bootstrapped trunk wholesale and loses nothing: the fold's own markers
 * re-cover these weeks.
 */
import "../src/env.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS, PRIVATE_DIR } from "../src/serve-paths.mjs";
import { beingsOf } from "../src/beings.mjs";
import { lifeEnabledFor, lifePathFor } from "../src/life-jobs.mjs";
import { lifeForHandle, compileFor, closeAllLives } from "../src/resident-life.mjs";
import { readFramesJsonl } from "../src/life-entries.mjs";

const args = process.argv.slice(2);
let recentDays = 14;
const handles = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--recent-days") recentDays = Number(args[++i]);
  else handles.push(args[i]);
}
if (!handles.length) {
  console.error("usage: bootstrap-life.mjs <handle> [...] [--recent-days N]");
  process.exit(2);
}
const GATE = process.env.HOUSE_LIFE_HANDLES_FILE || join(PRIVATE_DIR, "life-handles");
const STAMP = new Date().toISOString().slice(0, 10);

const rooms = readdirSync(RUNS)
  .map((id) => ({ id, runDir: join(RUNS, id) }))
  .filter(({ runDir }) => existsSync(join(runDir, "class.json")))
  .map((r) => {
    try {
      return { ...r, cls: JSON.parse(readFileSync(join(r.runDir, "class.json"), "utf8")) };
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const primaryOf = (cls) => (typeof cls?.being === "string" && cls.being ? cls.being : (beingsOf(cls)[0] ?? null));
const lastSeq = (runDir) => {
  let max = -1;
  for (const f of readFramesJsonl(runDir)) if (typeof f.seq === "number" && f.seq > max) max = f.seq;
  return max;
};
const recent = (runDir) => {
  try {
    return Date.now() - statSync(join(runDir, "frames.jsonl")).mtimeMs < recentDays * 86_400_000;
  } catch {
    return false;
  }
};

for (const handle of handles) {
  if (process.env.HOUSE_LIFE_HANDLES_FILE && existsSync(GATE) && lifeEnabledFor(handle)) {
    console.log(`@${handle}: already in the gate — has a life, skipped`);
    continue;
  }
  const backup = join(PRIVATE_DIR, `${handle}.pre-bootstrap-${STAMP}`);
  mkdirSync(join(backup, "markers"), { recursive: true });
  for (const sub of ["life", "life-with"]) {
    const from = join(PRIVATE_DIR, handle, sub);
    if (existsSync(from) && !existsSync(join(backup, sub))) renameSync(from, join(backup, sub));
  }

  const mine = rooms.filter(({ cls }) => beingsOf(cls).includes(handle) || cls.owner === handle);
  for (const { id, runDir } of mine) {
    const marker = join(runDir, `life.appended.${handle}.json`);
    if (existsSync(marker)) copyFileSync(marker, join(backup, "markers", `${id}.json`));
    writeFileSync(marker, JSON.stringify({ through_seq: lastSeq(runDir), sessions: [], bootstrapped: new Date().toISOString() }, null, 2));
  }

  const life = await lifeForHandle(handle);
  if (!life) {
    console.log(`@${handle}: no testament / speaks_for — markers seeded, NOT added to the gate`);
    continue;
  }
  let compiled = 0;
  for (const { runDir, cls } of mine.filter((r) => recent(r.runDir))) {
    await compileFor(life, runDir, { outPath: lifePathFor(runDir, handle, primaryOf(cls)) });
    compiled++;
  }
  appendFileSync(GATE, `${handle}\n`);
  console.log(`@${handle}: fresh life, ${mine.length} room markers at now, compiled ${compiled} recent room(s), gated on (rollback copy ${backup})`);
}
closeAllLives();
