// @ts-check
/* Dispatch summons a walker iff its @tag appears anywhere in the newly
 * arrived message (quoted text included); history is never rescanned.
 * Word-boundary matched so a name can't shadow-match inside a longer one. */

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param {string} name */
const boundaryRe = (name) => new RegExp(`@${escapeRe(name)}(?![\\w-])`);

/** Names from `names` whose @tag appears anywhere in `text`, roster order,
 * deduplicated.
 * @param {string} text
 * @param {string[]} names
 * @returns {string[]} */
export function mentionedNames(text, names) {
  const found = [];
  for (const n of names) {
    if (boundaryRe(n).test(text)) found.push(n);
  }
  return found;
}
