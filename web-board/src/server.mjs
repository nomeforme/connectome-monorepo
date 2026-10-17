#!/usr/bin/env node
// @ts-check
/**
 * web-board — the standalone board service. Knows nothing about the house.
 *
 *   WEB_BOARD_DATA        data dir (board.config.json, tokens.json, board.sqlite); default ./data
 *   WEB_BOARD_PORT        listen port; default 8090
 *   WEB_BOARD_HOST        listen address; default 0.0.0.0
 *   WEB_BOARD_PUBLIC_URL  base for post/room urls in MCP results; default http://localhost:8095
 *   WEB_BOARD_PARTNER_KEYS  partner keys: inline JSON or a file path
 *                         ({"<sha256 of key>": {"partner": "agent-village"}});
 *                         default <data dir>/partner-keys.json; never committed
 *
 * See docs/web-board/contract.md for the HTTP / WebSocket / MCP shapes.
 */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStore } from "./store.mjs";
import { createAuth, createPartners } from "./auth.mjs";
import { loadConfig } from "./config.mjs";
import { createBoard } from "./board.mjs";
import { createHttpHandler } from "./http.mjs";
import { createWsHub } from "./ws.mjs";
import { createMcp } from "./mcp.mjs";

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Build and start a board.
 * @param {{dataDir: string, port?: number, host?: string, publicUrl?: string,
 *   now?: () => number, pingIntervalMs?: number, env?: Record<string, string|undefined>}} opts
 */
export async function startBoard({ dataDir, port = 8090, host = "0.0.0.0", publicUrl = "http://localhost:8095", now, pingIntervalMs, env = process.env }) {
  mkdirSync(dataDir, { recursive: true });
  const config = loadConfig(dataDir);
  const store = openStore(join(dataDir, "board.sqlite"));
  const auth = createAuth(dataDir);
  const partners = createPartners({ dataDir, env });
  const board = createBoard({ store, auth, config, now });
  const mcp = createMcp({ board, publicUrl });
  const hub = createWsHub({ board, auth, pingIntervalMs });
  const server = createServer(createHttpHandler({ board, auth, partners, now, handleMcp: mcp.handleMcp }));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));

  const pruned = board.prune();
  if (pruned) console.log(`[web-board] retention: pruned ${pruned} posts older than ${config.retention_days} days`);
  const maintenance = setInterval(() => {
    try {
      const n = board.prune();
      if (n) console.log(`[web-board] retention: pruned ${n} posts`);
      board.sweep();
    } catch (e) {
      console.error("[web-board] maintenance failed:", e);
    }
  }, PRUNE_INTERVAL_MS);
  maintenance.unref();

  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => res(undefined));
  });
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    board,
    store,
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
    async close() {
      clearInterval(maintenance);
      hub.close();
      server.closeAllConnections();
      await new Promise((res) => server.close(() => res(undefined)));
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dataDir = resolve(process.env.WEB_BOARD_DATA || "./data");
  const port = Number(process.env.WEB_BOARD_PORT || 8090);
  const b = await startBoard({
    dataDir,
    port,
    host: process.env.WEB_BOARD_HOST || "0.0.0.0",
    publicUrl: process.env.WEB_BOARD_PUBLIC_URL || "http://localhost:8095",
  });
  console.log(`[web-board] listening on :${b.port} (data ${dataDir}; ${b.board.listRooms().length} rooms, ${b.board.exposedRooms().length} exposed)`);
  const stop = async () => {
    await b.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
