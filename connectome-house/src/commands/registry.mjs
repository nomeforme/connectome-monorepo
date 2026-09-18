// @ts-check
/* connectome-house/src/commands/registry.mjs — the `!` command table,
 * 02-user-contract.md §2 row by row (cited per entry as `C<n>`). Every
 * entry: which platforms recognize it (00-stack-as-is.md §4.3's own
 * per-command platform column), who may run it, what it touches (scope),
 * where its effect lives (persistence, store.mjs's three-plus-one tiers),
 * argument validation, and `run` — pure except for store.mjs's own reads/
 * writes (no network, no room loop, no wire).
 *
 * harness-port P-A (parity round, 2026-09-17): every reply string below
 * now comes from `fork-replies.mjs`, which reproduces the fork's own
 * command-effector text byte-for-byte (discord-axon/signal-axon/web-axon
 * `*-command-effector.ts`, cited there per entry) — a prior round's own
 * header note ("REPLY TEXT HONESTLY... every reply is this module's OWN
 * composition, NOT a citation") no longer holds for Discord and web,
 * which this task's mission asked for explicitly; Signal is reproduced
 * too wherever the fork's own text was free to copy alongside Discord
 * (fork-replies.mjs's own header explains the one exception, !help).
 *
 * THREE SCOPING CORRECTIONS this round makes (see this task's report):
 * `!mt`, `!tts`, `!sysprompt` are NOT room-scoped in the fork — each
 * command-effector method takes no `streamId` at all (only `!mcf` and
 * `!h-default` do) because one command-effector instance exists per BOT,
 * not per room. A prior round (R2-B) persisted `!sysprompt override` per
 * room; this round moves it to store.mjs's new being-scoped persisted
 * tier, and moves `!mt`/`!tts` to the memory tier's GLOBAL bucket keyed
 * by being, matching the fork's own axon-wide-per-bot scope exactly.
 * `!mmf` (echo-only in the fork, no consumer, 00 §4.3) is ALSO moved to
 * the global bucket here for the same reason (RuntimeConfig.
 * maxMemoryFrames is axon-wide, not per-stream) even though room-turn.mjs
 * gives it a real effect this round that the fork itself never did (a
 * "change, argued": see room-turn.mjs's own header).
 *
 * SCOPE VOCABULARY: `"room"` (the whole room, no one being), `"being-in-
 * room"` (one being, in the context of one room — `!mcf`/`!h-default`,
 * which DO take a streamId in the fork), `"being"` (one being, GLOBAL —
 * `!mt`/`!tts`/`!sysprompt`, which do not), `"global"` (axon-wide, no
 * room, no being — `!rr`/`!bb`/`!mmf`). `!stop`'s own scope doesn't fit
 * cleanly either — 02 C11 describes it reaching "every open room the
 * being is seated in" — tagged `"being"` here as the deliberate fourth
 * bucket that command needs; see its own comment. */
import {
  beingSettingsGet,
  beingSettingsSet,
  memoryGet,
  memorySet,
  roomSettingsGet,
  roomSettingsSet,
  secretDelete,
  secretList,
  secretSet,
} from "./store.mjs";
import * as fork from "./fork-replies.mjs";
import { SIGNAL_COMMAND_REPLIES } from "../mcpl/signal.mjs";

/** @typedef {"discord"|"signal"|"web"} Platform */
/** @typedef {"anyone"|"keeper"} Permission */
/** @typedef {"room"|"being-in-room"|"being"|"global"} Scope */
/** @typedef {"memory"|"room-persisted"|"being-persisted"|"global-persisted"|"none"} Persistence */
/**
 * @typedef {Object} CommandCtx
 * @property {Platform} platform
 * @property {string|null} roomKey null only for a command whose scope is "global"
 * @property {string} by the sender's house handle
 * @property {string|null} [being] which being this invocation targets. A
 *   caller passes null for a BARE command (`!mcf 200`, `!mt 500`: every
 *   being present, or "no specific being" — the fork's own bare/stream-
 *   wide form) and a handle for an EXPLICITLY TARGETED one (`@vallynn
 *   !mcf 200`: the fork's own per-bot form) — this is exactly the
 *   distinction discord-command-effector.ts's own `targeted` boolean
 *   parameter draws; this port has no separate boolean, `being != null`
 *   carries the same information. A command whose fork form has no bare
 *   variant at all (`!mt`, `!tts`, `!sysprompt` — always "this one bot"
 *   because one command-effector instance exists per bot) reads `being`
 *   the same way but never offers a `"*"`/stream-wide fallback.
 * @property {boolean} isKeeper
 */
