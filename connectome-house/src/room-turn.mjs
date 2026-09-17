// @ts-check
/* connectome-house/src/room-turn.mjs — the room worker's own being's-turn
 * loop (docs/harness-port/03-house-design.md §2.1's "room worker" cut,
 * §2.4 stage P2): renders a `turn.begin`'s context by REUSING
 * life-entries.mjs's `buildFullMessages` (the one place this port already
 * walks a room's frames into a per-being conversation — own turns under
 * the being's own handle, everyone else's under theirs; never a second
 * frame->conversation renderer), tracks the one in-flight turn a room's
 * singular attached seat can hold, and folds a being's streamed
 * `turn.event`/`tool.exec`/`turn.done`/`turn.error` back into the record
 * as `speech`/`reach`/`reach.result`/`aborted` frames — the house is the
 * only writer (house-design.md §1).
 *
 * One seat per room record in this port (open-rooms.mjs's `OpenRoomRec.
 * seat` is singular): a room with several beings present seats only the
 * one currently attached; that is an accepted, documented limitation of
 * this round, not silently papered over (see connectome-house/README.md's
 * seat-loop section).
 *
 * A `tool.exec` routes to `executeHouseTool`: a platform tool would go
 * through the room's own MCPL seat where one is registered
 * (`registerPlatformExecutor`) — no round in this port yet wires a real
 * one to a being's-turn room, so every call refuses with the same "not
 * offered" wording platform-tools.mjs already uses for the being-container
 * side of the exact same refusal.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCls } from "./room-policy.mjs";
import { beingsOf } from "./beings.mjs";
import { covenantFor } from "./resident-covenant.mjs";
import { lifePathFor } from "./serve-room-open.mjs";
import { buildFullMessages, readFramesJsonl } from "./life-entries.mjs";
import { lastFrameInfo } from "./frames-io.mjs";

const framesPath = (rec) => join(rec.runDir, "frames.jsonl");

/** a turn's own live, strictly-increasing INTEGER seq counter — distinct
 * from frames-io.mjs's `appendHouseFrame`/`houseFrameSeq`, which are built
 * for a single isolated insertion into a NON-live run (its own doc
 * comment: floor(last)+0.5, "never a bare +1... nor a bare +0.5" because a
 * SECOND fractional append would collide on the very next integer — which
 * is exactly what a turn's own several speech/reach frames would do if
 * they used it). A room actively streaming a turn IS live for the
 * duration of that turn, so this mirrors trace.mjs's own `frame()`
 * counter instead: resync from the record's current tail once, at
 * `beginTurn`, then increment purely in memory for the rest of the turn —
 * always landing on the next free integer, never colliding with the
 * message frame `roomInput` just wrote (which may itself sit at a
 * `houseFrameSeq` half-integer). */
function resyncTurnSeq(rec) {
  rec._turnSeq = Math.floor(lastFrameInfo(framesPath(rec)).seq) + 1;
}
function appendTurnFrame(rec, fields) {
  if (rec._turnSeq == null) resyncTurnSeq(rec);
  const frame = { seq: rec._turnSeq++, t: new Date().toISOString(), ...fields };
  appendFileSync(framesPath(rec), `${JSON.stringify(frame)}\n`);
  return frame;
}

/** how many of a compiled life's own tail messages ride along as the
 * "life excerpt" a turn.begin carries — an excerpt, not the whole life
 * (which is already sized to its own covenant budget, resident-covenant.
 * mjs's `life_budget_tokens`); this is a further, deliberately small
 * window on top of that. */
const LIFE_EXCERPT_MESSAGES = 20;

/** room -> platform tool executor, `{name, execute(tool, input) ->
 * Promise<{ok, content}>}` — registered by whichever MCPL wiring a later
 * round adds (03-house-design.md §1's "MCPL seats" own registry); nothing
 * in this port registers one yet, so `executeHouseTool` always falls to
 * its honest refusal below. Exported so a later round's MCPL adapter can
 * register without this module needing to know about it in advance. */
const platformExecutors = new Map(); // roomId -> {execute}
export function registerPlatformExecutor(roomId, executor) {
  platformExecutors.set(roomId, executor);
}
export function unregisterPlatformExecutor(roomId) {
  platformExecutors.delete(roomId);
}

