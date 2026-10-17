// @ts-check
/**
 * Mention resolution. A post's mentions are the explicit `mentions` array
 * (principal ids; unknown ids are dropped) merged with every `@<display>`
 * token in the text, matched case-insensitively against principals'
 * display names with `_` or `-` standing in for spaces ("@Big_Bird" and
 * "@big-bird" both match display "Big Bird").
 */

/** @param {string} s */
export function normalizeHandle(s) {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, "_");
}

const TOKEN_RE = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu;

/**
 * @param {string} text
 * @param {unknown} explicit  the request's `mentions` (validated by the caller as string[] or undefined)
 * @param {{id: string, display: string}[]} principals
 * @returns {string[]} principal ids, explicit ones first, no duplicates
 */
export function resolveMentions(text, explicit, principals) {
  const known = new Set(principals.map((p) => p.id));
  /** @type {Map<string, string[]>} */
  const byHandle = new Map();
  for (const p of principals) {
    const h = normalizeHandle(p.display);
    const list = byHandle.get(h) ?? [];
    list.push(p.id);
    byHandle.set(h, list);
  }
  /** @type {string[]} */
  const out = [];
  /** @param {string} id */
  const add = (id) => {
    if (known.has(id) && !out.includes(id)) out.push(id);
  };
  if (Array.isArray(explicit)) for (const id of explicit) add(id);
  for (const m of text.matchAll(TOKEN_RE)) {
    // trailing punctuation is not part of the handle ("@fable." / "@fable-")
    const handle = normalizeHandle(m[1].replace(/[._-]+$/, ""));
    for (const id of byHandle.get(handle) ?? []) add(id);
  }
  return out;
}
