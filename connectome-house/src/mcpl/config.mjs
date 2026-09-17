// @ts-check
/* harness/src/mcpl/config.mjs — the keeper-owned servers file
 * (`HOUSE_MCPL_SERVERS`, a path under harness/private/ — gitignored),
 * read lazily and validated into the shape host/route/seat consume. No
 * defaults name a machine or a token: `env` lists variable NAMES the
 * child may read from the house's own environment, never values.
 *
 *   { "rooms": [ { "stream": "discord:<guild>:<channel>",
 *                  "beings": ["<handle>", …] } ],   // GLOBAL allowlist, every
 *                  // server of a matching platform shares it (beings unset:
 *                  // every such server's own being joins — "all bots of that
 *                  // platform"; set: exactly those handles, whichever bots
 *       "servers": [ {                              // those are)
 *                  // "public": true optional, default false — a group/channel
 *                  // room is auth-gated by default (only a linked sender or
 *                  // the keeper wakes a being there); public:true opens it to
 *                  // any sender, as every room behaved before this field
 *                  // existed (early testers, pre-auth discourse). DMs are
 *                  // never affected — they stay linked-only regardless.
 *       "name": "discord-pilot",        // unique; the /api/mcpl/:server key
 *       "platform": "discord",          // the room key's prefix; the server's channel ids carry it
 *       "command": "node", "args": ["…/dist/src/index.js", "--stdio"],
 *       "cwd": "…",                     // optional
 *       "env": ["DISCORD_TOKEN"],       // names only
 *       "being": "<handle>",            // the house handle this ONE bot identity speaks for
 *       "being_id": "<platform user id>",  // optional: the bot's own id, christened to `being`
 *       "display_name": "<name>",       // optional fallback account name: used only
 *                                        // when the platform itself has reported none yet
 *                                        // this process (self-display.mjs) — a learned
 *                                        // sighting always wins over this field
 *       "rooms": [ { "stream": "discord:<guild>:<channel>", "title": "#general",
 *                    "beings": ["<handle>", …], "public": true } ],  // per-stream
 *                    // OVERRIDE of the global entry above, field by field —
 *                    // beings/public unset here ride into the global value.
 *                    // `title` is OPTIONAL and rarely needed: unset, a room's
 *                    // title comes from the platform itself (adapters.mjs's
 *                    // titleFor) — set it only to override that.
 *       "limit": 2000,                  // optional outbound text limit per message
 *       "mock": false,                  // test-only: rooms open with --mock
 *       "errors_to_chat": true,          // optional per-server override of the
 *                                        // global switch below (keeper: "config is
 *                                        // global to all bots with per bot overrides")
 *       "app_url": "https://…",          // optional per-server override of the global
 *                                        // app_url below
 *       "being_tools": ["list_channels"] // optional per-server override of the global
 *                                        // list below (platform-reach R2d gap 1) — the
 *                                        // tool NAMES a seated being may call on this
 *                                        // server, never this server's own speech tools
 *                                        // (stripped even if named here)
 *       "box": "sfo",                    // optional per-server override of the global
 *                                        // box below — this bot identity seats ONLY on
 *                                        // this machine id (resolveSelf().SELF_ID)
 *   } ],
 *   "errors_to_chat": false,             // GLOBAL default (OFF): a failed turn's
 *                                        // provider error posts as one short
 *                                        // house-voiced line, never the being's own
 *   "app_url": null,                     // GLOBAL default (unset): the app's public URL,
 *                                        // named in the unlinked-DM hint (mcpl/link.mjs's
 *                                        // unlinkedHint) when set; unset, the hint omits
 *                                        // it rather than guessing a machine's address
 *   "being_tools": null,                 // GLOBAL default (unset): each server falls back
 *                                        // to its own platform's conservative default
 *                                        // (adapters.mjs's defaultBeingTools) — read/
 *                                        // look-up/react-shaped, never speech
 *   "box": null                          // GLOBAL default (unset): no binding — a server
 *                                        // seats on ANY box (today's behaviour). One bot
 *                                        // identity must live on one box (Discord double-
 *                                        // delivers; Signal can't share a number) — bootSeats
 *                                        // (mcpl/routes.mjs) skips a server whose box mismatches.
 *
 * `loadServersConfig` resolves the global allowlist into each server's own
 * `rooms[]` ONCE (`mergeGlobalRooms`) so host/route/seat keep reading
 * `server.rooms` exactly as before — they never see the global list. */
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { HANDLE_RE } from "../testaments.mjs";
import { adapterFor } from "./adapters.mjs";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** @typedef {{stream: string, title: string|null, beings?: string[], public?: boolean}} RawRoom
 * a room entry before the cross-server merge — `beings` unset means "every
 * server sharing this stream with beings ALSO unset" (resolved later);
 * `public` unset means "inherit the merge's resolved default" (false). */
