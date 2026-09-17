// @ts-check
/* connectome-house/src/serve-room-open.mjs — a standing room's own opening
 * shape: the id it mints (`roomSlug`, never the raw stream — a Signal DM's
 * may be a phone number), the closed `class.json.room` record, and the
 * per-being life files a room worker hands its beings' seats at open/reopen.
 *
 * Ported from a private deployment (2026-09-17): the source built CLI
 * argv for a specific walk-child process (`--walkers`, `--room`,
 * `--life-for`, `--platform-surface`) — a spawn-shape this port's target
 * architecture doesn't use (docs/harness-port/03-house-design.md §2: a
 * being's-turn seat carries a rendered request over the wire, not CLI
 * flags to a subprocess). That argv-building half is cut; what's kept is
 * the generic part — a room's id, its closed record shape, and compiling
 * each present being's life — reshaped as plain data a seat implementation
 * can fold into its own `turn.begin` request.
 *
 * Stored shape, closed: `class.json.room = {platform, stream, title,
 * opened_t}`.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { compileFor, lifeForHandle } from "./resident-life.mjs";
import { beingsOf } from "./beings.mjs";

/** first 8 hex chars of sha256(stream) — what a room's own run id is
 * minted from. @param {string} stream */
export const roomSlug = (stream) =>
  createHash("sha256").update(String(stream)).digest("hex").slice(0, 8);

/** the record class.json keeps for a room — the one closed shape.
 * @param {{platform: string, stream: string, title?: string|null}} room
 * @param {string} openedAt */
export const roomRecord = (room, openedAt) => ({
  platform: room.platform,
  stream: room.stream,
  title: room.title ?? null,
  opened_t: openedAt,
});

/** widen a run's opening participants with every further being the room
 * holds (the primary is already seeded as owner/being) — same entry shape,
 * so beingsFromParticipants (beings.mjs) derives `beings` from one array.
 * `home` names this box, if at all, via HOUSE_ID — this port carries no
 * cross-machine registry.
 * @param {Array<{handle: string, home: string|null, joined_t: string, kind?: string}>} participants
 * @param {string[]|null|undefined} beings @param {string} openedAt */
export function widenRoomParticipants(participants, beings, openedAt) {
  const home = process.env.HOUSE_ID || "local";
  for (const h of beings ?? []) {
    if (!h || participants.some((p) => p.handle === h)) continue;
    participants.push({
      handle: h,
      home,
      joined_t: openedAt,
      kind: "resident",
    });
  }
  return participants;
}

/** the path a being's compiled life lands at: the primary's is the shared
 * `life.json` (compileFor's own side-effect file), every other being's is
 * `life.<handle>.json`. */
export const lifePathFor = (runDir, handle, primary) =>
  join(runDir, handle === primary ? "life.json" : `life.${handle}.json`);

/** compile every present being's life for this room (others first, the
 * primary last — compileFor restamps life.json on every call) and return
 * `{handle -> lifePath}` for whichever beings actually compiled — an
 * uncompiled life is an honest absence, never a reason to hold the room. A
 * compile failure is logged, never a refusal.
 * @param {{runDir: string, cls: any}} opts @returns {Promise<Record<string,string>>} */
export async function compileRoomLives({ runDir, cls }) {
  const beings = beingsOf(cls);
  const primary = typeof cls.being === "string" && cls.being ? cls.being : (beings[0] ?? null);
  const others = beings.filter((h) => h !== primary);
  const paths = /** @type {Record<string,string>} */ ({});
  for (const h of [...others, ...(primary ? [primary] : [])]) {
    try {
      const life = await lifeForHandle(h);
      if (!life) continue;
      await compileFor(life, runDir, {});
      const p = lifePathFor(runDir, h, primary);
      if (existsSync(p)) paths[h] = p;
    } catch (e) {
      console.error(`[life] compileFor failed for @${h} in room ${cls.room?.platform}: ${e.message}`);
    }
  }
  return paths;
}
