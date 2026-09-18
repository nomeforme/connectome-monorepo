// @ts-check
/* connectome-house/src/platform-tools-address.mjs — the "your tools"
 * clause: names exactly the tool names THIS TURN's covenant offers
 * (room-turn.mjs's covenantExcerpt, wire-provided — never a static
 * declaration; empty until a platform executor is registered for a room,
 * per connectome-house/README.md's own "known gaps").
 *
 * Reduced from the reference harness's platform-tools-address.mjs (a
 * declarative address-registry.mjs section this port doesn't carry) into
 * a direct function. */

/** @param {string[]|undefined} toolNames */
export function toolsText(toolNames) {
  if (!toolNames?.length) return "";
  return `## Your tools\n\nThis room currently offers you: ${toolNames.map((t) => `\`${t}\``).join(", ")}.`;
}
