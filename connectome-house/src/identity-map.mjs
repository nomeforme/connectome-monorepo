// @ts-check
/* Platform identity -> house handle, the keeper-owned map the platform
 * seat and the importer both call before a platform sender's words become
 * a room participant. One file, house-wide (not per-handle):
 * `<PRIVATE_DIR>/identity-map.json` —
 *   { "version": 1, "entries": { "<platform>:<id>": {
 *       handle, display, first_seen, home } } }
 * — gitignored with the rest of harness/private/.
 *
 * A KNOWN sender (an entry already exists for "<platform>:<id>") returns
 * that entry's handle. An UNKNOWN sender gets a stable PSEUDONYMOUS handle
 * `<platform>-<6 base32 chars>`, derived from
 * HMAC-SHA256(HOUSE_IDENTITY_SALT, "<platform>:<id>") — never an unsalted
 * hash (a raw Discord snowflake or Signal uuid must never be recoverable
 * from a record by brute-forcing an unsalted digest) — and the entry is
 * written back so the same sender maps to the same handle on every future
 * call. The salt is read LAZILY (call time, not module-load time) from
 * `process.env.HOUSE_IDENTITY_SALT`, set via harness/.env (env.mjs) —
 * per pii-discipline's "read env vars lazily" rule. Missing salt refuses
 * with a clear error; it never falls back to an unsalted derivation.
 *
 * Phone numbers: a Signal DM identifies its sender by uuid; when only a
 * phone number is available, the caller derives the id via `phoneId()`
 * (sha256(phone) hex) — the raw number must never reach `id` OR `display`.
 * As a second line of defense (this module is the one writer of the
 * store), any `display` that itself looks like a phone number is dropped
 * rather than stored — see `looksLikePhone`. */
import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "./env.mjs";
import { atomicWriteJSONSync } from "./atomic-write.mjs";
import { HANDLE_RE, knownHandle } from "./testaments.mjs";
import { PRIVATE_DIR, RUNS } from "./serve-paths.mjs";

/** a shorter salt leaves a 6-char pseudonym guessable by brute-forcing the
 * salt itself, which the HMAC exists to prevent. */
export const MIN_SALT_LENGTH = 16;

/** the salt, read at call time; refuses unset OR too short — never an
 * unsalted or weakly-salted derivation. */
function requireSalt() {
  const salt = process.env.HOUSE_IDENTITY_SALT;
  if (!salt) {
    throw new Error(
      "identityFor: HOUSE_IDENTITY_SALT is not set — refusing to derive an unsalted pseudonym " +
        "(set it in harness/.env; see harness/.env.example). A raw platform id must never be " +
        "recoverable from a stored handle.",
    );
  }
  if (salt.length < MIN_SALT_LENGTH) {
    throw new Error(
      `identityFor: HOUSE_IDENTITY_SALT is ${salt.length} chars; at least ${MIN_SALT_LENGTH} are ` +
        "required — a short salt can be brute-forced, which would make a raw platform id " +
        "recoverable from a stored handle.",
    );
  }
  return salt;
}

/** the shared store path — one file for the whole house, not per-handle
 * (distinct from PRIVATE_ROOT(handle), which is a person's own overlay). */
export function identityMapPath() {
  return join(PRIVATE_DIR, "identity-map.json");
}

/** @returns {{version: number, entries: Record<string, {handle: string, display: string|null,
 *   first_seen: string, home: string, linked?: boolean}>}} `linked` is set only by
 *   `linkIdentity`, never the passive auto-pseudonym path; absent reads as false. */
function readIdentityMap() {
  const p = identityMapPath();
  if (!existsSync(p)) return { version: 1, entries: {} };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j && typeof j === "object" && j.entries && typeof j.entries === "object") {
      return { version: typeof j.version === "number" ? j.version : 1, entries: j.entries };
    }
  } catch {
    /* an unreadable/malformed map reads as empty — never a throw at
       lookup time; the next write repairs the file on disk. */
  }
  return { version: 1, entries: {} };
}

function writeIdentityMap(map) {
  atomicWriteJSONSync(identityMapPath(), map);
}

/** a string that is plausibly a phone number (leading +, or mostly digits,
 * 7+ digits long) — the display-side guard against ever storing one, even
 * when a caller passes it by mistake. Deliberately loose (a false positive
 * only means a legitimate display name gets dropped, never a leak). */
function looksLikePhone(s) {
  if (typeof s !== "string") return false;
  const digits = s.replace(/[^0-9]/g, "");
  return digits.length >= 7 && digits.length >= s.replace(/\s/g, "").length - 2;
}

