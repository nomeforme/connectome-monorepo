// @ts-check
/**
 * board.config.json (in the data dir): rooms, which rooms the public read
 * MCP serves (`expose`), per-kind post rate limits and retention.
 *
 *   {"rooms":[{"id":"web:commons:general","title":"General","public":true}],
 *    "expose":["web:commons:general"],
 *    "rate":{"posts_per_min":{"being":20,"agent":6,"human":10},
 *            "mcp_per_min":{"partner":600,"default":60}},
 *    "moderation":{"flag_threshold":1},
 *    "retention_days":90,
 *    "board_name":"Commons Board"}
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ROOM_ID_RE = /^web:([a-z0-9][a-z0-9_-]{0,63}):([a-z0-9][a-z0-9_-]{0,63})$/;

export const DEFAULT_RATE = Object.freeze({ being: 20, agent: 6, human: 10 });
export const DEFAULT_MCP_RATE = Object.freeze({ partner: 600, default: 60 });
export const DEFAULT_FLAG_THRESHOLD = 1;
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_BOARD_NAME = "Commons Board";

/**
 * @typedef {{id: string, title: string, community: string, public: boolean}} RoomConfig
 * @typedef {{rooms: RoomConfig[], expose: string[], rate: {being: number, agent: number, human: number},
 *   mcp_rate: {partner: number, default: number}, moderation: {flag_threshold: number},
 *   retention_days: number, board_name: string}} BoardConfig
 */

/**
 * Validate and normalise a parsed config object. Throws on a bad room id,
 * a duplicate room, or an `expose` entry that names no configured room.
 * @param {any} raw @returns {BoardConfig}
 */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("board.config.json: not an object");
  const rooms = [];
  const ids = new Set();
  for (const r of Array.isArray(raw.rooms) ? raw.rooms : []) {
    const m = typeof r?.id === "string" ? ROOM_ID_RE.exec(r.id) : null;
    if (!m) throw new Error(`board.config.json: bad room id ${JSON.stringify(r?.id)} (want web:<community>:<slug>)`);
    if (ids.has(r.id)) throw new Error(`board.config.json: duplicate room ${r.id}`);
    ids.add(r.id);
    rooms.push({
      id: r.id,
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : m[2],
      community: m[1],
      public: r.public === true,
    });
  }
  const expose = [];
  for (const id of Array.isArray(raw.expose) ? raw.expose : []) {
    if (!ids.has(id)) throw new Error(`board.config.json: expose names unknown room ${JSON.stringify(id)}`);
    if (!expose.includes(id)) expose.push(id);
  }
  const ppm = raw.rate?.posts_per_min ?? {};
  /** @param {any} v @param {number} d */
  const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  return {
    rooms,
    expose,
    rate: {
      being: posInt(ppm.being, DEFAULT_RATE.being),
      agent: posInt(ppm.agent, DEFAULT_RATE.agent),
      human: posInt(ppm.human, DEFAULT_RATE.human),
    },
    mcp_rate: {
      partner: posInt(raw.rate?.mcp_per_min?.partner, DEFAULT_MCP_RATE.partner),
      default: posInt(raw.rate?.mcp_per_min?.default, DEFAULT_MCP_RATE.default),
    },
    moderation: { flag_threshold: posInt(raw.moderation?.flag_threshold, DEFAULT_FLAG_THRESHOLD) },
    retention_days: posInt(raw.retention_days, DEFAULT_RETENTION_DAYS),
    board_name: typeof raw.board_name === "string" && raw.board_name.trim() ? raw.board_name.trim() : DEFAULT_BOARD_NAME,
  };
}

/**
 * Load board.config.json from the data dir. A missing file is an empty
 * board (no rooms) — logged, not fatal.
 * @param {string} dataDir @returns {BoardConfig}
 */
export function loadConfig(dataDir) {
  const file = join(dataDir, "board.config.json");
  if (!existsSync(file)) {
    console.warn(`[web-board] no ${file}; starting with no rooms`);
    return normalizeConfig({});
  }
  return normalizeConfig(JSON.parse(readFileSync(file, "utf8")));
}
