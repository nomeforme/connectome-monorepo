// @ts-check
/* connectome-house/src/serve-beings.mjs — GET /api/beings: the public
 * roster of every being this house holds a testament for, plus which
 * open rooms (if any) each currently holds the one seat in.
 *
 * A private deployment's own serve-beings.mjs is almost entirely about
 * per-being LIFE compilation (opening/join/close bookkeeping) — this
 * port already carries that machinery elsewhere (serve-room-open.mjs's
 * `compileRoomLives`, called at room open/reopen; beings.mjs's
 * `beingsOf`/`beingsFromParticipants`), so re-porting it here would only
 * duplicate it (connectome-house/README.md's "what was cut" already
 * names the specific pieces — join-time life compile, the participant
 * invite/join HTTP flow — that don't apply to this port's room model).
 * What's genuinely missing, and what this file owns instead, is a plain
 * roster: which handles this box can voice at all, and where they
 * currently sit. `serve-house.mjs` builds its own keeper-only view on
 * top of this same roster.
 */
import { covenantFor } from "./resident-covenant.mjs";
import { testaments } from "./testaments.mjs";
import { open } from "./open-rooms.mjs";
import { json } from "./serve-http.mjs";

/** every room id this house currently holds open whose own `rec.seats`
 * names `handle` — harness-port W7: a room may now seat several beings at
 * once, so this can be more than a single-element array.
 * @param {string} handle @returns {string[]} */
function roomsSeatedIn(handle) {
  const ids = [];
  for (const [id, rec] of open) {
    if (rec.seats?.has(handle)) ids.push(id);
  }
  return ids;
}

/** GET /api/beings's payload: every testament-holding handle, its voice
 * (covenantFor's own `speaks_for`, honest null when unset), and the open
 * rooms it currently seats. Order: alphabetical by handle — this port
 * carries no "resident vs. derived walker" distinction to rank by
 * (testaments.mjs's own header: the source's per-pinned-model derived
 * testament feature was cut).
 * @returns {Array<{handle: string, model: string|null, posture: string|null, seated_in: string[]}>} */
export function beingsPublic() {
  const t = testaments();
  return Object.keys(t)
    .sort()
    .map((handle) => {
      const cov = covenantFor(handle);
      return {
        handle,
        model: typeof cov?.speaks_for === "string" ? cov.speaks_for : null,
        posture: cov?.posture ?? null,
        seated_in: roomsSeatedIn(handle),
      };
    });
}

/** GET /api/beings — public: safe to expose (naming a handle and its
 * current model/seat grants no access; every per-room route still checks
 * mayView/mayTouch of its own). */
export function handleBeingsList(req, res) {
  return json(res, 200, { beings: beingsPublic() });
}
