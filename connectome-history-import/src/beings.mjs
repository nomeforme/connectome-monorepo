// @ts-check
/* connectome-history-import/src/beings.mjs — a VEIL speech facet's
 * `agentName` classified BEFORE anything is written: system automation
 * (never a being nor a human), a known being (exact registry name, an
 * explicit alias, or a Cyrillic/Greek-confusable variant of one), or a
 * human whose typed message was recorded as speech. Without this: a
 * substream/workflow stream can record a HUMAN's typed messages as speech
 * facets whose `agentName` is the human's own display handle, and the
 * real archive also showed THREE bots occasionally authoring speech under
 * their Discord DISPLAY name (Cyrillic-lookalike letters standing in for
 * Latin ones, e.g. a display "сlαυdе opus 4.6" for the registry name
 * `claude-opus-4-6`) — an importer that treats every speech author as a
 * bot, or that only matches a being by EXACT name, mints a being out of a
 * person in the first case and a SECOND, garbled-handle being out of an
 * already-known one in the second.
 *
 * `--beings <path>` supplies the set; absent, `loadBeings` returns `null`,
 * read everywhere here as "every name is a being" — today's behaviour,
 * unchanged for a caller that doesn't opt in. The caller (cli.mjs) is
 * responsible for the report's one-line warning when it's absent.
 */
import { readFileSync } from "node:fs";
import { slugHandle } from "./identity.mjs";

/** VEIL workflow-stream automation naming itself as a speaker — never a
 * being NOR a human. An explicit, small constant (not inferred) so
 * extending it is one line here; matched case-insensitively. */
export const SYSTEM_AUTHORS = new Set(["system"]);

/** @param {string} name */
export const isSystemAuthor = (name) => SYSTEM_AUTHORS.has(String(name ?? "").trim().toLowerCase());

/** lowercase Cyrillic/Greek letters a Discord display name has stood in
 * for their Latin lookalikes (the real archive's own three bots) — at
 * least the pairs the keeper named, plus the same letters' obvious kin. */
const CONFUSABLES = {
  "с": "c", // с cyrillic es
  "а": "a", // а cyrillic a
  "α": "a", // α greek alpha
  "у": "u", // у cyrillic u
  "υ": "u", // υ greek upsilon
  "е": "e", // е cyrillic ie
  "о": "o", // о cyrillic o
  "ο": "o", // ο greek omicron
  "р": "p", // р cyrillic er
  "ρ": "p", // ρ greek rho
  "і": "i", // і cyrillic byelorussian-ukrainian i
  "ι": "i", // ι greek iota
  "х": "x", // х cyrillic ha
  "χ": "x", // χ greek chi
};

/** lowercase, de-confusable, slug-shaped — comparable against
 * `slugHandle(registryName)` regardless of the Unicode script a display
 * name borrowed its lookalike letters from. */
function confusableSlug(name) {
  const lowered = String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "");
  const de = [...lowered].map((ch) => CONFUSABLES[ch] ?? ch).join("");
  return de.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `path` as either the fleet's own `bot-runtime/config.json` shape
 * (`{"bots":[{"name":…}, …]}`, optionally per-bot `display`/`displayName`/
 * `nickname` — none of the fleet's own entries carry one today, but a
 * caller that adds one gets it as an extra exact alias for free) or a
 * plain `["name", …]` array.
 * @param {string|null} path
 * @returns {Map<string, string>|null} alias-or-registry-name -> registry
 *   name; null = no file given */
export function loadBeings(path) {
  if (!path) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.bots) ? raw.bots : [];
  const known = new Map();
  for (const e of entries) {
    const name = typeof e === "string" ? e : e?.name;
    if (typeof name !== "string" || !name) continue;
    known.set(name, name);
    for (const field of ["display", "displayName", "nickname"]) {
      const alias = typeof e === "object" && e ? e[field] : null;
      if (typeof alias === "string" && alias) known.set(alias, name);
    }
  }
  return known;
}

/** `agentName` -> the being's own registry name it resolves to: an exact
 * (or file-supplied alias) match, else a Cyrillic/Greek-confusable match
 * against a known being's own slug, else `null` — never a being.
 * `beings === null` (no `--beings` file) -> `agentName` itself, unchanged
 * default (every speech author is a being).
 * @param {Map<string, string>|null} beings @param {string} agentName
 * @returns {string|null} */
export function canonicalBeingName(beings, agentName) {
  const name = String(agentName ?? "");
  if (beings === null) return name;
  if (beings.has(name)) return /** @type {string} */ (beings.get(name));
  const slug = confusableSlug(name);
  if (!slug) return null;
  for (const canonical of new Set(beings.values())) if (slugHandle(canonical) === slug) return canonical;
  return null;
}

/** @param {Map<string, string>|null} beings @param {string} name */
export const isKnownBeing = (beings, name) => canonicalBeingName(beings, name) !== null;

/** @typedef {{kind: "system"} | {kind: "being", canonical: string, aliased: boolean} | {kind: "human"}} SpeechAuthorClass */

/** the ONE classification a VEIL speech facet's `agentName` gets, shared
 * by every caller (records.mjs, slice.mjs, streams.mjs, cli.mjs) so the
 * rule never drifts between them.
 * @param {Map<string, string>|null} beings @param {string} agentName
 * @returns {SpeechAuthorClass} */
export function classifySpeechAuthor(beings, agentName) {
  if (isSystemAuthor(agentName)) return { kind: "system" };
  const canonical = canonicalBeingName(beings, agentName);
  if (canonical) return { kind: "being", canonical, aliased: canonical !== String(agentName ?? "") };
  return { kind: "human" };
}

/** sums `systemNotices`/`reclassed`/`aliasMatches` across every per-room
 * row (streams.mjs's `countGroup` for a dry run, or `records.mjs`'s
 * `buildRoom` stats spread onto `cli.mjs`'s `written` for a real one) into
 * one report-ready summary — shared so the two report paths never drift.
 * `withHandle`: a real run's rows carry a resolved handle; a dry run's
 * don't (no identity map exists before a write, no salt required). */
export function summarizeSpeechClassification(rows, { withHandle = false } = {}) {
  const reclassed = new Map();
  const aliasMatches = new Map();
  let systemNotices = 0;
  for (const row of rows) {
    systemNotices += row.systemNotices ?? 0;
    for (const x of row.reclassed ?? []) {
      const cur = reclassed.get(x.name) ?? { handle: withHandle ? x.handle : null, count: 0 };
      cur.count += x.count;
      reclassed.set(x.name, cur);
    }
    for (const x of row.aliasMatches ?? []) {
      const cur = aliasMatches.get(x.name) ?? { canonical: x.canonical, count: 0 };
      cur.count += x.count;
      aliasMatches.set(x.name, cur);
    }
  }
  return {
    systemNotices,
    reclassed: [...reclassed.entries()].map(([name, r]) => ({ name, handle: r.handle, count: r.count })),
    aliasMatches: [...aliasMatches.entries()].map(([name, r]) => ({
      name,
      canonical: r.canonical,
      count: r.count,
    })),
  };
}
