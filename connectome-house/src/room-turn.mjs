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
 * harness-port W7, 2026-09-19: every being present now holds its OWN seat
 * and runs its OWN turn (`rec.seats`/`rec.turns`, Map<being, ...> —
 * open-rooms.mjs/room-seats.mjs's own headers have the full design; this
 * file's functions below are all per-being now, `handle` naming which).
 * W4-A: a being's one seat may be shared across many rooms at once
 * (open-rooms.mjs's `seatsByBeing`) — sends below stamp an explicit
 * `room: rec.id`.
 *
 * A `tool.exec` for a house tool (record/media/notes/stage/resident)
 * routes to `executeHouseTool` (room-turn-tools.mjs's `handleToolExec`,
 * extracted there to hold this file under its own line-length ratchet);
 * everything else goes through the room's own MCPL seat where one is
 * registered (`registerPlatformExecutor`) — no round in this port yet
 * wires a real one to a being's-turn room, so every OTHER call refuses
 * with the same "not offered" wording platform-tools.mjs already uses for
 * the being-container side of the exact same refusal.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCls } from "./room-policy.mjs";
import { beingsOf } from "./beings.mjs";
import { covenantFor } from "./resident-covenant.mjs";
import { lifePathFor } from "./serve-room-open.mjs";
import { buildFullMessages, readFramesJsonl } from "./life-entries.mjs";
import { displayFor } from "./identity-map.mjs";
import { lastFrameInfo, notifyFrameAppended } from "./frames-io.mjs";
import { beingSettingsGet, memoryGet } from "./commands/store.mjs";
import { roomSlug } from "./serve-room-open.mjs";
import { trimForContextSettings } from "./context-settings.mjs";
import { applyAutotriggerOnTurnClose } from "./autotrigger.mjs";
import { houseToolDefinitions } from "./house-tools.mjs";
import { handleToolExec, resolveCovenantFields } from "./room-turn-tools.mjs";
import { flushPendingFinal, foldTurnEvent } from "./room-turn-fold.mjs";
import { roomPeople } from "./room-reach.mjs";
import { seatFor } from "./open-rooms.mjs";
import { primaryBeingOf } from "./room-seats.mjs";

// harness-port W7: `applyInterrupt`/`applySteer`/`handleSeatExit` moved to
// room-seats.mjs (this file's own line-length ratchet, already at its cap)
// — re-exported here so every existing import path (mcpl/room-tails.mjs,
// this package's own tests) keeps working unchanged.
export { applyInterrupt, applySteer, handleSeatExit } from "./room-seats.mjs";

/** `!mcf`/`!h-default` (commands/registry.mjs) persist under `ctx.roomKey`
 * — mcpl/seat.mjs's own `roomKeyOf`, `` `${platform}:${roomSlug(stream)}` ``
 * — which is NOT this room's own run `id` (a `randomUUID()`, serve-rooms.
 * mjs's `openRoomLocked`; genuinely unrelated to the stream at all). A
 * room's `cls.room = {platform, stream, ...}` (serve-room-open.mjs) is
 * what carries the stream this record actually opened for — reproducing
 * `roomKeyOf` from it here, rather than reading `rec.id`, is this fix
 * (see this task's report: the earlier draft of this file's own consumers
 * read the wrong key entirely). A synthetic/non-platform room (no
 * `cls.room` at all — e.g. the walk-class rooms this repo's other tests
 * use) has no stream a `!` command could ever have targeted, so it
 * resolves to `null` — every command-lane consumer below then reads its
 * own honest default instead of guessing at a key.
 * @param {any} cls @returns {string|null} */
export function commandRoomKeyFor(cls) {
  const room = cls?.room;
  if (!room?.platform || !room?.stream) return null;
  return `${room.platform}:${roomSlug(room.stream)}`;
}

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
/** every turn frame this room appends also stamps `rec.lastFrameAt` (ms
 * epoch) and, for a `speech` frame, `rec.lastWasFinalSpeech` (true for a
 * non-interim final, false for an interim chunk or any other frame type)
 * — resident-alarms.mjs's own header names both as what its (not-yet-
 * ported) grace timer needs; cheap to stamp here, at the one place every
 * live turn frame already passes through. */
export function appendTurnFrame(rec, fields) {
  if (rec._turnSeq == null) resyncTurnSeq(rec);
  const frame = { seq: rec._turnSeq++, t: new Date().toISOString(), ...fields };
  appendFileSync(framesPath(rec), `${JSON.stringify(frame)}\n`);
  notifyFrameAppended(rec.runDir, frame); // W7-b's frame bus — a seat reacts at once, not on the 5s sweep
  rec.lastFrameAt = Date.now();
  if (fields.type === "speech") rec.lastWasFinalSpeech = !fields.interim;
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
    // platform-reach's human-display round: a human present in this
    // rendered turn shows by their current platform display, never their
    // kept pseudonym — displayFor's own null ("no display known") falls
    // back to the handle inside buildFullMessages itself.
    displayFor,
  });
  const rendered = built.map(({ participant, content }) => ({ participant, content }));
  return trimForContextSettings(rendered, commandRoomKeyFor(cls), handle);
}

