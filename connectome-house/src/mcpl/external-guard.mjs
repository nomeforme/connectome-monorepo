// @ts-check
/* connectome-house/src/mcpl/external-guard.mjs — the quiet outbound
 * backstop for EXTERNAL rooms (a seat whose config carries `"audience":
 * "external"` — the web board, where outside agents and people read and
 * keep what is posted). Beings carry autobiographical memory of Signal
 * and Discord (house territory); the norms for what may leave the house
 * live in the runtime skill skills/external-commons/SKILL.md, read on
 * demand. This module is the backstop under that skill, never a
 * substitute: before a send leaves the house for an external room, the
 * text is scanned for
 *   - phone numbers (E.164, 00-prefixed international, NANP 3-3-4 with
 *     separators, trunk-zero local formats) — years, prices, versions,
 *     times, dates and unix timestamps deliberately never match
 *   - email addresses
 *   - platform ids: Discord snowflakes, Signal uuids, identity-map
 *     pseudonym handles (`signal-xxxxxx`/`discord-xxxxxx`), and any
 *     human's literal platform id from the identity map
 *   - humans' display names (and christened handles) from the identity
 *     map, case-insensitive on word boundaries — beings' own names, names
 *     under 3 chars and a few generic words are never matched, and a
 *     person's display ON the external platform itself (they are present
 *     there under it, in public) is not blocked
 *   - the keeper's own list, `<HOUSE_PRIVATE_DIR>/external-guard.json`
 *     (never committed): `{"names": [...], "allow_phrases": [...]}`.
 *     `names` are blocked like display names (people the identity map
 *     doesn't know by that name); an `allow_phrases` phrase is removed
 *     before names are matched, so a name that is also a common word
 *     ("Rose") still blocks alone but not inside "rose garden".
 *     Re-read when the file changes; unreadable means empty.
 * A hit means the send is not delivered: one `delivered: false` row in
 * external.jsonl (reason `external-guard`, kinds only), one masked log
 * line, and one plain house line in the room's own record naming what
 * KIND of detail stopped it — never the value. House lines are never
 * relayed outward (relay.mjs's textFor), and nothing is ever added to a
 * turn: the being simply sees its send came back, as with any other
 * refused delivery, and rephrases. Internal seats (no `audience`, or
 * `"house"`) are never scanned at all. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { identityMapEntries } from "../identity-map.mjs";
import { PRIVATE_DIR } from "../serve-paths.mjs";
import { testaments } from "../testaments.mjs";
import { adapterFor } from "./adapters.mjs";
import { recordOutbound } from "./outbound.mjs";

export { AUDIENCES, parseAudience } from "./config-policy.mjs";

/** a seat's own `audience` wins; absent it, the platform adapter may
 * declare one (a web adapter can default to external). @param {any} cfg */
export function isExternalSeat(cfg) {
  if (!cfg) return false;
  if (cfg.audience !== undefined) return cfg.audience === "external";
  return adapterFor(cfg.platform)?.audience === "external";
}

const KIND_LABEL = {
  phone: "a phone number",
  email: "an email address",
  "platform-id": "a platform id",
  name: "a person's name",
};

// ---------- patterns ----------
const SEP = "[ .()\\-]{0,2}";
const PHONE_RES = [
  // E.164 / +country: 8–15 digits after the plus
  new RegExp(`(?<![\\w+])\\+\\d(?:${SEP}\\d){7,14}(?!\\d)`, "g"),
  // 00-prefixed international
  new RegExp(`(?<![\\w.+\\-])00\\d(?:${SEP}\\d){7,13}(?![\\w]|\\.\\d)`, "g"),
  // NANP: (555) 555-0123, 555-555-0123, 555.555.0123, 555 555 0123
  /(?<![\w.+\-/:])\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}(?![\w\-/:]|\.\d)/g,
  // trunk-zero local: 07700 900123, 020 7946 0958, 07700900123 (10–11 digits)
  /(?<![\w.+\-/:,])0\d{1,4}(?:[ .-]?\d{2,4}){1,3}(?![\w\-/:,]|\.\d)/g,
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SNOWFLAKE_RE = /(?<!\d)\d{17,20}(?!\d)/g;
const UUID_RE = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
const PSEUDONYM_RE = /(?<![\w-])(?:signal|discord)-[a-z2-7]{6}(?![\w-])/gi;

