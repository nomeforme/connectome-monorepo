// @ts-check
/* connectome-house/src/cache-budget.mjs — one turn's cache breakpoints,
 * fitted to the provider's ceiling: a life's own compiled messages and
 * the moving keeper breakpoint each place their own, and membrane passes
 * every one through. Ported near-verbatim from the reference harness
 * (harness/src/cache-budget.mjs) — pure and provider-agnostic, no archive
 * vocabulary to drop. */

/** Anthropic rejects a request with more than this many cache_control blocks. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** a block membrane's native request builder can carry cache_control on */
const cacheable = (b) =>
  b?.type === "tool_use" ||
  b?.type === "tool_result" ||
  (b?.type === "text" && typeof b.text === "string" && b.text !== "") ||
  (b?.type === "image" && b.source?.type === "base64");

/** a flagged message membrane will actually mark (an empty-text-only one it skips) */
const placesMarker = (m) =>
  m?.cacheBreakpoint === true && Array.isArray(m.content) && m.content.some(cacheable);

/**
 * Over budget, keep the first ⌊max/2⌋ breakpoints (stable prefixes) and the last ⌈max/2⌉
 * (life end, latest keeper message); the middle seams go, as flag-less copies.
 * @template {{cacheBreakpoint?: boolean, content?: any[]}} M
 * @param {M[]} messages
 * @param {number} [max]
 * @returns {{ messages: M[], supplied: number, kept: number }}
 */
export function fitCacheBreakpoints(messages, max = MAX_CACHE_BREAKPOINTS) {
  const marked = [];
  messages.forEach((m, i) => {
    if (placesMarker(m)) marked.push(i);
  });
  if (marked.length <= max) return { messages, supplied: marked.length, kept: marked.length };
  const head = Math.floor(max / 2);
  const drop = new Set(marked.slice(head, marked.length - (max - head)));
  const out = messages.map((m, i) => {
    if (!drop.has(i)) return m;
    const { cacheBreakpoint: _dropped, ...rest } = m;
    return /** @type {M} */ (rest);
  });
  return { messages: out, supplied: marked.length, kept: max };
}
