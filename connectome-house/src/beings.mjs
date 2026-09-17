// @ts-check
/* harness/src/beings.mjs — which beings a room holds, read from its
 * class.json. A leaf on purpose: resident-life.mjs (the life) and
 * serve-beings.mjs (the house's per-being plumbing) both need this one
 * reading, and serve-beings imports resident-life, so neither can own it. */

/** every kind:"resident" participant handle in `participants` — pending or
 * accepted alike (a resident named at all is a being this room is FOR),
 * deduped and sorted for a stable field. Model walkers (kind "walker"/
 * "model") are never recorded as participants at all (serve-walks.mjs's
 * `--walkers` roster names them only in the spawned args), so they're
 * excluded by construction, never by a filter here.
 * @param {Array<{handle?: string, kind?: string}>|undefined|null} participants
 * @returns {string[]}
 */
export function beingsFromParticipants(participants) {
  return [
    ...new Set(
      (participants ?? [])
        .filter((p) => p?.kind === "resident" && typeof p.handle === "string" && p.handle)
        .map((p) => /** @type {string} */ (p.handle)),
    ),
  ].sort();
}

/** the effective beings list for a class.json shape: `cls.beings` when
 * present — even an explicit empty array, never re-derived — else the
 * legacy single-being fallback `cls.being ? [cls.being] : []`. Every reader
 * of "which beings does this room hold" goes through this.
 * @param {{beings?: unknown, being?: unknown}|null|undefined} cls
 * @returns {string[]}
 */
export function beingsOf(cls) {
  if (Array.isArray(cls?.beings)) return /** @type {string[]} */ (cls.beings);
  return typeof cls?.being === "string" && cls.being ? [cls.being] : [];
}