/** @typedef {{name: string, platform: string, command: string, args: string[], cwd?: string,
 *   env: string[], being: string, being_id: string|null, display_name: string|null,
 *   rooms: {stream: string, title: string|null,
 *   beings: string[], public: boolean}[], limit: number, mock: boolean, errors_to_chat: boolean,
 *   app_url: string|null, being_tools: string[], box: string|null}} ServerConfig
 * `errors_to_chat`, `app_url`, `being_tools` and `box` are all unset from validateServer and
 * resolved by loadServersConfig (the global default — or, for `being_tools` with no
 * global either, the platform's own conservative default — fills each in, same
 * two-step as the rooms allowlist). */

/** a tool name's own shape — plain, lowercase, underscored (every server's own
 * tool names so far; never a handle, a platform id, or free text). */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** the seat's own speech tools — a being is never handed these through
 * `being_tools`: the seat already speaks through them (mcpl/speak.mjs), and a
 * being reaching them directly would double-post or bypass the room record
 * entirely. Stripped unconditionally, default or explicit override alike. */
export const NEVER_BEING_TOOLS = new Set(["send_message", "reply_message"]);

/** `raw` (an array, or absent) -> a deduped list of valid tool names, minus
 * the seat's own speech tools — or null when `raw` names nothing (the caller
 * falls back further). A non-string/malformed entry is dropped, not refused:
 * `being_tools` is an allowlist, so a typo just means one less tool offered.
 * @param {any} raw @returns {string[]|null} */
