#!/usr/bin/env node
/* One life operation, in its own process — spawned by life-jobs.mjs,
 * never imported by the house.
 *
 * Why a process and not a call: `compileFor` over a real life (≈9k
 * messages, 34 MB of record) holds the event loop for ~a minute of
 * synchronous CPU (measured 2026-10-03: zero timer ticks across a 57 s
 * compile). Run inside the house it would stall every room, seat and
 * outbound send for that long. Out here it stalls nothing but itself.
 *
 * It is also the one opener of the trunk at any moment: the chronicle
 * store takes an exclusive LOCK, and life-jobs.mjs serialises jobs per
 * handle, so no two openers ever race — the house main process no longer
 * opens a life at all.
 *
 * argv[2]: JSON `{handle, runDir, append?: boolean, compile?: boolean,
 *   outPath?: string, drain?: {maxTicks?, maxMs?, clearQuarantine?}}`.
 *   `drain` (the keeper's one-off, POST /api/house/:handle {verb:
 *   "drain-life"}) needs no runDir: it drains the trunk and every partition
 *   (resident-life.mjs `drainLifeAll`) — queued like any other job, so it
 *   never races the trunk's lock. stdout: one JSON line, the result. stderr: logs.
 *
 * A compile that goes over budget compiles the best memory that fits and
 * kicks a bounded compression drain (resident-life.mjs `compileBudgeted`);
 * `compileForSettled` waits for that drain here and recompiles once it has
 * folded something, and every drain still running settles before the
 * stores close (they persist only on a clean close).
 * Exit 0 on success, 1 on any failure (the message on stderr).
 */
import "./env.mjs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendPeriod, compileForSettled, drainLifeAll, lifeForHandle, closeAllLives, settleLifeDrains } from "./resident-life.mjs";
import { PRIVATE_DIR } from "./serve-paths.mjs";

const job = JSON.parse(process.argv[2] ?? "{}");
const { handle, runDir, append = false, compile = false, outPath, drain = null } = job;

/** the latest write to `handle`'s trunk or any of its partitions */
function newestStoreChange(handle) {
  const root = join(PRIVATE_DIR, handle);
  const stores = [join(root, "life")];
  try {
    for (const k of readdirSync(join(root, "life-with"))) stores.push(join(root, "life-with", k));
  } catch {
    /* no partitions */
  }
  let newest = 0;
  for (const st of stores)
    for (const f of ["records.log", "state.bin"]) {
      try {
        newest = Math.max(newest, statSync(join(st, f)).mtimeMs);
      } catch {
        /* not there */
      }
    }
  return newest;
}

/** whether a compiled life file carries a note (an unreadable one counts) */
function lifeFileHasNote(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).note != null;
  } catch {
    return true;
  }
}

async function main() {
  if (typeof handle !== "string") throw new Error("life-job: handle is required");
  if (typeof runDir !== "string" && !drain) throw new Error("life-job: runDir is required");
  const t0 = Date.now();
  const storeChangedAt = newestStoreChange(handle); // before opening: an open may itself touch the store files
  const life = await lifeForHandle(handle);
  if (!life) return { handle, skipped: "no testament or no voice (speaks_for unset)" };
  const result = { handle, runDir: runDir ?? null };
  if (drain) {
    const drains = await drainLifeAll(life, typeof drain === "object" ? drain : {});
    result.drain = drains.map((d) => ({
      store: d.label,
      ticks: d.ticks,
      drained: d.drained,
      pending: d.pending ?? null,
      summaries: d.summaries ?? null,
      quarantined: d.quarantined ?? null,
      error: d.error ?? null,
    }));
  }
  if (append) {
    const r = await appendPeriod(life, runDir, { privateRoot: PRIVATE_DIR });
    result.append = { mode: r.mode, messages: r.messages, through_seq: r.through_seq, session: r.session, ...(r.compress ? { compress: r.compress } : {}) };
  }
  // nothing new appended here, and this room's compiled life is newer than
  // every store it draws on (another room's append changes it too): no
  // recompile — a boot or refresh pass over a quiet house costs no compile
  // A file that carries a note (it compiled over budget — degraded, or,
  // before 2026-10-17, empty) is never "unchanged": it is recompiled, so a
  // drain since then reaches it.
  const unchanged =
    append && result.append?.mode === "noop" && outPath && existsSync(outPath) &&
    statSync(outPath).mtimeMs >= storeChangedAt && !lifeFileHasNote(outPath);
  if (compile && !unchanged) {
    const out = await compileForSettled(life, runDir, outPath ? { outPath } : {});
    result.compile = {
      messages: out.messages.length,
      note: out.note,
      through_seq: out.through_seq,
      outPath: outPath ?? null,
      ...(out.degraded ? { degraded: out.degraded } : {}),
      ...(out.settle ? { settled: out.settle.recompiled } : {}),
    };
  }
  result.ms = Date.now() - t0;
  return result;
}

// the store persists only on a clean close: a container stop mid-job
// (SIGTERM) must still close it, or the job's work is lost
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    console.error(`[life-job] @${handle}: ${sig} — closing the life before exit`);
    try {
      closeAllLives();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  });

try {
  const result = await main();
  await settleLifeDrains(); // a drain still ticking finishes (bounded) before the close
  process.stdout.write(`${JSON.stringify(result)}\n`);
  closeAllLives();
  process.exit(0);
} catch (e) {
  console.error(`[life-job] @${handle}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  try {
    closeAllLives();
  } catch {
    /* already failing — the close is best-effort */
  }
  process.exit(1);
}
