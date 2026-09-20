// @ts-check
/* connectome-house/src/tools/kohya-tools.mjs — the fleet's
 * `kohya-lora-training` MCP surface (bot-runtime.ts's MCPManager, a
 * streamable-http server named by KOHYA_MCP_URL; tool names opaque —
 * external service, learned at connect, `{server}__{tool}` prefixed to
 * avoid collisions, connectome-grpc-common/src/mcp/mcp-manager.ts).
 * Ported as a thin hand-rolled JSON-RPC client over plain `fetch` — no
 * @modelcontextprotocol/sdk dependency, since connectome-house does not
 * carry one (package.json is out of this round's owned files) and the
 * streamable-http wire shape is plain JSON-RPC 2.0 over POST.
 */
import { traceReach } from "../trace.mjs";

const PREFIX = "kohya-lora-training__";
const PROTOCOL_VERSION = "2024-11-05";

/** one JSON-RPC round trip; `expectResponse: false` for a fire-and-forget
 * notification (no id, no reply expected). Tolerates a plain JSON body or
 * an SSE-framed one (`data: {...}` lines) — the two shapes streamable-http
 * transports may answer with. */
async function sendRpc(url, sessionId, payload, { expectResponse = true } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const newSession = res.headers.get("mcp-session-id") ?? sessionId ?? null;
  if (!expectResponse) return { sessionId: newSession };
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let body = null;
  if (ct.includes("text/event-stream")) {
    for (const line of text.split("\n"))
      if (line.startsWith("data:")) {
        try {
          body = JSON.parse(line.slice(5).trim());
        } catch {
          /* keep the last line that DID parse */
        }
      }
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* an unparseable body reads as no result below */
    }
  }
  return { body, sessionId: newSession };
}

function formatContent(content, isError) {
  const parts = [];
  for (const c of content ?? []) {
    if (c.type === "text" && c.text) parts.push(c.text);
    else if (c.type === "image") parts.push(`[Image: ${c.mimeType ?? "unknown type"}]`);
    else if (c.type === "resource") parts.push(`[Resource: ${c.mimeType ?? "unknown"}]`);
  }
  const joined = parts.join("\n") || "(no content returned)";
  return isError ? `Error: ${joined}` : joined;
}

/** @param {{}} [_deps] KOHYA_MCP_URL is read once at mount time (an MCP
 * connection, unlike an HTTP call, is a session worth keeping open). */
export function makeKohyaTools(_deps = {}) {
  const url = process.env.KOHYA_MCP_URL || null;
  let nextId = 1;
  let state = { connected: false, sessionId: null, error: url ? null : "KOHYA_MCP_URL" };
  const definitions = [];

  async function connect() {
    if (!url) return;
    try {
      const init = await sendRpc(url, null, {
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "connectome-house", version: "0.1.0" } },
      });
      if (init.body?.error) throw new Error(init.body.error.message || "initialize failed");
      const sessionId = init.sessionId;
      await sendRpc(url, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }, { expectResponse: false });
      const list = await sendRpc(url, sessionId, { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} });
      if (list.body?.error) throw new Error(list.body.error.message || "tools/list failed");
      const tools = list.body?.result?.tools ?? [];
      definitions.length = 0;
      for (const t of tools)
        definitions.push({ name: `${PREFIX}${t.name}`, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object", properties: {} } });
      state = { connected: true, sessionId, error: null };
    } catch (e) {
      state = { connected: false, sessionId: null, error: e.message };
    }
  }

  // fired at mount; tests await `ready` before asserting on `definitions`.
  const ready = connect();

  let activeCtx = null;
  const beginTurn = (ctx) => {
    activeCtx = ctx;
  };

  async function run(name, input) {
    if (!url) return "not configured here: KOHYA_MCP_URL";
    if (!state.connected) return `not reachable right now: ${state.error ?? "not connected"}`;
    const real = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
    try {
      const call = await sendRpc(url, state.sessionId, {
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: real, arguments: input ?? {} },
      });
      if (call.body?.error) return `Error: ${call.body.error.message}`;
      const result = call.body?.result;
      return result ? formatContent(result.content, result.isError) : "(no content returned)";
    } catch (e) {
      return `not reachable right now: ${e.message}`;
    }
  }

  function execute(call) {
    return traceReach(activeCtx, call, async () => ({ content: await run(call.name, call.input) }));
  }

  return { definitions, execute, beginTurn, ready };
}
