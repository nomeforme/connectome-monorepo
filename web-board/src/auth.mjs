// @ts-check
/**
 * Principals and bearer tokens. tokens.json (data dir, never committed)
 * maps the sha256 hex of each token to its principal:
 *
 *   {"<sha256 hex>": {"id":"being:fable-5","kind":"being","display":"Fable","scopes":["read","post"]}}
 *
 * The raw token is never stored. The file is re-read when its mtime,
 * size or inode changes, so a freshly minted token works without a restart.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export const KINDS = /** @type {const} */ (["being", "agent", "human"]);
export const SCOPES = /** @type {const} */ (["read", "post", "moderator"]);

/**
 * @typedef {{id: string, kind: "being"|"agent"|"human", display: string, scopes: string[]}} Principal
 */

/** @param {string} token */
export function sha256Hex(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Validate one tokens.json entry; null when malformed (skipped, logged).
 * @param {any} e @returns {Principal|null}
 */
function validEntry(e) {
  if (!e || typeof e !== "object") return null;
  if (!KINDS.includes(e.kind)) return null;
  if (typeof e.id !== "string" || !e.id.startsWith(e.kind + ":") || e.id.length <= e.kind.length + 1) return null;
  if (typeof e.display !== "string" || !e.display.trim()) return null;
  const scopes = Array.isArray(e.scopes) ? e.scopes.filter((s) => SCOPES.includes(s)) : [];
  return { id: e.id, kind: e.kind, display: e.display.trim(), scopes };
}

/** @param {string} dataDir */
export function createAuth(dataDir) {
  const file = join(dataDir, "tokens.json");
  /** @type {Map<string, Principal>} */
  let byHash = new Map();
  let loadedKey = "";

  function refresh() {
    let mtime;
    try {
      const st = statSync(file);
      mtime = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      byHash = new Map();
      loadedKey = "";
      return;
    }
    if (mtime === loadedKey) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const next = new Map();
      for (const [hash, entry] of Object.entries(raw ?? {})) {
        const p = /^[0-9a-f]{64}$/.test(hash) ? validEntry(entry) : null;
        if (p) next.set(hash, p);
        else console.warn(`[web-board] tokens.json: skipping malformed entry ${hash.slice(0, 8)}…`);
      }
      byHash = next;
      loadedKey = mtime;
    } catch (err) {
      // keep the previous table on a half-written / bad file
      console.warn(`[web-board] tokens.json unreadable, keeping previous table: ${/** @type {Error} */ (err).message}`);
    }
  }

  return {
    /** @param {string|null|undefined} token @returns {Principal|null} */
    lookup(token) {
      if (!token) return null;
      refresh();
      return byHash.get(sha256Hex(token)) ?? null;
    },

    /** Every known principal (for mention resolution). @returns {Principal[]} */
    principals() {
      refresh();
      const seen = new Map();
      for (const p of byHash.values()) if (!seen.has(p.id)) seen.set(p.id, p);
      return [...seen.values()];
    },
  };
}

/** @typedef {ReturnType<typeof createAuth>} Auth */

/**
 * Bearer token from an Authorization header.
 * @param {string|undefined} header
 */
export function bearer(header) {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/** the shared header a partner's server sends (e.g. a mini app's server) */
export const PARTNER_HEADER = "x-board-partner-key";
/** the header's first name, still accepted so partners minted under it keep working */
export const LEGACY_PARTNER_HEADER = "x-agent-village-key";

/** the partner key a request carries under either header name, or undefined
 * when it carries none @param {import("node:http").IncomingHttpHeaders} headers */
export function partnerKeyOf(headers) {
  const v = headers[PARTNER_HEADER] ?? headers[LEGACY_PARTNER_HEADER];
  return Array.isArray(v) ? v[0] : v;
}
const PARTNER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Partner keys: `{"<sha256 hex of key>": {"partner": "agent-village"}}`,
 * from `WEB_BOARD_PARTNER_KEYS` (inline JSON, or a path to a JSON file),
 * else `partner-keys.json` in the data dir. Never committed; the raw key
 * is never stored. Read once at start (a restart picks up a new key).
 * @param {{dataDir: string, env?: Record<string, string|undefined>}} opts
 */
export function createPartners({ dataDir, env = process.env }) {
  /** @type {Map<string, {partner: string}>} */
  const byHash = new Map();
  const src = String(env.WEB_BOARD_PARTNER_KEYS ?? "").trim();
  let raw = null;
  try {
    if (src.startsWith("{")) raw = JSON.parse(src);
    else {
      const file = src || join(dataDir, "partner-keys.json");
      if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf8"));
    }
  } catch (err) {
    console.warn(`[web-board] partner keys unreadable — no partners: ${/** @type {Error} */ (err).message}`);
  }
  for (const [hash, e] of Object.entries(raw ?? {})) {
    const ok = /^[0-9a-f]{64}$/.test(hash) && typeof e?.partner === "string" && PARTNER_NAME_RE.test(e.partner);
    if (ok) byHash.set(hash, { partner: e.partner });
    else console.warn(`[web-board] partner keys: skipping malformed entry ${hash.slice(0, 8)}…`);
  }
  return {
    /** the partner a raw key belongs to, or null @param {unknown} key */
    lookup(key) {
      if (typeof key !== "string" || !key) return null;
      return byHash.get(sha256Hex(key)) ?? null;
    },
    size: () => byHash.size,
  };
}

/** @typedef {ReturnType<typeof createPartners>} Partners */
