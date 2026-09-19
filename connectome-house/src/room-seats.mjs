// @ts-check
/* connectome-house/src/room-seats.mjs — the multi-being seat/turn model
 * (harness-port W7, 2026-09-19). THE BUG this answers: two beings present
 * in one room, each with its own always-on walker; open-rooms.mjs's
 * `rec.seat` was a ROOM-singular slot, so a mention activating the SECOND
 * being (dispatch.mjs's own decision, correct) found `serve-rooms.mjs`'s
 * `roomInput` only willing to `beginTurn` for whichever ONE being already
 * held the room's one seat — the second being's own walker sat there
 * typing, with no turn, no reply, no log, and nothing to ever stop it.
 *
 * `rec.seats: Map<being, Seat>` and `rec.turns: Map<being, turn>`
 * (open-rooms.mjs/room-turn.mjs) replace the old singular fields — every
 * being present may now hold its own seat and run its own turn,
 * independently; per-being concurrency still caps at the walker's own
 * limit (unrelated to this file). `initSeatState` installs both maps PLUS
 * two backward-compatible getters, `rec.seat`/`rec.turn`, so every
 * NO-TOUCH consumer that still reads the old singular field (seat/
 * protocol.mjs, serve-house.mjs, this task's own untouched tests) keeps
 * working unchanged: the room's PRIMARY being's own seat/turn when it has
 * one, else whichever single being happens to (every pre-W7 room had at
 * most one, ever, so this is never ambiguous for old callers).
 *
 * Extracted out of room-turn.mjs (already at its own file-length ratchet
 * before this task, and may not grow) rather than grown in place — this
 * module is the "room-seats.mjs is a natural home" the task's own mission
 * names. `applyInterrupt`/`applySteer`/`handleSeatExit` moved here whole;
 * `beginTurn`/`closeTurn`/`handleSeatMessage` stayed in room-turn.mjs
 * (closeTurn needs `beginTurn` for autotrigger's own reactivate hook —
 * keeping them together avoids a needless import cycle for that one). */
import { beingsOf } from "./beings.mjs";
import { seatFor } from "./open-rooms.mjs";
import { appendTurnFrame, closeTurn } from "./room-turn.mjs";

/** the room's own primary being: `cls.being` when set, else the first of
 * `beingsOf(cls)` — the one resolution room-turn.mjs's `renderLifeExcerpt`
 * and room-turn-tools.mjs's own (now-removed) duplicate both used before
 * this task; collapsed here. @param {any} cls @returns {string|null} */
export function primaryBeingOf(cls) {
  const roster = beingsOf(cls);
  return typeof cls?.being === "string" && cls.being ? cls.being : (roster[0] ?? null);
}

/** which being a backward-compat `rec.seat`/`rec.turn` getter should read:
 * the primary being when IT holds an entry, else whichever ONE being does
 * (every pre-W7 room had at most one holder anyway — never an arbitrary
 * pick among several genuinely concurrent ones). `null` off an empty map.
 * @param {Map<string, any>|undefined} byBeing @param {any} cls */
function compatBeing(byBeing, cls) {
  if (!byBeing || byBeing.size === 0) return null;
  const primary = primaryBeingOf(cls);
  if (primary && byBeing.has(primary)) return primary;
  return byBeing.size === 1 ? [...byBeing.keys()][0] : (primary ?? null);
}

/** install `rec.seats`/`rec.turns` (fresh, empty Maps) and the
 * `rec.seat`/`rec.turn` compat getters — call once, right after a room
 * record is built (serve-rooms.mjs's two mint/reopen paths, room-fork.mjs's
 * child), before it's registered in `open-rooms.mjs`'s `open` map.
 * @param {{cls: any}} rec @returns {typeof rec} */
export function initSeatState(rec) {
  const r = /** @type {any} */ (rec);
  r.seats = new Map();
  r.turns = new Map();
  Object.defineProperty(r, "seat", {
    configurable: true,
    enumerable: true,
    get() {
      const being = compatBeing(r.seats, r.cls);
      return being ? r.seats.get(being) : null;
    },
  });
  Object.defineProperty(r, "turn", {
    configurable: true,
    enumerable: true,
    get() {
      const being = compatBeing(r.turns, r.cls);
      return being ? r.turns.get(being) : null;
    },
  });
  return rec;
}

/** `rec.turns.get(being)`, honest null off no map, no being, or no entry.
 * @param {any} rec @param {string|null|undefined} being */
export function turnFor(rec, being) {
  return (being && rec?.turns?.get(being)) || null;
}

/** `!stop` (C11) / POST /api/house/:handle{stop}: interrupt ONE being's
 * own open turn — `being` defaults to the room's primary (every pre-W7
 * caller, serve-house.mjs included, named none at all) so those callers
 * need no change. Sends that being's own seat an `interrupt`, closes its
 * turn exactly as a dropped seat would (the fork's own O30 "[Cycle
 * stopped]" notice), the room itself stays open either way. Every OTHER
 * being present, seated or not, is untouched.
 * @param {any} rec @param {string|null} [being]
 * @returns {boolean} whether a turn was actually interrupted */
export function applyInterrupt(rec, being = null) {
  const target = being ?? primaryBeingOf(rec.cls);
  const turn = turnFor(rec, target);
  if (!turn) return false;
  const seat = seatFor(rec, target);
  if (seat) seat.send({ type: "interrupt", room: rec.id, by: "house" });
  closeTurn(rec, target, turn, "aborted", "interrupted (!stop)");
  appendTurnFrame(rec, { type: "speech", by: turn.handle, inline: "[Cycle stopped]" });
  return true;
}

/** `!steer <msg>` (C12): deliver a line to ONE being's own open turn, at
 * its next tool boundary — `being` rides inside `opts` (default: the
 * room's primary) so the pre-W7 2-arg `applySteer(rec, {by, text})` shape
 * is unchanged for every existing caller. A room with no open turn for
 * that being (or no seat at all — a race with a turn that just ended) has
 * nothing to steer: a silent no-op.
 * @param {any} rec @param {{by: string, text: string, being?: string|null}} opts
 * @returns {boolean} whether a turn was actually steered */
export function applySteer(rec, { by, text, being = null }) {
  const target = being ?? primaryBeingOf(rec.cls);
  const turn = turnFor(rec, target);
  const seat = seatFor(rec, target);
  if (!turn || !seat) return false;
  appendTurnFrame(rec, { type: "message", by, text });
  seat.send({ type: "line", room: rec.id, by, text });
  return true;
}

/** one being's seat transport dropped (socket close, child exit) — ITS
 * in-flight turn (if any) ends `aborted`; ITS seat entry is removed from
 * `rec.seats` either way, so a fresh connection for the SAME being can
 * re-seat. Every OTHER being present is untouched — the W7 fix: one
 * being's exit no longer takes the whole room's seat down with it.
 * @param {any} rec @param {string} being */
export function handleSeatExit(rec, being) {
  const turn = turnFor(rec, being);
  if (turn) closeTurn(rec, being, turn, "aborted", "seat disconnected");
  rec.seats?.delete(being);
}
