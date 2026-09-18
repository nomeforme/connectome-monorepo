// @ts-check
/* connectome-house/src/serve-house.mjs — the keeper-only "house" control
 * plane: GET /api/house/:handle (this being's own detail: voice, posture,
 * which open rooms it seats, whether a turn is currently in flight in
 * each) and POST /api/house/:handle {verb:"stop"} (interrupt every one of
 * those turns at once).
 *
 * A private deployment's own serve-house.mjs is almost entirely the
 * resident wake/sleep alarm clock (pause/resume/wake, spend-today
 * accounting, a pending-walk intent) — connectome-house/README.md's "what
 * was cut" already retires that whole clock for this port ("every being
 * reads as awake"; a deployment wanting a sleep posture reintroduces it
 * on top). What's left, and genuinely still keeper-relevant here, is the
 * one control this port's room-turn.mjs already implements but nothing
 * yet CALLS from an HTTP surface: `applyInterrupt` (02-user-contract.md
 * C11's `!stop`, "every open room the being is seated in" — room-turn.
 * mjs's own header names this exact gap). This file is that missing
 * caller: it loops `serve-beings.mjs`'s own roster of a being's seated
 * rooms and applies the interrupt to each, since `room-turn.mjs` has no
 * cross-room registry of its own to loop over (open-rooms.mjs's `open`
 * Map is that registry, and this file — not room-turn.mjs — is where the
 * loop belongs, exactly as room-turn.mjs's own header anticipates).
 */
import { open } from "./open-rooms.mjs";
import { applyInterrupt } from "./room-turn.mjs";
import { covenantFor } from "./resident-covenant.mjs";
import { testamentFor } from "./testaments.mjs";
import { json } from "./serve-http.mjs";
import { whoAmI } from "./serve-identity.mjs";

/** every open room whose one seat is attached to `handle`, alongside
 * whether that room currently has a turn in flight — the detail
 * `houseState` and `stop` both need, kept in one place so they can't
 * drift. @param {string} handle */
function seatedRoomsDetail(handle) {
  const rows = [];
  for (const [id, rec] of open) {
    if (rec.seat?.being === handle) rows.push({ room: id, turn: !!rec.turn });
  }
  return rows;
}

/** the keeper-only detail view for one handle. `null` testament reads as
 * an honest "unknown to this house" rather than a fabricated state. */
function houseState(handle) {
  const t = testamentFor(handle);
  const cov = covenantFor(handle);
  return {
    handle,
    known: !!t,
    model: typeof cov?.speaks_for === "string" ? cov.speaks_for : null,
    posture: cov?.posture ?? null,
    rooms: seatedRoomsDetail(handle),
  };
}

/** GET /api/house/:handle — keeper-only (unlike GET /api/beings, this
 * view names which rooms are mid-turn right now, which is closer to
 * operational detail than a public roster should carry). */
export function handleHouseGet(req, res, handle) {
  const who = whoAmI(req);
  if (!who.roles.includes("keeper"))
    return json(res, 403, { error: "the house is a keeper-only view" });
  return json(res, 200, houseState(handle));
}

/** POST /api/house/:handle {verb: "stop"} — keeper-only: interrupt every
 * turn this being currently has open, across every room it seats
 * (`applyInterrupt` per room; a room with no open turn is a silent no-op,
 * matching its own posture). Only `stop` is implemented here — this port
 * carries no wake/sleep/pause clock to pair it with (see this file's own
 * header); a future round adding one back extends this verb switch.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {(req: import("node:http").IncomingMessage) => Promise<any>} bodyReader
 * @param {string} handle */
export async function handleHousePost(req, res, bodyReader, handle) {
  const who = whoAmI(req);
  if (!who.roles.includes("keeper"))
    return json(res, 403, { error: "the house is a keeper-only view" });
  if (!testamentFor(handle)) return json(res, 404, { error: "no testament for this handle" });
  const b = await bodyReader(req);
  if (b.verb === "stop") {
    let stopped = 0;
    for (const { room } of seatedRoomsDetail(handle)) {
      const rec = open.get(room);
      if (rec && applyInterrupt(rec)) stopped += 1;
    }
    return json(res, 200, { ...houseState(handle), stopped });
  }
  return json(res, 400, { error: `unknown verb ${JSON.stringify(b.verb)}` });
}
