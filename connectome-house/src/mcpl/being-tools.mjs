// @ts-check
/* harness/src/mcpl/being-tools.mjs — the house side of a seated being's
 * reach into its own platform (platform-reach R2d gap 1, plan.md §3/§6).
 * No new HTTP route: serve.mjs, mcpl/seat.mjs and mcpl/relay.mjs are all
 * closed this round, so the child (harness/src/platform-tools.mjs) and this
 * module speak through a request/response file pair — the same file+tick
 * shape serve-walk-intent.mjs already uses for a resident's `walk` intent,
 * just keyed by run instead of handle. The exchange dir is EPHEMERAL and
 * NEVER under harness/runs (treasure: hourly hard-link snapshots,
 * rsynced between boxes — a mid-call snapshot would keep the secret on
 * disk, and this feature's own rmSync calls have no business in that
 * tree): `os.tmpdir()/house-mcpl-calls/<runId>/`, mode 0o700, one per run.
 * mcpl/routes.mjs registers each seated server's resolved config here at
 * boot and starts/stops the poller; nothing here imports mcpl/seat.mjs —
 * only its own already-public `host` and `snapshot()`.
 *
 * Two gates before a tool ever reaches the wire: `cfg.being_tools` (the
 * keeper's allowlist, config.mjs) AND a registered NORMALIZER (below) — a
 * tool with no normalizer is never exposed, default or override alike
 * (PII discipline: "a tool whose result shape you can't normalize is not
 * exposed"). A platform author id never survives past `normalizedResult`;
 * only house handles do.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJSONSync } from "../atomic-write.mjs";
import { beingsOf } from "../beings.mjs";
import { identityFor } from "../identity-map.mjs";
import { placeOf, readCls } from "../room-policy.mjs";
import { RUNS } from "../serve-paths.mjs";
import { adapterFor } from "./adapters.mjs";
import { loadServersConfig } from "./config.mjs";

const POLL_MS = 250;
// a request nobody answered this long is abandoned, not retried — the
// child's own poll gives up well before this (platform-tools.mjs's
// TIMEOUT_MS), so anything still here is orphaned, never mid-flight.
const REQUEST_MAX_AGE_MS = 60_000;
const CALLS_ROOT = join(tmpdir(), "house-mcpl-calls");

/* ---------- spawn-time: everything a platform room's child needs, one call ---------- */

/** run id -> secret. In-memory only — never written to disk, a frame, or a
 * log line. */
const secrets = new Map();

/** mint (or return the existing) secret for `runId` — idempotent per run id
 * so a redundant call never orphans an already-spawned child's copy.
 * @param {string} runId @returns {string} */
export function mintRunSecret(runId) {
  const existing = secrets.get(runId);
  if (existing) return existing;
  const secret = randomBytes(24).toString("hex");
  secrets.set(runId, secret);
  return secret;
}

/** the ephemeral per-run exchange dir, created 0o700 on first use — never
 * under harness/runs. @param {string} runId @returns {string} */
