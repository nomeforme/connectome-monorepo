// @ts-check
/* connectome-house/src/serve-walks.mjs — the process table of being
 * processes, ONE PER BEING: spawning a walker, tracking it, restarting it
 * after an unplanned exit, and stopping it gracefully at shutdown. Ported
 * (with heavy adaptation, not a line-for-line copy) from a private
 * deployment's serve-walks.mjs — that source spawned a corpus-composing
 * CLI (`walk.mjs`) with mirror/archive/multiagent argv assembly
 * (docs/harness-port/03-house-design.md's "what the entrypoint leaves
 * out"); none of that applies here. What's kept is the SHAPE: a table of
 * {child, seat} the house itself launched, spawned detached with piped
 * stdio, torn down on exit, restarted on an unplanned one, all serialized
 * so two overlapping spawns for the same being can't race (a being-keyed
 * mutex, same pattern as this source's own `lifecycleLock`/
 * `lifecycleUnlock`).
 *
 * harness-port W4-A, 2026-09-19: this table was room-keyed (one walker
 * per (room, being) — the fleet's own problem: "each container had bots
 * that were always listening everywhere they were added"). It is now
 * BEING-keyed: one always-on walker per being, seated to every room the
 * house finds it present in (open-rooms.mjs's `seatsByBeing`/`seatBeing`;
 * that module's own header has the full design). `walkerStatus(being)`
 * reports every room it currently holds; the HTTP surface below is still
 * reached through a room's own door (`/api/rooms/:id/walker...`), because
 * that's the door a room's own participants/keeper may use, but every
 * handler resolves `being` from the room first and then acts per-being.
 *
 * This is ONE of two ways a being's seat (open-rooms.mjs's `seatsByBeing`)
 * gets attached: the other is a being's own container dialling in over
 * the socket transport with no house-side spawn at all (seat/socket-
 * seat.mjs's `createHouseSeatServer`, already wired in serve.mjs whenever
 * `HOUSE_SEAT_ADDR` is set). Both converge on the SAME handshake path — a
 * locally spawned walker is handed that very address on its own command
 * line and dials in exactly like a container would; this module never
 * wraps a seat itself, only launches the process and waits for
 * `open-rooms.mjs`'s `seatBeing` to fire.
 *
 * The walker entry point itself (docs/harness-port/13-walker-port.md's
 * `node src/walker.mjs --being <handle> --seat <addr>`) is W-A's own
 * file, built concurrently in this same package (`src/walker.mjs`) —
 * `walkerCommand()` below resolves it there by convention, or by explicit
 * override (`HOUSE_WALKER_ENTRY`), and refuses honestly (no throw, no
 * guess) if somehow neither is present. This package's own tests still
 * point `HOUSE_WALKER_ENTRY` at `test/lib/stub-walker.mjs` — a
 * deliberately dumb protocol fixture, never a real model call, kept even
 * now that the real entry point exists (this module's own tests have no
 * business depending on a real membrane turn).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_ROOT } from "./serve-paths.mjs";
import { beingsOf } from "./beings.mjs";
import { open, roomsFor, seatsByBeing } from "./open-rooms.mjs";
import { sendClose } from "./seat/protocol.mjs";
import { body, json } from "./serve-http.mjs";
import { mayTouch, scopeOfDir, whoAmI } from "./serve-identity.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** being -> {child, pid, spawnedAt, plannedExit, restarts} — every walker
 * THIS process spawned (never an externally-attached container, which has
 * no entry here even though it shares the same `seatsByBeing` registry).
 * Exported read-only for introspection/tests. */
export const walkers = new Map();

/** a being-keyed mutex: two overlapping spawn calls for the same being
 * must never both launch a child (one always-on seat per being). */
const spawnLocks = new Set();

/** the walker entry point: `HOUSE_WALKER_ENTRY` (an absolute or
 * cwd-relative path — tests point this at a stub) always wins; else this
 * package's OWN `src/walker.mjs` (W-A's entry point, `node src/walker.mjs
 * --being <handle> --seat <addr>`, a sibling file, not a separate
 * package, so no cross-package path guessing is needed once it exists).
 * `HOUSE_WALKER_NODE` overrides the interpreter (default `node`) for a
 * deployment that wants a specific binary (nvm, a pinned version). */
