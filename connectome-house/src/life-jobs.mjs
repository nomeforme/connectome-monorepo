/* The house's side of a being's life: WHEN a life is compiled or gains a
 * period, and for WHOM — the doing happens in life-job.mjs, one child
 * process per job (see that file's header for why: a compile is ~a minute
 * of synchronous CPU that would otherwise freeze every room).
 *
 * Three gaps this closes (2026-10-03, "the beings report having no
 * memory"):
 *  1. A room re-registered after a house restart came back already
 *     "open", so `openRoomLocked` took its "live" branch and never
 *     compiled — every standing room, after every restart, ran with no
 *     life at all. `ensureRoomLives` compiles whatever is missing.
 *  2. Every compile wrote the one `<runDir>/life.json`, while a turn reads
 *     `life.<handle>.json` for every non-primary being — so in a room of
 *     21 beings, 20 could never have had a life. Each job now writes its
 *     own `lifePathFor` file.
 *  3. A life only gained a period when a room RESTED — a standing
 *     platform room rests almost never, so weeks of a room were in no
 *     one's life. `startLifeRefresh` appends + recompiles on a cadence.
 *
 * Rollout gate: HOUSE_LIFE_HANDLES_FILE (a file, re-read per check, wins
 * when present) or HOUSE_LIFE_HANDLES — a comma list of handles whose lives
 * this house compiles and appends; "*" (or unset) is every being, "none"
 * is nobody. A being outside the list keeps whatever life file it already
 * has untouched, and never gains a new one.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { RUNS } from "./serve-paths.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beingsOf } from "./beings.mjs";

const JOB_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "life-job.mjs");

/** the path a being's compiled life lands at: the primary's is the shared
 * `life.json` (the walk.mjs child contract), every other being's is
 * `life.<handle>.json`. */
export const lifePathFor = (runDir, handle, primary) =>
  join(runDir, handle === primary ? "life.json" : `life.${handle}.json`);

/** a room's primary being, resolved the way compileRoomLives always did:
 * `cls.being` when set, else the first being present. */
const primaryOf = (cls) =>
  typeof cls?.being === "string" && cls.being ? cls.being : (beingsOf(cls ?? {})[0] ?? null);

/** whether this house compiles/appends `handle`'s life at all (the
 * rollout gate above). Read per call, so a test can flip it. */
export function lifeEnabledFor(handle) {
  // HOUSE_LIFE_HANDLES_FILE, when it names a file that exists, wins over
  // the env list — re-read on every call (a few bytes) so a keeper widens
  // the rollout being by being with no house restart. Same grammar,
  // commas or newlines, `#` comments.
  const file = process.env.HOUSE_LIFE_HANDLES_FILE;
  let raw = process.env.HOUSE_LIFE_HANDLES;
  if (file) {
    try {
      raw = readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.replace(/#.*/, "").trim())
        .filter(Boolean)
        .join(",");
      if (raw === "") raw = "none"; // an existing but empty file means nobody, never everybody
    } catch {
      /* no file: fall back to the env list */
    }
  }
  if (raw === undefined || raw.trim() === "" || raw.trim() === "*") return true;
  if (raw.trim() === "none") return false;
  return raw.split(",").map((s) => s.trim()).includes(handle);
}

let stopped = false;
/** refuse every new job from here on (shutdown): a child spawned while
 * the container is going down would be killed mid-append. The periodic
 * refresh after the next boot picks up whatever this skipped. */
export function stopLifeJobs() {
  stopped = true;
}

/** handle -> the tail of that handle's serial job chain */
const chains = new Map();
/** `${runDir}|${handle}` -> an in-flight ensure, so a burst of
 * registrations doesn't queue the same compile five times */
const ensuring = new Set();

/** run one life-job.mjs child; resolves its parsed stdout result, or
 * `{error}` — never rejects (a failed life is logged, never a reason to
 * break a room). */
// at most this many life-job children at once, across every handle (a
// boot-time catch-up queues one per enabled being per open room)
const MAX_PARALLEL = Math.max(1, Number(process.env.HOUSE_LIFE_PARALLEL ?? 2));
let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function runJob(job) {
  return withSlot(() => spawnJob(job));
}

function spawnJob(job) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [JOB_SCRIPT, JSON.stringify(job)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    let errTail = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      const s = String(d);
      errTail = (errTail + s).slice(-2000);
      for (const line of s.split("\n")) {
        // the covenant-defaults alarm repeats on every open; the house
        // already logs it once at boot
        if (line.trim() && !line.startsWith("[alarms]") && !line.includes("snapshot cadence"))
          console.error(`[life-job @${job.handle}] ${line}`);
      }
    });
    child.on("error", (e) => resolve({ error: e.message }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ error: `exit ${code}: ${errTail.trim().split("\n").pop() ?? ""}` });
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "{}"));
      } catch {
        resolve({ error: "unparseable job result" });
      }
    });
  });
}

