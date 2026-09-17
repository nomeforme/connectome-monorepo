// @ts-check
/* Lineage resolution across fork/Return chains — the READ-side counterpart
 * of loom.mjs's writeForkDir and serve-loom.mjs's continueRunLocked, which
 * both record a child's origin as `class.json.forkedFrom: {run, seq}` (an
 * ordinary fork and a Return share the one field; a Return's own
 * `continuation: true` marks which kind it was, immaterial to lineage
 * walking — both name a parent run id the same way).
 *
 * A chronicle blob is content-addressed (its filename IS its sha256), so a
 * fork/Return never copies blob files: it writes ONLY the
 * `class.json.forkedFrom` pointer, and `resolveBlobInLineage` reads from
 * whichever ancestor's own store holds the sha (own store first — the
 * common hit). The consequence: an ancestor's blobs are REFERENCED by its
 * descendants, and removing it breaks their chain (serve-paths.mjs's
 * `removeRun` refuses while any descendant still points at it).
 *
 * The `frames.jsonl` prefix copy stays a duplicate by design (small text;
 * `openTrace --resume` needs the prefix on disk) — see harness/README.md.
 *
 * Scope: the CHRONICLE substrate's content-addressed blobs only. The
 * jsonl-fallback substrate's `blob-<seq>-<timestamp>.txt` files carry no
 * hash to chain-resolve by, so loom.mjs and serve-loom.mjs still copy
 * those verbatim on fork/Return.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * @typedef {{ forkedFrom?: { run?: string, seq?: number } }} ClassJsonLineageFields
 */

/** read `<dir>/class.json`, honestly null on anything short of a parseable
 * object — a missing or corrupt file ends a lineage walk there, never
 * throws mid-chain.
 * @param {string} dir
 * @returns {ClassJsonLineageFields|null}
 */
function readClassJson(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "class.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * This run dir's ancestry: itself first, then its parent (per
 * `class.json.forkedFrom.run`), then its parent's parent, up to the root
 * (a run with no `forkedFrom`, or whose recorded parent no longer exists on
 * disk). Every ancestor is assumed to live as a sibling directory of its
 * child — true for every run this codebase writes: `writeForkDir` and
 * `continueRunLocked` both create the child under the SAME runs root the
 * parent lives in.
 *
 * Never throws: a missing/unparseable class.json, a parent id that isn't a
 * non-empty string, a parent dir that doesn't exist on disk, or a lineage
 * cycle (defensive only — should not occur) all end the walk with the
 * chain built so far. An honest partial chain beats a crash on a corrupt
 * record — and `missingAncestor` names the one case a reader must tell
 * apart: a parent the record still points at that is no longer on disk.
 *
 * @param {string} runDir
 * @returns {{chain: string[], missingAncestor: string|null}} `chain` is
 *   `[runDir, parentDir, grandparentDir, …]`, root last.
 */
export function lineageStatus(runDir) {
  const runsRoot = dirname(runDir);
  const chain = [runDir];
  const seen = new Set([runDir]);
  let dir = runDir;
  for (;;) {
    const cls = readClassJson(dir);
    const parentId = cls?.forkedFrom?.run;
    if (typeof parentId !== "string" || !parentId) break;
    const parentDir = join(runsRoot, parentId);
    if (seen.has(parentDir)) break;
    if (!existsSync(parentDir)) return { chain, missingAncestor: parentId };
    chain.push(parentDir);
    seen.add(parentDir);
    dir = parentDir;
  }
  return { chain, missingAncestor: null };
}

/** @param {string} runDir @returns {string[]} `lineageStatus(runDir).chain` */
export function lineageOf(runDir) {
  return lineageStatus(runDir).chain;
}

/**
 * Where a chronicle blob actually lives, walking `runDir`'s own lineage
 * (own store first, then parent, then parent's parent, …) — the single
 * entry point every blob reader goes through. `path` is the resolved file,
 * or `null` if no reachable ancestor's store holds the sha; when the chain
 * is broken (`missingAncestor`: an ancestor dir named by `forkedFrom` is
 * gone), a null `path` may mean the blob was there — the reader says so
 * rather than passing the miss off as an always-preview frame.
 *
 * @param {string} runDir
 * @param {string} sha
 * @returns {{path: string|null, missingAncestor: string|null}}
 */
export function resolveBlobInLineage(runDir, sha) {
  const { chain, missingAncestor } = lineageStatus(runDir);
  for (const dir of chain) {
    const path = join(dir, "chronicle", "blobs", sha.slice(0, 2), sha);
    if (existsSync(path)) return { path, missingAncestor: null };
  }
  return { path: null, missingAncestor };
}

/** @param {string} runDir @param {string} sha @returns {string|null} */
export function findBlobAcrossLineage(runDir, sha) {
  return resolveBlobInLineage(runDir, sha).path;
}