/** the room record's recent slice, rendered as `handle` sees it — own
 * turns under its own handle, every other being present under theirs
 * (life-entries.mjs's own attribution rule), house/tool lines as
 * `participant: "house"`/`"user"`. Strips `buildFullMessages`'s
 * `metadata.period` bookkeeping (a LIFE-compile concern, not a turn's
 * own context) down to `{participant, content}`.
 * @param {{id: string, runDir: string, cls: any}} rec @param {string} handle */
export function renderConversation(rec, handle) {
  const cls = rec.cls ?? readCls(rec.runDir);
  const roster = beingsOf(cls);
  const peers = new Set(roster.filter((h) => h !== handle));
  const frames = readFramesJsonl(rec.runDir);
  const periodBase = {
    run: rec.id,
    kind: "room",
    class: cls.class ?? null,
    room: cls.room?.platform ?? "synthetic",
    people: roster,
    visibility: cls.visibility ?? "public",
    session: 0,
  };
  const built = buildFullMessages({
    frames,
    handle,
    peers,
    runDir: rec.runDir,
    runId: rec.id,
    periodBase,
    closingFrame: null,
    restReason: null,
  });
  return built.map(({ participant, content }) => ({ participant, content }));
}

/** `handle`'s own compiled life (serve-room-open.mjs's `compileRoomLives`,
 * run at open/reopen), tailed to `LIFE_EXCERPT_MESSAGES` — an honest
 * `null` when nothing was ever compiled for this handle in this room,
 * never a fabricated empty life.
 * @param {{runDir: string, cls: any}} rec @param {string} handle */
export function renderLifeExcerpt(rec, handle) {
  const cls = rec.cls ?? readCls(rec.runDir);
  const roster = beingsOf(cls);
  const primary = typeof cls.being === "string" && cls.being ? cls.being : (roster[0] ?? null);
  const path = lifePathFor(rec.runDir, handle, primary);
  if (!existsSync(path)) return null;
  try {
    const life = JSON.parse(readFileSync(path, "utf8"));
    return {
      handle: life.handle ?? handle,
      note: life.note ?? null,
      through_seq: life.through_seq ?? null,
      messages: Array.isArray(life.messages) ? life.messages.slice(-LIFE_EXCERPT_MESSAGES) : [],
    };
  } catch {
    return null; // an unreadable/partial life.json is honest absence, never a throw
  }
}

/** the being's covenant excerpt a `turn.begin` carries — capabilities
 * only (house-design.md §6: "states capabilities only... never a secrets
 * file"): model, posture, and the tool names this room currently offers
 * (empty until a platform executor is registered for it, `tools offered`
 * is always the true, current list, never a static declaration).
 * @param {string} roomId @param {string} handle */
export function covenantExcerpt(roomId, handle) {
  const cov = covenantFor(handle);
  const executor = platformExecutors.get(roomId);
  return {
    model: typeof cov?.speaks_for === "string" ? cov.speaks_for : "mock",
    tools: executor?.toolNames ? [...executor.toolNames] : [],
    posture: cov?.posture ?? "resident",
  };
}

/** begin one turn for `handle`, who must already hold this room's one
 * attached seat (open-rooms.mjs's singular `rec.seat`). Sends `turn.begin`
 * over the wire and returns a promise that resolves once the turn closes
 * (`turn.done`, `turn.error`, or a dropped seat) — never rejects; the
 * outcome is carried in the resolved value's `kind`.
 * @param {{id: string, runDir: string, cls: any, seat?: any, turn?: any}} rec
 * @param {string} handle
 * @returns {Promise<{kind: "done"|"error"|"aborted", message?: string}>} */
export function beginTurn(rec, handle) {
  if (!rec.seat || rec.seat.being !== handle) {
    throw new Error(`beginTurn: @${handle} has no seat attached to room ${rec.id}`);
  }
  if (rec.turn) {
    throw new Error(`beginTurn: room ${rec.id} already has a turn in flight (${rec.turn.turnId})`);
  }
  const turnId = randomUUID();
  const context = { conversation: renderConversation(rec, handle), life: renderLifeExcerpt(rec, handle) };
  const covenant = covenantExcerpt(rec.id, handle);
  /** @type {any} */
  const turn = { turnId, handle };
  const donePromise = new Promise((resolve) => {
    turn.resolve = resolve;
  });
  rec.turn = turn;
  resyncTurnSeq(rec); // fresh baseline for this turn's own frames (see the counter's own header note)
  rec.seat.send({ type: "turn.begin", turnId, context, covenant });
  return donePromise;
}

