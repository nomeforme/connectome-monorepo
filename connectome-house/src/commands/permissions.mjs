// @ts-check
/* connectome-house/src/commands/permissions.mjs — who may run a command.
 * Mirrors the exact allowlist mcpl/seat.mjs already builds for
 * `routeIncoming`'s own `isKeeper` (HOUSE_KEEPERS, comma-separated
 * handles) rather than inventing a second mechanism — this module reads
 * the same env var so a keeper is a keeper everywhere, without this
 * package importing seat.mjs (which owns the actual seat wiring, not this
 * one's to touch). A caller that already has an `isKeeper` predicate
 * (from routeIncoming's own deps) should pass it through `ctx.isKeeper`
 * instead of relying on this default — this is the fallback for a caller
 * that has none. */

/** @returns {string[]} */
export function keeperHandlesFromEnv() {
  return String(process.env.HOUSE_KEEPERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @param {string} handle @param {string[]} [keepers] @returns {boolean} */
export function isKeeperHandle(handle, keepers = keeperHandlesFromEnv()) {
  return keepers.includes(handle);
}
