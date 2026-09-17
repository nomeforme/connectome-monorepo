#!/usr/bin/env node
/* harness/test/lib/mock-mcpl-server.mjs — a stdio MCPL 0.5 server that
 * speaks exactly what the house's seat consumes and nothing real: the
 * shapes are docs/research/mcpl.md §3.4/§5's, the platform is `mock`.
 * No dependency (plain NDJSON JSON-RPC), so a wire bug and a mock bug can
 * never be the same bug.
 *
 *   node mock-mcpl-server.mjs <fixture.json> <record.jsonl>
 *
 * fixture.json: { channels: [descriptor…], history: {<channelId>: [msg…]},
 *   script: [ {after_ms, push: {…push/event params}} |
 *             {after_ms, incoming: {…one channels/incoming message}} |
 *             {after_ms, crash: true} ],
 *   manifest_form?: "object"|"array", refuse_grant?: true,
 *   no_tools?: true (initialize advertises no `tools` capability — the
 *   host's grant then lacks `tools` and every tools/call is refused
 *   host-side), revision_salt?: string, toolResults?: {<name>: <plain
 *   object, returned as tools/call's JSON text content for that name>} }
 * Every server→host push is a Request; its result is recorded. Every
 * tools/call, featureSets/update, channels/open|close|typing the host
 * sends is appended to record.jsonl as {t, kind, …} for a test to read.
 * `shutdown` (notification) ends the process; a scripted `crash` exits 3
 * mid-stream so the seat's restart path is exercised. */
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [fixturePath, recordPath] = process.argv.slice(2);
// `node --test` runs every file under test/ — including this one, with no
// argv and a stdin nobody closes; a server nobody spawned exits at once.
if (!fixturePath || process.env.NODE_TEST_CONTEXT) process.exit(0);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const record = (row) => {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify({ t: Date.now(), ...row })}\n`);
};
const write = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

let nextId = 1;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    write({ id, method, params });
  });

const FEATURE_SET = {
  name: "mock.messaging",
  description: "the mock platform's one feature set",
  uses: [
    "tools",
    "pushEvents",
    "channels.register",
    "channels.incoming",
    "channels.publish",
    "channels.lifecycle",
    "channels.typing",
  ],
};
const featureSets =
  fixture.manifest_form === "array"
    ? [FEATURE_SET]
    : { [FEATURE_SET.name]: { description: FEATURE_SET.description, uses: FEATURE_SET.uses } };
// `fixture.manifest` replaces the whole experimental.mcpl object outright —
// a real server's own shape (e.g. discord-mcpl's legacy array-form feature
// sets with a tagOntology, docs/research/mcpl.md §3.3) rather than the mock
// platform's single synthetic set. `fixture.serverInfo`/`fixture.tools`
// override the other two initialize/tools.list fields the same way; all
// three default to the mock platform's own shapes when absent, so every
// fixture that predates this stays byte-identical.
const manifest = fixture.manifest ?? {
  version: fixture.manifest_form === "array" ? "0.4" : "0.5",
  pushEvents: true,
  inferenceLifecycle: true,
  channels: { register: true, publish: true, incoming: true, lifecycle: true, typing: true },
  featureSets,
  ...(fixture.revision_salt ? { salt: fixture.revision_salt } : {}),
};
const serverInfo = fixture.serverInfo ?? { name: "mock-mcpl", version: "0" };

/** every declared feature set, as `{name, uses}` regardless of the legacy
 * ARRAY form or the 0.5 Record-keyed-by-name form (SPEC §5.3) — the
 * `featureSets/update` handler checks `uses` against the grant for each
 * one, not just the mock platform's single hardcoded set. */
function declaredFeatureSets() {
  if (Array.isArray(manifest.featureSets))
    return manifest.featureSets.map((f) => ({ name: f.name, uses: f.uses ?? [] }));
  if (manifest.featureSets && typeof manifest.featureSets === "object")
    return Object.entries(manifest.featureSets).map(([name, f]) => ({ name, uses: f?.uses ?? [] }));
  return [];
}

const DEFAULT_TOOLS = [
  {
    name: "send_message",
    description: "send a message to a channel",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" }, content: { type: "string" } },
      required: ["channelId"],
    },
  },
  {
    name: "reply_message",
    description: "reply to a message in a channel",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        messageId: { type: "string" },
        content: { type: "string" },
      },
      required: ["channelId", "messageId"],
    },
  },
];
const TOOLS = fixture.tools ?? DEFAULT_TOOLS;

let policyReady = false;
let sentCount = 0;
const openChannels = new Set();
const timers = [];

function scheduleScript() {
  for (const step of fixture.script ?? []) {
    const t = setTimeout(async () => {
      if (step.crash) {
        record({ kind: "crash" });
        process.exit(3);
      }
      if (step.push) {
        const result = await request("push/event", step.push).catch((e) => ({ error: e.message }));
        record({ kind: "push/event.result", eventId: step.push.eventId, result });
      }
      if (step.incoming) {
        const t0 = Date.now();
        const result = await request("channels/incoming", { messages: [step.incoming] }).catch(
          (e) => ({ error: e.message }),
        );
        // ms: the host's answer time — a real server gives up at 30 s
        record({
          kind: "channels/incoming.result",
          messageId: step.incoming.messageId,
          result,
          ms: Date.now() - t0,
        });
      }
    }, step.after_ms ?? 0);
    timers.push(t);
  }
}

async function afterPolicy() {
  const channels = fixture.channels ?? [];
  const result = await request("channels/register", { channels }).catch((e) => ({
    error: e.message,
  }));
  record({ kind: "channels/register.result", result });
  scheduleScript();
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return write({
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            ...(fixture.no_tools ? {} : { tools: {} }),
            experimental: { mcpl: manifest },
          },
          serverInfo,
        },
      });
    case "featureSets/update": {
      record({ kind: "featureSets/update", params });
      if (fixture.refuse_grant) {
        return write({
          id,
          result: { accepted: false, fallback: "mcp-only", reason: "scripted refusal" },
        });
      }
      const granted = new Set(params?.effectiveCapabilities ?? []);
      const unavailableFeatures = declaredFeatureSets()
        .map((fs) => ({ featureSet: fs.name, missingCapabilities: fs.uses.filter((u) => !granted.has(u)) }))
        .filter((u) => u.missingCapabilities.length)
        .map((u) => ({ ...u, effect: "degraded" }));
      const missing = unavailableFeatures.length > 0;
      write({
        id,
        result: {
          accepted: true,
          ...(missing ? { mode: "degraded" } : {}),
          unavailableFeatures,
          notes: [],
        },
      });
      if (!policyReady) {
        policyReady = true;
        void afterPolicy();
      }
      return;
    }
    case "tools/list":
      return write({ id, result: { tools: TOOLS } });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      record({ kind: "tools/call", name, arguments: args });
      if (name === "send_message" || name === "reply_message") {
        sentCount += 1;
        const messageId = `m${sentCount}`;
        return write({
          id,
          result: { content: [{ type: "text", text: JSON.stringify({ messageId }) }] },
        });
      }
      // any other tool a fixture names a canned result for (a being's own
      // platform tools, platform-reach R2d gap 1) — additive, so every
      // fixture that predates this stays byte-identical.
      if (fixture.toolResults && Object.hasOwn(fixture.toolResults, name)) {
        return write({
          id,
          result: { content: [{ type: "text", text: JSON.stringify(fixture.toolResults[name]) }] },
        });
      }
      return write({ id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
    case "channels/open": {
      const channelId = params?.channelId;
      const desc = (fixture.channels ?? []).find((c) => c.id === channelId);
      record({ kind: "channels/open", params });
      if (!desc) return write({ id, error: { code: -32023, message: "unknown channel" } });
      openChannels.add(channelId);
      const limit = params?.history?.limit ?? 0;
      const history = limit > 0 ? (fixture.history?.[channelId] ?? []).slice(-limit) : undefined;
      return write({
        id,
        result: {
          channel: desc,
          ...(history ? { history, historyTruncated: false } : {}),
        },
      });
    }
    case "channels/close":
      record({ kind: "channels/close", params });
      openChannels.delete(params?.channelId);
      return write({ id, result: { closed: true } });
    case "channels/publish": {
      record({ kind: "channels/publish", params });
      sentCount += 1;
      return write({ id, result: { delivered: true, messageId: `m${sentCount}` } });
    }
    case "channels/typing":
      record({ kind: "channels/typing", params });
      return write({ id, result: {} });
    default:
      return write({ id, error: { code: -32601, message: `unsupported: ${method}` } });
  }
}

function handleNotification(msg) {
  const { method, params } = msg;
  if (method === "notifications/initialized") return;
  if (method === "channels/typing") return record({ kind: "channels/typing", params });
  if (method === "inference/lifecycle") return record({ kind: "inference/lifecycle", params });
  if (method === "shutdown") {
    record({ kind: "shutdown" });
    for (const t of timers) clearTimeout(t);
    process.exit(0);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && ("result" in msg || "error" in msg)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
    return;
  }
  if (msg.id != null && typeof msg.method === "string") {
    void handleRequest(msg).catch((e) =>
      write({ id: msg.id, error: { code: -32603, message: e.message } }),
    );
    return;
  }
  if (typeof msg.method === "string") handleNotification(msg);
});
rl.on("close", () => process.exit(0));
