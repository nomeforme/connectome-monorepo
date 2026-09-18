// @ts-check
/* connectome-house/src/serve-walks.mjs — the process table of being
 * processes per room: spawning a walker for an open room, tracking it,
 * restarting it after an unplanned exit, and stopping it gracefully at
 * shutdown. Ported (with heavy adaptation, not a line-for-line copy) from
 * a private deployment's serve-walks.mjs — that source spawned a
 * corpus-composing CLI (`walk.mjs`) with mirror/archive/multiagent argv
 * assembly (docs/harness-port/03-house-design.md's "what the entrypoint
 * leaves out"); none of that applies here. What's kept is the SHAPE: a
 * room-keyed table of {child, seat} the house itself launched, spawned
 * detached with piped stdio, torn down on exit, restarted on an
 * unplanned one, all serialized so two overlapping spawns for the same
 * room can't race (a room-keyed mutex, same pattern as this source's own
 * `lifecycleLock`/`lifecycleUnlock`).
 *
 * This is ONE of two ways a room's one seat (open-rooms.mjs's singular
 * `rec.seat`) gets attached: the other is a being's own container
 * dialling in over the socket transport with no house-side spawn at all
 * (seat/socket-seat.mjs's `createHouseSeatServer`, already wired in
 * serve.mjs whenever `HOUSE_SEAT_ADDR` is set). Both converge on the SAME
 * handshake path — a locally spawned walker is handed that very address
 * on its own command line and dials in exactly like a container would;
 * this module never wraps a seat itself, only launches the process and
 * waits for `open-rooms.mjs`'s `attachSeat` to fire.
 *
 * The walker entry point itself (docs/harness-port/13-walker-port.md's
 * `node src/walker.mjs --being <handle> --seat <addr> --room <id>`) is
 * W-A's own file, built concurrently THIS round in this same package
 * (`src/walker.mjs`, not a separate sibling package as this file first
 * assumed before W-A's own commit landed) — `walkerCommand()` below
 * resolves it there by convention, or by explicit override
 * (`HOUSE_WALKER_ENTRY`), and refuses honestly (no throw, no guess) if
 * somehow neither is present. This package's own tests still point
 * `HOUSE_WALKER_ENTRY` at `test/lib/stub-walker.mjs` — a deliberately
 * dumb protocol fixture, never a real model call, kept even now that the
 * real entry point exists (this module's own tests have no business
 * depending on a real membrane turn).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_ROOT } from "./serve-paths.mjs";
import { open } from "./open-rooms.mjs";
import { sendClose } from "./seat/protocol.mjs";
import { body, json } from "./serve-http.mjs";
import { mayTouch, scopeOfDir, whoAmI } from "./serve-identity.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** roomId -> {child, being, pid, spawnedAt, plannedExit, restarts} — every
 * walker THIS process spawned (never an externally-attached container,
 * which has no entry here even though it shares the same `open` rec's
 * `.seat`). Exported read-only for introspection/tests. */
export const walkers = new Map();

/** a room-keyed mutex: two overlapping spawn calls for the same room must
 * never both launch a child (the room's one seat slot can hold only one). */
const spawnLocks = new Set();

/** the walker entry point: `HOUSE_WALKER_ENTRY` (an absolute or
 * cwd-relative path — tests point this at a stub) always wins; else this
 * package's OWN `src/walker.mjs` (W-A's entry point, `node src/walker.mjs
 * --being <handle> --seat <addr> --room <id>`, landed in this same
 * checkout mid-round — a sibling file, not a separate package, so no
 * cross-package path guessing is needed once it exists). `HOUSE_WALKER_NODE`
 * overrides the interpreter (default `node`) for a deployment that wants
 * a specific binary (nvm, a pinned version). */
function walkerCommand() {
  const override = process.env.HOUSE_WALKER_ENTRY;
  if (override) return { command: process.env.HOUSE_WALKER_NODE || "node", args: [resolve(override)] };
  const conventional = resolve(PACKAGE_ROOT, "src", "walker.mjs");
  if (existsSync(conventional)) return { command: process.env.HOUSE_WALKER_NODE || "node", args: [conventional] };
  return null;
}

/** poll `open.get(roomId)?.seat` until it names `being`, or time out —
 * the handshake side of a spawn (or an external attach) is asynchronous
 * and this module never assumes it landed just because the process is
 * alive. @param {string} roomId @param {string} being @param {number} ms */
