// @ts-check
/* connectome-history-import/src/beings.mjs — the known-beings set a VEIL
 * speech facet's `agentName` must be in to still mint a being. Without it:
 * a substream/workflow stream can record a HUMAN's typed messages as
 * speech facets whose `agentName` is the human's own display handle, and
 * an importer that treats every speech author as a bot mints a being out
 * of a person (docs/harness-port/04-history-restore.md §2 assumed VEIL
 * speech facets are always a being's own words; this is the case where
 * that assumption breaks).
 *
 * `--beings <path>` supplies the set; absent, `loadBeings` returns `null`,
 * read by `isKnownBeing` as "every name is a being" — today's behaviour,
 * unchanged for a caller that doesn't opt in. The caller (cli.mjs) is
 * responsible for the report's one-line warning when it's absent.
 */
import { readFileSync } from "node:fs";

/** `path` as either the fleet's own `bot-runtime/config.json` shape
 * (`{"bots":[{"name":…}, …]}`) or a plain `["name", …]` array.
 * @param {string|null} path
 * @returns {Set<string>|null} null = no file given */
export function loadBeings(path) {
  if (!path) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const names = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.bots)
      ? raw.bots.map((b) => b?.name)
      : [];
  return new Set(names.filter((n) => typeof n === "string" && n));
}

/** @param {Set<string>|null} beings @param {string} name */
export const isKnownBeing = (beings, name) => beings === null || beings.has(String(name ?? ""));
