// @ts-check
/* connectome-house/src/commands/index.mjs — the command lane's one public
 * entry point: `handleCommand(msg, ctx) -> {reply, intent} | null`. Pure
 * except for store.mjs's own filesystem reads/writes (no wire, no room
 * loop). null means "not a command at all — let this message reach room
 * admission/dispatch exactly as any other" (03-house-design.md §5.4): the
 * caller (route.mjs, NOT this module — see this task's own report for the
 * named call site) must run this BEFORE room admission/decideActivation,
 * exactly like 00-stack-as-is.md §4.3's fork: "no command ever reaches
 * VEIL — it returns early in the receptor before any event is emitted."
 *
 * Three outcomes a caller must tell apart (all three come back as a
 * non-null object; only "not a command" is null):
 * - a reply with no intent (help, a query with no `N`, a validation error,
 *   a platform/permission refusal) — send the reply, do nothing else, the
 *   message never enters the record as a room turn.
 * - a reply AND an intent (most settings) — same, plus the loop applies
 *   the intent.
 * - `{reply: null, intent: {kind: "swallow"}}` — Signal's OWN rule (00
 *   §4.3, 02 C18): every `!`-prefixed line is swallowed there, recognized
 *   or not, with no reply and no record entry at all. A caller must not
 *   confuse this with `null` (not a command): `null` lets a Signal message
 *   fall through to room admission like ordinary text (which never
 *   happens here, precisely because grammar.mjs's BANG_RE + this
 *   function's own signal-swallow rule intercepts every `!`-line first). */
import { parseCommandLine } from "./grammar.mjs";
import { keeperHandlesFromEnv, isKeeperHandle } from "./permissions.mjs";
import { COMMANDS, EXTRA_HELP_LINES, lookup } from "./registry.mjs";
import { HELP_TEXT_DISCORD, HELP_TEXT_WEB } from "./fork-replies.mjs";

/** @typedef {import("./registry.mjs").CommandCtx} CommandCtx */
/** @typedef {import("./registry.mjs").CommandResult} CommandResult */

/**
 * @typedef {Object} HandleCommandCtx
 * @property {"discord"|"signal"|"web"} platform
 * @property {string|null} [roomKey] the room's stream key; required for
 *   every scope except a bare "global" command run with none open (rare —
 *   `!secret` still wants one, so pass it whenever a room exists at all)
 * @property {string} by the sender's house handle
 * @property {string|null} [being] see registry.mjs's CommandCtx
 * @property {(handle: string) => boolean} [isKeeper] a caller-supplied
 *   predicate (e.g. routeIncoming's own deps) — when omitted, falls back
 *   to HOUSE_KEEPERS (permissions.mjs), never the other way around
 */

/** !help's per-platform text (C1's own target home: "static per-platform
 * text table"). harness-port P-A (parity round, 2026-09-17): Discord and
 * web now return the fork's own `handleHelp()` text BYTE-FOR-BYTE
 * (fork-replies.mjs's HELP_TEXT_DISCORD/HELP_TEXT_WEB) — this is also a
 * correction: a prior round's own version filtered out keeper-only
 * commands for a non-keeper asker, which the fork never does (discord-
 * command-effector.ts:144 `handleHelp()` takes NO arguments at all — the
 * exact same text for every asker, keeper or not; permission is enforced
 * only when a command actually RUNS). `isKeeper` is kept as a parameter
 * for call-site stability but no longer filters anything.
 *
 * Signal falls back to the generic per-registry-usage-line list this
 * function always produced — the fork's own signal !help EMBEDS LIVE
 * config values inline (signal-command-effector.ts:148-206, "Current:
 * ${config.randomReplyChance}" etc.), which this pure, state-free function
 * has no way to reproduce byte-for-byte; named as a gap in this task's
 * report (out of its Discord+web scope). @param {"discord"|"signal"|
 * "web"} platform @param {boolean} isKeeper @returns {string} */
export function helpTextFor(platform, isKeeper) {
  void isKeeper; // no longer filters — see this function's own header
  if (platform === "discord") return HELP_TEXT_DISCORD;
  if (platform === "web") return HELP_TEXT_WEB;
  const lines = COMMANDS.filter((c) => c.platforms.has(platform)).map((c) => c.usage);
  for (const extra of EXTRA_HELP_LINES) if (extra.platforms.has(platform)) lines.push(extra.usage);
  return `Commands available here:\n${lines.join("\n")}`;
}

/** @param {{text?: string}|string} msg @param {HandleCommandCtx} ctx
 * @returns {CommandResult|null} */
export function handleCommand(msg, ctx) {
  const text = typeof msg === "string" ? msg : (msg?.text ?? "");
  const parsed = parseCommandLine(text);
  if (!parsed) return null; // not a command shape at all — ordinary room turn

  const isKeeper = ctx.isKeeper ? ctx.isKeeper(ctx.by) : isKeeperHandle(ctx.by, keeperHandlesFromEnv());
  /** @type {CommandCtx} */
  const cctx = { platform: ctx.platform, roomKey: ctx.roomKey ?? null, by: ctx.by, being: ctx.being ?? null, isKeeper };

  if (parsed.kind === "continue") {
    // D·S only (00 §4.3); on web this text was never a trigger to begin
    // with — let it fall through as an ordinary message, unchanged.
    if (ctx.platform !== "discord" && ctx.platform !== "signal") return null;
    return { reply: null, intent: { kind: "continue", scope: "being", being: cctx.being } };
  }

  if (parsed.kind === "h-once") {
    // C8: D·W recognize it; Signal swallows it (02's own note, verbatim).
    if (ctx.platform === "signal") return { reply: null, intent: { kind: "swallow" } };
    if (ctx.platform !== "discord" && ctx.platform !== "web") return null;
    return {
      reply: null,
      intent: { kind: "input-trim", scope: "input", frames: parsed.frames, modelText: parsed.text },
    };
  }

  // parsed.kind === "bang"
  const spec = lookup(parsed.name);
  if (!spec) {
    // C18: an unrecognized `!x` — Signal swallows every `!`-line
    // regardless; Discord/web fall through as an ordinary message.
    if (ctx.platform === "signal") return { reply: null, intent: { kind: "swallow" } };
    return null;
  }
  if (!spec.platforms.has(ctx.platform)) {
    // A recognized command name this platform's own grammar never carries
    // (mission's own instruction: "refused per platform per 02", a
    // deliberate house-side improvement over the fork's silent fall-
    // through — see registry.mjs's file header and this task's report).
    // Signal still swallows the line either way (it swallows every `!`,
    // known or not, on its own platform) rather than "falling through".
    if (ctx.platform === "signal") return { reply: null, intent: { kind: "swallow" } };
    return { reply: `the !${spec.name} command isn't available here.`, intent: null };
  }
  if (spec.permission === "keeper" && !isKeeper) {
    return { reply: `!${spec.name} is keeper-only.`, intent: null };
  }
  const v = spec.validate(parsed.argsRaw, cctx);
  if (!v.ok) return { reply: v.error, intent: null };
  if (spec.name === "help") return { reply: helpTextFor(ctx.platform, isKeeper), intent: null };
  return spec.run(parsed.argsRaw, cctx);
}
