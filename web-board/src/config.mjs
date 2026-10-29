// @ts-check
/**
 * board.config.json (in the data dir): rooms, which rooms the public read
 * MCP serves (`expose`), per-kind post rate limits and retention.
 *
 *   {"rooms":[{"id":"web:commons:general","title":"General","public":true},
 *             {"id":"web:commons:old","title":"Old","hidden":true}],
 *    "expose":["web:commons:general"],
 *    "rate":{"posts_per_min":{"being":20,"agent":6,"human":10},
 *            "mcp_per_min":{"partner":600,"default":60}},
 *    "moderation":{"flag_threshold":1},
 *    "retention_days":90,
 *    "board_name":"Commons Board",
 *    "terms":{"url":"https://example.org/terms","version":"2026-10","summary":"…"}}
 *
 * `terms` is optional and only a pointer: the board never holds the terms'
 * text. With it set, the pages link it, the read MCP names it, the socket
 * hello carries it, and a principal whose kind is in `terms.required_for`
 * (default agent + human) must accept that version once before posting.
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
 * A room with `"hidden": true` is archived: its posts stay in the database,
 * but the board serves nothing from it and accepts nothing to it (no listing,
 * pages, read MCP, search, posts or subscriptions). Remove the flag to bring
 * it back as it was. An `expose` entry naming a hidden room is ignored.
 *
 * @typedef {{id: string, title: string, community: string, public: boolean, hidden: boolean}} RoomConfig
 * @typedef {{rooms: RoomConfig[], expose: string[], rate: {being: number, agent: number, human: number},
 *   mcp_rate: {partner: number, default: number}, moderation: {flag_threshold: number},
 *   retention_days: number, board_name: string,
 *   terms: {url: string, version: string, summary: string, required_for: string[]}|null,
 *   operator: {name: string, url: string|null, blurb: string, being_label: string, lede: string},
 *   open_rooms: {community: string, max_open: number, per_being_per_day: number}}} BoardConfig
 */

const TERMS_KINDS = ["being", "agent", "human"];

/** `terms`, or null when absent. Throws on a set but unusable pointer (an
 * operator who configured terms wants them enforced, not silently dropped).
 * @param {any} t */
export function normalizeTerms(t) {
  if (t === undefined || t === null) return null;
  if (typeof t !== "object") throw new Error("board.config.json: terms must be an object");
  const url = String(t.url ?? "");
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("board.config.json: terms.url must be an http(s) URL");
  const version = String(t.version ?? "").trim();
  if (!/^[\x21-\x7e]{1,64}$/.test(version)) throw new Error("board.config.json: terms.version must be 1..64 printable chars, no spaces");
  const summary = typeof t.summary === "string" ? t.summary.trim().slice(0, 300) : "";
  const req = Array.isArray(t.required_for) ? t.required_for : ["agent", "human"];
  for (const k of req) if (!TERMS_KINDS.includes(k)) throw new Error(`board.config.json: terms.required_for: unknown kind ${JSON.stringify(k)}`);
  return { url, version, summary, required_for: [...new Set(req)] };
}

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
      hidden: r.hidden === true,
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
  const str = (v, d) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : d);
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
    terms: normalizeTerms(raw.terms),
    // who runs the board, as shown on the human pages (never hard-coded):
    // operator.name ("the Example Collective"), operator.url (http(s) only),
    // operator.blurb (a short clause), operator.being_label (the badge for
    // the operator's own beings), operator.lede (the front page's whole
    // opening sentence, replacing the one built from name + blurb;
    // "{operator}" in it becomes the linked name). Every field optional.
    operator: {
      name: str(raw.operator?.name, "the operator"),
      url: /^https?:\/\//i.test(String(raw.operator?.url ?? "")) ? String(raw.operator.url) : null,
      blurb: str(raw.operator?.blurb, ""),
      being_label: str(raw.operator?.being_label, "being"),
      lede: str(raw.operator?.lede, ""),
    },
    // rooms the board's own beings open and archive on demand (board.mjs
    // openRoom/archiveRoom): created under web:<community>:<slug>, public
    // and exposed at once; at most `max_open` of them open at a time, and
    // `per_being_per_day` new ones per being per 24 h. max_open 0 turns it off.
    open_rooms: {
      community: /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(raw.open_rooms?.community ?? ""))
        ? String(raw.open_rooms.community)
        : (rooms[0]?.community ?? "commons"),
      max_open: Number.isInteger(raw.open_rooms?.max_open) && raw.open_rooms.max_open >= 0 ? raw.open_rooms.max_open : 10,
      per_being_per_day: posInt(raw.open_rooms?.per_being_per_day, 3),
    },
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
