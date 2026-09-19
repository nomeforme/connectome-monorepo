// @ts-check
/* connectome-house/src/mcpl/routes.mjs — the seat's boot and its keeper
 * routes, the only surface serve.mjs (composition root) touches:
 *   bootSeats()                          — iff HOUSE_MCPL_SERVERS is set and parses (and, sandboxed,
 *                                          lives under HOUSE_PRIVATE_DIR — config.mjs); else one log line
 *   GET  /api/mcpl                       — servers, state, channels open, last error, counts
 *   POST /api/mcpl/:server/restart       — kill + re-handshake + re-open
 *   POST /api/mcpl/:server/open {stream, title}
 * Keeper-only, the same gate as /api/house/*. */
import { body, json } from "../serve-http.mjs";
import { whoAmI } from "../serve-identity.mjs";
import { clearRemoteHosts, registerRemoteHost } from "../open-rooms.mjs";
import {
  clearSeats,
  registerSeat,
  startBeingToolsPoller,
  stopBeingToolsPoller,
} from "./being-tools.mjs";
import { loadServersConfig } from "./config.mjs";
import { createSeat } from "./seat.mjs";
import { clearSeatRegistry } from "./seat-registry.mjs";

/** @type {Map<string, ReturnType<typeof createSeat>>} */
export const seats = new Map();

/** servers bound to another box (platform-reach R3 — one bot identity, one
 * box): kept here, never seated, so GET /api/mcpl can still show them.
 * @type {Map<string, {name: string, platform: string, being: string, box: string, reason: string}>} */
export const notSeated = new Map();

/** start every configured server's seat; honest absence otherwise. A
 * server whose resolved `box` doesn't match this box's own id is skipped —
 * one bot identity may live on only one box at a time (Discord delivers to
 * every live seat; a Signal number can't serve two device stores). */
export function bootSeats({ log = console.error } = {}) {
  const { path, servers, errors, warnings } = loadServersConfig();
  for (const e of errors) log(`[mcpl] servers file: ${e}`);
  for (const w of warnings) log(`[mcpl] servers file (warning): ${w}`);
  notSeated.clear();
  if (!path) {
    log("[mcpl] no seat: HOUSE_MCPL_SERVERS is unset");
    return [];
  }
  if (!servers.length) {
    log(`[mcpl] no seat: ${path} names no valid server`);
    return [];
  }
  // no cross-machine registry in this port (a private deployment's own —
  // this box names itself, if at all, via HOUSE_ID).
  const selfId = process.env.HOUSE_ID || "local";
  const seatable = [];
  for (const server of servers) {
    if (server.box && server.box !== selfId) {
      const reason = `bound to box "${server.box}"; this box is "${selfId}"`;
      notSeated.set(server.name, {
        name: server.name,
        platform: server.platform,
        being: server.being,
        box: server.box,
        reason,
      });
      log(`[mcpl] not seated: ${server.name} (box: ${server.box}, this box: ${selfId})`);
      continue;
    }
    seatable.push(server);
  }
  for (const server of seatable) {
    // every OTHER seated server's being_id on this same platform, computed
    // once at boot — the pre-connection gate's own bot-loop guard (a
    // sibling house bot never gets a template reply, never re-reads the
    // servers file per message).
    const otherBotIds = new Set(
      seatable
        .filter((s) => s !== server && s.platform === server.platform && s.being_id)
        .map((s) => s.being_id),
    );
    const seat = createSeat({ server, log, otherBotIds });
    seats.set(server.name, seat);
    // the being-tools bridge (platform-reach R2d gap 1) needs the resolved
    // config (platform, being, being_tools) beside the seat it dispatches
    // through — registered here, at the one place both already exist,
    // rather than seat.mjs growing a new export (it's at its own cap).
    registerSeat(server, seat);
    // harness-port W6, 2026-09-19: a being-hosted server spawns no child —
    // its seat's own host (seat.mjs's own hosted_by switch, mcpl/remote-
    // host.mjs) waits here for that being's `platform.hello`, found by
    // (being, server name) on whichever connection it eventually makes
    // (seat/socket-seat.mjs's dispatch).
    if (server.hosted_by === "being") registerRemoteHost(server.being, server.name, seat.host);
    seat.start().catch((e) => log(`[seat:${server.name}] start failed: ${e.message}`));
    log(
      `[mcpl] seated ${server.name} (${server.platform}, speaks for @${server.being}, ${server.rooms.length} room(s))`,
    );
  }
  if (seatable.length) startBeingToolsPoller();
  return [...seats.keys()];
}

export function stopSeats() {
  stopBeingToolsPoller();
  clearSeats();
  for (const s of seats.values()) s.stop();
  seats.clear();
  notSeated.clear();
  clearRemoteHosts();
  clearSeatRegistry();
}

function keeperOnly(req, res) {
  if (whoAmI(req).roles.includes("keeper")) return true;
  json(res, 403, { error: "the MCPL seat is a keeper-only view" });
  return false;
}

/** GET /api/mcpl — a box-skipped server appears too (`seated: false`,
 * `reason`), so the gap is visible rather than silently absent.
 * `observe_only` (harness-port P-F, 2026-09-17, mission task 2) rides in
 * automatically through each seat's own `snapshot()` (mcpl/seat.mjs) —
 * no separate field-picking needed here. */
export function handleMcplGet(req, res) {
  if (!keeperOnly(req, res)) return;
  return json(res, 200, {
    t: new Date().toISOString(),
    configured: !!process.env.HOUSE_MCPL_SERVERS,
    servers: [
      ...[...seats.values()].map((s) => ({ seated: true, ...s.snapshot() })),
      ...[...notSeated.values()].map((n) => ({ seated: false, ...n })),
    ],
  });
}

/** POST /api/mcpl/:server/(restart|open) */
export async function handleMcplPost(req, res, match) {
  if (!keeperOnly(req, res)) return;
  const [, name, verb] = match;
  const seat = seats.get(name);
  if (!seat) return json(res, 404, { error: `no seat named ${name}` });
  try {
    if (verb === "restart") {
      await seat.restart();
      return json(res, 200, { ok: true, state: seat.host.state.state });
    }
    const b = await body(req);
    const stream = String(b.stream ?? "").trim();
    if (!stream) return json(res, 400, { error: "stream is required" });
    const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : null;
    const r = await seat.openStream(stream, title);
    return json(res, 200, { ok: true, ...r });
  } catch (e) {
    return json(res, 409, { error: e.message });
  }
}