/**
 * @typedef {Object} CommandResult
 * @property {string|null} reply text to send back through the same MCPL
 *   server's send tool, attributed to the addressed being (03-house-design
 *   §5.3) — null means no chat-visible reply at all (continue, h-once)
 * @property {Record<string, any>|null} intent the typed effect for the
 *   room loop to apply; null when the command is pure confirmation/query
 *   with nothing for the loop to do
 */
/**
 * @typedef {Object} CommandSpec
 * @property {string} name
 * @property {string} usage a one-line grammar string, for !help
 * @property {string} c ref into 02-user-contract.md, e.g. "C2"
 * @property {Set<Platform>} platforms
 * @property {Permission} permission
 * @property {Scope} scope
 * @property {Persistence} persistence
 * @property {(argsRaw: string, ctx: CommandCtx) => {ok: true}|{ok: false, error: string}} validate
 * @property {(argsRaw: string, ctx: CommandCtx) => CommandResult} run
 */

const DSW = new Set(["discord", "signal", "web"]);
const DS = new Set(["discord", "signal"]);
const S_ONLY = new Set(["signal"]);

/** the fork's own numeric-arg parsing (`parseInt(args)`, no radix, no full-
 * string match — `"5abc"` parses to `5`, matching handleRandomReply et al
 * exactly, NOT the stricter `/^\d+$/` a prior round used). @param {string}
 * s @returns {number} NaN when nothing numeric leads the string */
function forkParseInt(s) {
  return parseInt(String(s ?? ""), 10);
}

/** the being name a reply string can safely embed. The fork's botName is
 * never absent (one command-effector per bot); the house's `ctx.being`
 * legitimately can be, for a bare/untargeted invocation in a room with no
 * single obvious being — CLOSEST FAITHFUL BEHAVIOUR (named here and in
 * this task's report), not a fork citation. @param {string|null} being */
function nameFor(being) {
  return being ?? "this bot";
}

/** harness-port P-F, 2026-09-17 (mission task 3; mcpl-signal/PARITY.md
 * §1's own named hook): a Signal invocation of rr/bb/mt/split/stop/steer
 * consults `SIGNAL_COMMAND_REPLIES` (mcpl/signal.mjs) FIRST — builder
 * P-B's byte-exact port of the fork's own `SignalCommandEffector`, the
 * source of truth for those six strings — falling back to fork-replies.mjs
 * (whose own text is already identical for these six, since discord-
 * command-effector.ts's body is byte-for-byte the same as signal-command-
 * effector.ts's for every one of them — see fork-replies.mjs's own per-
 * command citations) only when no override function is registered for a
 * given command name, or the platform isn't Signal at all. Every other
 * platform, and every other command, is untouched.
 * @param {string} name @param {string} argsRaw @param {CommandCtx} ctx
 * @param {Record<string, any>} state @returns {string|null} */
function signalReply(name, argsRaw, ctx, state) {
  if (ctx.platform !== "signal") return null;
  const fn = SIGNAL_COMMAND_REPLIES[name];
  return typeof fn === "function" ? fn(argsRaw, state) : null;
}