/** display names too generic to mean anyone in particular */
const GENERIC_NAMES = new Set([
  "admin", "anon", "anonymous", "everyone", "here", "house", "keeper", "someone", "unknown", "user", "you",
]);

/** the keeper's private list (see the header), cached on mtime */
let keeperCache = { mtime: -1, names: /** @type {string[]} */ ([]), allow: /** @type {string[]} */ ([]) };
function keeperList() {
  const path = join(process.env.HOUSE_PRIVATE_DIR || PRIVATE_DIR, "external-guard.json");
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return (keeperCache = { mtime: 0, names: [], allow: [] });
  }
  if (mtime === keeperCache.mtime) return keeperCache;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
    keeperCache = { mtime, names: list(raw.names), allow: list(raw.allow_phrases) };
  } catch (err) {
    console.error(`[external-guard] ${path} unreadable — ignored: ${/** @type {Error} */ (err).message}`);
    keeperCache = { mtime, names: [], allow: [] };
  }
  return keeperCache;
}

const digitCount = (s) => s.replace(/\D/g, "").length;
const normName = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** a matched value, masked for a log line: the first char, then `•••`,
 * then the last two only when the value is long enough that two chars
 * can't name it. @param {string} v */
export function maskValue(v) {
  const s = String(v ?? "");
  if (!s) return "•••";
  return `${s[0]}•••${s.length >= 8 ? s.slice(-2) : ""}`;
}

function phoneHits(text) {
  const out = [];
  for (const re of PHONE_RES) {
    for (const m of text.matchAll(re)) {
      const v = m[0];
      const n = digitCount(v);
      if (v.startsWith("+") ? n >= 8 && n <= 15 : v.startsWith("00") ? n >= 10 && n <= 15 : v.startsWith("0") || v.startsWith("(0") ? n >= 10 && n <= 11 : n === 10)
        out.push(v);
    }
  }
  return out;
}

/** what the identity map says must stay home, as seen from `platform`:
 * humans' names and literal ids from every OTHER platform, and every
 * pseudonym handle (to tell a real `discord-xxxxxx` from a word like
 * "discord-server"). @param {string} platform @param {Set<string>} beingNames */
function identityFacts(platform, beingNames) {
  const entries = identityMapEntries();
  const beings = new Set(Object.keys(testaments()));
  const humans = entries.filter((e) => e.handle && !beings.has(e.handle));
  const publicHere = new Set(humans.filter((e) => e.platform === platform && e.display).map((e) => normName(e.display)));
  const names = new Set();
  const ids = new Set();
  for (const e of humans) {
    if (e.platform === platform) continue;
    if (e.id && e.id.length >= 6) ids.add(e.id);
    const candidates = [e.display];
    if (!/^[a-z]+-[a-z2-7]{6}$/.test(e.handle)) candidates.push(e.handle);
    for (const c of candidates) {
      const k = normName(c);
      if (k.length < 3 || !/\p{L}/u.test(k) || GENERIC_NAMES.has(k) || beingNames.has(k) || publicHere.has(k)) continue;
      names.add(k);
    }
  }
  for (const n of keeperList().names) {
    const k = normName(n);
    if (k.length >= 3 && !beingNames.has(k)) names.add(k);
  }
  const pseudonyms = new Set(entries.map((e) => String(e.handle).toLowerCase()));
  return { names, ids, pseudonyms };
}

/** every identifying detail in `text`, as `{kind, value}`. Pure apart from
 * reading the identity map and the covenants.
 * @param {string} text
 * @param {{platform: string, beingNames?: Iterable<string>}} opts
 * @returns {{kind: "phone"|"email"|"platform-id"|"name", value: string}[]} */