function walkerCommand() {
  const override = process.env.HOUSE_WALKER_ENTRY;
  if (override) return { command: process.env.HOUSE_WALKER_NODE || "node", args: [resolve(override)] };
  const conventional = resolve(PACKAGE_ROOT, "src", "walker.mjs");
  if (existsSync(conventional)) return { command: process.env.HOUSE_WALKER_NODE || "node", args: [conventional] };
  return null;
}

/** poll `seatsByBeing.get(being)` until it's live, or time out — the
 * handshake side of a spawn (or an external attach) is asynchronous and
 * this module never assumes it landed just because the process is alive.
 * @param {string} being @param {number} ms */
async function waitForAttach(being, ms) {
  const t0 = Date.now();
  for (;;) {
    const seat = seatsByBeing.get(being);
    if (seat && (typeof seat.isLive !== "function" || seat.isLive())) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
}

/** does ANY currently open room still name this being in its own roster?
 * — the being-keyed replacement for the old room-keyed "is this room
 * still open" check: a walker with nothing left to seat has nothing to
 * restart into. @param {string} being */
function anyOpenRoomFor(being) {
  for (const rec of open.values()) {
    if (rec.status === "open" && beingsOf(rec.cls).includes(being)) return true;
  }
  return false;
}

/** W-A's own resume/backoff policy hooks in here — replace via
 * `setResumeStrategy` rather than editing the call site below. The
 * default is a bare respawn with no backoff: enough for this round's own
 * tests (a stub walker that never crashes on its own); a real deployment
 * wants real backoff/jitter and a cap tied to the being's own covenant,
 * which is exactly the shape `setResumeStrategy` exists to swap in.
 * @type {(being: string) => Promise<{ok:true,pid:number}|{error:string}>} */
export let resumeWalker = async (being) => spawnWalker(being, {});
/** @param {(being: string) => Promise<any>} fn */
export function setResumeStrategy(fn) {
  resumeWalker = fn;
}
/** test-only: restore the default (bare respawn) strategy. */
export function _resetResumeStrategy() {
  resumeWalker = async (being) => spawnWalker(being, {});
}

const MAX_RESTARTS = 3;

/** the spawned child's own exit: never restarts a PLANNED exit
 * (`stopWalker`/`stopAllWalkers` set `plannedExit` first), never restarts
 * a being with nowhere left to seat (every room naming it has closed —
 * nothing to resume), and gives up past `MAX_RESTARTS` rather than
 * looping forever against a walker that keeps dying immediately. */
function onWalkerExit(being, entry, code, signal) {
  if (walkers.get(being) === entry) walkers.delete(being);
  console.error(`[serve-walks] walker for @${being} exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
  if (entry.plannedExit) return;
  if (!anyOpenRoomFor(being)) return;
  if (entry.restarts >= MAX_RESTARTS) {
    console.error(`[serve-walks] @${being} exceeded ${MAX_RESTARTS} restarts — giving up; its rooms stay open with no seat`);
    return;
  }
  resumeWalker(being)
    .then((r) => {
      if (r?.error) {
        console.error(`[serve-walks] restart refused for @${being}: ${r.error}`);
        return;
      }
      const fresh = walkers.get(being);
      if (fresh) fresh.restarts = entry.restarts + 1;
    })
    .catch((e) => console.error(`[serve-walks] restart threw for @${being}: ${e.message}`));
}

/** spawn a walker for `being`, handing it `--being` and `--seat` (the
 * house's own `HOUSE_SEAT_ADDR`, or `opts.seatAddr` for a caller that
 * knows a different one) — no `--room`: the house's own attach logic
 * (open-rooms.mjs's `seatBeing`) seats it to every open room whose roster
 * already names it, plus any that open later. Resolves once the walker
 * has actually attached its seat somewhere, OR the attach window elapses
 * with the seat still registered but pointed at zero rooms (a being
 * spawned with no open room yet — not an error, just not yet useful; a
 * spawned-but-never-attached process is left running, not killed here; a
 * caller that wants it gone calls `stopWalker`). Refuses (never throws)
 * when: no seat address, this being already has a live seat, no walker
 * entry point configured, or a spawn already in flight for this being.
 * @param {string} being
 * @param {{seatAddr?: string, extraArgs?: string[], attachTimeoutMs?: number}} [opts]
 * @returns {Promise<{ok:true, pid:number, attached:boolean}|{error:string}>} */
export async function spawnWalker(being, opts = {}) {
  const seatAddr = opts.seatAddr || process.env.HOUSE_SEAT_ADDR;
  if (!seatAddr) return { error: "HOUSE_SEAT_ADDR is not set — no seat address to hand the walker" };
  const existingSeat = seatsByBeing.get(being);
  if (existingSeat && (typeof existingSeat.isLive !== "function" || existingSeat.isLive()))
    return { error: "this being already has a seat attached" };
  if (walkers.has(being)) return { error: "a walker is already spawned for this being" };
  if (spawnLocks.has(being)) return { error: "a spawn is already in flight for this being — one moment" };
  const cmd = walkerCommand();
  if (!cmd) return { error: "no walker entry point configured (HOUSE_WALKER_ENTRY, or src/walker.mjs)" };
  spawnLocks.add(being);
  try {
    const args = [...cmd.args, "--being", being, "--seat", seatAddr, ...(opts.extraArgs ?? [])];
    // never let the house's OWN test-runner plumbing ride down into a
    // spawned walker's env — Node's default child_process.spawn inherits
    // the whole parent env, and this house process may itself be a test's
    // own spawned child (test/lib/serve-harness.mjs); a var like
    // NODE_TEST_CONTEXT surviving that hop once caused a real, correctly
    // invoked stub walker to exit immediately (see test/lib/stub-walker.
    // mjs's own header for the full story). Scrubbed here, once, rather
    // than trusting every future walker entry point to defend against it.
    const { NODE_TEST_CONTEXT: _scrubbed, ...childEnv } = process.env;
    const child = spawn(cmd.command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env: childEnv });
    const entry = { child, being, pid: child.pid, spawnedAt: new Date().toISOString(), plannedExit: false, restarts: 0 };
    walkers.set(being, entry);
    child.stdout?.on("data", (b) => console.error(`[walker @${being}] ${b.toString().trimEnd()}`));
    child.stderr?.on("data", (b) => console.error(`[walker @${being}] ${b.toString().trimEnd()}`));
    child.on("exit", (code, signal) => onWalkerExit(being, entry, code, signal));
    // 20s default: generous enough for a node child's own boot + dial-in
    // under a busy shared box (this round's own checkout runs several
    // builders' test suites concurrently) without masking a genuinely
    // stuck walker forever.
    const attached = await waitForAttach(being, opts.attachTimeoutMs ?? 20_000);
    return { ok: true, pid: /** @type {number} */ (child.pid), attached };
  } finally {
    spawnLocks.delete(being);
  }
}

/** the process table's own row for `being`, or null — pid/spawnedAt/
 * restarts, the rooms its seat currently holds, never the raw child (a
 * caller wanting to touch the child directly should be using
 * `stopWalker`, not reaching in here). @param {string} being */
export function walkerStatus(being) {
  const entry = walkers.get(being);
  if (!entry) return null;
  const seat = seatsByBeing.get(being);
  return {
    pid: entry.pid,
    being,
    spawnedAt: entry.spawnedAt,
    restarts: entry.restarts,
    attached: !!(seat && (typeof seat.isLive !== "function" || seat.isLive())),
    rooms: roomsFor(being).map((r) => r.id),
  };
}

/** gracefully stop `being`'s SPAWNED walker (a no-op, `{ok:true,
 * already:true}`, for a being with no house-spawned child — an externally
 * attached container is not this function's to stop; a caller wanting
 * that closes its seat itself, e.g. via `sendClose` per room). Sends the
 * seat's own `close`/"rest" verb first, to EVERY room this being's seat
 * currently holds (the being's own turn loop decides when it's safe to
 * actually exit); SIGTERM after `timeoutMs` with no exit; SIGKILL after a
 * second `timeoutMs` with still no exit. Marks `plannedExit` BEFORE any
 * of that, so `onWalkerExit` never mistakes this for a crash worth
 * restarting. @param {string} being @param {{timeoutMs?: number}} [opts] */
export async function stopWalker(being, opts = {}) {
  const entry = walkers.get(being);
  if (!entry) return { ok: true, already: true };
  const timeoutMs = opts.timeoutMs ?? 5000;
  entry.plannedExit = true;
  for (const rec of roomsFor(being)) {
    try {
      sendClose(rec, "rest");
    } catch (e) {
      console.error(`[serve-walks] sendClose failed for @${being} in ${rec.id}: ${e.message}`);
    }
  }
  const exited = () => entry.child.exitCode != null || entry.child.signalCode != null;
  const untilExited = (ms) =>
    Promise.race([
      new Promise((r) => entry.child.once("exit", () => r(true))),
      sleep(ms).then(() => exited()),
    ]);
  if (!(await untilExited(timeoutMs)) && !exited()) {
    entry.child.kill("SIGTERM");
    if (!(await untilExited(timeoutMs)) && !exited()) entry.child.kill("SIGKILL");
  }
  walkers.delete(being);
  return { ok: true };
}

/** every currently-spawned walker, stopped the same gentle way — the
 * shutdown-time sweep (serve-shutdown.mjs calls this alongside its own
 * room-rest sequence). Never throws; one failed stop is logged, not fatal
 * to the rest. @param {{timeoutMs?: number}} [opts] */
export async function stopAllWalkers(opts = {}) {
  const beings = [...walkers.keys()];
  return Promise.all(
    beings.map((being) =>
      stopWalker(being, opts).catch((e) => {
        console.error(`[serve-walks] stopWalker(@${being}) failed: ${e.message}`);
        return { ok: false, error: e.message };
      }),
    ),
  );
}

/* -------------------------------------------------------------------- *
 * a thin, keeper/participant-gated HTTP surface over the same table —
 * ops visibility for the process table this file owns, not a full
 * walk-lifecycle API (there is no HTTP door onto an EXTERNALLY attached
 * container's own process; only the house's own spawns are listed here).
 * Every handler is still reached through a ROOM's own door (a room's own
 * participants/keeper are who may act on it), resolving to the being
 * that room's own seat (if any) names, then acting per-being.
 * -------------------------------------------------------------------- */

/** GET /api/rooms/:id/walker — `walker`: the room's PRIMARY being's own
 * house-spawned walker row, kept for every pre-W7 caller (never a 404: a
 * room with no house-spawned walker seated to it is an ordinary, honest
 * state, not an error). `walkers` (harness-port W7): every being this room
 * currently seats, its own row — a room may now hold several at once.
 * Readable by anyone who may VIEW the room (matches serve-rooms.mjs's own
 * room-metadata gate — this is metadata too, not a way to touch the
 * room). */
export function handleRoomWalkerGet(req, res, match) {
  const [, id] = match;
  const rec = open.get(id);
  if (!rec) return json(res, 404, { error: "no such open room" });
  if (!mayTouch(whoAmI(req), rec.scope)) return json(res, 403, { error: "this room is private" });
  const being = rec.seat?.being ?? null;
  const walkers = [...(rec.seats?.keys() ?? [])].map((b) => walkerStatus(b)).filter(Boolean);
  return json(res, 200, { walker: being ? walkerStatus(being) : null, walkers });
}

/** POST /api/rooms/:id/walker/spawn {being} — only this room's own
 * people (or the keeper) may ask it to spawn a walker; `being` must be
 * one of the room's own beings (never an arbitrary handle a caller
 * dreams up — that would let anyone put words in an unrelated being's
 * mouth). The spawned walker seats to EVERY open room naming it, not just
 * this one. */
export async function handleRoomWalkerSpawn(req, res, match) {
  const [, id] = match;
  const rec = open.get(id);
  if (!rec) return json(res, 404, { error: "no such open room" });
  const who = whoAmI(req);
  if (!mayTouch(who, rec.scope)) return json(res, 403, { error: "this room is private" });
  const b = await body(req);
  const being = String(b.being ?? "").trim();
  const roster = rec.cls?.beings ?? (rec.cls?.being ? [rec.cls.being] : []);
  if (!being || !roster.includes(being))
    return json(res, 400, { error: "being must name one of this room's own beings" });
  const r = await spawnWalker(being);
  return json(res, r.error ? 409 : 200, r);
}

/** POST /api/rooms/:id/walker/stop — same gate as spawn. Stops the BEING's
 * whole walker (every room its seat holds), not just this one — a single,
 * always-on seat has nowhere else it can go while its being still runs. A
 * no-op (`{ok:true, already:true}`) for a room with nothing spawned. */
export async function handleRoomWalkerStop(req, res, match) {
  const [, id] = match;
  const rec = open.get(id);
  if (!rec) return json(res, 404, { error: "no such open room" });
  if (!mayTouch(whoAmI(req), rec.scope)) return json(res, 403, { error: "this room is private" });
  const being = rec.seat?.being ?? null;
  if (!being) return json(res, 200, { ok: true, already: true });
  return json(res, 200, await stopWalker(being));
}