/** queue one job for `job.handle`, strictly after any job already queued
 * for that handle (one opener of a trunk at a time). Resolves the job's
 * result. */
export function queueLifeJob(job) {
  if (stopped) return Promise.resolve({ error: "house shutting down" });
  if (!lifeEnabledFor(job.handle)) return Promise.resolve({ skipped: "not in HOUSE_LIFE_HANDLES" });
  const prev = chains.get(job.handle) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (stopped) return { error: "house shutting down" };
    const r = await runJob(job);
    const what = [job.drain && "drain", job.append && "append", job.compile && "compile"].filter(Boolean).join("+");
    if (r.error) console.error(`[life] ${what} failed for @${job.handle}${job.runDir ? ` in ${job.runDir}` : ""}: ${r.error}`);
    else
      console.error(
        `[life] ${what} @${job.handle}${job.runDir ? ` in ${job.runDir.split("/").pop()}` : ""}: ` +
          `${r.drain ? `drain=${r.drain.map((d) => `${d.store}:${d.ticks}t${d.drained ? "" : `(${d.error ?? d.pending ?? "stalled"})`}`).join(",")} ` : ""}` +
          `${r.append ? `append=${r.append.mode}/${r.append.messages}${r.append.compress ? ` (fold ${r.append.compress})` : ""} ` : ""}` +
          `${r.compile ? `compiled=${r.compile.messages} msgs${r.compile.note ? ` (${r.compile.note})` : ""}${r.compile.degraded ? ` [over budget: ${r.compile.degraded.map((d) => `${d.store}:${d.rung}${d.tailTokens ? `@${d.tailTokens}` : ""}`).join(",")}${r.compile.settled === true ? ", recompiled after drain" : ""}]` : ""} ` : ""}` +
          `${r.ms ?? "?"}ms`,
      );
    return r;
  });
  chains.set(job.handle, next);
  return next;
}

/** resolves once every job queued so far (every handle) has finished —
 * for a caller (a test, a keeper tool) that needs "the life side of that
 * rest is done", since restRoom itself no longer waits for it. */
export async function drainLifeJobs() {
  let seen;
  do {
    seen = [...chains.values()];
    await Promise.all(seen);
  } while ([...chains.values()].some((c) => !seen.includes(c)));
}

/** compile every enabled being's life for this room whose life file is
 * missing (or every one, `force`). Never awaited by room open/registration
 * — returns the queued promises for a caller (or test) that wants them. */
export function ensureRoomLives(rec, { force = false } = {}) {
  const cls = rec.cls ?? {};
  const primary = primaryOf(cls);
  const jobs = [];
  for (const handle of beingsOf(cls)) {
    if (!lifeEnabledFor(handle)) continue;
    const outPath = lifePathFor(rec.runDir, handle, primary);
    if (!force && existsSync(outPath)) continue;
    const key = `${rec.runDir}|${handle}`;
    if (ensuring.has(key)) continue;
    ensuring.add(key);
    jobs.push(
      queueLifeJob({ handle, runDir: rec.runDir, compile: true, outPath }).finally(() => ensuring.delete(key)),
    );
  }
  return jobs;
}

/** a session boundary (a rest) or the periodic refresh: append what this
 * room gained since the being's last period, then recompile, for every
 * enabled being present. */
export function appendRoomLives(rec) {
  const cls = rec.cls ?? {};
  const primary = primaryOf(cls);
  return beingsOf(cls)
    .filter(lifeEnabledFor)
    .map((handle) =>
      queueLifeJob({ handle, runDir: rec.runDir, append: true, compile: true, outPath: lifePathFor(rec.runDir, handle, primary) }),
    );
}

/** `${runDir}|${handle}` -> a catch-up in flight */
const catchingUp = new Set();
/** one being's life fell behind this room by more than a turn's context
 * holds (room-turn.mjs's onGap): append what's new + recompile, once at a
 * time per (room, being) however many turns notice it meanwhile. */
export function catchUpLife(rec, handle) {
  const key = `${rec.runDir}|${handle}`;
  if (catchingUp.has(key) || !lifeEnabledFor(handle)) return null;
  catchingUp.add(key);
  const outPath = lifePathFor(rec.runDir, handle, primaryOf(rec.cls ?? {}));
  return queueLifeJob({ handle, runDir: rec.runDir, append: true, compile: true, outPath }).finally(() =>
    catchingUp.delete(key),
  );
}