export function callsDirFor(runId) {
  const dir = join(CALLS_ROOT, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** this platform's `being_tools`, resolved fresh from the servers file (not
 * the `seated` registry below — a spawn may happen before or between boot
 * cycles) for whichever configured server speaks for one of `beings`;
 * absent a match, the platform's own conservative default.
 * @param {string|null|undefined} platform @param {string[]} beings @returns {string[]} */
export function resolveBeingTools(platform, beings) {
  if (!platform) return [];
  const { servers } = loadServersConfig();
  const cfg = servers.find((s) => s.platform === platform && beings.includes(s.being));
  return cfg?.being_tools ?? adapterFor(platform).defaultBeingTools;
}

/** everything serve-walks.mjs's spawn needs in one call: mints the secret,
 * makes the exchange dir, resolves the allowlist — `null` for a non-room
 * spawn (a plain conversation passes no platform env at all).
 * @param {string} runId @param {string|null|undefined} platform @param {string[]} beings
 * @returns {Record<string,string>|null} */
export function platformSpawnEnv(runId, platform, beings) {
  if (!platform) return null;
  return {
    HOUSE_PLATFORM_TOOLS_SECRET: mintRunSecret(runId),
    HOUSE_PLATFORM_TOOLS_CALLS_DIR: callsDirFor(runId),
    HOUSE_PLATFORM_TOOLS_ALLOWED: JSON.stringify(resolveBeingTools(platform, beings)),
  };
}

/** the run is truly done: forgets its secret and removes its exchange dir
 * (a leaked one would otherwise keep the secret on disk indefinitely).
 * A no-op for a run that never minted either. @param {string} runId */
export function cleanupPlatformRun(runId) {
  secrets.delete(runId);
  rmSync(join(CALLS_ROOT, runId), { recursive: true, force: true });
}

/* ---------- the seat registry: platform + being_tools, by server name ---------- */

/** server name -> {cfg, seat} — mcpl/routes.mjs's bootSeats/stopSeats own
 * the lifecycle; nothing else writes here. */
const seated = new Map();

/** @param {import("./config.mjs").ServerConfig} cfg @param {ReturnType<typeof import("./seat.mjs").createSeat>} seat */
export function registerSeat(cfg, seat) {
  seated.set(cfg.name, { cfg, seat });
}

export function clearSeats() {
  seated.clear();
}

/** the seat serving `runId`'s room, matched by PLACE and by the being it
 * actually speaks for standing in the room's own roster — a stream match
 * alone isn't enough (a DM is often unlisted in any server's static
 * `rooms[]`); the roster always names who is really there.
 * @param {string} runId @returns {{cfg: import("./config.mjs").ServerConfig, seat: any}|null} */
function seatFor(runId) {
  let cls;
  try {
    cls = readCls(join(RUNS, runId));
  } catch {
    return null;
  }
  const place = placeOf(cls);
  if (!place) return null;
  const beings = beingsOf(cls);
  for (const entry of seated.values()) {
    if (entry.cfg.platform === place.platform && beings.includes(entry.cfg.being)) return entry;
  }
  return null;
}

/* ---------- normalizers: a tool with none is never exposed ---------- */

/** a platform author/member id -> house handle, through the identity map —
 * the ONLY road a raw id may travel past this point. `display` seeds a
 * fresh pseudonym's stored display name exactly as identityFor already
 * does for incoming messages; it is never itself returned to a caller.
 * @param {string} platform @param {unknown} id @param {unknown} display */
function asHandle(platform, id, display) {
  if (!id) return null;
  return identityFor({ platform, id: String(id), display: display ? String(display) : null })
    .handle;
}

/** member/author-shaped entries -> `{handle, isBot}` — every OTHER field
 * (username, displayName, discriminator, avatar, tag) is dropped, never
 * carried through, even when a caller adds a field this table doesn't yet
 * know about (an unrecognized field is absent, not guessed safe).
 * @param {unknown} list @param {string} platform */
function normalizeMembers(list, platform) {
  return (Array.isArray(list) ? list : []).map((m) => ({
    handle: asHandle(platform, m?.id, m?.username ?? m?.displayName ?? m?.global_name ?? null),
    ...(typeof m?.isBot === "boolean" ? { isBot: m.isBot } : {}),
  }));
}

/** tool name -> (parsed result, platform) -> normalized result. Exhaustive
 * by design: `dispatch` refuses a tool absent here even if `being_tools`
 * names it (a keeper override can widen the allowlist; it cannot widen
 * this table without a code change). Every entry either carries no
 * author-shaped field at all (room/server/channel/emoji ids, counts,
 * config state — room addresses, not people) or is rewritten below. */
export const NORMALIZERS = {
  list_guilds: (r) => r,
  list_channels: (r) => r,
  list_emojis: (r) => r,
  filters_get: (r) => r,
  list_subscriptions: (r) => r,
  channel_missed: (r) => r,
  add_reaction: (r) => r,
  remove_reaction: (r) => r,
  list_groups: (r) => r,
  // mcpl-web's flag: a post id and counts — nothing author-shaped; picked,
  // so a later field is absent rather than guessed safe
  flag_post: (r) => ({
    post_id: r?.post_id ?? null,
    duplicate: !!r?.duplicate,
    flags: Number.isInteger(r?.flags) ? r.flags : null,
    threshold: Number.isInteger(r?.threshold) ? r.threshold : null,
    hidden: !!r?.hidden,
    ...(typeof r?.note === "string" ? { note: r.note } : {}),
  }),
  list_channel_members: (r, platform) => ({
    ...r,
    members: normalizeMembers(r?.members, platform),
  }),
};

/** the parsed object inside an MCP `{content:[{type:"text",text}]}}` tool
 * result, or `result` itself when it already arrived as a plain object (the
 * two shapes a server's own dispatcher may return) — a non-JSON text block
 * reads as `{text}` rather than failing.
 * @param {any} result */
export function parseToolResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result.content)) return result;
  const block = Array.isArray(result?.content)
    ? result.content.find((b) => b?.type === "text")
    : null;
  if (!block) return result ?? {};
  try {
    return JSON.parse(block.text);
  } catch {
    return { text: block.text };
  }
}

