// @ts-check
/* connectome-house/src/commands/registry.mjs — the `!` command table,
 * 02-user-contract.md §2 row by row (cited per entry as `C<n>`). Every
 * entry: which platforms recognize it (00-stack-as-is.md §4.3's own
 * per-command platform column), who may run it, what it touches (scope),
 * where its effect lives (persistence, store.mjs's three tiers),
 * argument validation, and `run` — pure except for store.mjs's own reads/
 * writes (no network, no room loop, no wire).
 *
 * REPLY TEXT HONESTLY: 02-user-contract.md is a target-design MAPPING
 * document, not a UI copy deck — it gives verbatim user-visible text for
 * exactly one case (`!stop` → `[Cycle stopped]`, C11, matching O30's
 * system-notice shape exactly) and states the others only as effects
 * ("room setting X", "being covenant field Y"). Every OTHER reply string
 * below is this module's own composition, in a plain confirming voice,
 * NOT a citation — flagged here once so no comment below has to repeat
 * it, and flagged again in this task's report.
 *
 * SCOPE VOCABULARY: `"room"` (the whole room, no one being), `"being-in-
 * room"` (one being, in the context of one room — most covenant fields),
 * `"global"` (axon-wide/keeper-wide, no room at all). `!stop`'s own scope
 * doesn't fit cleanly — 02 C11 describes it reaching "every open room the
 * being is seated in", i.e. one being, but EVERY room, not one — tagged
 * `"being"` here as the deliberate fourth bucket that one command needs;
 * see its own comment. */
import {
  globalSettingsGet,
  globalSettingsSet,
  memoryGet,
  memorySet,
  roomSettingsGet,
  roomSettingsSet,
  secretDelete,
  secretGet,
  secretList,
  secretSet,
} from "./store.mjs";

/** @typedef {"discord"|"signal"|"web"} Platform */
/** @typedef {"anyone"|"keeper"} Permission */
/** @typedef {"room"|"being-in-room"|"being"|"global"} Scope */
/** @typedef {"memory"|"room-persisted"|"global-persisted"|"none"} Persistence */
/**
 * @typedef {Object} CommandCtx
 * @property {Platform} platform
 * @property {string|null} roomKey null only for a command whose scope is "global"
 * @property {string} by the sender's house handle
 * @property {string|null} [being] which being this invocation targets, when
 *   the room seats more than one and the command needs to pick — null
 *   means "the room's only being, or every being" (see each command)
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

/** N|reset|off style args → {ok, value|error}. `off`/`reset` → null
 * (clears the setting back to its default). @param {string} argsRaw
 * @param {string[]} [extraWords] additional accepted bare words → null */
function parseCountOrClear(argsRaw, extraWords = ["off", "reset"]) {
  const s = argsRaw.trim();
  if (s === "") return { ok: true, value: undefined }; // query, not set
  if (extraWords.includes(s.toLowerCase())) return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: `expected a whole number or "${extraWords.join('"/"')}"`, };
  return { ok: true, value: Number(s) };
}

