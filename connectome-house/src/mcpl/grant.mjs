// @ts-check
/* harness/src/mcpl/grant.mjs — what this house advertises to an MCPL
 * server and what it is willing to grant (SPEC §5.2–§5.4): the grant is
 * a host-computed allowlist, advertisement is input never authorization,
 * absence is denial. Pure; no wire. */
import { advertisedPaths } from "./wire.mjs";

/** what this house is willing to grant at all — intersected with what the
 * server advertises (§5.4: advertisement is input, never authorization).
 * No `channels.streaming` (never delivery; the double-post path), no
 * `contextHooks.*` (the house injects nothing), no `inferenceRequest`
 * (accepted as a house event, never auto-run). */
export const HOST_GRANT_ALLOWLIST = [
  "tools",
  "pushEvents",
  "inferenceLifecycle",
  "channels.register",
  "channels.lifecycle",
  "channels.publish",
  "channels.incoming",
  "channels.acknowledge",
  "channels.typing",
];

/** the host's own `experimental.mcpl` advertisement (§5.2) */
export const HOST_MCPL = {
  version: "0.5",
  pushEvents: true,
  inferenceLifecycle: true,
  channels: {
    register: true,
    lifecycle: true,
    publish: true,
    incoming: true,
    acknowledge: true,
    typing: true,
  },
  featureSets: true,
};

/** the grant: allowlist ∩ advertised; `tools` rides on the outer MCP
 * capability.
 * @param {unknown} capabilities @returns {string[]} */
export function computeGrant(capabilities) {
  const adv = advertisedPaths(capabilities);
  return HOST_GRANT_ALLOWLIST.filter((p) => adv.has(p));
}
