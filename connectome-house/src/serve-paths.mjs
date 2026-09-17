// @ts-check
/* Shared filesystem-root constants; every serve-*.mjs module derives its
 * paths from here instead of its own `import.meta.url` math. */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { houseConfig } from "./house-config.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
// this package's own root (connectome-house/), not the workspace root —
// every path this module hands out is package-local unless an env var
// points elsewhere.
export const PACKAGE_ROOT = resolve(HERE, "..");
const _roots = houseConfig().roots;
/** the run ledger's root — overridable via HOUSE_RUNS_DIR. Tests must never
 * hold a live path into the real ledger: a stray rm/rmSync against an
 * empty id here would delete the whole append-only conversation record.
 * Tests set HOUSE_RUNS_DIR to a throwaway mkdtemp sandbox instead. */
export const RUNS = process.env.HOUSE_RUNS_DIR || _roots.runs;

/** the private-roots PARENT dir — overridable via HOUSE_PRIVATE_DIR
 * (default <package>/private). Same sandboxing discipline as RUNS: a test
 * must set the env var before first importing this module. */
export const PRIVATE_DIR = process.env.HOUSE_PRIVATE_DIR || _roots.private;

/** a person's private root — their own overlay corpus, inbox, and kept
 * note all live under here (<PRIVATE_DIR>/<owner>/…). */
export const PRIVATE_ROOT = (owner) => join(PRIVATE_DIR, owner);

const RUN_ID_RE = /^[a-zA-Z0-9][\w.-]{5,}$/;

/** the run ids under RUNS whose `class.json.forkedFrom.run` names `id` —
 * its direct forks/Returns, which resolve their chronicle blobs through
 * it (lineage.mjs) rather than holding copies. */
export function runsReferencing(id) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(RUNS);
  } catch {
    return out;
  }
  for (const d of entries) {
    if (d === id) continue;
    try {
      const cls = JSON.parse(readFileSync(join(RUNS, d, "class.json"), "utf8"));
      if (cls?.forkedFrom?.run === id) out.push(d);
    } catch {
      /* no class.json, or unreadable — not a reference */
    }
  }
  return out.sort();
}

/** the only sanctioned way to delete a run directory. Throws (never a
 * silent no-op) unless `id` matches a real run-id shape, the resolved path
 * lands strictly inside RUNS, and that path is actually a directory.
 * Refuses — `{ok:false, reason, referencedBy}` — while another run's
 * lineage still points at it (`runsReferencing`), unless `force`: those
 * descendants would lose every blob they resolve through this record.
 * @param {string} id @param {{force?: boolean}} [opts]
 * @returns {{ok: true} | {ok: false, reason: string, referencedBy: string[]}} */
export function removeRun(id, { force = false } = {}) {
  if (!RUN_ID_RE.test(id ?? "")) {
    throw new Error(`removeRun: refusing an invalid run id ${JSON.stringify(id)}`);
  }
  const dir = resolve(RUNS, id);
  const runsResolved = resolve(RUNS);
  if (!dir.startsWith(runsResolved + sep)) {
    throw new Error(`removeRun: ${JSON.stringify(id)} resolves outside RUNS (${dir})`);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`removeRun: ${dir} is not a directory`);
  }
  const referencedBy = force ? [] : runsReferencing(id);
  if (referencedBy.length) {
    return {
      ok: false,
      reason: `${id} is an ancestor of ${referencedBy.join(", ")} — their blobs resolve through it; pass {force:true} to remove it anyway`,
      referencedBy,
    };
  }
  rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/** the live-walk TREE cap's own default, when HOUSE_MAX_LIVE isn't set. */
export const DEFAULT_MAX_LIVE = 3;

/** the live-walk cap, read fresh on every call — never cached at
 * module-eval time, since a test may set the env var after this loads. */
export function maxLive() {
  return Number(process.env.HOUSE_MAX_LIVE || DEFAULT_MAX_LIVE);
}

/** a standing room's own pool — placeholder, the keeper's own number. */
export const DEFAULT_MAX_STANDING = 30;
export function maxStanding() {
  return Number(process.env.HOUSE_MAX_STANDING || DEFAULT_MAX_STANDING);
}

/** a standing room's idle-rest window — placeholder, defined, unenforced. */
export const DEFAULT_ROOM_IDLE_REST_MS = 30 * 60 * 1000;
export function roomIdleRestMs() {
  return Number(process.env.HOUSE_ROOM_IDLE_REST_MS || DEFAULT_ROOM_IDLE_REST_MS);
}
