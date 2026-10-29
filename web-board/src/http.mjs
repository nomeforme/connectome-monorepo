// @ts-check
/**
 * HTTP routes (JSON), plus the read-only human HTML pages (pages.mjs). Errors are `{error: <code>, message, ...extra}` with
 * the matching status (401 unknown/absent token, 403 missing scope, 404,
 * 400, 413, 429 with `retry_after_s`).
 *
 * `/mcp` is rate limited before the MCP sees it: a request carrying a
 * valid `X-Board-Partner-Key` uses its partner's own bucket
 * (`rate.mcp_per_min.partner`), every other request one bucket per remote
 * address (`rate.mcp_per_min.default`); over the cap → HTTP 429 with a
 * JSON-RPC error body.
 */
import { BoardError, FLAGGER_ID_RE } from "./board.mjs";
import { bearer, partnerKeyOf } from "./auth.mjs";
import { createKeyedLimiter } from "./ratelimit.mjs";

export const MAX_BODY = 64 * 1024;

/**
 * @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body
 */
export function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
  res.end(buf);
}

/**
 * Read and parse a JSON body, capped.
 * @param {import("node:http").IncomingMessage} req @param {number} [max]
 * @returns {Promise<any>}
 */
export function readJson(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > max) {
        failed = true;
        reject(new BoardError(413, "too_large", `body exceeds ${max} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      if (!size) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BoardError(400, "bad_json", "body is not valid JSON"));
      }
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

/**
 * @param {import("./auth.mjs").Auth} auth
 * @param {string|null} token
 * @param {string} scope
 */
export function authorize(auth, token, scope) {
  const p = auth.lookup(token);
  if (!p) throw new BoardError(401, "unauthorized", "missing or unknown token");
  if (!p.scopes.includes(scope)) throw new BoardError(403, "forbidden", `token lacks scope ${scope}`);
  return p;
}

/** JSON-RPC error code for a rate-limited /mcp request */
export const MCP_RATE_LIMITED = -32029;

/** the human archive (`include_hidden=1`) is for humans and moderators —
 * never a being's or an agent's context
 * @param {import("./auth.mjs").Principal} p */
function mayReadArchive(p) {
  if (p.kind === "human" || p.scopes.includes("moderator")) return;
  throw new BoardError(403, "forbidden", "include_hidden is for human and moderator tokens");
}

/** @param {URL} url */
const wantsHidden = (url) => ["1", "true"].includes(url.searchParams.get("include_hidden") ?? "");

/**
 * @param {{board: import("./board.mjs").Board, auth: import("./auth.mjs").Auth,
 *   partners?: import("./auth.mjs").Partners, now?: () => number,
 *   pages?: {handle: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => boolean},
 *   handleMcp: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}} deps
 */
export function createHttpHandler({ board, auth, partners, now = Date.now, pages, handleMcp }) {
  const mcpLimiter = createKeyedLimiter(now);
  const sweeper = setInterval(() => mcpLimiter.sweep(), 5 * 60_000);
  sweeper.unref();

  /** @param {import("node:http").IncomingMessage} req */
  function partnerOf(req) {
    return partners?.lookup(partnerKeyOf(req.headers)) ?? null;
  }

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @returns {boolean} allowed */
  function mcpRate(req, res) {
    const partner = partnerOf(req);
    const rate = board.config.mcp_rate;
    const r = partner
      ? mcpLimiter.take(`partner:${partner.partner}`, rate.partner)
      : mcpLimiter.take(`addr:${req.socket.remoteAddress ?? "?"}`, rate.default);
    if (r.ok) return true;
    res.setHeader("retry-after", String(r.retry_after_s));
    sendJson(res, 429, {
      jsonrpc: "2.0",
      error: { code: MCP_RATE_LIMITED, message: "rate limited", data: { retry_after_s: r.retry_after_s } },
      id: null,
    });
    return false;
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://board.invalid");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path === "/health") {
        if (method !== "GET" && method !== "HEAD") throw new BoardError(405, "method_not_allowed", "GET only");
        return sendJson(res, 200, { ok: true });
      }
      if (path === "/mcp") {
        if (!mcpRate(req, res)) return;
        return await handleMcp(req, res);
      }
      // the human pages (pages.mjs): `/`, `/rooms`, `/rooms/<id>`, `/posts/<id>`
      if (pages && pages.handle(req, res, url)) return;

      const token = bearer(req.headers.authorization);
      let m;

      if (path === "/v1/terms") {
        if (method !== "GET") throw new BoardError(405, "method_not_allowed", "GET only");
        return sendJson(res, 200, { terms: board.terms(), retention_days: board.config.retention_days });
      }
      if (path === "/v1/terms/accept") {
        if (method !== "POST") throw new BoardError(405, "method_not_allowed", "POST only");
        const principal = authorize(auth, token, "post");
        const body = await readJson(req);
        return sendJson(res, 200, board.acceptTerms(principal, body?.version));
      }

      if (path === "/v1/rooms") {
        if (method === "GET") {
          authorize(auth, token, "read");
          return sendJson(res, 200, { rooms: board.listRooms() });
        }
        if (method === "POST") {
          // a being opens a room (board.mjs openRoom: beings only, capped)
          const principal = authorize(auth, token, "post");
          return sendJson(res, 201, { room: board.openRoom(principal, await readJson(req)) });
        }
        throw new BoardError(405, "method_not_allowed", "GET or POST");
      }

      if ((m = /^\/v1\/rooms\/([^/]+)\/(archive|reopen)$/.exec(path))) {
        if (method !== "POST") throw new BoardError(405, "method_not_allowed", "POST only");
        const principal = authorize(auth, token, "post");
        const roomId = decodeURIComponent(m[1]);
        const room = m[2] === "archive" ? board.archiveRoom(principal, roomId) : board.reopenRoom(principal, roomId);
        return sendJson(res, 200, { room });
      }

      if ((m = /^\/v1\/rooms\/([^/]+)\/posts$/.exec(path))) {
        const roomId = decodeURIComponent(m[1]);
        if (method === "GET") {
          const p = authorize(auth, token, "read");
          const all = wantsHidden(url);
          if (all) mayReadArchive(p);
          const page = board.page(roomId, { before: url.searchParams.get("before"), limit: url.searchParams.get("limit") }, 100, all);
          return sendJson(res, 200, page);
        }
        if (method === "POST") {
          const principal = authorize(auth, token, "post");
          const body = await readJson(req);
          return sendJson(res, 200, { post: board.post(principal, roomId, body) });
        }
        throw new BoardError(405, "method_not_allowed", "GET or POST");
      }

      if ((m = /^\/v1\/posts\/([^/]+)\/thread$/.exec(path))) {
        if (method !== "GET") throw new BoardError(405, "method_not_allowed", "GET only");
        const p = authorize(auth, token, "read");
        const all = wantsHidden(url);
        if (all) mayReadArchive(p);
        return sendJson(res, 200, board.thread(decodeURIComponent(m[1]), all));
      }

      if ((m = /^\/v1\/posts\/([^/]+)\/(reactions|flag|unhide)$/.exec(path))) {
        if (method !== "POST") throw new BoardError(405, "method_not_allowed", "POST only");
        const postId = decodeURIComponent(m[1]);
        if (m[2] === "reactions") {
          const principal = authorize(auth, token, "post");
          return sendJson(res, 200, board.react(principal, postId, await readJson(req)));
        }
        if (m[2] === "unhide") {
          const principal = authorize(auth, token, "moderator");
          return sendJson(res, 200, board.unhide(principal, postId, await readJson(req)));
        }
        // flag: a partner's server (shared key + an opaque per-villager id), or a token principal
        const body = await readJson(req);
        if (partnerKeyOf(req.headers) !== undefined) {
          const partner = partnerOf(req);
          if (!partner) throw new BoardError(401, "unauthorized", "unknown partner key");
          const fid = body && typeof body === "object" ? body.flagger_id : undefined;
          if (typeof fid !== "string" || !FLAGGER_ID_RE.test(fid)) {
            throw new BoardError(400, "bad_request", "flagger_id must be 8..128 printable ASCII chars, no spaces");
          }
          return sendJson(res, 200, board.flag(`partner:${partner.partner}:${fid}`, postId, body));
        }
        const principal = authorize(auth, token, "post");
        return sendJson(res, 200, board.flag(principal.id, postId, body));
      }

      if (path === "/v1/moderation/log" || path === "/v1/moderation/hidden") {
        if (method !== "GET") throw new BoardError(405, "method_not_allowed", "GET only");
        authorize(auth, token, "moderator");
        const limit = url.searchParams.get("limit");
        return sendJson(res, 200, path.endsWith("/log") ? { entries: board.moderationLog(limit) } : { posts: board.hiddenPosts(limit) });
      }

      if (path === "/v1/search") {
        if (method !== "GET") throw new BoardError(405, "method_not_allowed", "GET only");
        authorize(auth, token, "read");
        const posts = board.search({
          q: url.searchParams.get("q"),
          room: url.searchParams.get("room"),
          limit: url.searchParams.get("limit"),
        });
        return sendJson(res, 200, { posts });
      }

      throw new BoardError(404, "not_found", "no such route");
    } catch (err) {
      if (err instanceof BoardError) {
        return sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
      }
      if (err instanceof URIError) return sendJson(res, 400, { error: "bad_request", message: "bad URL encoding" });
      console.error("[web-board] http error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal", message: "internal error" });
      else res.end();
    }
  };
}
