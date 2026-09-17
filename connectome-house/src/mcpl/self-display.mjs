// @ts-check
/* harness/src/mcpl/self-display.mjs — the server's own bot, as the
 * PLATFORM shows it: an in-house, in-memory note of the rendered display
 * name a server's own being carries there (Discord's "vallynn" beside the
 * house's "@resident"), keyed `<platform>:<being>`. discord-mcpl never
 * reports this over the wire (initialize's serverInfo names only the
 * package; channels/register|open carry no self field; a self-authored
 * live message is dropped before it ever reaches the host) — the one
 * place it actually shows up is a channels/open history entry the being
 * spoke itself (fetchHistory does not filter self-authored messages the
 * way the live path does), matched by `being_id`; seat.mjs learns it
 * there and here, so route.mjs's inbound rewrite and serve-room-open.mjs's
 * platform surface both read one answer. A generic live message whose
 * author id matches is also accepted, for a future server that DOES
 * forward its own speech. Never persisted — a fresh process re-learns it;
 * an absent value is an honest "not yet known", never fabricated. */

/** @type {Map<string, string>} */
const known = new Map();

const key = (platform, being) => `${platform}:${being}`;

/** record the display name the platform showed for `being`'s own identity
 * on `platform` — a later call overwrites (the freshest sighting wins; a
 * display name a person can change on the platform itself).
 * @param {string} platform @param {string} being
 * @param {string|null|undefined} name */
export function noteSelfDisplay(platform, being, name) {
  if (!platform || !being || typeof name !== "string" || !name.trim()) return;
  known.set(key(platform, being), name.trim());
}

/** the display name learned for `being` on `platform`, or null when none
 * has been seen yet this process.
 * @param {string} platform @param {string} being @returns {string|null} */
export function selfDisplayFor(platform, being) {
  return known.get(key(platform, being)) ?? null;
}

/** test-only: forget everything learned (a fresh process's own state). */
export function resetSelfDisplay() {
  known.clear();
}
