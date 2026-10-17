// @ts-check
/* mcpl-web/test/lib/boot.mjs — one seat in-process over a PassThrough
 * pair (test/lib/wire.mjs's openWire plays the host), its board client
 * pointed at a fake board. Every test boots its own; nothing is shared. */
import { PassThrough } from "node:stream";
import { McplConnection } from "@animalabs/mcpl-core";
import { createBoardClient } from "../../src/board-client.mjs";
import { readConfig } from "../../src/config.mjs";
import { createServer } from "../../src/server.mjs";
import { TOKENS, waitFor } from "./fake-board.mjs";
import { openWire } from "./wire.mjs";

export const FULL_GRANT = [
  "tools",
  "pushEvents",
  "channels.register",
  "channels.lifecycle",
  "channels.publish",
  "channels.incoming",
  "channels.typing",
];

/** @param {{url: string}} board
 * @param {{token?: string, grant?: string[]|null, open?: string[], env?: Record<string, string>}} [opts]
 *   `grant: null` sends no featureSets/update at all */
export async function boot(board, { token = TOKENS.fable, grant = FULL_GRANT, open = [], env = {} } = {}) {
  const config = readConfig({
    WEB_BOARD_URL: board.url,
    WEB_BOARD_TOKEN: token,
    WEB_POLICY_GRACE_MS: "200",
    WEB_SEND_TIMEOUT_MS: "5000",
    WEB_RECONNECT_MIN_MS: "50",
    WEB_RECONNECT_MAX_MS: "200",
    ...env,
  });
  if (typeof config === "string") throw new Error(config);
  /** @type {string[]} */
  const logs = [];
  const log = (l) => logs.push(l);
  const client = createBoardClient({ ...config, log });
  const s2h = new PassThrough();
  const h2s = new PassThrough();
  const conn = McplConnection.fromStreams(h2s, s2h);
  const server = createServer({ conn, client, config, log });
  const wire = openWire({ readable: s2h, writable: h2s, requestTimeoutMs: 5000 });
  /** @type {{method: string, params: any}[]} */
  const inbound = [];
  /** @type {{method: string, params: any}[]} */
  const notes = [];
  /** @type {Map<string, any>} */
  const channels = new Map();
  wire.onRequest(async (method, params) => {
    inbound.push({ method, params });
    if (method === "push/event") return { accepted: true };
    if (method === "channels/incoming")
      return { results: params.messages.map((m) => ({ messageId: m.messageId, accepted: true })) };
    if (method === "channels/register" || method === "channels/changed") {
      const list = params.channels ?? params.added ?? [];
      for (const d of list) channels.set(d.id, d);
      return { results: list.map((d) => ({ id: d.id, accepted: true })) };
    }
    return undefined;
  });
  wire.onNotification((method, params) => notes.push({ method, params }));
  const started = server.start();
  const init = await wire.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { mcpl: { version: "0.5", featureSets: true } } },
    clientInfo: { name: "t", version: "0" },
  });
  wire.notify("notifications/initialized");
  const receipt = grant ? await wire.request("featureSets/update", { effectiveCapabilities: grant }) : null;
  await started;
  for (const id of open) {
    await waitFor(() => channels.has(id));
    await wire.request("channels/open", { channelId: id });
  }
  /** channels/incoming messages, flattened */
  const incoming = () => inbound.filter((r) => r.method === "channels/incoming").flatMap((r) => r.params.messages);
  const pushes = () => inbound.filter((r) => r.method === "push/event").map((r) => r.params);
  /** a tool call's parsed JSON result */
  const call = async (name, args) => {
    const r = /** @type {any} */ (await wire.request("tools/call", { name, arguments: args }));
    return JSON.parse(r.content[0].text);
  };
  return {
    server,
    client,
    wire,
    init,
    receipt,
    inbound,
    notes,
    channels,
    logs,
    incoming,
    pushes,
    call,
    async close() {
      server.stop();
      wire.close();
    },
  };
}
