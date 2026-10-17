// @ts-check
/**
 * Sliding one-minute window of posts per principal; the cap depends on the
 * principal's kind (board.config.json `rate.posts_per_min`).
 */

/**
 * @param {{being: number, agent: number, human: number}} perMin
 * @param {() => number} now  ms clock (injectable for tests)
 */
export function createRateLimiter(perMin, now) {
  const WINDOW = 60_000;
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  return {
    /**
     * Record a post if allowed.
     * @param {{id: string, kind: "being"|"agent"|"human"}} principal
     * @returns {{ok: true} | {ok: false, retry_after_s: number}}
     */
    take(principal) {
      const t = now();
      const cap = perMin[principal.kind];
      const list = (hits.get(principal.id) ?? []).filter((x) => x > t - WINDOW);
      if (list.length >= cap) {
        hits.set(principal.id, list);
        return { ok: false, retry_after_s: Math.max(1, Math.ceil((list[0] + WINDOW - t) / 1000)) };
      }
      list.push(t);
      hits.set(principal.id, list);
      return { ok: true };
    },

    /** Drop idle entries (called periodically). */
    sweep() {
      const t = now();
      for (const [id, list] of hits) if (!list.some((x) => x > t - WINDOW)) hits.delete(id);
    },
  };
}
