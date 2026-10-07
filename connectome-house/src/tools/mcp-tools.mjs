// @ts-check
/* connectome-house/src/tools/mcp-tools.mjs — MCP servers by name, as the
 * fleet's MCPManager ran them: a global server list (the fleet's own
 * `mcp_servers` shape — name, transport stdio|streamable-http|sse, url or
 * command/args, headers/env with `${VAR}` resolved from this process's
 * env), and a testament's `mcp: [names]` granting every tool of those
 * servers, named `{server}__{tool}`.
 *
 * Servers live in HOUSE_MCP_SERVERS_FILE (default
 * /workspace/house-config/mcp-servers.json). Only servers some testament
 * names are connected — adding one means adding its entry there and its
 * name to a testament. A server that can't be reached (or whose `${VAR}`s
 * aren't set) is logged once and retried on a slow timer; its tools are
 * simply absent until it answers.
 *
 * The house holds the connections; a being's turn carries the tool
 * definitions it was granted (room-turn.mjs's covenantExcerpt), so the
 * walker can offer them without a connection of its own.
 */
import { existsSync, readFileSync } from "node:fs";
import { traceReach } from "../trace.mjs";

const SEP = "__";
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const RETRY_MS = 10 * 60 * 1000;

const serversFile = () => process.env.HOUSE_MCP_SERVERS_FILE ?? "/workspace/house-config/mcp-servers.json";

/** @returns {Record<string, any>[]} */
export function readServers(file = serversFile()) {
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(j) ? j : j?.mcp_servers;
    return Array.isArray(list) ? list.filter((s) => s && typeof s.name === "string") : [];
  } catch (e) {
    console.error(`[mcp] ${file} unreadable: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/** `${VAR}` → env; null when any named var is unset (the server is then
 * not connectable, rather than connected with an empty credential) */
export function resolveEnv(value, env = process.env) {
  let missing = false;
  const out = String(value).replace(/\$\{(\w+)\}/g, (_m, name) => {
    const v = env[name];
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

function resolveMap(map, env) {
  if (!map) return {};
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const r = resolveEnv(v, env);
    if (r === null) return null;
    out[k] = r;
  }
  return out;
}

/** every server name some testament's `mcp:` list names */
async function namedServers() {
  const { testaments } = await import("../testaments.mjs");
  const names = new Set();
  for (const t of Object.values(testaments())) for (const n of Array.isArray(t.covenant?.mcp) ? t.covenant.mcp : []) names.add(String(n));
  return names;
}

function formatContent(content, isError) {
  const parts = [];
  for (const c of content ?? []) {
    if (c.type === "text" && c.text) parts.push(c.text);
    else if (c.type === "image") parts.push(`[Image: ${c.mimeType ?? "unknown type"}]`);
    else if (c.type === "resource") parts.push(c.resource?.text ?? `[Resource: ${c.resource?.mimeType ?? c.mimeType ?? "unknown"}]`);
  }
  const joined = parts.join("\n") || "(no content returned)";
  return isError ? `Error: ${joined}` : joined;
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms).unref())]);

/** @param {{servers?: Record<string, any>[], env?: NodeJS.ProcessEnv, wanted?: () => Promise<Set<string>>}} [deps] */
export function makeMcpTools(deps = {}) {
  const env = deps.env ?? process.env;
  /** @type {Map<string, {config: any, client?: any, tools: any[], error?: string|null, connecting?: Promise<void>|null}>} */
  const servers = new Map();
  for (const cfg of deps.servers ?? readServers()) servers.set(cfg.name, { config: cfg, tools: [], error: null });
  /** the one flat list house-tools.mjs scans — kept in place, refilled as servers connect */
  const definitions = [];
  const rebuild = () => {
    definitions.length = 0;
    for (const [name, s] of servers)
      for (const t of s.tools)
        definitions.push({
          name: `${name}${SEP}${t.name}`,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
  };

  async function connect(name) {
    const s = servers.get(name);
    if (!s || s.client) return;
    const cfg = s.config;
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      let transport;
      if (cfg.transport === "stdio") {
        const extra = resolveMap(cfg.env, env);
        if (extra === null) throw new Error("an env var it names is unset");
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)), ...extra },
          ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
          stderr: "ignore",
        });
      } else {
        const url = resolveEnv(cfg.url ?? "", env);
        const headers = resolveMap(cfg.headers, env);
        if (!url || headers === null) throw new Error("its url or a header names an unset env var");
        const opts = { requestInit: { headers } };
        if (cfg.transport === "sse") {
          const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
          transport = new SSEClientTransport(new URL(url), opts);
        } else {
          const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
          transport = new StreamableHTTPClientTransport(new URL(url), opts);
        }
      }
      const client = new Client({ name: `connectome-house-${name}`, version: "1.0.0" });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to ${name}`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing ${name}'s tools`);
      s.client = client;
      // `exclude_tools`: names a server offers that this house withholds
      const exclude = new Set(Array.isArray(cfg.exclude_tools) ? cfg.exclude_tools : []);
      s.tools = (listed.tools ?? []).filter((t) => !exclude.has(t.name));
      s.error = null;
      client.onclose = () => {
        s.client = undefined;
        s.tools = [];
        rebuild();
      };
      rebuild();
      console.error(`[mcp] connected ${name}: ${s.tools.length} tool(s)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (s.error !== msg) console.error(`[mcp] ${name} not connected: ${msg}`);
      s.error = msg;
    }
  }

  /** connect (or retry) every configured server a testament names */
  async function connectNamed() {
    const wanted = await (deps.wanted ?? namedServers)();
    await Promise.all([...wanted].filter((n) => servers.has(n)).map((n) => connect(n)));
  }
  const ready = connectNamed();
  const retry = setInterval(() => void connectNamed(), RETRY_MS);
  retry.unref();

  let activeCtx = null;

  async function run(name, input) {
    const i = name.indexOf(SEP);
    const server = i > 0 ? name.slice(0, i) : "";
    const tool = i > 0 ? name.slice(i + SEP.length) : name;
    const s = servers.get(server);
    if (!s) return `not offered here: no MCP server "${server}"`;
    if (!s.client) return `not reachable right now: ${s.error ?? "not connected"}`;
    try {
      const r = await withTimeout(s.client.callTool({ name: tool, arguments: input ?? {} }), CALL_TIMEOUT_MS, `${name}`);
      return formatContent(r?.content, r?.isError);
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    definitions,
    ready,
    /** the definitions of every tool the named servers offer right now */
    definitionsFor(names) {
      const want = new Set((Array.isArray(names) ? names : []).map(String));
      return definitions.filter((d) => want.has(d.name.slice(0, d.name.indexOf(SEP))));
    },
    beginTurn(ctx) {
      activeCtx = ctx;
    },
    /** @param {{id: string, name: string, input: any}} call */
    execute(call) {
      return traceReach(activeCtx, call, async () => ({ content: await run(call.name, call.input) }));
    },
    async close() {
      clearInterval(retry);
      for (const s of servers.values()) await s.client?.close?.().catch(() => {});
    },
  };
}
