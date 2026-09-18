// @ts-check
/* connectome-house/src/walk-address.mjs — the address composed fresh for
 * each turn: the being's own testament persona (if any), the standing,
 * the room fragment, who else is present, and the tools this turn
 * offers. walker.mjs calls `systemFor(f)` once per turn (walk-turn.mjs's
 * own composition point) and never caches it — a keeper's testament edit,
 * or a newly registered tool, should reach the very next turn.
 *
 * Reduced from the reference harness's walk-address.mjs + address-
 * registry.mjs (a large declarative section registry threaded throughout
 * with archive/loom/paint/media sections and four speech-observation
 * modules — citation/frag/want/altitude seams): this port carries only
 * the generic shape — a being's persona, the room, who's present, tools
 * offered — composed directly rather than through a registry. No speech
 * modules at all: those observe and re-ground CITATIONS against an
 * archive this port's beings don't have. */
import { readFileSync } from "node:fs";
import { testamentFor, splitFrontmatter } from "./testaments.mjs";
import { STANDING } from "./walk-address-strings.mjs";
import { presenceNote } from "./who-address.mjs";
import { roomText } from "./room-address.mjs";
import { toolsText } from "./platform-tools-address.mjs";

/** a being's own testament BODY (persona prose, after the frontmatter
 * fence) — testaments.mjs's own scan caches the frontmatter, not the
 * body; re-read here each call, always current with a keeper's edit. No
 * testament at all (a bare model with no covenant file) is honest
 * silence, never a guessed persona. */
function personaFor(handle) {
  const t = testamentFor(handle);
  if (!t) return "";
  try {
    const { body } = splitFrontmatter(readFileSync(t.path, "utf8"));
    return body.trim();
  } catch {
    return "";
  }
}

/**
 * @param {{
 *   being: string,
 *   covenant: {model: string, tools: string[], posture: string},
 *   context: {conversation?: {participant: string}[], life?: object|null, room?: {id: string}|null},
 * }} f
 */
export function systemFor(f) {
  const persona = personaFor(f.being);
  const participants = (f.context.conversation ?? []).map((m) => m.participant);
  const parts = [
    persona,
    STANDING,
    roomText({ roomId: f.context.room?.id ?? null, posture: f.covenant.posture, hasLife: !!f.context.life }),
    presenceNote(f.being, participants),
    toolsText(f.covenant.tools),
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
  ].filter(Boolean);
  return parts.join("\n\n");
}
