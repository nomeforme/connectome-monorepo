#!/usr/bin/env node
// @ts-check
/* mcpl-signal/src/index.mjs — the stdio entry: JSON-RPC on stdin/stdout,
 * one line per message; stderr is the log (the house tags and keeps it).
 * Exits 2 with the NAME of what is missing when the environment is
 * incomplete — never a value. */
import { McplConnection } from "@animalabs/mcpl-core";
import { readConfig } from "./config.mjs";
import { createServer } from "./server.mjs";
import { createSignalCli } from "./signal-cli.mjs";

const log = (line) => process.stderr.write(`[mcpl-signal] ${line}\n`);

const config = readConfig();
if (typeof config === "string") {
  log(config);
  process.exit(2);
}
const client = createSignalCli({
  baseUrl: config.baseUrl,
  wsUrl: config.wsUrl,
  number: config.number,
  log,
});
const conn = McplConnection.fromStreams(process.stdin, process.stdout);
const server = createServer({ conn, client, config, log, exit: (code) => process.exit(code) });
server.start().catch((e) => {
  log(`start failed: ${e.message}`);
  process.exit(1);
});
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