/** one `turn.event` folded into the record — `tokens` (an interim chunk)
 * and `final` (a segment's closing speech, may recur across a
 * multi-tool-round turn) both become `speech` frames; `reach` becomes a
 * `reach` frame reported for the record only (the being already resolved
 * it itself — distinct from `tool.exec`, below, which the house executes). */
function foldTurnEvent(rec, turn, event) {
  if (event?.kind === "tokens") {
    appendTurnFrame(rec, { type: "speech", by: turn.handle, interim: true, inline: String(event.text ?? "") });
  } else if (event?.kind === "final") {
    appendTurnFrame(rec, { type: "speech", by: turn.handle, inline: String(event.text ?? "") });
  } else if (event?.kind === "reach") {
    appendTurnFrame(rec, {
      type: "reach",
      tool: event.name,
      input: event.input ?? {},
      ...(typeof event.id === "string" ? { callId: event.id } : {}),
    });
  }
}

/** a live `tool.exec`: recorded as a reach/reach.result pair (matching
 * trace.mjs's `traceReach` shape, minus the blob-threshold escalation —
 * every payload this round produces is small enough to inline), then
 * answered with `tool.result`. Platform tools route through this room's
 * registered executor where one exists; everything else is an honest
 * refusal, worded like platform-tools.mjs's own "not offered" case. */
async function handleToolExec(rec, turn, msg) {
  const { callId, tool, input } = msg;
  appendTurnFrame(rec, { type: "reach", tool, input: input ?? {}, callId });
  const executor = platformExecutors.get(rec.id);
  let result;
  try {
    result = executor ? await executor.execute(tool, input ?? {}) : { ok: false, content: `${tool} is not offered here` };
  } catch (e) {
    result = { ok: false, content: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
  appendTurnFrame(rec, {
    type: "reach.result",
    callId,
    ok: !!result.ok,
    inline: typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? null),
  });
  if (rec.seat) rec.seat.send({ type: "tool.result", callId, ok: !!result.ok, content: result.content });
}

/** close the room's in-flight turn (idempotent: a turn already closed by
 * another path is a no-op) — `error`/a dropped seat append an `aborted`
 * frame; `done` writes nothing further (the speech/reach frames already
 * carry the whole turn). The room itself is never touched here: it stays
 * open either way (house-design.md's mission: "the room stays open"). */
function closeTurn(rec, turn, kind, message) {
  if (rec.turn !== turn) return;
  rec.turn = null;
  if (kind !== "done") {
    appendTurnFrame(rec, { type: "aborted", reason: message || `turn.${kind}` });
  }
  turn.resolve({ kind, ...(message ? { message } : {}) });
}

/** the room worker's own dispatcher for every being->house message that
 * arrives while a turn is in flight — wire this to the seat's own event
 * stream (socket-seat.mjs's `onEvent`, or a future stdio-turn transport's
 * equivalent). A message naming a turnId that isn't the current one is a
 * stray from an already-closed turn — ignored, never a throw.
 * @param {{id: string, runDir: string, seat?: any, turn?: any}} rec
 * @param {Record<string, unknown>} msg */
export function handleSeatMessage(rec, msg) {
  const turn = rec.turn;
  if (!turn || msg.turnId !== turn.turnId) return;
  switch (msg.type) {
    case "turn.event":
      return foldTurnEvent(rec, turn, /** @type {any} */ (msg.event));
    case "tool.exec":
      return void handleToolExec(rec, turn, /** @type {any} */ (msg));
    case "turn.done":
      return closeTurn(rec, turn, "done");
    case "turn.error":
      return closeTurn(rec, turn, "error", /** @type {any} */ (msg.message));
    default:
      return; // an unrecognized message mid-turn is ignored, not fatal
  }
}

/** the seat's own transport dropped (socket close, child exit) — a turn
 * still in flight ends `aborted`; the room's seat slot is freed either way
 * so a new being can seat (seat-abort.test.mjs's own acceptance).
 * @param {{seat?: any, turn?: any}} rec */
export function handleSeatExit(rec) {
  if (rec.turn) closeTurn(rec, rec.turn, "aborted", "seat disconnected");
  rec.seat = null;
}
