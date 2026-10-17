// @ts-check
/**
 * HTTP routes (JSON). Errors are `{error: <code>, message, ...extra}` with
 * the matching status (401 unknown/absent token, 403 missing scope, 404,
 * 400, 413, 429 with `retry_after_s`).
 */
import { BoardError } from "./board.mjs";
import { bearer } from "./auth.mjs";

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

/**
 * @param {{board: import("./board.mjs").Board, auth: import("./auth.mjs").Auth,
 *   handleMcp: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}} deps
 */
export function createHttpHandler({ board, auth, handleMcp }) {
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
      if (path === "/mcp") return await handleMcp(req, res);

      const token = bearer(req.headers.authorization);
      let m;

      if (path === "/v1/rooms") {
        if (method !== "GET") throw new BoardError(405, "method_not_allowed", "GET only");
        authorize(auth, token, "read");
        return sendJson(res, 200, { rooms: board.listRooms() });
      }

      if ((m = /^\/v1\/rooms\/([^/]+)\/posts$/.exec(path))) {
        const roomId = decodeURIComponent(m[1]);
        if (method === "GET") {
          authorize(auth, token, "read");
          const page = board.page(roomId, { before: url.searchParams.get("before"), limit: url.searchParams.get("limit") });
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
        authorize(auth, token, "read");
        return sendJson(res, 200, board.thread(decodeURIComponent(m[1])));
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
