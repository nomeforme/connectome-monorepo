// @ts-check
/* connectome-house/src/walk-address.mjs — the address composed fresh for
 * each turn: who's actually speaking (the wire's own header, named and
 * reconciled), the being's own testament persona (if any), the standing,
 * the room fragment, the memory bridge, who else is present, and the
 * tools this turn offers. walker.mjs calls `systemFor(f)` once per turn
 * (walk-turn.mjs's own composition point) and never caches it — a
 * keeper's testament edit, or a newly registered tool, should reach the
 * very next turn.
 *
 * Reduced from the reference harness's walk-address.mjs + address-
 * registry.mjs (a large declarative section registry threaded throughout
 * with archive/loom/paint/media sections and four speech-observation
 * modules — citation/frag/want/altitude seams): this port carries only
 * the generic shape — a being's persona, the room, who's present, tools
 * offered — composed directly rather than through a registry. No speech
 * modules at all: those observe and re-ground CITATIONS against an
 * archive this port's beings don't have.
 *
 * harness-port W-address-reconcile: three "you are" claims used to reach
 * one turn with nothing reconciling them — see walk-address-strings.mjs's
 * own header. `systemFor()` now opens with WIRE_NAMING + identityLine +
 * reconcileLine, in that order, BEFORE persona or anything else that
 * could name the being differently; `personaFor()` now reads only a
 * testament's delimited `## Address` section (never the whole body —
 * keeper-facing porting memo, an Origin paragraph, a quoted historical
 * line are none of them address); and the memory bridge (`lifeText`) now
 * fires on the life alone, not only when a room id happens to be present. */
import { readFileSync } from "node:fs";
import { testamentFor, splitFrontmatter, addressSection } from "./testaments.mjs";
import { STANDING, WIRE_NAMING, identityLine, reconcileLine, lifeText } from "./walk-address-strings.mjs";
import { presenceNote } from "./who-address.mjs";
import { roomText } from "./room-address.mjs";
import { toolsText } from "./platform-tools-address.mjs";

/** a being's own `## Address` section — the only part of its testament
 * BODY meant to reach the being directly (frontmatter is never read
 * here; testaments.mjs's own scan caches that separately). Re-read on
 * every call, always current with a keeper's edit. No testament at all
 * (a bare model with no covenant file) is honest silence, never a
 * guessed persona; a testament with no `## Address` section is ALSO
 * honest silence — the identity line above already states who's seated
 * here, so no body prose fills the gap — but the gap itself is logged
 * once per call so a keeper can see which files still owe one. */
function personaFor(handle) {
  const t = testamentFor(handle);
  if (!t) return "";
  try {
    const { body } = splitFrontmatter(readFileSync(t.path, "utf8"));
    const section = addressSection(body);
    if (section == null) {
      console.error(
        `[address] ${t.path} carries no '## Address' section — no persona prose reaches ` +
          `@${handle}'s turn; the keeper still owes this file one.`,
      );
      return "";
    }
    return section;
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
    WIRE_NAMING,
    identityLine(f.being, f.covenant.model),
    reconcileLine(f.being, f.covenant.model),
    persona,
    STANDING,
    roomText({ roomId: f.context.room?.id ?? null, posture: f.covenant.posture }),
    lifeText(!!f.context.life),
    presenceNote(f.being, participants),
    toolsText(f.covenant.tools),
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
  ].filter(Boolean);
  return parts.join("\n\n");
}