/** sha256(phone) hex — the id a caller must derive when a Signal sender is
 * known only by phone number (no uuid available). The raw number itself
 * must never be passed anywhere near `identityFor` — not as `id` (this
 * function is how `id` gets made instead) and not as `display`.
 * @param {string} phone @returns {string} */
export function phoneId(phone) {
  return createHash("sha256").update(String(phone)).digest("hex");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** lowercase RFC4648 base32, no padding — just enough alphabet to spell a
 * handle suffix (HANDLE_RE is lowercase letters/digits/dashes only).
 * @param {Buffer} buf @returns {string} */
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** the stable pseudonym for a platform+id pair — deterministic given the
 * same salt, never reproducible without it.
 * @param {string} platform @param {string} id @param {string} salt */
function pseudonym(platform, id, salt) {
  const digest = createHmac("sha256", salt).update(`${platform}:${id}`).digest();
  const suffix = base32(digest).slice(0, 6);
  return `${String(platform).toLowerCase()}-${suffix}`;
}

/** Platform identity -> house handle. A known "<platform>:<id>" returns
 * its stored handle (`known: true`). An unknown one gets a fresh
 * pseudonymous handle, written back for next time (`known: false` — the
 * keeper's signal that this identity has not yet been christened;
 * `rechristen` below is how a keeper later gives it a real handle).
 * Throws if `HOUSE_IDENTITY_SALT` is unset — refusing to derive an
 * unsalted (and therefore reversible-by-guessing) pseudonym.
 * @param {{platform: string, id: string, display?: string|null}} args
 * @returns {{handle: string, home: string, known: boolean, linked: boolean}} */
export function identityFor({ platform, id, display }) {
  const plat = String(platform ?? "").trim();
  const sid = String(id ?? "").trim();
  if (!plat || !sid) throw new Error("identityFor: platform and id are both required");
  const key = `${plat}:${sid}`;
  const map = readIdentityMap();
  const existing = map.entries[key];
  if (existing) {
    return {
      handle: existing.handle,
      home: existing.home ?? plat,
      known: true,
      linked: existing.linked === true,
    };
  }
  const handle = pseudonym(plat, sid, requireSalt());
  const safeDisplay = display != null && !looksLikePhone(display) ? String(display) : null;
  map.entries[key] = {
    handle,
    display: safeDisplay,
    first_seen: new Date().toISOString(),
    home: plat,
  };
  writeIdentityMap(map);
  return { handle, home: plat, known: false, linked: false };
}

/** the keeper's own act: bind "<platform>:<id>" to EXACTLY `handle` —
 * creating the entry if none exists, or repointing an existing one (most
 * often an auto-minted pseudonym like `discord-i4awaa`) the same one file
 * `rechristen` writes through. Refuses a handle the house does not already
 * know (knownHandle: a testament, a private root, or an account) — the
 * keeper is NAMING an existing identity, never minting a fresh one by
 * fiat. `harness/tools/identity.mjs`'s `link` subcommand (and `mcpl/link.mjs`'s
 * `attemptLink`) are the CLI/app callers; marks the entry `linked: true`.
 * @param {{platform: string, id: string, handle: string,
 *   display?: string|null}} args
 * @returns {{linked: boolean, previous: string|null}} */
export function linkIdentity({ platform, id, handle, display }) {
  if (!HANDLE_RE.test(handle))
    throw new Error(`linkIdentity: "${handle}" is not a valid handle shape`);
  if (!knownHandle(handle))
    throw new Error(`linkIdentity: "${handle}" is not a handle the house knows`);
  const plat = String(platform ?? "").trim();
  const sid = String(id ?? "").trim();
  if (!plat || !sid) throw new Error("linkIdentity: platform and id are both required");
  const map = readIdentityMap();
  const key = `${plat}:${sid}`;
  const existing = map.entries[key];
  const previous = existing?.handle ?? null;
  const safeDisplay =
    display != null && !looksLikePhone(display) ? String(display) : (existing?.display ?? null);
  map.entries[key] = {
    handle,
    display: safeDisplay,
    first_seen: existing?.first_seen ?? new Date().toISOString(),
    home: plat,
    linked: true,
  };
  writeIdentityMap(map);
  return { linked: true, previous };
}

/** the app-side disconnect: every entry on `platform` linked to `handle`
 * flips to `linked: false` in place — never deleted, so records stay as they are.
 * @param {string} platform @param {string} handle
 * @returns {{unlinked: boolean, count: number}} */
export function unlinkIdentity(platform, handle) {
  const map = readIdentityMap();
  let count = 0;
  for (const e of Object.values(map.entries)) {
    if (e.handle !== handle || e.linked !== true || (e.home ?? "") !== platform) continue;
    e.linked = false;
    count += 1;
  }
  if (count) writeIdentityMap(map);
  return { unlinked: count > 0, count };
}

/** every platform `handle` currently holds a live link on — the app's own
 * "connected accounts" read. Never the platform id itself.
 * @param {string} handle
 * @returns {{platform: string, display: string|null, first_seen: string}[]} */
export function linkedPlatformsFor(handle) {
  const map = readIdentityMap();
  const out = [];
  for (const e of Object.values(map.entries)) {
    if (e.handle !== handle || e.linked !== true) continue;
    out.push({ platform: e.home, display: e.display ?? null, first_seen: e.first_seen });
  }
  return out;
}

/** handle → the platform identity it was mapped from, or null. The ONLY
 * road back from a record's handle to a platform author id: records
 * (frames, external.jsonl) carry handles, never author ids, so anything
 * that must address a person on their platform (an outbound mention)
 * comes here at call time. A handle mapped from several identities
 * returns the one on `platform` when given, else the first stored.
 * @param {string} handle @param {string} [platform]
 * @returns {{platform: string, id: string}|null} */
/** the platform id behind a rendered display name (case-insensitive), or
 * null — the outbound mention rewrite's second pass. */
export function identityMapReverseByDisplay(display, platform) {
  const want = String(display ?? "").trim().toLowerCase();
  if (!want) return null;
  const map = readIdentityMap();
  for (const [key, e] of Object.entries(map.entries)) {
    if (typeof e.display !== "string" || e.display.trim().toLowerCase() !== want) continue;
    const i = key.indexOf(":");
    if (!platform || key.slice(0, i) === platform) return { platform: key.slice(0, i), id: key.slice(i + 1) };
  }
  return null;
}

export function identityMapReverse(handle, platform) {
  const map = readIdentityMap();
  let first = null;
  for (const [key, e] of Object.entries(map.entries)) {
    if (e.handle !== handle) continue;
    const i = key.indexOf(":");
    const hit = { platform: key.slice(0, i), id: key.slice(i + 1) };
    if (platform && hit.platform === platform) return hit;
    first ??= hit;
  }
  return platform ? null : first;
}

/** true when `handle` is recognized by the house at all — mapped from some
 * platform identity, OR already a testament/private-root/account handle
 * (testaments.mjs's own `knownHandle`, reused rather than re-derived). */
export function identityKnown(handle) {
  if (knownHandle(handle)) return true;
  const map = readIdentityMap();
  return Object.values(map.entries).some((e) => e.handle === handle);
}

/** run ids under RUNS whose class.json.participants names `handle` — the
 * scan `rechristen` reports so the keeper knows what still reads the old
 * name (it does NOT rewrite those records; see `rechristen`'s own note). */
function runsNamingHandle(handle) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(RUNS);
  } catch {
    return out;
  }
  for (const d of entries) {
    try {
      const cls = JSON.parse(readFileSync(join(RUNS, d, "class.json"), "utf8"));
      const participants = Array.isArray(cls?.participants) ? cls.participants : [];
      if (participants.some((p) => p?.handle === handle)) out.push(d);
    } catch {
      /* no class.json, or unreadable — not a match */
    }
  }
  return out.sort();
}

