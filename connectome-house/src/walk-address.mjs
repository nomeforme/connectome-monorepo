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
 * fires on the life alone, not only when a room id happens to be present.
 *
 * harness-port 34 (docs/harness-port/34-typing-after-decision.md):
 * `address_mode` (testaments.mjs's `addressModeFor`) — `"verbatim"`
 * (default) makes a being's own `## Address` text the WHOLE composed
 * turn address, nothing else assembled around it (the old fleet's own
 * system-prompt shape, as-is — the wire's own mandatory header, when
 * this turn's route carries one, still precedes it; that's auth.mjs's
 * own layer, untouched here). `"append"` is today's shape unchanged. The
 * WIRE_NAMING line itself now only rides when this being's own route is
 * the wire's OAuth one — a covenant naming its own `endpoint`/
 * `use_api_key` (an openai-compatible backend, e.g. plantoid's Qwen)
 * never sees that wire header at all, so naming it would be naming a
 * condition that was never actually true for this turn. */
import { readFileSync } from "node:fs";
import { testamentFor, splitFrontmatter, addressSection, addressModeFor, COVENANTS_DIR } from "./testaments.mjs";
import { STANDING, WIRE_NAMING, boardRoomLine, identityLine, reconcileLine, lifeText, skillsText } from "./walk-address-strings.mjs";
import { presenceNote } from "./who-address.mjs";
import { roomText } from "./room-address.mjs";
import { toolsText } from "./platform-tools-address.mjs";
import { inlineBody } from "./skills.mjs";

/** harness-port task-0 (root cause of the plantoid 17:15 reply, verified
 * live): a being-hosted container that never got `HOUSE_COVENANTS_DIR`
 * resolves `COVENANTS_DIR()` to a path that doesn't exist THERE (the
 * house's own private-root-relative default), so `testamentFor(handle)`
 * silently returns null and every turn falls through to the full house
 * address with no persona at all — indistinguishable, from inside a
 * turn, from "this being genuinely has no covenant". Logged once per
 * handle per process (a misconfigured being turns forever, this would
 * otherwise spam once per turn). */
const missingCovenantLogged = new Set();

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
  if (!t) {
    if (!missingCovenantLogged.has(handle)) {
      missingCovenantLogged.add(handle);
      console.error(
        `[address] no covenant found for @${handle} in ${COVENANTS_DIR()} — ` +
          "no persona reaches this being's turn; the full house address rides unfiltered " +
          "(first turn only logged; check HOUSE_COVENANTS_DIR if this being does hold a covenant file).",
      );
    }
    return "";
  }
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

/** whether `handle`'s own covenant names a route OTHER than the wire's
 * mandatory OAuth-Anthropic one — the one fact `systemFor()` can already
 * see (testaments.mjs's own raw frontmatter, the same file `personaFor()`
 * already reads) without walker.mjs threading a route fact through. An
 * `endpoint` or `use_api_key` field (an openai-compatible backend, e.g.
 * plantoid's Qwen) is concrete evidence this turn never reaches the
 * OAuth route at all; absent both, this house assumes the common case
 * (the route WIRE_NAMING has always named) rather than guessing a route
 * it has no evidence for. @param {string} handle @returns {boolean} */
function isOAuthRoute(handle) {
  const cov = testamentFor(handle)?.covenant;
  return !(cov?.endpoint || cov?.use_api_key);
}

/** @param {any[]|undefined} skills */
function withInlineBodies(skills) {
  if (!Array.isArray(skills)) return skills;
  return skills.map((s) => {
    if (!s?.inline) return s;
    try {
      return { ...s, body: inlineBody(s) };
    } catch {
      return s;
    }
  });
}

/**
 * @param {{
 *   being: string,
 *   covenant: {model: string, tools: string[], posture: string, skills?: {name: string, description: string, location: string}[]},
 *   context: {conversation?: {participant: string}[], life?: object|null, room?: {id: string}|null},
 * }} f
 */
export function systemFor(f) {
  const persona = personaFor(f.being);
  // a skill the house marked inline (an external room): loaded in full here,
  // where the shared workspace its `inline-with:` files live in is mounted
  f = { ...f, covenant: { ...f.covenant, skills: withInlineBodies(f.covenant.skills) } };
  // address_mode "verbatim" (default): the being's own `## Address` text
  // IS the whole address — nothing else from the house assembled around
  // it, the old fleet's own system-prompt shape, as-is. Only takes effect
  // when there's actually persona text to carry; no `## Address` section
  // falls through to the ordinary full assembly below regardless of mode
  // (persona-less, one log line — unchanged from before this round).
  // ...save how memory works, when a life rides (2026-10-05): the one
  // thing a being can't learn from its own address or its own context, and
  // without which an empty life and no life at all look the same from inside.
  if (persona && addressModeFor(f.being) === "verbatim")
    return [
      // the wire's own CLI line sits above even a verbatim address; without
      // this a being reads "you are Claude Code" as its identity
      isOAuthRoute(f.being) ? WIRE_NAMING : null,
      persona,
      skillsText(f.covenant.skills, f.covenant.tools),
      boardRoomLine(f.context.room),
      lifeText(!!f.context.life),
      // a life spans months and its lines carry no timestamps: the date is
      // what places "now" against it
      f.context.life ? `Today's date is ${new Date().toISOString().slice(0, 10)}.` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
  const participants = (f.context.conversation ?? []).map((m) => m.participant);
  const parts = [
    isOAuthRoute(f.being) ? WIRE_NAMING : null,
    identityLine(f.being, f.covenant.model),
    reconcileLine(f.being, f.covenant.model),
    persona,
    STANDING,
    roomText({
      roomId: f.context.room?.id ?? null,
      posture: f.covenant.posture,
      title: f.context.room?.title ?? null,
      platform: f.context.room?.platform ?? null,
      stream: f.context.room?.stream ?? null,
    }),
    lifeText(!!f.context.life),
    presenceNote(f.being, participants),
    toolsText(f.covenant.tools),
    skillsText(f.covenant.skills, f.covenant.tools),
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
  ].filter(Boolean);
  return parts.join("\n\n");
}