export function scanExternal(text, { platform, beingNames = [] }) {
  const src = String(text ?? "");
  if (!src.trim()) return [];
  /** @type {{kind: any, value: string}[]} */
  const hits = [];
  const ownNames = new Set([...beingNames].map(normName));
  for (const h of Object.keys(testaments())) ownNames.add(normName(h));
  const facts = identityFacts(platform, ownNames);

  // emails first, and out of the way, so a digit-heavy local part isn't also read as a phone
  let rest = src;
  for (const m of src.matchAll(EMAIL_RE)) {
    hits.push({ kind: "email", value: m[0] });
    rest = rest.replace(m[0], " ");
  }
  for (const v of phoneHits(rest)) hits.push({ kind: "phone", value: v });
  for (const re of [SNOWFLAKE_RE, UUID_RE]) for (const m of rest.matchAll(re)) hits.push({ kind: "platform-id", value: m[0] });
  for (const m of rest.matchAll(PSEUDONYM_RE)) {
    const v = m[0].toLowerCase();
    if (/[2-7]/.test(v.slice(v.indexOf("-") + 1)) || facts.pseudonyms.has(v)) hits.push({ kind: "platform-id", value: m[0] });
  }
  for (const id of facts.ids) if (rest.includes(id)) hits.push({ kind: "platform-id", value: id });
  let named = rest;
  for (const phrase of keeperList().allow) {
    const body = normName(phrase).split(" ").map(escapeRe).join("[\\s_-]+");
    named = named.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu"), " ");
  }
  for (const name of facts.names) {
    const body = name.split(" ").map(escapeRe).join("[\\s_-]+");
    const m = new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu").exec(named);
    if (m) hits.push({ kind: "name", value: m[0] });
  }
  const seen = new Set();
  return hits.filter((h) => !seen.has(`${h.kind}\0${h.value}`) && seen.add(`${h.kind}\0${h.value}`));
}

/** the plain line the being sees in the room's record */
export function blockedNotice(platform, by, kinds) {
  const labels = kinds.map((k) => KIND_LABEL[k] ?? k);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
  const who = by === "house" ? "the house's notice" : `what @${by} just said`;
  return `[not sent to ${platform}: ${who} contains ${list}. This room is external — outsiders read and keep what is posted here. Say it again without that detail.]`;
}

/** the hook speak.mjs (and redeliver.mjs) asks before any external send:
 * false when the seat is internal or the text is clean; true when the send
 * must not leave — and by then the refusal is already recorded, logged
 * once (masked) and, when a `houseLine` is given, noted in the room.
 * @param {{cfg: any, text: string, roomId: string, stream: string, by: string,
 *   seq?: number|null, RUNS: string, say?: (line: string) => void,
 *   houseLine?: ((roomId: string, text: string) => void)|null, beingNames?: string[]}} args
 * @returns {boolean} */
export function externalGuardRefusal({ cfg, text, roomId, stream, by, seq = null, RUNS, say, houseLine = null, beingNames = [] }) {
  if (!isExternalSeat(cfg)) return false;
  const names = [cfg.being, cfg.display_name, ...beingNames].filter((n) => typeof n === "string" && n);
  const hits = scanExternal(text, { platform: cfg.platform, beingNames: names });
  if (!hits.length) return false;
  const kinds = [...new Set(hits.map((h) => h.kind))];
  recordOutbound(join(RUNS, roomId), {
    platform: cfg.platform,
    by,
    seq,
    delivered: false,
    reason: "external-guard",
    error: `blocked: ${kinds.join(", ")}`,
  });
  const masked = hits.map((h) => `${h.kind} ${maskValue(h.value)}`).join(", ");
  (say ?? ((l) => console.error(l)))(`[external-guard] blocked @${by} to ${stream}: ${masked}`);
  houseLine?.(roomId, blockedNotice(cfg.platform, by, kinds));
  return true;
}
