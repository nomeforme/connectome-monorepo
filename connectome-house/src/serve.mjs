// @ts-check
/* connectome-house/src/serve.mjs — the house's own entrypoint: boots
 * config, the room registry, and the MCPL seats, then serves ONLY the
 * HTTP a seat actually needs (/api/rooms, /api/live/input, /api/mcpl).
 *
 * Ported from a private deployment (2026-09-17): that source's own
 * serve.mjs also composed a UI's routes (wiki/viz, decay, alarms, a
 * loom/fork browser, composition advertisement, a compose-surface
 * mirror) — all product/UI-layer, out of scope for this port (see
 * docs/harness-port/03-house-design.md §"what the entrypoint leaves
 * out"). Where those left-out routes would have wired a module this
 * port doesn't carry, the import and the route are simply absent here,
 * not stubbed — there is no dangling reference to clean up.
 */
import "./env.mjs"; // load a local .env once, side-effect only
import { createServer } from "node:http";
import { body, json } from "./serve-http.mjs";
import { whoAmI, mayTouch, scopeOfDir } from "./serve-identity.mjs";
import { RUNS } from "./serve-paths.mjs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleRoomGet,
  handleRoomRest,
  handleRoomsList,
  handleRoomsOpen,
  restRoom,
  roomInput,
} from "./serve-rooms.mjs";
import { handleRoomFrames } from "./serve-runs.mjs";
import { handleBeingsList } from "./serve-beings.mjs";
import { handleHouseGet, handleHousePost } from "./serve-house.mjs";
import { handleMediaUpload } from "./serve-media-upload.mjs";
import {
  handleRoomWalkerGet,
  handleRoomWalkerSpawn,
  handleRoomWalkerStop,
  stopAllWalkers,
} from "./serve-walks.mjs";
import { createShutdown } from "./serve-shutdown.mjs";
import { open } from "./open-rooms.mjs";
import { bootSeats, handleMcplGet, handleMcplPost, stopSeats } from "./mcpl/routes.mjs";
import { createHouseSeatServer, parseHouseSeatAddr } from "./seat/socket-seat.mjs";

const PORT = Number(process.env.HOUSE_PORT || 8787);
// loopback-only by default, matching the source's own keeper-side-local
// posture (serve-identity.mjs's header) — widen only deliberately.
const HOST = process.env.HOUSE_HOST || "127.0.0.1";

/** POST /api/live/input — the one generic HTTP door onto `roomInput`,
 * for a caller that isn't a platform seat (a keeper's own CLI, a test).
 * `mayTouch` gates it same as any other room-touching route. */
async function handleLiveInput(req, res) {
  const who = whoAmI(req);
  const b = await body(req);
  const id = String(b.id ?? "").trim();
  if (!id) return json(res, 400, { error: "id is required" });
  const runDir = join(RUNS, id);
  if (!mayTouch(who, scopeOfDir(runDir)))
    return json(res, 403, { error: "this conversation is private" });
  const r = await roomInput({
    id,
    by: who.handle,
    home: who.home,
    text: String(b.text ?? ""),
    targets: Array.isArray(b.targets) ? b.targets : undefined,
    observe: !!b.observe,
    attachments: b.attachments,
    external: b.external,
  });
  return json(res, r.error ? (r.code ?? 409) : 200, r);
}