/** The keeper christening an auto-pseudonym (or renaming any mapped
 * identity): every identity-map entry currently naming `oldHandle`
 * repoints to `newHandle`. This ONLY changes future `identityFor` lookups
 * — it does NOT rewrite any run's class.json/frames.jsonl, which still
 * name the old handle verbatim (records are append-only; rewriting them
 * would falsify history). The return value names every run still reading
 * the old handle so the keeper can judge what that means.
 * @param {string} oldHandle @param {string} newHandle
 * @returns {{renamed: boolean, affectedRuns: string[], note: string}} */
export function rechristen(oldHandle, newHandle) {
  if (!HANDLE_RE.test(newHandle)) {
    throw new Error(`rechristen: "${newHandle}" is not a valid handle shape`);
  }
  const map = readIdentityMap();
  let renamed = false;
  for (const key of Object.keys(map.entries)) {
    if (map.entries[key].handle === oldHandle) {
      map.entries[key] = { ...map.entries[key], handle: newHandle };
      renamed = true;
    }
  }
  if (renamed) writeIdentityMap(map);
  return {
    renamed,
    affectedRuns: runsNamingHandle(oldHandle),
    note:
      "records under harness/runs were NOT rewritten — every run listed here still names " +
      `"${oldHandle}" verbatim in its own class.json; this call only repoints future identity ` +
      "lookups to the new handle.",
  };
}