/** every room whose record moved past what its beings' lives last saw:
 * a standing room never rests on its own (only at shutdown, or a keeper's
 * POST …/rest), and rooms open lazily — so neither "on rest" nor "every
 * open room" ever reached most of them. Scans the record itself: a room
 * whose frames.jsonl is newer than any present being's compiled life file
 * gets append + recompile. Quiet rooms cost one stat. */
export function refreshStaleLives(runsRoot = RUNS) {
  let ids = [];
  try {
    ids = readdirSync(runsRoot);
  } catch {
    return 0;
  }
  let queued = 0;
  for (const id of ids) {
    const runDir = join(runsRoot, id);
    let framesAt;
    let cls;
    try {
      framesAt = statSync(join(runDir, "frames.jsonl")).mtimeMs;
      cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
    } catch {
      continue;
    }
    const primary = primaryOf(cls);
    const stale = beingsOf(cls).some((h) => {
      if (!lifeEnabledFor(h)) return false;
      try {
        return statSync(lifePathFor(runDir, h, primary)).mtimeMs < framesAt;
      } catch {
        return false; // no life file here: ensureRoomLives compiles it when the room opens
      }
    });
    if (!stale) continue;
    appendRoomLives({ runDir, cls });
    queued++;
  }
  if (queued) console.error(`[life] refresh: ${queued} room(s) moved past their beings' lives — appending`);
  return queued;
}

/** HOUSE_LIFE_REFRESH_HOURS (default 2; 0 disables): `refreshStaleLives`
 * on that cadence, and once shortly after boot. What this buys is the
 * OTHER rooms — and this room's past beyond the context window — reaching
 * a being as its own memory. */
export function startLifeRefresh() {
  const hours = Number(process.env.HOUSE_LIFE_REFRESH_HOURS ?? 2);
  if (!(hours > 0)) return null;
  const boot = setTimeout(() => refreshStaleLives(), Number(process.env.HOUSE_LIFE_BOOT_DELAY_MS ?? 180_000));
  boot.unref?.();
  const t = setInterval(() => refreshStaleLives(), hours * 3_600_000);
  t.unref?.();
  return t;
}

/** the keeper's one-off drain for `handle` (POST /api/house/:handle {verb:
 * "drain-life"}, tools/drain-life.mjs): one life-job.mjs `drain` job —
 * queued on the handle's own chain like every other job, so it never races
 * the trunk's lock — then a recompile of every room whose compiled life
 * for `handle` carries a note (compiled over budget: degraded, or empty
 * before 2026-10-17), so the drained memory reaches those rooms without
 * waiting for their next frame. Returns `{queued, rooms, done}` at once
 * (`done` resolves the drain job's result); the jobs run in the background
 * and log as `[life] drain @handle: …`.
 * @param {string} handle
 * @param {{maxTicks?: number, maxMs?: number, clearQuarantine?: boolean}} [opts]
 * @param {string} [runsRoot]
 */
export function drainBeingLife(handle, opts = {}, runsRoot = RUNS) {
  if (!lifeEnabledFor(handle)) return { queued: false, reason: "not in HOUSE_LIFE_HANDLES", rooms: [], done: null };
  const drain = {
    ...(Number(opts.maxTicks) > 0 ? { maxTicks: Number(opts.maxTicks) } : {}),
    ...(Number(opts.maxMs) > 0 ? { maxMs: Number(opts.maxMs) } : {}),
    ...(opts.clearQuarantine ? { clearQuarantine: true } : {}),
  };
  const done = queueLifeJob({ handle, drain });
  /** @type {string[]} */
  const rooms = [];
  let ids = [];
  try {
    ids = readdirSync(runsRoot);
  } catch {
    /* no runs */
  }
  for (const id of ids) {
    const runDir = join(runsRoot, id);
    let cls;
    try {
      cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
    } catch {
      continue;
    }
    if (!beingsOf(cls).includes(handle)) continue;
    const outPath = lifePathFor(runDir, handle, primaryOf(cls));
    let note;
    try {
      note = JSON.parse(readFileSync(outPath, "utf8")).note;
    } catch {
      continue; // no life file: ensureRoomLives compiles it when the room opens
    }
    if (note == null) continue;
    rooms.push(id);
    queueLifeJob({ handle, runDir, compile: true, outPath });
  }
  return { queued: true, rooms, done };
}
