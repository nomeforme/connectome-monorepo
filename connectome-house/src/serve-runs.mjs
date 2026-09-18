// @ts-check
/* connectome-house/src/serve-runs.mjs — GET /api/rooms/:id/frames: a
 * room's own verbatim record, read whole. `serve-rooms.mjs` already owns
 * room LISTING (GET /api/rooms, GET /api/rooms/:platform/:slug8 — a
 * metadata row per room, "extend, don't duplicate" per this task's own
 * brief) and room OPEN/REST; what it does not yet offer is reading a
 * room's actual frame-by-frame record over HTTP — this file is that one
 * addition, needed later by a web-facing MCPL client the same way it
 * needs serve-media-upload.mjs's upload route (docs/harness-port/
 * 03-house-design.md §4's web MCPL server, not yet written).
 *
 * A private deployment's own serve-runs.mjs is much larger: ATIF/OTEL
 * trajectory export, a leaf-hit/citation-audit hydration pass, and the
 * walk-class skill registry (`/api/classes`) — all archive-composition
 * concerns this port's rooms don't have (no compiled corpus, no
 * citations to audit). This file keeps only the one generic piece: read
 * the record, gated exactly like every other per-room route
 * (`serve-identity.mjs`'s `mayView`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS } from "./serve-paths.mjs";
import { json } from "./serve-http.mjs";
import { mayView, scopeOfDir, whoAmI } from "./serve-identity.mjs";

/** a room dir's frames.jsonl, parsed whole — an unparseable/partial
 * trailing line (a read racing a live append) is dropped rather than
 * thrown; every complete line before it still returns.
 * @param {string} runDir @returns {object[]} */
export function readRoomFrames(runDir) {
  const p = join(runDir, "frames.jsonl");
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      break; // a partial trailing line mid-append — stop, don't throw
    }
  }
  return out;
}

/** GET /api/rooms/:id/frames.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {RegExpMatchArray} match */
export function handleRoomFrames(req, res, match) {
  const [, id] = match;
  const runDir = join(RUNS, id);
  if (!existsSync(join(runDir, "class.json"))) return json(res, 404, { error: "no such room" });
  if (!mayView(whoAmI(req), scopeOfDir(runDir)))
    return json(res, 403, { error: "this room is private" });
  return json(res, 200, readRoomFrames(runDir));
}
