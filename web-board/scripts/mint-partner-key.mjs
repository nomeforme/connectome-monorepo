#!/usr/bin/env node
// @ts-check
/**
 * Mint a partner key (the `X-Agent-Village-Key` a partner's server sends):
 * prints the new key ONCE on stdout and writes only its sha256 (with the
 * partner name) to <data dir>/partner-keys.json. The board reads partner
 * keys at start — restart it after minting.
 *
 *   node scripts/mint-partner-key.mjs --partner agent-village [--data ./data]
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sha256Hex } from "../src/auth.mjs";

/** @param {{dataDir: string, partner: string}} opts @returns {string} the raw key (never stored) */
export function mintPartnerKey({ dataDir, partner }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(partner)) throw new Error("partner must be a lowercase slug");
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "partner-keys.json");
  const table = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const key = "wbp_" + randomBytes(32).toString("base64url");
  table[sha256Hex(key)] = { partner };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(table, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return key;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { partner: { type: "string" }, data: { type: "string" } } });
  if (!values.partner) {
    console.error("usage: mint-partner-key.mjs --partner <slug> [--data dir]");
    process.exit(2);
  }
  try {
    process.stdout.write(mintPartnerKey({ dataDir: resolve(values.data ?? process.env.WEB_BOARD_DATA ?? "./data"), partner: values.partner }) + "\n");
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(1);
  }
}
