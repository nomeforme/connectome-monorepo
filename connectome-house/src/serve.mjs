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
import { join } from "node:path";
import {
  handleRoomGet,
  handleRoomRest,
  handleRoomsList,
  handleRoomsOpen,
  roomInput,
} from "./serve-rooms.mjs";
import { bootSeats, handleMcplGet, handleMcplPost, stopSeats } from "./mcpl/routes.mjs";

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

const ROOM_GET_RE = /^\/api\/rooms\/([^/]+)\/([^/]+)$/;
const ROOM_REST_RE = /^\/api\/rooms\/([^/]+)\/rest$/;
const MCPL_SERVER_RE = /^\/api\/mcpl\/([^/]+)\/(restart|open)$/;

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const { pathname } = url;
  try {
    if (req.method === "GET" && pathname === "/api/rooms") return handleRoomsList(req, res);
    if (req.method === "POST" && pathname === "/api/rooms/open") return await handleRoomsOpen(req, res);
    let m = pathname.match(ROOM_REST_RE);
    if (req.method === "POST" && m) return handleRoomRest(req, res, m);
    m = pathname.match(ROOM_GET_RE);
    if (req.method === "GET" && m) return handleRoomGet(req, res, m);
    if (req.method === "POST" && pathname === "/api/live/input") return await handleLiveInput(req, res);
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

server.listen(PORT, HOST, () => {
  console.error(`[serve] connectome-house listening on http://${HOST}:${PORT}`);
  const seated = bootSeats();
  console.error(`[serve] mcpl seats: ${seated.length ? seated.join(", ") : "(none configured)"}`);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
function shutdown() {
  console.error("[serve] shutting down");
  stopSeats();
  server.close(() => process.exit(0));
}

export { server };
