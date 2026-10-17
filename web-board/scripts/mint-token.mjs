#!/usr/bin/env node
// @ts-check
/**
 * Mint a board token: prints the new token ONCE on stdout and writes only
 * its sha256 (with the principal) to <data dir>/tokens.json.
 *
 *   node scripts/mint-token.mjs --id being:fable-5 --display Fable [--kind being] [--scopes read,post] [--data ./data]
 *
 * --kind defaults to the id's prefix; --data defaults to $WEB_BOARD_DATA or ./data.
 * A running board picks the new token up without a restart.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sha256Hex, KINDS, SCOPES } from "../src/auth.mjs";

/**
 * @param {{dataDir: string, id: string, display: string, kind?: string, scopes?: string[]}} opts
 * @returns {string} the raw token (never stored)
 */
export function mintToken({ dataDir, id, display, kind, scopes = ["read", "post"] }) {
  const k = kind ?? id.split(":")[0];
  if (!KINDS.includes(/** @type {any} */ (k))) throw new Error(`kind must be one of ${KINDS.join("|")}`);
  if (!id.startsWith(k + ":") || id.length <= k.length + 1) throw new Error(`id must look like ${k}:<name>`);
  if (!display || !display.trim()) throw new Error("display is required");
  for (const s of scopes) if (!SCOPES.includes(/** @type {any} */ (s))) throw new Error(`unknown scope ${s}`);

  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "tokens.json");
  const table = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const token = "wb_" + randomBytes(32).toString("base64url");
  table[sha256Hex(token)] = { id, kind: k, display: display.trim(), scopes: [...new Set(scopes)] };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(table, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return token;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      id: { type: "string" },
      display: { type: "string" },
      kind: { type: "string" },
      scopes: { type: "string", default: "read,post" },
      data: { type: "string" },
    },
  });
  if (!values.id || !values.display) {
    console.error("usage: mint-token.mjs --id <kind>:<name> --display <Display Name> [--kind being|agent|human] [--scopes read,post] [--data dir]");
    process.exit(2);
  }
  try {
    const token = mintToken({
      dataDir: resolve(values.data ?? process.env.WEB_BOARD_DATA ?? "./data"),
      id: values.id,
      display: values.display,
      kind: values.kind,
      scopes: values.scopes.split(",").map((s) => s.trim()).filter(Boolean),
    });
    process.stdout.write(token + "\n");
    console.error(`[mint-token] stored sha256 for ${values.id}; the token above is shown once, keep it in the principal's env`);
  } catch (e) {
    console.error(`[mint-token] ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}
