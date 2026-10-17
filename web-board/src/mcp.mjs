// @ts-check
/**
 * The public read MCP at POST /mcp: Streamable HTTP, stateless (a fresh
 * server + transport per request), no auth, read-only. It serves ONLY the
 * rooms in board.config.json `expose`; any other room or post is "not
 * found". Exactly four tools, with exact JSON input schemas
 * (additionalProperties: false) enforced here — the low-level SDK Server
 * does not validate arguments itself.
 *
 * A post is rendered as {id, room, author_display, author_kind, text,
 * reply_to, created_at, url}: no principal ids, no mentions (those are
 * principal ids), no tokens. Each result is two text blocks: the JSON
 * payload, then the source line `Source: <board>, <room title>, <url>`.
 * Results are capped at 200 KB by dropping list items (never cutting a
 * post), with `truncated: true` and a note.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { BoardError } from "./board.mjs";
import { readJson, sendJson } from "./http.mjs";

export const MAX_RESULT_BYTES = 200 * 1024;
const MAX_MCP_BODY = 256 * 1024;

export const TOOLS = Object.freeze([
  {
    name: "list_rooms",
    description: "List the public rooms of the board, with each room's latest post time and post count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_posts",
    description: "List posts in a public room, oldest first within the page. Page back with `before` (a post id; use next_before from the previous page).",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room id, e.g. web:commons:general" },
        before: { type: "string", description: "Only posts older than this post id" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["room"],
      additionalProperties: false,
    },
  },
  {
    name: "get_thread",
    description: "Get the thread a post belongs to: its top-level post and every reply, oldest first.",
    inputSchema: {
      type: "object",
      properties: { post_id: { type: "string" } },
      required: ["post_id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_posts",
    description: "Search posts in the public rooms by text (case-insensitive substring), newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200 },
        room: { type: "string", description: "Limit to one room id" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
]);

/**
 * Minimal validator for the four schemas above (object, string, integer,
 * required, additionalProperties:false, min/max, minLength/maxLength).
 * @param {any} schema @param {unknown} args @returns {string|null} error or null
 */
export function validateArgs(schema, args) {
  const a = args === undefined ? {} : args;
  if (!a || typeof a !== "object" || Array.isArray(a)) return "arguments must be an object";
  const obj = /** @type {Record<string, unknown>} */ (a);
  for (const k of Object.keys(obj)) if (!(k in schema.properties)) return `unexpected argument "${k}"`;
  for (const k of schema.required ?? []) if (obj[k] === undefined) return `missing required argument "${k}"`;
  for (const [k, s] of Object.entries(/** @type {Record<string, any>} */ (schema.properties))) {
    const v = obj[k];
    if (v === undefined) continue;
    if (s.type === "string") {
      if (typeof v !== "string") return `"${k}" must be a string`;
      if (s.minLength !== undefined && [...v].length < s.minLength) return `"${k}" must be at least ${s.minLength} chars`;
      if (s.maxLength !== undefined && [...v].length > s.maxLength) return `"${k}" must be at most ${s.maxLength} chars`;
    } else if (s.type === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) return `"${k}" must be an integer`;
      if (s.minimum !== undefined && v < s.minimum) return `"${k}" must be >= ${s.minimum}`;
      if (s.maximum !== undefined && v > s.maximum) return `"${k}" must be <= ${s.maximum}`;
    }
  }
  return null;
}

/** @param {string} base @param {string} roomId */
export function roomUrl(base, roomId) {
  return `${base}/rooms/${encodeURIComponent(roomId).replace(/%3A/gi, ":")}`;
}
/** @param {string} base @param {string} postId */
export function postUrl(base, postId) {
  return `${base}/posts/${encodeURIComponent(postId)}`;
}

/**
 * @param {{board: import("./board.mjs").Board, publicUrl: string}} deps
 */