async function waitForAttach(roomId, being, ms) {
  const t0 = Date.now();
  for (;;) {
    if (open.get(roomId)?.seat?.being === being) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
}

/** W-A's own resume/backoff policy hooks in here once walker.mjs (and its
 * `walk-resume` module, per this task's brief) exist — replace via
 * `setResumeStrategy` rather than editing the call site below. The
 * default is a bare respawn with no backoff: enough for this round's own
 * tests (a stub walker that never crashes on its own); a real deployment
 * wants real backoff/jitter and a cap tied to the being's own covenant,
 * which is exactly the shape `setResumeStrategy` exists to swap in.
 * @type {(roomId: string, being: string) => Promise<{ok:true,pid:number}|{error:string}>} */
export let resumeWalker = async (roomId, being) => spawnWalker(roomId, being, {});
/** @param {(roomId: string, being: string) => Promise<any>} fn */
export function setResumeStrategy(fn) {
  resumeWalker = fn;
}
/** test-only: restore the default (bare respawn) strategy. */
export function _resetResumeStrategy() {
  resumeWalker = async (roomId, being) => spawnWalker(roomId, being, {});
}

const MAX_RESTARTS = 3;

/** the spawned child's own exit: never restarts a PLANNED exit
 * (`stopWalker`/`stopAllWalkers` set `plannedExit` first), never restarts
 * a room that isn't open anymore (rested/aborted/gone — nothing left to
 * resume), and gives up past `MAX_RESTARTS` rather than looping forever
 * against a walker that keeps dying immediately. */
function onWalkerExit(roomId, entry, code, signal) {
  if (walkers.get(roomId) === entry) walkers.delete(roomId);
  console.error(`[serve-walks] walker for room ${roomId} (@${entry.being}) exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
  if (entry.plannedExit) return;
  const rec = open.get(roomId);
  if (!rec || rec.status !== "open") return;
  if (entry.restarts >= MAX_RESTARTS) {
    console.error(`[serve-walks] room ${roomId} (@${entry.being}) exceeded ${MAX_RESTARTS} restarts — giving up; the room stays open with no seat`);
    return;
  }
  resumeWalker(roomId, entry.being)
    .then((r) => {
      if (r?.error) {
        console.error(`[serve-walks] restart refused for room ${roomId} (@${entry.being}): ${r.error}`);
        return;
      }
      const fresh = walkers.get(roomId);
      if (fresh) fresh.restarts = entry.restarts + 1;
    })
    .catch((e) => console.error(`[serve-walks] restart threw for room ${roomId} (@${entry.being}): ${e.message}`));
}

/** spawn a walker for `roomId`, handing it `--being`, `--seat` (the
 * house's own `HOUSE_SEAT_ADDR`, or `opts.seatAddr` for a caller that
 * knows a different one), and `--room`. Resolves once the walker has
 * actually attached its seat (or the attach window elapses — a spawned-
 * but-never-attached process is left running, not killed here; a caller
 * that wants it gone calls `stopWalker`). Refuses (never throws) when: no
 * room, a room already seated, no walker entry point configured, or a
 * spawn already in flight for this room.
 * @param {string} roomId @param {string} being
 * @param {{seatAddr?: string, extraArgs?: string[], attachTimeoutMs?: number}} [opts]
 * @returns {Promise<{ok:true, pid:number, attached:boolean}|{error:string}>} */
export async function spawnWalker(roomId, being, opts = {}) {
  const seatAddr = opts.seatAddr || process.env.HOUSE_SEAT_ADDR;
  if (!seatAddr) return { error: "HOUSE_SEAT_ADDR is not set — no seat address to hand the walker" };
  const rec = open.get(roomId);
  if (!rec) return { error: "no such open room" };
  if (rec.seat) return { error: "this room already has a seat attached" };
  if (walkers.has(roomId)) return { error: "a walker is already spawned for this room" };
  if (spawnLocks.has(roomId)) return { error: "a spawn is already in flight for this room — one moment" };
  const cmd = walkerCommand();
  if (!cmd) return { error: "no walker entry point configured (HOUSE_WALKER_ENTRY, or ../connectome-walker/src/walker.mjs)" };
  spawnLocks.add(roomId);
  try {
    const args = [...cmd.args, "--being", being, "--seat", seatAddr, "--room", roomId, ...(opts.extraArgs ?? [])];
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
    walkers.set(roomId, entry);
    child.stdout?.on("data", (b) => console.error(`[walker ${roomId}] ${b.toString().trimEnd()}`));
    child.stderr?.on("data", (b) => console.error(`[walker ${roomId}] ${b.toString().trimEnd()}`));
    child.on("exit", (code, signal) => onWalkerExit(roomId, entry, code, signal));
    // 20s default: generous enough for a node child's own boot + dial-in
    // under a busy shared box (this round's own checkout runs several
    // builders' test suites concurrently) without masking a genuinely
    // stuck walker forever.
    const attached = await waitForAttach(roomId, being, opts.attachTimeoutMs ?? 20_000);
    return { ok: true, pid: /** @type {number} */ (child.pid), attached };
  } finally {
    spawnLocks.delete(roomId);
  }
}

/** the process table's own row for `roomId`, or null — pid/being/
 * spawnedAt/restarts, never the raw child (a caller wanting to touch the
 * child directly should be using `stopWalker`, not reaching in here).
 * @param {string} roomId */
export function walkerStatus(roomId) {
  const entry = walkers.get(roomId);
  if (!entry) return null;
  return { pid: entry.pid, being: entry.being, spawnedAt: entry.spawnedAt, restarts: entry.restarts, attached: open.get(roomId)?.seat?.being === entry.being };
}

/** gracefully stop a room's SPAWNED walker (a no-op, `{ok:true,
 * already:true}`, for a room with no house-spawned child — an externally
 * attached container is not this function's to stop; a caller wanting
 * that closes the room's seat itself, e.g. via `sendClose`). Sends the
 * seat's own `close`/"rest" verb first (the being's own turn loop decides
 * when it's safe to actually exit); SIGTERM after `timeoutMs` with no
 * exit; SIGKILL after a second `timeoutMs` with still no exit. Marks
 * `plannedExit` BEFORE any of that, so `onWalkerExit` never mistakes this
 * for a crash worth restarting.
 * @param {string} roomId @param {{timeoutMs?: number}} [opts] */
export async function stopWalker(roomId, opts = {}) {
  const entry = walkers.get(roomId);
  if (!entry) return { ok: true, already: true };
  const timeoutMs = opts.timeoutMs ?? 5000;
  entry.plannedExit = true;
  const rec = open.get(roomId);
  if (rec?.seat) {
    try {
      sendClose(rec, "rest");
    } catch (e) {
      console.error(`[serve-walks] sendClose failed for ${roomId}: ${e.message}`);
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
  walkers.delete(roomId);
  return { ok: true };
}

/** every currently-spawned walker, stopped the same gentle way — the
 * shutdown-time sweep (serve-shutdown.mjs calls this alongside its own
 * room-rest sequence). Never throws; one failed stop is logged, not fatal
 * to the rest. @param {{timeoutMs?: number}} [opts] */
export async function stopAllWalkers(opts = {}) {
  const ids = [...walkers.keys()];
  return Promise.all(
    ids.map((id) =>
      stopWalker(id, opts).catch((e) => {
        console.error(`[serve-walks] stopWalker(${id}) failed: ${e.message}`);
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
 * -------------------------------------------------------------------- */

/** GET /api/rooms/:id/walker — this room's spawned-walker row, or `null`
 * (never a 404: a room with no house-spawned walker, whether because
 * none was ever asked for or because one attached externally instead, is
 * an ordinary, honest state, not an error). Readable by anyone who may
 * VIEW the room (matches serve-rooms.mjs's own room-metadata gate — this
 * is metadata too, not a way to touch the room). */
export function handleRoomWalkerGet(req, res, match) {
  const [, id] = match;
  const rec = open.get(id);
  if (!rec) return json(res, 404, { error: "no such open room" });
  if (!mayTouch(whoAmI(req), rec.scope)) return json(res, 403, { error: "this room is private" });
  return json(res, 200, { walker: walkerStatus(id) });
}

/** POST /api/rooms/:id/walker/spawn {being} — only this room's own
 * people (or the keeper) may ask it to spawn a walker; `being` must be
 * one of the room's own beings (never an arbitrary handle a caller
 * dreams up — that would let anyone put words in an unrelated being's
 * mouth). */
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
  const r = await spawnWalker(id, being);
  return json(res, r.error ? 409 : 200, r);
}

/** POST /api/rooms/:id/walker/stop — same gate as spawn. A no-op
 * (`{ok:true, already:true}`) for a room with nothing spawned. */
export async function handleRoomWalkerStop(req, res, match) {
  const [, id] = match;
  const rec = open.get(id);
  if (!rec) return json(res, 404, { error: "no such open room" });
  if (!mayTouch(whoAmI(req), rec.scope)) return json(res, 403, { error: "this room is private" });
  return json(res, 200, await stopWalker(id));
}