/* `SERVER_DEFAULT_MAX_FRAMES`/`mcfBudget`/`trimForContextSettings` moved to
 * context-settings.mjs (harness-port Q1-C, 2026-09-18) to keep this file
 * under its own line-length ratchet — same behaviour, same doc comments,
 * imported above. */

/** `handle`'s own compiled life (serve-room-open.mjs's `compileRoomLives`,
 * run at open/reopen), tailed to `LIFE_EXCERPT_MESSAGES` — an honest
 * `null` when nothing was ever compiled for this handle in this room,
 * never a fabricated empty life.
 * @param {{runDir: string, cls: any}} rec @param {string} handle */
export function renderLifeExcerpt(rec, handle) {
  const cls = rec.cls ?? readCls(rec.runDir);
  const path = lifePathFor(rec.runDir, handle, primaryBeingOf(cls));
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
 *
 * harness-port P-A (parity round, 2026-09-17) — mission task 2's own
 * consumers, both GLOBAL PER BEING (not per room — neither `!mt`'s nor
 * `!sysprompt`'s fork command-effector method takes a streamId at all;
 * commands/registry.mjs's own header explains the correction this makes
 * to a prior round's per-room storage):
 * - `maxTokens`: `!mt`'s (C6) own in-memory override, when a keeper has
 *   set one — carried so the being's own runtime can apply it
 *   (connectome-seat-protocol/src/messages.mjs's `covenant.maxTokens`,
 *   OPTIONAL — the being side, bot-runtime's equivalent, is what actually
 *   reads it; named here since this port has none of its own yet).
 * - `systemPromptOverride`: `!sysprompt`'s (C16) own effective override —
 *   the in-memory tier first (whichever of `temp`/`override` ran most
 *   recently THIS process, matching the fork's own single running field),
 *   falling back to the being-persisted tier (a fresh process that never
 *   ran the command this session, but a previous one persisted an
 *   `override`) — composed ahead of the testament, exactly as 02-user-
 *   contract.md's own C16 target home describes.
 *
 * harness-port W3-A, 2026-09-18: `maxTokens`/`tools`/`thinking`/
 * `promptCaching` also bind the testament's own static covenant fields
 * (house/covenants/README.md's field table) — `resolveCovenantFields`
 * (room-turn-tools.mjs) is the how; see its own header.
 * @param {string} roomId @param {string} handle */
export function covenantExcerpt(roomId, handle) {
  const cov = covenantFor(handle);
  const executor = platformExecutors.get(roomId);
  const systemPromptOverride = memoryGet(null, `sysprompt:${handle}`, undefined) ?? beingSettingsGet(handle, "sysprompt", undefined) ?? null;
  const offeredNames = new Set([...(executor?.toolNames ?? []), ...houseToolDefinitions().map((d) => d.name)]);
  const { maxTokens, tools, thinking, promptCaching } = resolveCovenantFields(
    cov,
    offeredNames,
    handle,
    memoryGet(null, `max_tokens:${handle}`, undefined),
  );
  return {
    model: typeof cov?.speaks_for === "string" ? cov.speaks_for : "mock",
    tools,
    posture: cov?.posture ?? "resident",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(systemPromptOverride ? { systemPromptOverride } : {}),
    ...(thinking === false ? { thinking: false } : {}),
    ...(promptCaching !== undefined ? { promptCaching } : {}),
  };
}

/** begin one turn for `handle`, who must already hold this room's one
 * attached seat (open-rooms.mjs's singular `rec.seat`). Sends `turn.begin`
 * over the wire and returns a promise that resolves once the turn closes
 * (`turn.done`, `turn.error`, or a dropped seat) — never rejects; the
 * outcome is carried in the resolved value's `kind`.
 *
 * harness-port P-A (parity round, 2026-09-17) — mission task 2's own
 * `!continue`/`m continue` (C10) consumer: `opts.continue: true` carries
 * a `continue: true` field on the wire `turn.begin` message
 * (connectome-seat-protocol's schema, extended this round to accept it as
 * an OPTIONAL field). 02-user-contract.md §2.1's own note says to
 * reproduce the fork's *effect* (a no-tool continuation of the being's
 * last speech) "through the seat's ordinary turn transport, not a raw
 * provider call" — this is that transport-level carrier; the BEING side
 * (bot-runtime's own equivalent, not this file — this port has none of
 * its own yet) is what must actually honour the flag by skipping tool use
 * and continuing its own last output instead of responding fresh. Naming
 * that handoff here, not implementing the being side (out of this
 * package's scope — connectome-house is the house, not a being runtime).
 * @param {{id: string, runDir: string, cls: any, seat?: any, turn?: any}} rec
 * @param {string} handle
 * @param {{continue?: boolean}} [opts]
 * @returns {Promise<{kind: "done"|"error"|"aborted", message?: string}>} */
export function beginTurn(rec, handle, opts = {}) {
  const seat = seatFor(rec, handle);
  if (!seat) {
    throw new Error(`beginTurn: @${handle} has no seat attached to room ${rec.id}`);
  }
  if (rec.turns.get(handle)) {
    throw new Error(`beginTurn: @${handle} already has a turn in flight in room ${rec.id} (${rec.turns.get(handle).turnId})`);
  }
  const turnId = randomUUID();
  /** @type {any} */
  // `calledContinueSubstream`/`producedSpeech` (harness-port Q1-C,
  // 2026-09-18): this turn's own two autotrigger facts, tracked live below
  // by `handleToolExec`/`foldTurnEvent` as the turn runs, read by
  // `closeTurn`'s own `applyAutotriggerOnTurnClose` call once it ends.
  const turn = { turnId, handle, calledContinueSubstream: false, producedSpeech: false, pendingFinal: null };
  const donePromise = new Promise((resolve) => {
    turn.resolve = resolve;
  });
  // harness-port 31-silent-turn.md's own structural guard: marked in-flight
  // BEFORE any step below that could throw, so a failure in that section
  // always has a turn already sitting in `rec.turns` to find and release —
  // never a stuck entry that refuses every later activation for `handle`
  // with "already has a turn in flight" forever (this is the one place in
  // this file that turn is ever set, so this is the one place it must be
  // guaranteed to come back off on any failure between here and a
  // genuinely delivered wire `turn.begin`).
  rec.turns.set(handle, turn);
  try {
    const cls = rec.cls ?? readCls(rec.runDir);
    // `room`: who-address.mjs's own header names this exact addition as
    // what would let it read a real roster instead of approximating one
    // from the rendered conversation — `participants` is every human AND
    // being actually present (owner + accepted participants), `being` the
    // room's own primary being (may differ from `handle`, a visitor's turn).
    const room = {
      id: rec.id,
      participants: [cls?.owner, ...roomPeople(cls, handle).others, ...beingsOf(cls)].filter(
        (h, i, a) => h && a.indexOf(h) === i,
      ),
      being: primaryBeingOf(cls),
    };
    const context = { conversation: renderConversation(rec, handle), life: renderLifeExcerpt(rec, handle), room };
    const covenant = covenantExcerpt(rec.id, handle);
    resyncTurnSeq(rec); // fresh baseline for this turn's own frames (see the counter's own header note)
    seat.send({ type: "turn.begin", room: rec.id, turnId, context, covenant, ...(opts.continue ? { continue: true } : {}) });
  } catch (e) {
    // any throw here (a malformed class.json, a covenant that fails to
    // resolve, a broken wire send…) is a failure strictly between marking
    // this turn in-flight and actually delivering it — the exact silent
    // window 31-silent-turn.md names. Never swallowed: one house line
    // naming the being, room and error, then the same close a real
    // `turn.error` would take (frees `rec.turns`, resolves `donePromise`
    // so no caller hangs on it either).
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[room] turn.begin failed for @${handle} in ${rec.id}: ${message}`);
    closeTurn(rec, handle, turn, "error", message);
  }
  return donePromise;
}

/** `!continue`/`m continue` (C10): begin a turn that asks `handle` to
 * CONTINUE its own last speech rather than respond to new input — the
 * command lane's own intent (`{kind: "continue", scope: "being", being}`,
 * commands/registry.mjs, index.mjs's grammar/handleCommand) applied
 * against this room's seat, exactly as `applyInterrupt`/`applySteer` do
 * for `!stop`/`!steer` above.
 *
 * KNOWN GAP, named here and in this task's report: nothing yet calls this
 * from a live seat (mcpl/seat.mjs, NO-TOUCH for this task) — the same gap
 * `applyInterrupt`/`applySteer` already named for their own commands;
 * exercised directly by this package's own tests in the meantime.
 * @param {{id: string, runDir: string, seat?: any, turn?: any}} rec
 * @param {string} handle
 * @returns {Promise<{kind: "done"|"error"|"aborted", message?: string}>|null}
 *   null when this room has no seat for `handle` at all, or a turn is
 *   already in flight — a silent no-op, matching the other two hooks'
 *   own "nothing to do" shape rather than throwing. */
export function applyContinue(rec, handle) {
  if (!seatFor(rec, handle) || rec.turns.get(handle)) return null;
  return beginTurn(rec, handle, { continue: true });
}

/* `flushPendingFinal`/`foldTurnEvent` moved to room-turn-fold.mjs
 * (harness-port W3-A, 2026-09-18) to keep this file under its own
 * line-length ratchet — same behaviour, imported above. */

/** close ONE being's in-flight turn (idempotent: a turn already closed by
 * another path is a no-op) — `error`/a dropped seat append an `aborted`
 * frame (a pending final is discarded, never salvaged); `done` flushes a
 * pending final as the turn's true final speech, then applies
 * `!autotrigger`'s (C14) own re-activation rule (autotrigger.mjs,
 * harness-port Q1-C, 2026-09-18) — an error or a dropped seat never
 * auto-reactivates, deliberately: only an ordinary, successful close asks
 * "does the being get another cycle with no new external trigger?". The
 * room itself is never touched here: it stays open either way
 * (house-design.md's mission: "the room stays open"). Exported: room-
 * seats.mjs's `applyInterrupt`/`handleSeatExit` are this function's only
 * other callers (harness-port W7 extraction, this file's own ratchet).
 * @param {any} rec @param {string} being @param {any} turn
 * @param {"done"|"error"|"aborted"} kind @param {string} [message] */
export function closeTurn(rec, being, turn, kind, message) {
  if (rec.turns.get(being) !== turn) return;
  rec.turns.delete(being);
  if (kind !== "done") {
    turn.pendingFinal = null;
    appendTurnFrame(rec, { type: "aborted", reason: message || `turn.${kind}` });
  } else {
    flushPendingFinal(appendTurnFrame, rec, turn, false);
    const roomId = commandRoomKeyFor(rec.cls ?? readCls(rec.runDir));
    applyAutotriggerOnTurnClose(roomId, turn, {
      reactivate: () => beginTurn(rec, being),
      notice: (text) => appendTurnFrame(rec, { type: "message", by: "house", text }),
    });
  }
  turn.resolve({ kind, ...(message ? { message } : {}) });
}

/** the room worker's own dispatcher for every being->house message that
 * arrives while `being`'s own turn is in flight — wire this to the seat's
 * own event stream (socket-seat.mjs's `onEvent`, which already knows
 * `being` from its own handshake). A message naming a turnId that isn't
 * `being`'s current one is a stray from an already-closed turn — ignored,
 * never a throw.
 * @param {any} rec @param {string} being @param {Record<string, unknown>} msg */
export function handleSeatMessage(rec, being, msg) {
  const turn = rec.turns.get(being);
  if (!turn || msg.turnId !== turn.turnId) {
    // harness-port W8-A: a stray/duplicate turn.event|turn.done|turn.error
    // for a turn already closed (at-least-once delivery, never
    // exactly-once — 19-seat-idempotency.md) — ignored, never a crash or
    // a second close.
    if (msg.type === "turn.event" || msg.type === "turn.done" || msg.type === "turn.error") {
      console.error(`[room-turn] @${being} sent a stray/duplicate ${msg.type} for turn ${msg.turnId} — ignored`);
    }
    return;
  }
  switch (msg.type) {
    case "turn.event":
      return foldTurnEvent(appendTurnFrame, rec, turn, /** @type {any} */ (msg.event));
    case "tool.exec":
      flushPendingFinal(appendTurnFrame, rec, turn, true); // a tool call proves the buffered segment wasn't the turn's last word
      return void handleToolExec(rec, turn, /** @type {any} */ (msg), {
        appendTurnFrame,
        platformExecutorFor: (id) => platformExecutors.get(id),
      });
    case "turn.done":
      return closeTurn(rec, being, turn, "done");
    case "turn.error":
      return closeTurn(rec, being, turn, "error", /** @type {any} */ (msg.message));
    default:
      return; // an unrecognized message mid-turn is ignored, not fatal
  }
}