export function createMcp({ board, publicUrl }) {
  const base = publicUrl.replace(/\/+$/, "");
  const boardName = board.config.board_name;

  /** @param {import("./store.mjs").Post} p */
  const view = (p) => ({
    id: p.id,
    room: p.room,
    author_display: p.author.display,
    author_kind: p.author.kind,
    text: p.text,
    reply_to: p.reply_to,
    created_at: p.created_at,
    url: postUrl(base, p.id),
  });

  /** @param {string} title @param {string} url */
  const sourceLine = (title, url) => `Source: ${boardName}, ${title}, ${url}`;

  /** @param {unknown} payload @param {string} source */
  const content = (payload, source) => [
    { type: "text", text: JSON.stringify(payload, null, 1) },
    { type: "text", text: source },
  ];

  /**
   * Build the result, dropping items from `payload[key]` until it fits.
   * @param {Record<string, any>} payload @param {string} key @param {"front"|"back"} dropFrom
   * @param {string} source @param {(p: Record<string, any>) => void} [onTruncate]
   */
  function capped(payload, key, dropFrom, source, onTruncate) {
    const total = payload[key].length;
    let c = content(payload, source);
    while (Buffer.byteLength(JSON.stringify(c)) > MAX_RESULT_BYTES - 1024 && payload[key].length) {
      // drop ~10% (at least one) per pass; a post is ≤ 8000 chars so this converges fast
      const n = Math.max(1, Math.floor(payload[key].length / 10));
      payload[key] = dropFrom === "front" ? payload[key].slice(n) : payload[key].slice(0, -n);
      payload.truncated = true;
      payload.note = `${key} truncated to ${payload[key].length} of ${total} items to fit the ${MAX_RESULT_BYTES / 1024} KB response cap`;
      onTruncate?.(payload);
      c = content(payload, source);
    }
    return { content: c };
  }

  const notFound = () => ({ content: [{ type: "text", text: "not found" }], isError: true });

  /** @param {string} name @param {any} args */
  function callTool(name, args) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${name}`);
    const err = validateArgs(tool.inputSchema, args);
    if (err) return { content: [{ type: "text", text: `invalid arguments: ${err}` }], isError: true };
    const a = args ?? {};
    const allRooms = sourceLine("all rooms", `${base}/rooms`);

    switch (name) {
      case "list_rooms": {
        const rooms = board.exposedRooms().map((r) => ({
          id: r.id, title: r.title, ...board.roomStats(r.id), url: roomUrl(base, r.id),
        }));
        return capped({ rooms }, "rooms", "back", allRooms);
      }
      case "list_posts": {
        if (!board.isExposed(a.room)) return notFound();
        const room = /** @type {import("./store.mjs").Room} */ (board.getRoom(a.room));
        const page = board.page(a.room, { before: a.before, limit: a.limit ?? 20 }, 50);
        const payload = {
          room: { id: room.id, title: room.title, url: roomUrl(base, room.id) },
          posts: page.posts.map(view),
          next_before: page.next_before,
        };
        return capped(payload, "posts", "front", sourceLine(room.title, roomUrl(base, room.id)), (p) => {
          if (p.posts.length) p.next_before = p.posts[0].id;
        });
      }
      case "get_thread": {
        let t;
        try {
          t = board.thread(a.post_id);
        } catch (e) {
          if (e instanceof BoardError && e.status === 404) return notFound();
          throw e;
        }
        if (!board.isExposed(t.root.room)) return notFound();
        const room = /** @type {import("./store.mjs").Room} */ (board.getRoom(t.root.room));
        const payload = { room: { id: room.id, title: room.title }, root: view(t.root), replies: t.replies.map(view) };
        return capped(payload, "replies", "back", sourceLine(room.title, postUrl(base, t.root.id)));
      }
      case "search_posts": {
        const exposed = board.exposedRooms().map((r) => r.id);
        if (a.room !== undefined && !exposed.includes(a.room)) return notFound();
        const posts = board.search({ q: a.query, room: a.room, limit: a.limit ?? 10 }, exposed);
        const room = a.room ? board.getRoom(a.room) : null;
        const source = room ? sourceLine(room.title, roomUrl(base, room.id)) : allRooms;
        return capped({ query: a.query, posts: posts.map(view) }, "posts", "back", source);
      }
    }
    throw new McpError(ErrorCode.InvalidParams, `unknown tool ${name}`);
  }

  function buildServer() {
    const server = new Server({ name: "web-board", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      try {
        return /** @type {any} */ (callTool(req.params.name, req.params.arguments));
      } catch (e) {
        if (e instanceof McpError) throw e;
        if (e instanceof BoardError) return { content: [{ type: "text", text: e.status === 404 ? "not found" : e.message }], isError: true };
        console.error("[web-board] mcp tool error:", e);
        return { content: [{ type: "text", text: "internal error" }], isError: true };
      }
    });
    return server;
  }

  /**
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
   */
  async function handleMcp(req, res) {
    if (req.method !== "POST") {
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless: POST only)" }, id: null });
    }
    let body;
    try {
      body = await readJson(req, MAX_MCP_BODY);
    } catch (e) {
      const status = e instanceof BoardError ? e.status : 400;
      return sendJson(res, status, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return { handleMcp, callTool };
}
