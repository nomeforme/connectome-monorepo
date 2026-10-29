// @ts-check
/* Platform identity -> house handle, the keeper-owned map the platform
 * seat and the importer both call before a platform sender's words become
 * a room participant. One file, house-wide (not per-handle):
 * `<PRIVATE_DIR>/identity-map.json` —
 *   { "version": 1, "entries": { "<platform>:<id>": {
 *       handle, display, first_seen, home,
 *       kind?, kind_set_by?, kind_set_at?, kind_reason?, ai_limit? } } }
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
import { HANDLE_RE, knownHandle, testamentFor } from "./testaments.mjs";
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
 *   first_seen: string, home: string, linked?: boolean, display_seen_at?: string}>}} `linked` is
 *   set only by `linkIdentity`, never the passive auto-pseudonym path; absent reads as false.
 *   `display_seen_at` is stamped whenever `display` is written with a fresh, distinct value —
 *   absent on an entry whose display has never been set (or was never re-sighted since platform-
 *   reach's human-display round) — `displayFor`/`handleForDisplay`'s own "most recently seen
 *   wins" tie-break reads it. */
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
 * its stored handle (`known: true`) — and, when this sighting carries a
 * fresh, non-phone `display` that differs from what's stored, updates the
 * entry's `display` (stamping `display_seen_at`) before returning: a
 * profile/username can change on the platform itself, and every being-
 * facing rendering built on `displayFor` should read the CURRENT one, not
 * whatever was true the first time this sender was ever seen (platform-
 * reach's human-display round — this was write-once before). An unknown
 * one gets a fresh pseudonymous handle, written back for next time
 * (`known: false` — the keeper's signal that this identity has not yet
 * been christened; `rechristen` below is how a keeper later gives it a
 * real handle). Throws if `HOUSE_IDENTITY_SALT` is unset — refusing to
 * derive an unsalted (and therefore reversible-by-guessing) pseudonym.
 * @param {{platform: string, id: string, display?: string|null}} args
 * @returns {{handle: string, home: string, known: boolean, linked: boolean}} */
export function identityFor({ platform, id, display }) {
  const plat = String(platform ?? "").trim();
  const sid = String(id ?? "").trim();
  if (!plat || !sid) throw new Error("identityFor: platform and id are both required");
  const key = `${plat}:${sid}`;
  const map = readIdentityMap();
  const existing = map.entries[key];
  const safeDisplay = display != null && !looksLikePhone(display) ? String(display) : null;
  if (existing) {
    if (safeDisplay != null && safeDisplay !== existing.display) {
      map.entries[key] = { ...existing, display: safeDisplay, display_seen_at: new Date().toISOString() };
      writeIdentityMap(map);
    }
    const k = kindFields(map, existing.handle);
    return {
      handle: existing.handle,
      home: existing.home ?? plat,
      known: true,
      linked: existing.linked === true,
      kind: k.kind,
      ai_limit: k.ai_limit,
    };
  }
  const handle = pseudonym(plat, sid, requireSalt());
  const now = new Date().toISOString();
  map.entries[key] = {
    handle,
    display: safeDisplay,
    ...(safeDisplay != null ? { display_seen_at: now } : {}),
    first_seen: now,
    home: plat,
  };
  writeIdentityMap(map);
  return { handle, home: plat, known: false, linked: false, kind: null, ai_limit: null };
}

/* ---------- account kind: AI accounts ----------
 * A platform account run by an AI outside this house (Signal never flags
 * one) is marked per entry: `kind: "ai"` plus `kind_set_by`, `kind_set_at`,
 * `kind_reason` and an optional `ai_limit` (integer: the bot-chain budget
 * for chains this account takes part in). Every entry naming the handle is
 * written together, so the mark holds across platforms. Anyone may mark or
 * tighten; un-marking, raising or removing a limit needs a keeper.
 * `kind: "human"` is a keeper's confirmation — only a keeper overrides it,
 * so the typing-speed heuristic can't re-flag an account a keeper cleared. */

/** the kind/limit a handle carries across its entries ("ai" wins).
 * @returns {{kind: "ai"|"human"|null, ai_limit: number|null, entry: any}} */
function kindFields(map, handle) {
  let found = null;
  for (const e of Object.values(map.entries)) {
    if (e.handle !== handle) continue;
    if (e.kind === "ai") return { kind: "ai", ai_limit: Number.isInteger(e.ai_limit) ? e.ai_limit : null, entry: e };
    if (e.kind === "human" && !found) found = e;
  }
  return found ? { kind: "human", ai_limit: null, entry: found } : { kind: null, ai_limit: null, entry: null };
}

/** @param {string} handle @returns {"ai"|"human"|null} null = never marked */
export function kindOf(handle) {
  return kindFields(readIdentityMap(), handle).kind;
}

/** the full kind record for `handle`, or null when no entry names it.
 * @param {string} handle
 * @returns {{kind: "ai"|"human"|null, ai_limit: number|null, kind_set_by: string|null,
 *   kind_set_at: string|null, kind_reason: string|null}|null} */
export function aiInfo(handle) {
  const map = readIdentityMap();
  if (!Object.values(map.entries).some((e) => e.handle === handle)) return null;
  const k = kindFields(map, handle);
  return {
    kind: k.kind,
    ai_limit: k.ai_limit,
    kind_set_by: k.entry?.kind_set_by ?? null,
    kind_set_at: k.entry?.kind_set_at ?? null,
    kind_reason: k.entry?.kind_reason ?? null,
  };
}

/** @param {unknown} v */
const validLimit = (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;

/** write `fields` onto every entry naming `handle`; false when none does. */
function writeKind(map, handle, fields, drop = []) {
  let hit = false;
  for (const key of Object.keys(map.entries)) {
    if (map.entries[key].handle !== handle) continue;
    const next = { ...map.entries[key], ...fields };
    for (const f of drop) delete next[f];
    map.entries[key] = next;
    hit = true;
  }
  if (hit) writeIdentityMap(map);
  return hit;
}

/** mark `handle` as an AI account. Anyone may mark, and may set a limit
 * where none exists or lower one; raising or removing (limit: null) an
 * existing limit, or overriding a keeper's "human", needs `keeper: true`.
 * `limit` undefined keeps the current one.
 * @param {string} handle
 * @param {{by: string, reason?: string, limit?: number|null, keeper?: boolean}} opts
 * @returns {{ok: boolean, changed?: boolean, kind?: "ai", ai_limit?: number|null,
 *   needsKeeper?: boolean, error?: string}} */
export function markAI(handle, { by, reason, limit, keeper = false } = /** @type {any} */ ({})) {
  if (!by) return { ok: false, error: "markAI: `by` is required" };
  if (limit !== undefined && limit !== null && !validLimit(limit))
    return { ok: false, error: "limit must be a whole number of turns (0 or more)" };
  if (testamentFor(handle)) return { ok: false, error: `@${handle} is a house being, not an outside account` };
  const map = readIdentityMap();
  const cur = kindFields(map, handle);
  if (!Object.values(map.entries).some((e) => e.handle === handle))
    return { ok: false, error: `no platform account is known as @${handle}` };
  if (cur.kind === "human" && !keeper)
    return { ok: false, needsKeeper: true, error: `a keeper confirmed @${handle} as human; only a keeper can change that` };
  let nextLimit = cur.kind === "ai" ? cur.ai_limit : null;
  if (limit !== undefined) {
    const raising = cur.kind === "ai" && cur.ai_limit != null && (limit === null || limit > cur.ai_limit);
    if (raising && !keeper)
      return { ok: false, needsKeeper: true, error: `raising or removing @${handle}'s limit (${cur.ai_limit}) needs a keeper` };
    nextLimit = limit;
  }
  if (cur.kind === "ai" && nextLimit === cur.ai_limit) return { ok: true, changed: false, kind: "ai", ai_limit: nextLimit };
  writeKind(
    map,
    handle,
    {
      kind: "ai",
      kind_set_by: by,
      kind_set_at: new Date().toISOString(),
      kind_reason: reason ? String(reason).slice(0, 300) : null,
      ...(nextLimit != null ? { ai_limit: nextLimit } : {}),
    },
    nextLimit == null ? ["ai_limit"] : [],
  );
  return { ok: true, changed: true, kind: "ai", ai_limit: nextLimit };
}

/** un-mark `handle` (keeper only): it reads as a keeper-confirmed human.
 * @param {string} handle @param {{by: string, keeper?: boolean, reason?: string}} opts
 * @returns {{ok: boolean, changed?: boolean, needsKeeper?: boolean, error?: string}} */
export function clearAI(handle, { by, keeper = false, reason } = /** @type {any} */ ({})) {
  if (!keeper) return { ok: false, needsKeeper: true, error: `only a keeper can mark @${handle} as human` };
  const map = readIdentityMap();
  const cur = kindFields(map, handle);
  const hit = writeKind(
    map,
    handle,
    { kind: "human", kind_set_by: by, kind_set_at: new Date().toISOString(), kind_reason: reason ? String(reason).slice(0, 300) : null },
    ["ai_limit"],
  );
  if (!hit) return { ok: false, error: `no platform account is known as @${handle}` };
  return { ok: true, changed: cur.kind !== "human" };
}

/** set `handle`'s chain limit. Lowering (or setting one where none was)
 * is open to anyone on an AI-marked account; raising or null needs a
 * keeper. An unmarked account is marked AI by this call.
 * @param {string} handle @param {number|null} limit
 * @param {{by: string, keeper?: boolean}} opts */
export function setAILimit(handle, limit, { by, keeper = false } = /** @type {any} */ ({})) {
  const cur = kindOf(handle);
  if (limit === null && !keeper) return { ok: false, needsKeeper: true, error: `removing @${handle}'s limit needs a keeper` };
  return markAI(handle, { by, keeper, limit, ...(cur === "ai" ? {} : { reason: "limit set" }) });
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
  const freshDisplay = display != null && !looksLikePhone(display) ? String(display) : null;
  const safeDisplay = freshDisplay ?? existing?.display ?? null;
  map.entries[key] = {
    handle,
    display: safeDisplay,
    ...(freshDisplay != null
      ? { display_seen_at: new Date().toISOString() }
      : existing?.display_seen_at
        ? { display_seen_at: existing.display_seen_at }
        : {}),
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

/** case/separator-insensitive comparison key for a display name: lower-
 * cased, `_`/`-` folded to a plain space alongside real whitespace, then
 * collapsed — so a stored "Robin T" and a being's own typed "Robin_T"
 * or "robin-t" all land on the same key ("robin t"). A being reads a
 * platform's rendered display but can only TYPE a single unbroken mention
 * token back, so it joins the words itself; this is the one place that
 * join is undone, in either direction.
 * @param {string} s @returns {string} */
function normalizeDisplayKey(s) {
  return String(s ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** the latest display name recorded for `handle` across every platform
 * identity mapped to it, or null when none has ever been stored (an
 * identity-mapped human `identityFor` has never seen a display for, or a
 * being/testament handle — those never carry a `display` at all). Several
 * platform identities can share one handle (`rechristen`, or one person
 * linked on two platforms) — the entry whose `display` was stamped most
 * recently (`display_seen_at`) wins; among entries that never stamped one
 * (pre-dating this field, or never re-sighted since), the last in
 * iteration order does — an honest "which one, if it must pick," never a
 * crash. The room-facing name a being should show in place of a kept
 * pseudonym; `?? handle` at every call site is what actually falls back
 * when this returns null.
 * @param {string} handle @returns {string|null} */
export function displayFor(handle) {
  const map = readIdentityMap();
  let best = null;
  let bestAt = "";
  for (const e of Object.values(map.entries)) {
    if (e.handle !== handle || typeof e.display !== "string" || !e.display) continue;
    const at = typeof e.display_seen_at === "string" ? e.display_seen_at : "";
    if (best === null || at >= bestAt) {
      best = e.display;
      bestAt = at;
    }
  }
  return best;
}

/** the handle behind a rendered display name, on `platform` — the being-
 * side inverse of `displayFor`: a being types back `@<display>` (any of
 * `normalizeDisplayKey`'s accepted variants — spaces, underscores, dashes,
 * any case) and this resolves which house handle that was. Scoped to one
 * platform (a display name is that platform's own rendering; the same
 * person can show differently elsewhere, and a bare display string alone
 * is not enough to say which platform's copy of them is meant) — never a
 * cross-platform fallback the way `identityMapReverse` allows. Two
 * different people sharing one display name on the same platform is a
 * real collision, not a house error: the entry most recently sighted
 * (`display_seen_at`) wins, same tie-break as `displayFor`.
 * @param {string} platform @param {string} display @returns {string|null} */
export function handleForDisplay(platform, display) {
  const want = normalizeDisplayKey(display);
  if (!want) return null;
  const map = readIdentityMap();
  let best = null;
  let bestAt = "";
  for (const [key, e] of Object.entries(map.entries)) {
    if (typeof e.display !== "string" || normalizeDisplayKey(e.display) !== want) continue;
    const i = key.indexOf(":");
    if (platform && key.slice(0, i) !== platform) continue;
    const at = typeof e.display_seen_at === "string" ? e.display_seen_at : "";
    if (best === null || at >= bestAt) {
      best = e.handle;
      bestAt = at;
    }
  }
  return best;
}

/** handle → the platform identity it was mapped from, or null. The ONLY
 * road back from a record's handle to a platform author id: records
 * (frames, external.jsonl) carry handles, never author ids, so anything
 * that must address a person on their platform (an outbound mention)
 * comes here at call time. A handle mapped from several identities
 * returns the one on `platform` when given, else the first stored.
 * @param {string} handle @param {string} [platform]
 * @returns {{platform: string, id: string}|null} */
/** the platform id behind a rendered display name, on `platform` — routes
 * through `handleForDisplay` (the variant/collision rules live there
 * alone) then `identityMapReverse`; the outbound mention rewrite's second
 * pass (mcpl/outbound.mjs's `rewriteOutboundMentions`, injected as
 * `reverseDisplay`). @returns {{platform: string, id: string}|null} */
export function identityMapReverseByDisplay(display, platform) {
  const handle = handleForDisplay(platform, display);
  return handle ? identityMapReverse(handle, platform) : null;
}

/** every stored entry as `{platform, id, handle, display}` — a read-only
 * snapshot for mcpl/external-guard.mjs, which must know every human's
 * display and platform id to keep them from leaving for an external room.
 * @returns {{platform: string, id: string, handle: string, display: string|null}[]} */
export function identityMapEntries() {
  return Object.entries(readIdentityMap().entries).map(([key, e]) => {
    const i = key.indexOf(":");
    return { platform: key.slice(0, i), id: key.slice(i + 1), handle: e.handle, display: e.display ?? null };
  });
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
