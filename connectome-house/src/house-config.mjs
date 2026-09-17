// @ts-check
// The house's own filesystem roots, read once from an optional
// connectome-house/house-config.json (path via HOUSE_CONFIG_FILE). No
// import of serve-paths.mjs — that would cycle back into this file.
//
// Ported from a private deployment's house-config.mjs (2026-09-17): that
// source named several product-specific roots (a corpus's own compose
// pipeline, compiled wiki/answers output). This port keeps only what a
// generic house needs: where its record and per-person private state
// live, plus ONE optional `archive` mount a being's covenant may name
// (resident-covenant.mjs's `archiveMountedFor`) — a single directory, not
// a composition pipeline. Wiring an actual corpus behind that mount is a
// product-layer concern, left to whoever deploys this package.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");

// Every value below is the fallback when house-config.json is absent or
// omits a key.
export const DEFAULTS = {
  roots: {
    runs: join(PACKAGE_ROOT, "runs"),
    private: join(PACKAGE_ROOT, "private"),
  },
  // a being's optional archive mount (resident-covenant.mjs's
  // archiveMountedFor, resident-life.mjs's archive_glob/grep/read tools):
  // off by default — a deployer opts in by pointing `path` at a real
  // directory (house-config.json, or HOUSE_ARCHIVE_PATH).
  archive: {
    enabled: false,
    path: null,
  },
};

function readHouseJson() {
  const p = process.env.HOUSE_CONFIG_FILE || join(PACKAGE_ROOT, "house-config.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`[house-config] ${p} unreadable/malformed, defaults stand: ${e.message}`);
    return null;
  }
}

// A file's own `roots`/`archive` may name a SUBSET of keys, relative to
// PACKAGE_ROOT — anything it omits keeps the default.
function mergeRoot(defaults, fileSection) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(fileSection ?? {})) {
    if (k === "enabled") out.enabled = !!v;
    else if (typeof v === "string") out[k] = resolve(PACKAGE_ROOT, v);
  }
  return out;
}

let cached = null;
// Computed once per process; a test sets HOUSE_CONFIG_FILE (or the
// individual root env vars serve-paths.mjs reads) before its first call
// here.
export function houseConfig() {
  if (cached) return cached;
  const file = readHouseJson();
  cached = {
    roots: mergeRoot(DEFAULTS.roots, file?.roots),
    archive: {
      enabled:
        typeof file?.archive?.enabled === "boolean"
          ? file.archive.enabled
          : !!process.env.HOUSE_ARCHIVE_PATH || DEFAULTS.archive.enabled,
      path:
        (typeof file?.archive?.path === "string" ? resolve(PACKAGE_ROOT, file.archive.path) : null) ??
        process.env.HOUSE_ARCHIVE_PATH ??
        DEFAULTS.archive.path,
    },
  };
  return cached;
}

// test-only: drop the cache so a test setting HOUSE_CONFIG_FILE after an
// earlier houseConfig() call still sees its own file.
export function _resetHouseConfigCache() {
  cached = null;
}