function normalizeBeingTools(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    const name = String(t ?? "").trim();
    if (!TOOL_NAME_RE.test(name) || NEVER_BEING_TOOLS.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** one raw entry → ServerConfig, or a string naming what is wrong. A
 * server's own `rooms[].beings` stays UNSET here when the entry doesn't
 * name one — `loadServersConfig`'s `mergeGlobalRooms` is what finalizes it
 * (the global allowlist, or another server's own being, may fill it in);
 * an EXPLICIT list is resolved right away, this server's own being always
 * first (unchanged from before the global allowlist existed).
 * @param {any} raw @returns {ServerConfig|string} */
export function validateServer(raw) {
  if (!raw || typeof raw !== "object") return "a server entry must be an object";
  const name = String(raw.name ?? "");
  if (!NAME_RE.test(name)) return `server name ${JSON.stringify(raw.name)} is not [a-z0-9-]`;
  const platform = String(raw.platform ?? "");
  if (!NAME_RE.test(platform))
    return `${name}: platform ${JSON.stringify(raw.platform)} is not [a-z0-9-]`;
  if (typeof raw.command !== "string" || !raw.command) return `${name}: command is required`;
  const being = String(raw.being ?? "");
  if (!HANDLE_RE.test(being)) return `${name}: being ${JSON.stringify(raw.being)} is not a handle`;
  let display_name = null;
  if (raw.display_name !== undefined) {
    display_name = typeof raw.display_name === "string" ? raw.display_name.trim() : "";
    if (!display_name || display_name.length > 100)
      return `${name}: display_name must be a non-empty string, 100 characters or fewer`;
  }
  // shown verbatim in the unlinked-DM hint to a stranger — must at least look like a URL.
  if (raw.app_url !== undefined && !/^https?:\/\/\S+$/.test(String(raw.app_url ?? "").trim()))
    return `${name}: app_url must be an http(s) URL`;
  // a machine id, the same shape as a declared one (resolveSelf().SELF_ID).
  let box;
  if (raw.box !== undefined) {
    box = String(raw.box ?? "").trim();
    if (!NAME_RE.test(box)) return `${name}: box ${JSON.stringify(raw.box)} is not a machine id`;
  }
  const env = Array.isArray(raw.env) ? raw.env : [];
  // a NAME, or CHILD=HOUSE — the child reads CHILD from the house's HOUSE var
  // (discord-mcpl wants DISCORD_TOKEN; the house keeps HOUSE_DISCORD_TOKEN_<HANDLE>).
  if (env.some((e) => typeof e !== "string" || !/^[A-Z_][A-Z0-9_]*(=[A-Z_][A-Z0-9_]*)?$/.test(e)))
    return `${name}: env must list variable NAMES only (NAME or CHILD=HOUSE)`;
  const rooms = [];
  for (const r of Array.isArray(raw.rooms) ? raw.rooms : []) {
    if (!r || typeof r.stream !== "string" || !r.stream) return `${name}: a room needs a stream`;
    const entry = {
      stream: r.stream,
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : null,
    };
    if (r.beings !== undefined) {
      const beings = Array.isArray(r.beings) ? r.beings.map(String) : null;
      if (!beings || beings.some((b) => !HANDLE_RE.test(b)))
        return `${name}: room ${r.stream} names a non-handle`;
      // the server's being is always first: the room's primary (openRoom's beings[0])
      entry.beings = [being, ...beings.filter((b) => b !== being)];
    }
    if (r.public !== undefined) entry.public = r.public === true;
    rooms.push(entry);
  }
  return {
    name,
    platform,
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    ...(typeof raw.cwd === "string" && raw.cwd ? { cwd: raw.cwd } : {}),
    env,
    being,
    being_id: raw.being_id != null ? String(raw.being_id) : null,
    display_name,
    rooms,
    limit:
      Number.isFinite(Number(raw.limit)) && Number(raw.limit) > 0
        ? Number(raw.limit)
        : adapterFor(platform).limit,
    mock: raw.mock === true,
    // left unset when the entry doesn't name one — loadServersConfig's
    // global default (or this server's own explicit override) fills it in.
    ...(typeof raw.errors_to_chat === "boolean" ? { errors_to_chat: raw.errors_to_chat } : {}),
    ...(raw.app_url !== undefined ? { app_url: String(raw.app_url).trim() } : {}),
    // left unset when this entry names none — loadServersConfig's global
    // list, or (absent that too) the platform's own default, fills it in.
    ...(raw.being_tools !== undefined
      ? { being_tools: normalizeBeingTools(raw.being_tools) ?? [] }
      : {}),
    // left unset when this entry names none — loadServersConfig's global
    // box (or null, "any box") fills it in.
    ...(box !== undefined ? { box } : {}),
  };
}

/** one top-level `rooms[]` entry → {stream, title, beings?}, or a string
 * naming which entry is wrong (the global allowlist has no owning server,
 * so an explicit `beings` here is used exactly as given — never
 * force-including any one server's being).
 * @param {any} raw @param {number} i @returns {RawRoom|string} */
function validateGlobalRoom(raw, i) {
  if (!raw || typeof raw !== "object" || typeof raw.stream !== "string" || !raw.stream)
    return `rooms[${i}]: a room needs a stream`;
  const out = {
    stream: raw.stream,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null,
  };
  if (raw.beings !== undefined) {
    const beings = Array.isArray(raw.beings) ? raw.beings.map(String) : null;
    if (!beings || beings.some((b) => !HANDLE_RE.test(b)))
      return `rooms[${i}] (${raw.stream}): beings must be a list of handles`;
    out.beings = beings;
  }
  if (raw.public !== undefined) out.public = raw.public === true;
  return out;
}

/** resolve the global allowlist into every server's OWN `rooms[]`, in
 * place: for each server, seed from every global room whose stream's
 * platform prefix matches, then let the server's own `rooms[]` win field
 * by field (same stream). Once every server's raw list is built, any
 * entry still unset for `beings` is filled from the UNION of every
 * server (of any platform) that shares that exact stream with `beings`
 * ALSO unset — the same array, so whichever server's seat opens the room
 * first mints it with the full roster, deterministically ordered by
 * config order, never by which seat won the race.
 * @param {ServerConfig[]} servers @param {RawRoom[]} globalRooms */
function mergeGlobalRooms(servers, globalRooms) {
  const perServer = servers.map((server) => {
    const byStream = new Map();
    for (const g of globalRooms) {
      if (g.stream.split(":")[0] !== server.platform) continue;
      byStream.set(g.stream, {
        stream: g.stream,
        title: g.title,
        ...(g.beings ? { beings: g.beings } : {}),
        ...(g.public !== undefined ? { public: g.public } : {}),
      });
    }
    for (const r of server.rooms) byStream.set(r.stream, { ...byStream.get(r.stream), ...r });
    return { server, raw: [...byStream.values()] };
  });
  const union = new Map();
  for (const { server, raw } of perServer) {
    for (const r of raw) {
      if (r.beings !== undefined) continue;
      const arr = union.get(r.stream) ?? [];
      if (!arr.includes(server.being)) arr.push(server.being);
      union.set(r.stream, arr);
    }
  }
  for (const { server, raw } of perServer) {
    server.rooms = raw.map((r) => ({
      stream: r.stream,
      title: r.title ?? null,
      beings: r.beings ?? union.get(r.stream) ?? [server.being],
      public: r.public === true,
    }));
  }
}

/** a sandboxed serve (HOUSE_RUNS_DIR set — a test's) seats only a servers
 * file under its own sandboxed HOUSE_PRIVATE_DIR: the box's real file
 * names real tokens, and a test serve wearing the keeper's bot would
 * answer real people from a throwaway room (seen live, 2026-09-10).
 * Returns the reason to refuse, or null. */
export function sandboxRefusal(env = process.env) {
  const path = env.HOUSE_MCPL_SERVERS;
  if (!path || !env.HOUSE_RUNS_DIR) return null;
  const priv = env.HOUSE_PRIVATE_DIR;
  if (!priv) return "sandboxed serve (HOUSE_RUNS_DIR) without HOUSE_PRIVATE_DIR";
  const inside = resolve(path).startsWith(`${resolve(priv)}${sep}`);
  return inside ? null : "sandboxed serve: the servers file is not under HOUSE_PRIVATE_DIR";
}

/** the servers file, parsed and validated: `{servers, errors, warnings}` —
 * a bad entry is reported (naming it) and skipped, never a throw; an
 * absent env var or file is `{servers: [], errors: [], warnings: []}`
 * (honest absence, the caller logs one line). A global room whose stream
 * matches no configured server's platform is a WARNING, never a refusal
 * — the allowlist stays exactly an allowlist either way. Read at call
 * time, never at import. */
export function loadServersConfig(env = process.env) {
  const path = env.HOUSE_MCPL_SERVERS;
  if (!path) return { path: null, servers: [], errors: [], warnings: [] };
  const refused = sandboxRefusal(env);
  if (refused) return { path, servers: [], errors: [refused], warnings: [] };
  if (!existsSync(path))
    return { path, servers: [], errors: [`${path} does not exist`], warnings: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { path, servers: [], errors: [`${path}: ${e.message}`], warnings: [] };
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : null;
  if (!list)
    return { path, servers: [], errors: [`${path}: expected {servers: [...]}`], warnings: [] };
  const servers = [];
  const errors = [];
  const names = new Set();
  for (const entry of list) {
    const v = validateServer(entry);
    if (typeof v === "string") {
      errors.push(v);
      continue;
    }
    if (names.has(v.name)) {
      errors.push(`duplicate server name ${v.name}`);
      continue;
    }
    names.add(v.name);
    servers.push(v);
  }
  const globalRooms = [];
  const rawGlobalRooms = Array.isArray(raw) ? [] : Array.isArray(raw?.rooms) ? raw.rooms : [];
  rawGlobalRooms.forEach((r, i) => {
    const g = validateGlobalRoom(r, i);
    if (typeof g === "string") errors.push(g);
    else globalRooms.push(g);
  });
  const platforms = new Set(servers.map((s) => s.platform));
  const warnings = globalRooms
    .filter((g) => !platforms.has(g.stream.split(":")[0]))
    .map((g) => `rooms: ${g.stream} names no configured server's platform`);
  mergeGlobalRooms(servers, globalRooms);
  // global default, same override shape as the rooms allowlist: a server's
  // own explicit errors_to_chat (set above, in validateServer) always wins.
  const globalErrorsToChat = !Array.isArray(raw) && raw?.errors_to_chat === true;
  for (const s of servers)
    if (typeof s.errors_to_chat !== "boolean") s.errors_to_chat = globalErrorsToChat;
  // same two-step for app_url: a malformed GLOBAL value is a warning (never
  // a refusal — the allowlist-style posture every global default here
  // holds), left null; a server's own explicit override always wins.
  let globalAppUrl = null;
  if (!Array.isArray(raw) && raw?.app_url !== undefined) {
    const s = String(raw.app_url ?? "").trim();
    if (/^https?:\/\/\S+$/.test(s)) globalAppUrl = s;
    else warnings.push("app_url (global) must be an http(s) URL — ignored");
  }
  for (const s of servers) if (s.app_url === undefined) s.app_url = globalAppUrl;
  // same two-step for box: a malformed GLOBAL value is a warning, left null
  // ("any box" — today's behaviour); a server's own explicit override wins.
  let globalBox = null;
  if (!Array.isArray(raw) && raw?.box !== undefined) {
    const b = String(raw.box ?? "").trim();
    if (NAME_RE.test(b)) globalBox = b;
    else warnings.push("box (global) must be a machine id — ignored");
  }
  for (const s of servers) if (s.box === undefined) s.box = globalBox;
  // being_tools: same two-step, one rung deeper — a server's own explicit
  // list wins; absent that, the GLOBAL list; absent that too, the
  // platform's own conservative default (adapters.mjs). Never a refusal:
  // a malformed global list is a warning and reads as "none named".
  const globalBeingTools = normalizeBeingTools(Array.isArray(raw) ? undefined : raw?.being_tools);
  if (!Array.isArray(raw) && raw?.being_tools !== undefined && globalBeingTools === null)
    warnings.push("being_tools (global) must be an array of tool names — ignored");
  for (const s of servers)
    if (s.being_tools === undefined)
      s.being_tools = globalBeingTools ?? adapterFor(s.platform).defaultBeingTools;
  return { path, servers, errors, warnings };
}
