// @ts-check
/* harness/src/link-codes.mjs — one-time codes a signed-in app user mints to
 * prove a platform DM is theirs: `<PRIVATE_DIR>/link-codes.json` —
 *   { version: 1, entries: { "<platform>:<code_sha256>": {
 *       handle, platform, created, expires, used } } }
 * — gitignored with the rest of harness/private/. The code itself is never
 * stored (sha256 only, same posture as app/viz/tools/accounts.mjs's reset
 * codes) and never logged; `mintLinkCode` hands it to its caller exactly
 * once. `redeemLinkCode` is the seat's one road in — nothing else reads
 * this file. Single-use: `used` flips true on the first successful
 * redemption and a refused redemption (already linked elsewhere) never
 * marks it, so the code still works once the sender fixes that. */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJSONSync } from "./atomic-write.mjs";
import { PRIVATE_DIR } from "./serve-paths.mjs";

/** ~10 minutes, per the keeper's ask. */
export const TTL_MS = 10 * 60 * 1000;

function hash(code) {
  return createHash("sha256").update(String(code)).digest("hex");
}

export function linkCodesPath() {
  return join(PRIVATE_DIR, "link-codes.json");
}

/** @returns {{version: number, entries: Record<string, {handle: string, platform: string,
 *   created: string, expires: string, used: boolean}>}} */
function readStore() {
  const p = linkCodesPath();
  if (!existsSync(p)) return { version: 1, entries: {} };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j && typeof j === "object" && j.entries && typeof j.entries === "object")
      return { version: typeof j.version === "number" ? j.version : 1, entries: j.entries };
  } catch {
    /* unreadable/malformed reads as empty — the next write repairs it */
  }
  return { version: 1, entries: {} };
}

function writeStore(store) {
  atomicWriteJSONSync(linkCodesPath(), store);
}

const key = (platform, code) => `${platform}:${hash(String(code).trim().toLowerCase())}`;

/** drop anything expired, used or not, so the file never grows without bound. */
function pruneExpired(store, now = Date.now()) {
  for (const k of Object.keys(store.entries))
    if (Date.parse(store.entries[k].expires) <= now) delete store.entries[k];
  return store;
}

/** a fresh single-use code for `handle` on `platform`, good for `TTL_MS`.
 * @param {{handle: string, platform: string}} args
 * @returns {{code: string, expires: string}} */
export function mintLinkCode({ handle, platform }) {
  const store = pruneExpired(readStore());
  const code = randomBytes(4).toString("hex"); // 8 hex chars — short enough to type in a DM
  const now = Date.now();
  const expires = new Date(now + TTL_MS).toISOString();
  store.entries[key(platform, code)] = {
    handle,
    platform,
    created: new Date(now).toISOString(),
    expires,
    used: false,
  };
  writeStore(store);
  return { code, expires };
}

/** every pending (unused, unexpired) code for `handle` on `platform`,
 * invalidated — the app's "get a fresh code" and "disconnect" both call
 * this first, so a stale code never lingers alongside a new one.
 * @param {{handle: string, platform: string}} args @returns {{count: number}} */
export function revokeLinkCodes({ handle, platform }) {
  const store = pruneExpired(readStore());
  let count = 0;
  for (const e of Object.values(store.entries)) {
    if (e.handle === handle && e.platform === platform && !e.used) {
      e.used = true;
      count += 1;
    }
  }
  if (count) writeStore(store);
  return { count };
}

/** the seat's one road in: `code` presented in a DM on `platform`.
 * `currentHandle` is the handle this sender's platform id is ALREADY
 * linked to, or null — checked before the code is spent, so a sender
 * linked to a different handle never silently re-links (refused, the code
 * left unspent for its rightful owner to use).
 * @param {{platform: string, code: string, currentHandle: string|null}} args
 * @returns {{ok: true, handle: string} | {error: "invalid"|"already-linked", handle?: string}} */
export function redeemLinkCode({ platform, code, currentHandle }) {
  const store = pruneExpired(readStore());
  const k = key(platform, code);
  const entry = store.entries[k];
  if (!entry || entry.used) return { error: "invalid" };
  if (currentHandle && currentHandle !== entry.handle)
    return { error: "already-linked", handle: currentHandle };
  entry.used = true;
  writeStore(store);
  return { ok: true, handle: entry.handle };
}