/** the one call a normalized tool result travels through — throws for a
 * tool with no registered normalizer (dispatch checks first; this is the
 * second line of defense, never reachable in practice).
 * @param {string} tool @param {any} rawResult @param {string} platform */
export function normalizedResult(tool, rawResult, platform) {
  const fn = NORMALIZERS[tool];
  if (!fn) throw new Error(`no normalizer registered for ${tool} — not exposed`);
  return fn(parseToolResult(rawResult), platform);
}

/* ---------- the file bridge: one run's ephemeral exchange dir ---------- */

function writeResponse(runId, id, body) {
  try {
    atomicWriteJSONSync(join(callsDirFor(runId), `${id}.response.json`), body);
  } catch {
    /* the run may already be gone — nothing to answer */
  }
}

function removeRequest(runId, id) {
  try {
    rmSync(join(CALLS_ROOT, runId, `${id}.request.json`), { force: true });
  } catch {
    /* best-effort cleanup only */
  }
}

/** one pending request, end to end: secret, then place+seat, then the
 * allowlist AND the normalizer table, then the wire, through the grant
 * gate host.callTool already enforces — never a throw past this function.
 * @param {string} runId @param {string} id @param {any} req */
async function serviceRequest(runId, id, req) {
  if (!secretOk(runId, req?.secret)) {
    removeRequest(runId, id); // a forged/stale run id gets silence, not a hint
    return;
  }
  const entry = seatFor(runId);
  if (!entry) {
    writeResponse(runId, id, { ok: false, error: "no seated server owns this room" });
    removeRequest(runId, id);
    return;
  }
  const tool = String(req?.tool ?? "");
  if (!entry.cfg.being_tools.includes(tool) || !NORMALIZERS[tool]) {
    writeResponse(runId, id, { ok: false, error: `${tool} is not offered here` });
    removeRequest(runId, id);
    return;
  }
  try {
    const raw = await entry.seat.host.callTool(tool, req.args ?? {});
    writeResponse(runId, id, { ok: true, result: normalizedResult(tool, raw, entry.cfg.platform) });
  } catch (e) {
    // GrantRefused (calls.mjs) and a plain wire error both land here —
    // the same "typed, never a throw" posture host.callTool already holds.
    writeResponse(runId, id, { ok: false, error: e.message });
  }
  removeRequest(runId, id);
}

/** constant-time compare against the run's own registered secret — an
 * unregistered run (never minted, or already forgotten) refuses every call.
 * @param {string} runId @param {unknown} given @returns {boolean} */
function secretOk(runId, given) {
  const want = secrets.get(runId);
  if (!want || typeof given !== "string" || given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(given));
}

/** every pending request under a seat's OWN live rooms — bounded by the
 * seats' configured rosters, never a scan of all of harness/runs
 * (serve-walk-intent.mjs's tick is the same shape, over residents instead
 * of seats). Abandoned requests (the child gave up long ago) are pruned,
 * not serviced. */
function pendingRequests() {
  const out = [];
  for (const { seat } of seated.values()) {
    for (const room of seat.snapshot().rooms) {
      if (!room.run || !room.live) continue;
      let entries;
      try {
        entries = readdirSync(join(CALLS_ROOT, room.run));
      } catch {
        continue; // no exchange dir yet — nothing pending
      }
      for (const f of entries) {
        if (!f.endsWith(".request.json")) continue;
        const p = join(CALLS_ROOT, room.run, f);
        let age = 0;
        try {
          age = Date.now() - statSync(p).mtimeMs;
        } catch {
          continue; // raced a concurrent cleanup — skip, next tick is fine
        }
        if (age > REQUEST_MAX_AGE_MS) {
          rmSync(p, { force: true });
          continue;
        }
        out.push({ runId: room.run, id: f.slice(0, -".request.json".length), path: p });
      }
    }
  }
  return out;
}

let timer = null;

/** the poller — started once at boot (mcpl/routes.mjs's bootSeats), stopped
 * at shutdown (stopSeats). A no-op if already running. */
export function startBeingToolsPoller() {
  if (timer) return;
  timer = setInterval(() => {
    for (const { runId, id, path } of pendingRequests()) {
      let req;
      try {
        req = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue; // a request file mid-write — whole on the next tick
      }
      serviceRequest(runId, id, req).catch(() => {}); // serviceRequest never rejects; belt only
    }
  }, POLL_MS);
  timer.unref?.();
}

export function stopBeingToolsPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** true when a run has a live exchange dir — test/diagnostic convenience
 * only, never used on the dispatch path itself.
 * @param {string} runId */
export function hasPendingCalls(runId) {
  return existsSync(join(CALLS_ROOT, runId));
}