/** @type {CommandSpec[]} */
export const COMMANDS = [
  // C1 — !help's OWN text is generated by index.mjs's `helpTextFor`
  // (fork-replies.mjs's HELP_TEXT_DISCORD/HELP_TEXT_WEB, verbatim, for
  // those two platforms — see that function's own header for why signal
  // is a documented fallback, not a byte-exact reproduction).
  {
    name: "help",
    usage: "!help",
    c: "C1",
    platforms: DSW,
    permission: "anyone",
    scope: "room",
    persistence: "none",
    validate: () => ({ ok: true }),
    run: () => ({ reply: null, intent: null }), // index.mjs fills the reply
  },

  // C2 — axon-wide, every being, every room; resets on restart (memory).
  {
    name: "rr",
    usage: "!rr [N]",
    c: "C2",
    platforms: DSW,
    permission: "anyone",
    scope: "global",
    persistence: "memory",
    validate: (a, ctx) => {
      const s = a.trim();
      if (s === "") return { ok: true };
      const n = forkParseInt(s);
      return Number.isNaN(n) || n < 0 ? { ok: false, error: ctx.platform === "web" ? fork.rr.web.invalid() : fork.rr.invalid() } : { ok: true };
    },
    run: (a, ctx) => {
      const s = a.trim();
      const web = ctx.platform === "web";
      const override = signalReply("rr", a, ctx, {
        randomReplyChance: memoryGet(null, "dispatch.random_reply", 0),
      });
      if (s === "") {
        const cur = memoryGet(null, "dispatch.random_reply", 0);
        return { reply: override ?? (web ? fork.rr.web.query(cur) : fork.rr.query(cur)), intent: null };
      }
      const value = forkParseInt(s);
      memorySet(null, "dispatch.random_reply", value);
      return {
        reply: override ?? (web ? fork.rr.web.set(value) : fork.rr.set(value)),
        intent: { kind: "setting", scope: "global", key: "dispatch.random_reply", value },
      };
    },
  },

  // C3 — same shape as rr, the bot-to-bot mention budget.
  {
    name: "bb",
    usage: "!bb [N]",
    c: "C3",
    platforms: DSW,
    permission: "anyone",
    scope: "global",
    persistence: "memory",
    validate: (a, ctx) => {
      const s = a.trim();
      if (s === "") return { ok: true };
      const n = forkParseInt(s);
      return Number.isNaN(n) || n < 0 ? { ok: false, error: ctx.platform === "web" ? fork.bb.web.invalid() : fork.bb.invalid() } : { ok: true };
    },
    run: (a, ctx) => {
      const s = a.trim();
      const web = ctx.platform === "web";
      const override = signalReply("bb", a, ctx, {
        maxBotMentionsPerConversation: memoryGet(null, "dispatch.bot_mention_budget", 1),
      });
      if (s === "") {
        const cur = memoryGet(null, "dispatch.bot_mention_budget", 1);
        return { reply: override ?? (web ? fork.bb.web.query(cur) : fork.bb.query(cur)), intent: null };
      }
      const value = forkParseInt(s);
      memorySet(null, "dispatch.bot_mention_budget", value);
      return {
        reply: override ?? (web ? fork.bb.web.set(value) : fork.bb.set(value)),
        intent: { kind: "setting", scope: "global", key: "dispatch.bot_mention_budget", value },
      };
    },
  },

  // C4 — room × (being or "*"), range 10-2000, `reset` — the fork's own
  // per-stream-per-bot-or-wildcard override (discord/signal); web is a
  // materially simpler flat numeric config field, no scoping, no reset
  // (see fork-replies.mjs's own header — 02-user-contract.md's "W no-op"
  // was wrong, corrected in this task's doc diff too).
  {
    name: "mcf",
    usage: "!mcf [N|reset]",
    c: "C4",
    platforms: DSW,
    permission: "anyone",
    scope: "being-in-room",
    persistence: "memory",
    validate: (a, ctx) => {
      const s = a.trim();
      if (s === "" || /^(reset|off|default)$/i.test(s)) return { ok: true };
      const n = forkParseInt(s);
      const web = ctx.platform === "web";
      const bad = web ? Number.isNaN(n) || n < 10 : Number.isNaN(n) || n < 10 || n > 2000;
      return bad ? { ok: false, error: web ? fork.mcf.web.invalid() : fork.mcf.invalid() } : { ok: true };
    },
    run: (a, ctx) => {
      const s = a.trim();
      const web = ctx.platform === "web";
      const scopeKey = ctx.being ?? "*";
      const key = `context.max_frames:${scopeKey}`;
      if (web) {
        // flat, unscoped — a genuinely different (simpler) mechanism than
        // D/S's per-scope compound key below, never "context.max_frames:*".
        if (s === "") return { reply: fork.mcf.web.query(memoryGet(ctx.roomKey, "web.context.max_frames", 400)), intent: null };
        const value = forkParseInt(s);
        memorySet(ctx.roomKey, "web.context.max_frames", value);
        return { reply: fork.mcf.web.set(value), intent: { kind: "setting", scope: "room", key: "context.max_frames", value } };
      }
      if (!ctx.roomKey) return { reply: fork.mcf.noStream(), intent: null };
      if (s === "") {
        // NAMED GAP: the fork's own query path always checks the
        // RESPONDING bot's own override first (`this.botName`, always
        // known — one command-effector instance per bot), THEN falls
        // back to the stream-wide value, regardless of whether THIS
        // particular query was itself sent bare or @mention-targeted. The
        // house runs the command lane once per incoming message, before
        // any being is chosen to answer — `ctx.being` is only known when
        // the invocation text itself named one. Closest faithful
        // behaviour: show a per-bot override when `ctx.being` is known,
        // else stream-wide only — see this task's report.
        const botVal = ctx.being != null ? memoryGet(ctx.roomKey, `context.max_frames:${ctx.being}`, undefined) : undefined;
        const streamVal = memoryGet(ctx.roomKey, "context.max_frames:*", undefined);
        return { reply: fork.mcf.query({ botVal, streamVal, botName: nameFor(ctx.being) }), intent: null };
      }
      if (/^(reset|off|default)$/i.test(s)) {
        const hadOverride = memoryGet(ctx.roomKey, key, undefined) !== undefined;
        if (hadOverride) memorySet(ctx.roomKey, key, undefined);
        return {
          reply: fork.mcf.reset({ hadOverride, targeted: ctx.being != null, botName: nameFor(ctx.being) }),
          intent: hadOverride ? { kind: "setting", scope: "being-in-room", key: "context.max_frames", being: ctx.being ?? null, value: null } : null,
        };
      }
      const value = forkParseInt(s);
      memorySet(ctx.roomKey, key, value);
      return {
        reply: fork.mcf.set({ value, targeted: ctx.being != null, botName: nameFor(ctx.being) }),
        intent: { kind: "setting", scope: "being-in-room", key: "context.max_frames", being: ctx.being ?? null, value },
      };
    },
  },

  // C5 — axon-wide (RuntimeConfig.maxMemoryFrames has no streamId either),
  // echo-only in the fork (00 §4.3, no consumer) — room-turn.mjs gives it
  // a real effect this round (a "change, argued": the fork itself never
  // reads this back).
  {
    name: "mmf",
    usage: "!mmf [N]",
    c: "C5",
    platforms: DSW,
    permission: "anyone",
    scope: "global",
    persistence: "memory",
    validate: (a, ctx) => {
      const s = a.trim();
      if (s === "") return { ok: true };
      const n = forkParseInt(s);
      return Number.isNaN(n) || n < 10 ? { ok: false, error: ctx.platform === "web" ? fork.mmf.web.invalid() : fork.mmf.invalid() } : { ok: true };
    },
    run: (a, ctx) => {
      const s = a.trim();
      const web = ctx.platform === "web";
      if (s === "") {
        const cur = memoryGet(null, "memory.max_frames", 400);
        return { reply: web ? fork.mmf.web.query(cur) : fork.mmf.query(cur), intent: null };
      }
      const value = forkParseInt(s);
      memorySet(null, "memory.max_frames", value);
      return {
        reply: web ? fork.mmf.web.set(value) : fork.mmf.set(value),
        intent: { kind: "setting", scope: "global", key: "memory.max_frames", value },
      };
    },
  },

  // C6 — being covenant field, GLOBAL per being (no streamId in the fork's
  // own handleMaxTokens — corrected this round from a prior round's
  // room-scoped storage; see this module's own header).
  {
    name: "mt",
    usage: "!mt [N]",
    c: "C6",
    platforms: DSW,
    permission: "anyone",
    scope: "being",
    persistence: "memory",
    validate: (a, ctx) => {
      const s = a.trim();
      if (s === "") return { ok: true };
      const n = forkParseInt(s);
      return Number.isNaN(n) || n < 0 ? { ok: false, error: ctx.platform === "web" ? fork.mt.web.invalid() : fork.mt.invalid() } : { ok: true };
    },
    run: (a, ctx) => {
      const s = a.trim();
      const web = ctx.platform === "web";
      const key = `max_tokens:${ctx.being ?? "*"}`;
      const botName = nameFor(ctx.being);
      const override = signalReply("mt", a, ctx, {
        being: botName,
        maxOutputTokens: memoryGet(null, key, undefined),
      });
      if (s === "") {
        const cur = memoryGet(null, key, undefined);
        return { reply: override ?? (web ? fork.mt.web.query(botName, cur) : fork.mt.query(botName, cur)), intent: null };
      }
      const n = forkParseInt(s);
      const value = n === 0 ? undefined : n;
      memorySet(null, key, value);
      const reply = override ?? (value === undefined ? (web ? fork.mt.web.reset(botName) : fork.mt.reset(botName)) : web ? fork.mt.web.set(botName, value) : fork.mt.set(botName, value));
      return {
        reply,
        intent: { kind: "setting", scope: "being", key: "max_tokens", being: ctx.being ?? null, value: value ?? null },
      };
    },
  },

  // C7 — persists per (being, room): the fork's own `handleHistoryDefault`
  // DOES take a streamId (unlike mt/tts/sysprompt) AND is stored inside
  // the per-BOT overlay file (`historyDefaults[streamId]`) — genuinely
  // (being × room)-scoped, not just room-scoped as a prior round modeled
  // it. Corrected to key on both here.
  {
    name: "h-default",
    usage: "!h-default [N|off]",
    c: "C7",
    platforms: DS,
    permission: "anyone",
    scope: "being-in-room",
    persistence: "room-persisted",
    validate: (a) => {
      const s = a.trim().toLowerCase();
      if (s === "" || s === "off" || s === "disable" || s === "none") return { ok: true };
      const n = forkParseInt(a.trim());
      return Number.isNaN(n) || n < 0 ? { ok: false, error: fork.hDefault.invalid() } : { ok: true };
    },
    run: (a, ctx) => {
      if (!ctx.roomKey) return { reply: fork.hDefault.noStream(), intent: null };
      const s = a.trim();
      const lower = s.toLowerCase();
      const key = `context.history_default:${ctx.being ?? "*"}`;
      const botName = nameFor(ctx.being);
      if (s === "") {
        const cur = roomSettingsGet(ctx.roomKey, key, undefined);
        return { reply: fork.hDefault.query(botName, cur), intent: null };
      }
      const value = lower === "off" || lower === "disable" || lower === "none" ? undefined : forkParseInt(s);
      roomSettingsSet(ctx.roomKey, key, value ?? null);
      return {
        reply: value === undefined ? fork.hDefault.off(botName) : fork.hDefault.set(botName, value),
        intent: { kind: "setting", scope: "being-in-room", key: "context.history_default", being: ctx.being ?? null, value: value ?? null },
      };
    },
  },

  // C11 — the command's OWN synchronous reply is "Stopping <bot>..."
  // (byte-identical on all three platforms) — NOT "[Cycle stopped]",
  // which is a separate, later, conditional notice the being's own
  // runtime posts only when a cycle was genuinely mid-generation
  // (connectome-agent-core/src/connectome-effector.ts:292-303) — see
  // fork-replies.mjs's own header for the citation and the correction
  // this makes to a prior round. That notice is posted by room-turn.mjs's
  // `applyInterrupt`, not here (this function only fires the intent).
  {
    name: "stop",
    usage: "!stop",
    c: "C11",
    platforms: DSW,
    permission: "anyone",
    scope: "being",
    persistence: "none",
    validate: () => ({ ok: true }),
    run: (_a, ctx) => ({
      reply: signalReply("stop", _a, ctx, { being: nameFor(ctx.being) }) ?? fork.stop.ack(nameFor(ctx.being)),
      intent: { kind: "interrupt", scope: "being", being: ctx.being ?? null },
    }),
  },

  // C12 — queued at the turn's next tool boundary; per-being, per-room.
  {
    name: "steer",
    usage: "!steer <msg>",
    c: "C12",
    platforms: DSW,
    permission: "anyone",
    scope: "being-in-room",
    persistence: "none",
    validate: (a, ctx) => (a.trim() ? { ok: true } : { ok: false, error: fork.steer.usage(ctx.platform) }),
    run: (a, ctx) => ({
      reply: signalReply("steer", a, ctx, { being: nameFor(ctx.being) }) ?? fork.steer.ack(ctx.platform, nameFor(ctx.being), a),
      intent: { kind: "steer", scope: "being-in-room", being: ctx.being ?? null, message: a },
    }),
  },

  // C13 — a forked room with a relay prefix rendered back into the
  // parent; structural (creates/points at a stream), not a plain
  // key/value, so its intent carries a direction instead of a value.
  //
  // CLOSED (mission task 2, this round): this entry's own reply/intent
  // shape was already right — room-fork.mjs (new) is the forked-room
  // primitive a prior round named as missing; mcpl/room-tails.mjs's
  // applyCommandAction reads this `{kind:"stream", direction, name}`
  // intent and actually forks/unforks the room (same `forkedFrom`
  // pointer shape connectome-history-import writes), seat.mjs's own
  // onFrame applies the fleet's own relay prefix (room-fork.mjs's own
  // `streamRelay`) to a fork's speech before it goes out.
  {
    name: "stream",
    usage: "!stream in <name> | !stream out",
    c: "C13",
    platforms: DS,
    permission: "anyone",
    scope: "room",
    persistence: "memory",
    validate: (a, ctx) => {
      const w = a.trim().split(/\s+/).filter(Boolean);
      if (w[0] === "out" && w.length === 1) return { ok: true };
      if (w[0] === "in" && w.length === 2) return { ok: true };
      return { ok: false, error: fork.stream.usage(ctx.platform) };
    },
    run: (a, ctx) => {
      const w = a.trim().split(/\s+/).filter(Boolean);
      const botName = nameFor(ctx.being);
      if (w[0] === "out") return { reply: fork.stream.out(botName), intent: { kind: "stream", direction: "out" } };
      return { reply: fork.stream.in(w[1], botName), intent: { kind: "stream", direction: "in", name: w[1] } };
    },
  },

  // C14 — arms a per-room continuation posture; the fork's own
  // "no `continue_substream` tool call this cycle = loop ends" rule and
  // its `--max-speech-only N` idle-cycle ejection are read live by
  // dispatch.mjs's `decideAutotriggerReactivation` (this task's mission
  // item 2) — this command only records the posture the room starts with.
  {
    name: "autotrigger",
    usage: "!autotrigger [on|off] …",
    c: "C14",
    platforms: DS,
    permission: "anyone",
    scope: "room",
    persistence: "memory",
    validate: () => ({ ok: true }), // the fork's own parser (below) never refuses a line — unrecognized tokens are silently ignored, matching handleAutoTrigger exactly
    run: (a, ctx) => {
      // mirrors discord/signal-command-effector.ts's handleAutoTrigger loop
      // exactly: EVERY token is scanned (not just the first), on/off may
      // appear anywhere, and unrecognized tokens are silently skipped.
      const w = a.trim().split(/\s+/).filter(Boolean);
      const botName = nameFor(ctx.being);
      let enable = true;
      let substreamName;
      let maxSpeechOnly;
      for (let i = 0; i < w.length; i++) {
        const part = w[i].toLowerCase();
        if (part === "off") enable = false;
        else if (part === "on") enable = true;
        else if (part === "--stream" && i + 1 < w.length) substreamName = w[++i];
        else if (part === "--max-speech-only" && i + 1 < w.length) {
          const v = forkParseInt(w[++i]);
          if (!Number.isNaN(v) && v > 0) maxSpeechOnly = v;
        }
      }
      memorySet(ctx.roomKey, "autotrigger.on", enable);
      if (enable) {
        memorySet(ctx.roomKey, "autotrigger.max_speech_only", maxSpeechOnly ?? 5);
        memorySet(ctx.roomKey, "autotrigger.idle_cycles", 0); // (re)arming always resets the idle counter
      }
      return {
        reply: enable ? fork.autotrigger.enabled(ctx.platform, { botName, substreamName, maxSpeechOnly }) : fork.autotrigger.disabled(ctx.platform, botName),
        intent: { kind: "setting", scope: "room", key: "autotrigger.on", value: enable, rest: substreamName ? `--stream ${substreamName}` : null },
      };
    },
  },

  // C15 — being covenant field, toggled live, GLOBAL per being (no
  // streamId in the fork's own handleTTS — corrected this round from a
  // prior round's room-scoped storage).
  {
    name: "tts",
    usage: "!tts [on|off]",
    c: "C15",
    platforms: DS,
    permission: "anyone",
    scope: "being",
    persistence: "memory",
    validate: (a) => {
      const s = a.trim().toLowerCase();
      return s === "" || ["on", "enable", "true", "1", "off", "disable", "false", "0"].includes(s) ? { ok: true } : { ok: false, error: fork.tts.invalidUsage() };
    },
    run: (a, ctx) => {
      const s = a.trim().toLowerCase();
      const key = `tts:${ctx.being ?? "*"}`;
      const botName = nameFor(ctx.being);
      if (s === "") {
        const cur = memoryGet(null, key, undefined);
        return { reply: fork.tts.query(botName, cur), intent: null };
      }
      const on = ["on", "enable", "true", "1"].includes(s);
      memorySet(null, key, on);
      return {
        reply: fork.tts.set(botName, on),
        intent: { kind: "setting", scope: "being", key: "tts", being: ctx.being ?? null, value: on },
      };
    },
  },

  // C16 — being covenant: a persona overlay. The fork persists `override`
  // to a PER-BEING file (`/workspace/bot-config-overrides/<botName>.json`,
  // no streamId in handleSysPrompt at all) — this round moves the house's
  // own persistence to match (store.mjs's new being-scoped tier),
  // correcting a prior round's per-room storage (this module's own
  // header, and this task's report).
  {
    name: "sysprompt",
    usage: "!sysprompt temp|override <text> | !sysprompt reset",
    c: "C16",
    platforms: DSW,
    permission: "anyone",
    scope: "being",
    persistence: "being-persisted",
    validate: (a, ctx) => {
      const [mode, ...rest] = a.trim().split(/\s+/);
      if (!mode) return { ok: true }; // query
      if (mode === "reset") return { ok: true };
      if (mode === "temp" || mode === "override")
        return rest.join(" ").trim() ? { ok: true } : { ok: false, error: fork.sysprompt.usageNeedsText(ctx.platform, mode) };
      return { ok: false, error: fork.sysprompt.usageBadMode(ctx.platform, mode) };
    },
    run: (a, ctx) => {
      const trimmed = a.trim();
      const being = ctx.being ?? "*";
      const botName = nameFor(ctx.being);
      const memKey = `sysprompt:${being}`;

      if (!trimmed) {
        const persisted = beingSettingsGet(being, "sysprompt", undefined);
        if (typeof persisted === "string" && persisted) {
          const preview = fork.truncatePreview(persisted, 400);
          const updatedAt = beingSettingsGet(being, "sysprompt_updated_at", null);
          const ts = updatedAt ? new Date(updatedAt).toISOString() : "unknown";
          return { reply: fork.sysprompt.statusPersisted(ctx.platform, { botName, len: persisted.length, updatedAt: ts, preview }), intent: null };
        }
        return { reply: fork.sysprompt.statusNone(ctx.platform, botName), intent: null };
      }

      const [mode, ...rest] = trimmed.split(/\s+/);
      const text = rest.join(" ");

      if (mode === "reset") {
        beingSettingsSet(being, "sysprompt", null);
        memorySet(null, memKey, null);
        return {
          reply: fork.sysprompt.reset(botName),
          intent: { kind: "setting", scope: "being", key: "sysprompt", being: ctx.being ?? null, value: null },
        };
      }

      if (!text) return { reply: fork.sysprompt.emptyPrompt(), intent: null };
      const byteLen = Buffer.byteLength(text, "utf8");
      if (byteLen > fork.MAX_SYSPROMPT_BYTES) return { reply: fork.sysprompt.tooLong(byteLen, fork.MAX_SYSPROMPT_BYTES), intent: null };

      if (mode === "temp") {
        memorySet(null, memKey, text);
        return {
          reply: fork.sysprompt.updated(ctx.platform, { botName, mode: "temp", text }),
          intent: { kind: "setting", scope: "being", key: "sysprompt", being: ctx.being ?? null, value: text, persisted: false },
        };
      }
      // override — now persists PER BEING (store.mjs's beingSettingsSet), matching the fork.
      beingSettingsSet(being, "sysprompt", text);
      beingSettingsSet(being, "sysprompt_updated_at", Date.now());
      memorySet(null, memKey, text);
      return {
        reply: fork.sysprompt.updated(ctx.platform, { botName, mode: "override", text }),
        intent: { kind: "setting", scope: "being", key: "sysprompt", being: ctx.being ?? null, value: text, persisted: true },
      };
    },
  },

  // C17 — keeper-scoped secrets store, "reached through a mount, never
  // through the record" (02) — unambiguously keeper-only.
  {
    name: "secret",
    usage: "!secret <name> <value> | !secret list | !secret delete <name>",
    c: "C17",
    platforms: DS,
    permission: "keeper",
    scope: "global",
    persistence: "global-persisted",
    validate: (a, ctx) => {
      const [first, ...rest] = a.trim().split(/\s+/).filter(Boolean);
      if (!first) return { ok: false, error: fork.secret.setUsage(ctx.platform) };
      if (first === "list") return { ok: true };
      if (first === "delete") return rest.length === 1 ? { ok: true } : { ok: false, error: fork.secret.deleteUsage(ctx.platform) };
      if (rest.length < 1) return { ok: false, error: fork.secret.setUsage(ctx.platform) };
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(first)) return { ok: false, error: fork.secret.invalidName() };
      return { ok: true };
    },
    run: (a, ctx) => {
      const [first, ...rest] = a.trim().split(/\s+/).filter(Boolean);
      const roomKey = ctx.roomKey ?? "global";
      if (first === "list") {
        const names = secretList(roomKey);
        return { reply: fork.secret.list(ctx.platform, names), intent: null };
      }
      if (first === "delete") {
        const existed = secretDelete(roomKey, rest[0]);
        return {
          reply: existed ? fork.secret.deleted(rest[0]) : fork.secret.notFound(rest[0]),
          intent: existed ? { kind: "secret-deleted", name: rest[0] } : null,
        };
      }
      const value = rest.join(" ");
      secretSet(roomKey, first, value);
      return { reply: fork.secret.stored(ctx.platform, first, value.length), intent: { kind: "secret-set", name: first } };
    },
  },

  // C9 — Signal only; moot for Discord's hard 2000-char wall (00 §4.8).
  {
    name: "split",
    usage: "!split [N|auto|native|off]",
    c: "C9",
    platforms: S_ONLY,
    permission: "anyone",
    scope: "room",
    persistence: "memory",
    validate: (a) => {
      const s = a.trim().toLowerCase();
      if (s === "" || s === "auto" || s === "native" || s === "off") return { ok: true };
      const n = forkParseInt(s);
      return Number.isNaN(n) || n < 0 ? { ok: false, error: fork.split.invalid() } : { ok: true };
    },
    run: (a, ctx) => {
      const s = a.trim().toLowerCase();
      const DEFAULT_SPLIT = 400; // signal-command-effector.ts's own env-configured default (typical value); see the split test's own note
      if (s === "") {
        const cur = memoryGet(ctx.roomKey, "split", DEFAULT_SPLIT);
        const override = signalReply("split", a, ctx, { current: cur, def: DEFAULT_SPLIT });
        return { reply: override ?? fork.split.query(cur, DEFAULT_SPLIT), intent: null };
      }
      let value;
      if (s === "auto") value = DEFAULT_SPLIT;
      else if (s === "native" || s === "off") value = 0;
      else value = forkParseInt(s);
      memorySet(ctx.roomKey, "split", value);
      const override = signalReply("split", a, ctx, { current: value, def: DEFAULT_SPLIT });
      return {
        reply: override ?? (value === 0 ? fork.split.disabled() : fork.split.set(value)),
        intent: { kind: "setting", scope: "room", key: "split", value },
      };
    },
  },
];

/** the two shapes grammar.mjs recognizes OUTSIDE the bang table (continue,
 * h-once) — carried here only so !help can list them too; index.mjs is
 * still what actually runs them (registry.mjs holds no logic for either).
 * @type {{usage: string, platforms: Set<Platform>}[]} */
export const EXTRA_HELP_LINES = [
  { usage: "!continue (or: m continue | m go | m more)", platforms: DS },
  { usage: "!h<N> <text> — one-shot context trim for this message only", platforms: new Set(["discord", "web"]) },
];

/** name/alias → spec, case-insensitive. @type {Map<string, CommandSpec>} */
export const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** @param {string} name @returns {CommandSpec|undefined} */
export function lookup(name) {
  return BY_NAME.get(String(name ?? "").toLowerCase());
}