/** @type {CommandSpec[]} */
export const COMMANDS = [
  // C1 — static per-platform text table (index.mjs generates the actual
  // list; this entry exists so !help appears in its own listing and
  // carries platform/permission/scope like every other command).
  {
    name: "help",
    usage: "!help",
    c: "C1",
    platforms: DSW,
    permission: "anyone",
    scope: "room",
    persistence: "none",
    validate: () => ({ ok: true }),
    run: () => ({ reply: null, intent: null }), // index.mjs fills the reply (it owns the per-platform command list)
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
    validate: (a) => {
      const p = parseCountOrClear(a, ["off"]);
      return p.ok ? { ok: true } : { ok: false, error: p.error };
    },
    run: (a) => {
      const p = parseCountOrClear(a, ["off"]);
      if (p.value === undefined) {
        const cur = memoryGet(null, "dispatch.random_reply", 0);
        return { reply: `random reply is currently ${cur > 0 ? `1-in-${cur}` : "off"}.`, intent: null };
      }
      const value = p.value ?? 0;
      memorySet(null, "dispatch.random_reply", value);
      return {
        reply: value > 0 ? `random reply set to 1-in-${value}.` : "random reply turned off.",
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
    validate: (a) => {
      const p = parseCountOrClear(a, ["off"]);
      return p.ok ? { ok: true } : { ok: false, error: p.error };
    },
    run: (a) => {
      const p = parseCountOrClear(a, ["off"]);
      if (p.value === undefined) {
        const cur = memoryGet(null, "dispatch.bot_mention_budget", 1);
        return { reply: `bot-to-bot mention budget is currently ${cur}.`, intent: null };
      }
      const value = p.value ?? 0;
      memorySet(null, "dispatch.bot_mention_budget", value);
      return {
        reply: `bot-to-bot mention budget set to ${value}.`,
        intent: { kind: "setting", scope: "global", key: "dispatch.bot_mention_budget", value },
      };
    },
  },

  // C4 — room × (being or "*"); 00 marks this a no-op on web (recognized,
  // does nothing there — this module still validates/replies on web, and
  // leaves "is it actually a no-op" to the seat that reads the intent).
  {
    name: "mcf",
    usage: "!mcf [N|reset]",
    c: "C4",
    platforms: DSW,
    permission: "anyone",
    scope: "room",
    persistence: "memory",
    validate: (a) => {
      const p = parseCountOrClear(a);
      return p.ok ? { ok: true } : { ok: false, error: p.error };
    },
    run: (a, ctx) => {
      const p = parseCountOrClear(a);
      if (p.value === undefined) {
        const cur = memoryGet(ctx.roomKey, "context.max_frames", null);
        return { reply: `max context frames here: ${cur ?? "(default)"}.`, intent: null };
      }
      memorySet(ctx.roomKey, "context.max_frames", p.value);
      return {
        reply: p.value == null ? "max context frames reset to the default." : `max context frames set to ${p.value}.`,
        intent: { kind: "setting", scope: "room", key: "context.max_frames", value: p.value },
      };
    },
  },

  // C5 — echo only: 00 §4.3 confirms no consumer reads this today in the
  // fork either. Kept as a house verb that stores the value (so a future
  // consumer has something to read) but the reply says plainly it is not
  // wired to anything yet — never claim an effect this doesn't have.
  {
    name: "mmf",
    usage: "!mmf [N]",
    c: "C5",
    platforms: DSW,
    permission: "anyone",
    scope: "room",
    persistence: "memory",
    validate: (a) => {
      const s = a.trim();
      if (s === "") return { ok: true };
      return /^\d+$/.test(s) ? { ok: true } : { ok: false, error: "expected a whole number" };
    },
    run: (a, ctx) => {
      const s = a.trim();
      if (s === "") {
        const cur = memoryGet(ctx.roomKey, "memory.max_frames", null);
        return { reply: `memory frames here: ${cur ?? "(unset)"} (no consumer reads this yet).`, intent: null };
      }
      const value = Number(s);
      memorySet(ctx.roomKey, "memory.max_frames", value);
      return {
        reply: `memory frames set to ${value} (echoed only — no consumer reads this yet).`,
        intent: { kind: "setting", scope: "room", key: "memory.max_frames", value },
      };
    },
  },

  // C6 — being covenant field, live-settable, in-memory (00: "most other
  // commands are in-memory only, lost on restart" — mt is not one of the
  // two named exceptions).
  {
    name: "mt",
    usage: "!mt [N]",
    c: "C6",
    platforms: DS,
    permission: "anyone",
    scope: "being-in-room",
    persistence: "memory",
    validate: (a) => {
      const s = a.trim();
      if (s === "") return { ok: true };
      return /^\d+$/.test(s) && Number(s) > 0
        ? { ok: true }
        : { ok: false, error: "expected a positive whole number of tokens" };
    },
    run: (a, ctx) => {
      const s = a.trim();
      const key = `max_tokens:${ctx.being ?? "*"}`;
      if (s === "") {
        const cur = memoryGet(ctx.roomKey, key, null);
        return { reply: `max output tokens: ${cur ?? "(model default)"}.`, intent: null };
      }
      const value = Number(s);
      memorySet(ctx.roomKey, key, value);
      return {
        reply: `max output tokens set to ${value}.`,
        intent: { kind: "setting", scope: "being-in-room", key: "max_tokens", being: ctx.being ?? null, value },
      };
    },
  },

  // C7 — persists per-room, survives restart (00 §4.3 names this one of
  // the two persistence exceptions, verbatim).
  {
    name: "h-default",
    usage: "!h-default [N|off]",
    c: "C7",
    platforms: DS,
    permission: "anyone",
    scope: "room",
    persistence: "room-persisted",
    validate: (a) => {
      const p = parseCountOrClear(a, ["off"]);
      return p.ok ? { ok: true } : { ok: false, error: p.error };
    },
    run: (a, ctx) => {
      const p = parseCountOrClear(a, ["off"]);
      if (p.value === undefined) {
        const cur = roomSettingsGet(ctx.roomKey, "context.history_default", null);
        return { reply: `default history here: ${cur ?? "(off)"}.`, intent: null };
      }
      const value = p.value ?? null;
      roomSettingsSet(ctx.roomKey, "context.history_default", value);
      return {
        reply: value == null ? "default history turned off." : `default history set to ${value} messages, persisted.`,
        intent: { kind: "setting", scope: "room", key: "context.history_default", value },
      };
    },
  },

  // C11 — the one command 02 gives verbatim reply text for: "[Cycle
  // stopped]", per open room the being is seated in. Scope "being" is the
  // deliberate fourth bucket (see file header): this reaches every room
  // that being is live in, not just this one — the room loop (not this
  // module) is what actually knows every room a being is seated in, so
  // the intent only names the being; applying it room-by-room is the
  // loop's job, matching "you do not touch the loop".
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
      reply: "[Cycle stopped]",
      intent: { kind: "interrupt", scope: "being", being: ctx.being ?? null },
    }),
  },

  // C12 — queued at the turn's next tool boundary; per-being, per-room (a
  // steer aimed at whichever being's turn is actually running here).
  {
    name: "steer",
    usage: "!steer <msg>",
    c: "C12",
    platforms: DSW,
    permission: "anyone",
    scope: "being-in-room",
    persistence: "none",
    validate: (a) => (a.trim() ? { ok: true } : { ok: false, error: "usage: !steer <message>" }),
    run: (a, ctx) => ({
      reply: "steering the current turn.",
      intent: { kind: "steer", scope: "being-in-room", being: ctx.being ?? null, message: a },
    }),
  },

  // C13 — a forked room with a relay prefix rendered back into the
  // parent; structural (creates/points at a stream), not a plain
  // key/value, so its intent carries a direction instead of a value.
  {
    name: "stream",
    usage: "!stream in <name> | !stream out",
    c: "C13",
    platforms: DS,
    permission: "anyone",
    scope: "room",
    persistence: "memory",
    validate: (a) => {
      const w = a.trim().split(/\s+/).filter(Boolean);
      if (w[0] === "out" && w.length === 1) return { ok: true };
      if (w[0] === "in" && w.length === 2) return { ok: true };
      return { ok: false, error: "usage: !stream in <name> | !stream out" };
    },
    run: (a) => {
      const w = a.trim().split(/\s+/).filter(Boolean);
      if (w[0] === "out") return { reply: "leaving the substream.", intent: { kind: "stream", direction: "out" } };
      return {
        reply: `entering substream "${w[1]}".`,
        intent: { kind: "stream", direction: "in", name: w[1] },
      };
    },
  },

  // C14 — arms a per-room continuation posture; grammar allows trailing
  // params 00 traces to substream-tool.ts that this port does not resolve
  // from these two docs alone — accepted and carried verbatim as `rest`,
  // not interpreted, rather than guessed at.
  {
    name: "autotrigger",
    usage: "!autotrigger [on|off] …",
    c: "C14",
    platforms: DS,
    permission: "anyone",
    scope: "room",
    persistence: "memory",
    validate: (a) => {
      const w = a.trim().split(/\s+/).filter(Boolean);
      if (w.length === 0) return { ok: true };
      return ["on", "off"].includes(w[0]) ? { ok: true } : { ok: false, error: 'usage: !autotrigger [on|off] …' };
    },
    run: (a, ctx) => {
      const w = a.trim().split(/\s+/).filter(Boolean);
      if (w.length === 0) {
        const cur = memoryGet(ctx.roomKey, "autotrigger.on", false);
        return { reply: `autotrigger is ${cur ? "on" : "off"} here.`, intent: null };
      }
      const on = w[0] === "on";
      const rest = w.slice(1).join(" ");
      memorySet(ctx.roomKey, "autotrigger.on", on);
      return {
        reply: `autotrigger turned ${on ? "on" : "off"}.`,
        intent: { kind: "setting", scope: "room", key: "autotrigger.on", value: on, rest: rest || null },
      };
    },
  },

  // C15 — being covenant field, toggled live.
  {
    name: "tts",
    usage: "!tts [on|off]",
    c: "C15",
    platforms: DS,
    permission: "anyone",
    scope: "being-in-room",
    persistence: "memory",
    validate: (a) => {
      const s = a.trim().toLowerCase();
      return s === "" || s === "on" || s === "off" ? { ok: true } : { ok: false, error: "usage: !tts [on|off]" };
    },
    run: (a, ctx) => {
      const s = a.trim().toLowerCase();
      const key = `tts:${ctx.being ?? "*"}`;
      if (s === "") {
        const cur = memoryGet(ctx.roomKey, key, false);
        return { reply: `tts is ${cur ? "on" : "off"}.`, intent: null };
      }
      const on = s === "on";
      memorySet(ctx.roomKey, key, on);
      return {
        reply: `tts turned ${on ? "on" : "off"}.`,
        intent: { kind: "setting", scope: "being-in-room", key: "tts", being: ctx.being ?? null, value: on },
      };
    },
  },

  // C16 — being covenant: a persona overlay. 00/02 both document this as
  // persisting to a PER-BEING file in the fork (00 §4.3: "/workspace/
  // bot-config-overrides/<botName>.json"; 02 §2.1 calls it "a per-being
  // overlay file"). THIS TASK'S OWN BRIEF instructs `override` to persist
  // PER ROOM instead — a deliberate divergence from both source docs,
  // followed here because the brief is explicit, flagged here (and in
  // this task's report) rather than silently matching one source and
  // silently dropping the other.
  {
    name: "sysprompt",
    usage: "!sysprompt temp|override <text> | !sysprompt reset",
    c: "C16",
    platforms: DSW,
    permission: "anyone",
    scope: "being-in-room",
    persistence: "room-persisted",
    validate: (a) => {
      const [mode, ...rest] = a.trim().split(/\s+/);
      if (mode === "reset") return { ok: true };
      if (mode === "temp" || mode === "override")
        return rest.join(" ").trim() ? { ok: true } : { ok: false, error: `usage: !sysprompt ${mode} <text>` };
      return { ok: false, error: "usage: !sysprompt temp|override <text> | !sysprompt reset" };
    },
    run: (a, ctx) => {
      const [mode, ...rest] = a.trim().split(/\s+/);
      const text = rest.join(" ");
      const key = `sysprompt:${ctx.being ?? "*"}`;
      if (mode === "reset") {
        roomSettingsSet(ctx.roomKey, key, null);
        memorySet(ctx.roomKey, key, null);
        return {
          reply: "persona overlay reset to the testament.",
          intent: { kind: "setting", scope: "being-in-room", key: "sysprompt", being: ctx.being ?? null, value: null },
        };
      }
      if (mode === "temp") {
        memorySet(ctx.roomKey, key, text);
        return {
          reply: "persona overlay set for this session only (not persisted).",
          intent: { kind: "setting", scope: "being-in-room", key: "sysprompt", being: ctx.being ?? null, value: text, persisted: false },
        };
      }
      // override — divergence noted above: room-persisted here, per-being in the fork.
      roomSettingsSet(ctx.roomKey, key, text);
      return {
        reply: "persona overlay set and persisted for this room.",
        intent: { kind: "setting", scope: "being-in-room", key: "sysprompt", being: ctx.being ?? null, value: text, persisted: true },
      };
    },
  },

  // C17 — keeper-scoped secrets store, "reached through a mount, never
  // through the record" (02) — the one command this port makes
  // unambiguously keeper-only, independent of 02 §10 Q2's open question
  // about the others (rr/bb/sysprompt), because the target-home wording
  // itself says "keeper-scoped", not merely "sensitive".
  {
    name: "secret",
    usage: "!secret <name> <value> | !secret list | !secret delete <name>",
    c: "C17",
    platforms: DS,
    permission: "keeper",
    scope: "global",
    persistence: "global-persisted",
    validate: (a) => {
      const [first, ...rest] = a.trim().split(/\s+/).filter(Boolean);
      if (!first) return { ok: false, error: "usage: !secret <name> <value> | !secret list | !secret delete <name>" };
      if (first === "list") return { ok: true };
      if (first === "delete") return rest.length === 1 ? { ok: true } : { ok: false, error: "usage: !secret delete <name>" };
      return rest.length >= 1 ? { ok: true } : { ok: false, error: "usage: !secret <name> <value>" };
    },
    run: (a, ctx) => {
      const [first, ...rest] = a.trim().split(/\s+/).filter(Boolean);
      const roomKey = ctx.roomKey ?? "global";
      if (first === "list") {
        const names = secretList(roomKey);
        return { reply: names.length ? `secrets set here: ${names.join(", ")}` : "no secrets set here.", intent: null };
      }
      if (first === "delete") {
        const existed = secretDelete(roomKey, rest[0]);
        return {
          reply: existed ? `secret "${rest[0]}" deleted.` : `no secret named "${rest[0]}" was set.`,
          intent: existed ? { kind: "secret-deleted", name: rest[0] } : null,
        };
      }
      secretSet(roomKey, first, rest.join(" "));
      return { reply: `secret "${first}" stored.`, intent: { kind: "secret-set", name: first } };
    },
  },

  // C9 — Signal only; moot for Discord's hard 2000-char wall (00 §4.8).
  // Read live by the Signal MCPL server's own splitter per 02 — this
  // module only records the room's own preference.
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
      return /^\d+$/.test(s) ? { ok: true } : { ok: false, error: "usage: !split [N|auto|native|off]" };
    },
    run: (a, ctx) => {
      const s = a.trim().toLowerCase();
      if (s === "") {
        const cur = memoryGet(ctx.roomKey, "split", "auto");
        return { reply: `message split mode here: ${cur}.`, intent: null };
      }
      const value = /^\d+$/.test(s) ? Number(s) : s;
      memorySet(ctx.roomKey, "split", value);
      return {
        reply: `message split mode set to ${value}.`,
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