// every /api/rooms/:id/<suffix> route must be matched BEFORE the generic
// two-segment ROOM_GET_RE below, which would otherwise happily (and
// wrongly) treat <suffix> as a slug8 and 404.
const ROOM_FRAMES_RE = /^\/api\/rooms\/([\w.-]+)\/frames$/;
const ROOM_WALKER_SPAWN_RE = /^\/api\/rooms\/([\w.-]+)\/walker\/spawn$/;
const ROOM_WALKER_STOP_RE = /^\/api\/rooms\/([\w.-]+)\/walker\/stop$/;
const ROOM_WALKER_RE = /^\/api\/rooms\/([\w.-]+)\/walker$/;
const ROOM_REST_RE = /^\/api\/rooms\/([^/]+)\/rest$/;
const ROOM_GET_RE = /^\/api\/rooms\/([^/]+)\/([^/]+)$/;
const HOUSE_RE = /^\/api\/house\/([a-z0-9][a-z0-9-]{1,23})$/;
const MCPL_SERVER_RE = /^\/api\/mcpl\/([^/]+)\/(restart|open)$/;

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const { pathname } = url;
  try {
    if (req.method === "GET" && pathname === "/api/rooms") return handleRoomsList(req, res);
    if (req.method === "POST" && pathname === "/api/rooms/open") return await handleRoomsOpen(req, res);
    let m = pathname.match(ROOM_FRAMES_RE);
    if (req.method === "GET" && m) return handleRoomFrames(req, res, m);
    m = pathname.match(ROOM_WALKER_SPAWN_RE);
    if (req.method === "POST" && m) return await handleRoomWalkerSpawn(req, res, m);
    m = pathname.match(ROOM_WALKER_STOP_RE);
    if (req.method === "POST" && m) return await handleRoomWalkerStop(req, res, m);
    m = pathname.match(ROOM_WALKER_RE);
    if (req.method === "GET" && m) return handleRoomWalkerGet(req, res, m);
    m = pathname.match(ROOM_REST_RE);
    if (req.method === "POST" && m) return await handleRoomRest(req, res, m);
    m = pathname.match(ROOM_GET_RE);
    if (req.method === "GET" && m) return handleRoomGet(req, res, m);
    if (req.method === "POST" && pathname === "/api/live/input") return await handleLiveInput(req, res);
    if (req.method === "GET" && pathname === "/api/beings") return handleBeingsList(req, res);
    m = pathname.match(HOUSE_RE);
    if (m && req.method === "GET") return handleHouseGet(req, res, m[1]);
    if (m && req.method === "POST") return await handleHousePost(req, res, body, m[1]);
    if (req.method === "POST" && pathname === "/api/media/upload") return await handleMediaUpload(req, res, url);
    if (req.method === "GET" && pathname === "/api/mcpl") return handleMcplGet(req, res);
    m = pathname.match(MCPL_SERVER_RE);
    if (req.method === "POST" && m) return await handleMcplPost(req, res, m);
    return json(res, 404, { error: "no such route" });
  } catch (e) {
    console.error(`[serve] ${req.method} ${pathname} failed: ${e.message}`);
    return json(res, 500, { error: "internal error" });
  }
}

const server = createServer((req, res) => {
  void route(req, res);
});

// the being's-turn socket seat (docs/harness-port/03-house-design.md §2.3):
// unset by default — nothing over this transport runs unless a deployment
// (or a test's own sandboxed env) names an address.
let seatServer = null;
const SEAT_ADDR = process.env.HOUSE_SEAT_ADDR;

server.listen(PORT, HOST, () => {
  console.error(`[serve] connectome-house listening on http://${HOST}:${PORT}`);
  const seated = bootSeats();
  console.error(`[serve] mcpl seats: ${seated.length ? seated.join(", ") : "(none configured)"}`);
  if (SEAT_ADDR) {
    seatServer = createHouseSeatServer();
    seatServer
      .listen(parseHouseSeatAddr(SEAT_ADDR))
      .then(() => console.error(`[serve] being's-turn seat listening on ${SEAT_ADDR}`))
      .catch((e) => console.error(`[serve] being's-turn seat failed to listen on ${SEAT_ADDR}: ${e.message}`));
  }
});

// a real process owns its signals; an in-process import (this package's
// own in-process unit tests) must not — matches the reference's own
// posture (isMainProcess), never installed as a side effect of merely
// importing this module for its exports.
const isMainProcess =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainProcess) {
  createShutdown({
    open,
    restRoom,
    stopAllWalkers,
    stopSeats,
    closeServer: () => {
      const closeSeat = seatServer ? seatServer.close() : Promise.resolve();
      closeSeat.finally(() => server.close());
    },
  }).install();
}

export { server };
