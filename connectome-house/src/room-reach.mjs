// @ts-check
/* The one room-reachability rule, shared by resident-life.mjs's
 * compileFor/appendPeriod and user-notes.mjs's selfNoteReachable — must
 * never drift between the two callers. */

/**
 * Can something formed in a room whose OTHER people (self excluded) were
 * `sourceOthers` be opened in a room whose present humans (self excluded)
 * are `destHumans`?
 *
 *  - sourceOthers empty            → true   (the being's own; it lives in the trunk)
 *  - every sourceOther consents    → true   (widened to the trunk: consentOf = group_visible)
 *  - destHasWalker                 → false  (a model walker / another being is a public audience)
 *  - destHumans empty              → false  (alone = trunk only; no solitary rumination on private rooms)
 *  - else                          → destHumans ⊆ sourceOthers  (everyone present now was there then)
 *
 * @param {{sourceOthers: Iterable<string>, destHumans: Iterable<string>,
 *   destHasWalker: boolean, consentOf: (handle: string) => boolean}} args
 */
export function reachable({ sourceOthers, destHumans, destHasWalker, consentOf }) {
  const src = new Set(sourceOthers);
  if (src.size === 0) return true;
  if ([...src].every((h) => consentOf(h))) return true;
  if (destHasWalker) return false;
  const dest = new Set(destHumans);
  if (dest.size === 0) return false;
  for (const h of dest) if (!src.has(h)) return false;
  return true;
}

/** sorted, deduped handles joined by "+" — the partition store's own
 * directory-naming key (`<privateRoot>/<handle>/life-with/<key>/`). */
export function partitionKey(people) {
  return [...new Set(people)].sort().join("+");
}

/**
 * From a run's class.json, the four facts both the life and the self-note
 * gate need about who else is (or was invited into) this room, relative to
 * `self` (the handle whose reach this is being computed for):
 *  - `others`: humans ≠ self — the owner (if not self) plus every ACCEPTED
 *    participant of kind absent or "human" (never pending).
 *  - `beings`: OTHER resident-kind participants (kind "resident", ≠ self)
 *    — every resident-kind participant is a BEING, not a walker:
 *    named here so a caller can tell WHO the other
 *    being(s) present are, distinct from a model walker's own kind.
 *  - `hasWalker`: true when some OTHER participant is a model walker
 *    (kind "walker"|"model") OR another being (kind "resident", ≠ self) —
 *    a second AI presence, model or being alike, is itself a public
 *    audience for this rule's purposes (the-life.md §3: partitions must
 *    not mount for a room another being shares).
 *  - `invited`: pending human invites (kind absent|"human", `pending: true`)
 *    — named at opening (serve-walks.mjs's `with:`) but not yet joined.
 * @param {any} cls @param {string} self
 * @returns {{others: string[], beings: string[], hasWalker: boolean, invited: string[]}}
 */
export function roomPeople(cls, self) {
  const others = new Set();
  const beings = new Set();
  const invited = [];
  let hasWalker = false;
  const owner = typeof cls?.owner === "string" ? cls.owner : null;
  if (owner && owner !== self) others.add(owner);
  for (const p of cls?.participants ?? []) {
    if (!p?.handle || p.handle === self) continue;
    const kind = p.kind;
    if (kind === "resident") {
      beings.add(p.handle);
      hasWalker = true;
      continue;
    }
    if (kind === "walker" || kind === "model") {
      hasWalker = true;
      continue;
    }
    if (!kind || kind === "human") {
      if (p.pending) invited.push(p.handle);
      else others.add(p.handle);
    }
  }
  return { others: [...others], beings: [...beings], hasWalker, invited };
}
