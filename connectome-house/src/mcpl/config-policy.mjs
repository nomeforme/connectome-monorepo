// @ts-check
/* connectome-house/src/mcpl/config-policy.mjs — pure validators split out
 * of config.mjs (410 lines, at cap, may not grow — harness-port W5-A,
 * 2026-09-19): a being's own `being_tools` allowlist (moved, unchanged),
 * and the two W5-A fields' shared constants (`rooms_policy`, `number_env`)
 * plus the one routing decision (`isPublicRoom`) route.mjs needs so IT
 * doesn't have to grow either (already 558 lines, also over cap). */

import { IDENTITY_GATES } from "./identity-gate.mjs";

/** a tool name's own shape — plain, lowercase, underscored (every server's own
 * tool names so far; never a handle, a platform id, or free text). */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** the seat's own speech tools — a being is never handed these through
 * `being_tools`: the seat already speaks through them (mcpl/speak.mjs), and a
 * being reaching them directly would double-post or bypass the room record
 * entirely. Stripped unconditionally, default or explicit override alike. */
export const NEVER_BEING_TOOLS = new Set(["send_message", "reply_message"]);

/** `raw` (an array, or absent) -> a deduped list of valid tool names, minus
 * the seat's own speech tools — or null when `raw` names nothing (the caller
 * falls back further). A non-string/malformed entry is dropped, not refused:
 * `being_tools` is an allowlist, so a typo just means one less tool offered.
 * @param {any} raw @returns {string[]|null} */
export function normalizeBeingTools(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    const name = String(t ?? "").trim();
    if (!TOOL_NAME_RE.test(name) || NEVER_BEING_TOOLS.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** the two valid `rooms_policy` values (config.mjs's own header: "listed",
 * today's behaviour, is the default when the field is unset). */
export const ROOMS_POLICIES = new Set(["listed", "any"]);

/** raw.identity_gate, validated: undefined stays undefined (the loader fills
 * the global default, then "off"); an unknown value is an error string naming
 * the server. Semantics live in identity-gate.mjs.
 * @param {any} raw @param {string} name @returns {string|undefined} */
export function parseIdentityGate(raw, name) {
  if (raw === undefined) return undefined;
  if (!IDENTITY_GATES.has(raw))
    return `${name}: identity_gate must be one of ${[...IDENTITY_GATES].map((v) => JSON.stringify(v)).join(", ")} (got ${JSON.stringify(raw)})`;
  return raw;
}

/** a bare env-var NAME shape — `number_env` names exactly one variable the
 * HOUSE itself reads (never a CHILD=HOUSE rename; that grammar is `env[]`'s
 * own, for a spawned child's imports, not this field's). */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** whether a room admits ANY sender (no linked-account/keeper gate): an
 * explicit `configured.public` always wins; absent that, "any" rooms_policy
 * defaults public (harness-port W5-A mission §1 — axon parity: every
 * stream the server delivers behaves as if `public: true` unless a keeper
 * named this exact stream with `public: false`).
 * @param {{public?: boolean}|null|undefined} configured
 * @param {"listed"|"any"|undefined} roomsPolicy @returns {boolean} */
export function isPublicRoom(configured, roomsPolicy) {
  if (configured?.public !== undefined) return configured.public === true;
  return roomsPolicy === "any";
}

/** hosted_by: default "house" (the house spawns the child — today's
 * behaviour); "being" — no child spawned here at all, a REMOTE host
 * bridged over the being's own socket connection instead (mcpl/
 * remote-host.mjs, harness-port W6, 2026-09-19: "each being's container
 * hosts its own platform children"). */
export const HOSTED_BY_VALUES = new Set(["house", "being"]);

/** raw.hosted_by, validated and defaulted, with the one rule that used to
 * live in config.mjs alone (a "house" server needs `command`; "being"
 * never does — the house never spawns it) — moved here so config.mjs,
 * already at its own cap, gains one call site rather than the branch.
 * Returns the resolved value ("house"/"being"), OR an error string — the
 * two never collide (HOUSE_BY_VALUES is a closed set); the caller checks
 * membership to tell them apart, matching validateServer's own
 * return-a-string-on-error convention everywhere else in this file.
 * @param {any} raw @param {string} name @returns {string} */
export function resolveHostedBy(raw, name) {
  const v = raw.hosted_by === undefined ? "house" : String(raw.hosted_by);
  if (!HOSTED_BY_VALUES.has(v)) return `${name}: hosted_by must be "house" or "being"`;
  if (v === "house" && (typeof raw.command !== "string" || !raw.command))
    return `${name}: command is required`;
  return v;
}

/** the seat's `audience` (mcpl/external-guard.mjs): "house" (unset reads the
 * same) or "external" — a public room outside the house, where sends are
 * scanned for identifying details before they leave. */
export const AUDIENCES = new Set(["house", "external"]);

/** raw.audience, validated like config-policy's parseIdentityGate:
 * undefined stays undefined (internal); an unknown value is an error string
 * naming the server — a typo must refuse the seat, never quietly leave an
 * external room unguarded.
 * @param {any} raw @param {string} name @returns {string|undefined} */
export function parseAudience(raw, name) {
  if (raw === undefined) return undefined;
  if (!AUDIENCES.has(raw)) return `${name}: audience must be "house" or "external" (got ${JSON.stringify(raw)})`;
  return raw;
}
