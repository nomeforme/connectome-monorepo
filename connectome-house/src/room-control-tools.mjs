// @ts-check
/* connectome-house/src/room-control-tools.mjs — two tools a being uses to
 * keep a room from looping, with no keeper or config needed:
 *
 *   - `stop_being({being, minutes, reason})`: stop a being in this room
 *     (another, or oneself) and hush it for up to 30 minutes — it stays out
 *     of non-human traffic; a human's mention/reply/DM still wakes it.
 *   - `mark_ai({who, limit, reason})`: mark a participant's account as an
 *     AI account (identity-map.mjs's `markAI`), so it counts toward the
 *     bot-to-bot chain; may set or lower its chain limit.
 *
 * Revoking (un-marking, raising or removing a limit, lifting a hush early)
 * is a keeper's act, never a being's. Both tools write an audit house line
 * into the record (`message` by "house", `notice: "room-control"`).
 *
 * Offered only in a room with at least two participants, one of them
 * (besides the caller) a being or an AI-marked account —
 * `roomControlToolsFor`, read by room-turn.mjs's covenantExcerpt. The
 * walker mounts this module for its definitions only; `execute` runs in
 * the house (room-seats.mjs is imported lazily: it imports room-turn.mjs,
 * which imports house-tools.mjs, which imports this). */
import { beingsOf } from "./beings.mjs";
import { open } from "./open-rooms.mjs";
import { roomKeyForCls } from "./room-chain.mjs";
import { hushGet, hushSet } from "./commands/store.mjs";
import { handleForDisplay, kindOf, markAI } from "./identity-map.mjs";
import { testamentFor } from "./testaments.mjs";
import { isKeeperHandle } from "./commands/permissions.mjs";
import { traceReach } from "./trace.mjs";

export const ROOM_CONTROL_TOOLS = ["stop_being", "mark_ai"];
export const STOP_MAX_MINUTES = 30;
const CALLS_PER_WINDOW = 3;
const CALL_WINDOW_MS = 10 * 60_000;
/** a being-set hush shields its target from another being-set one this long */
const REHUSH_COOLDOWN_MS = 30 * 60_000;

/** caller|room|tool -> call times (in-memory; a restart forgets) */
const calls = new Map();
/** test-only */
export function _resetRoomControl() {
  calls.clear();
}

/** accepted participants (not pending) plus the room's beings.
 * @param {any} cls @returns {{handle: string, kind: string}[]} */
function participantsOf(cls) {
  const seen = new Map();
  for (const p of cls?.participants ?? []) if (p?.handle && !p.pending) seen.set(p.handle, p.kind ?? "human");
  for (const b of beingsOf(cls)) seen.set(b, "resident");
  return [...seen].map(([handle, kind]) => ({ handle, kind }));
}

/** @param {string} h */
const isBeing = (h) => !!testamentFor(h);

/** the room-control tools `handle` is offered in this room: both, when the
 * room holds at least two participants and one other than `handle` is a
 * being or an AI-marked account; none otherwise.
 * @param {any} rec an open room record ({cls}) @param {string} handle
 * @returns {string[]} */
export function roomControlToolsFor(rec, handle) {
  const people = participantsOf(rec?.cls);
  if (people.length < 2) return [];
  const others = people.filter((p) => p.handle !== handle);
  const ok = others.some((p) => p.kind === "resident" || p.kind === "walker" || isBeing(p.handle) || kindOf(p.handle) === "ai");
  return ok ? [...ROOM_CONTROL_TOOLS] : [];
}

/** @param {unknown} s */
const bare = (s) => String(s ?? "").trim().replace(/^@/, "");

/** @param {{houseLine?: (ctx: any, text: string) => void,
 *   interrupt?: (rec: any, being: string) => Promise<boolean>|boolean,
 *   now?: () => number}} [deps] */
export function makeRoomControlTools(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const houseLine =
    deps.houseLine ??
    ((ctx, text) => ctx?.trace?.frame("message", { by: "house", text, to: [], notice: "room-control" }));
  const interrupt =
    deps.interrupt ??
    (async (rec, being) => {
      const { applyInterrupt } = await import("./room-seats.mjs");
      return applyInterrupt(rec, being);
    });

  const definitions = [
    {
      name: "stop_being",
      description:
        "Stop a being in this room — another being caught in a loop, or yourself — and keep it out of non-human traffic for a while (a human's mention, reply or DM still wakes it). Use it when beings or outside AI accounts keep answering each other with no human in the exchange. Naming another being ends its current turn now; naming yourself means you end your turn right after this call. The room sees a line saying who stopped whom and why. Only a keeper can lift it early.",
      inputSchema: {
        type: "object",
        properties: {
          being: { type: "string", description: "the being's handle (yourself included); never a human" },
          minutes: { type: "integer", minimum: 0, maximum: STOP_MAX_MINUTES, description: "how long it stays hushed (0-30, default 10; 0 stops the turn only)" },
          reason: { type: "string", description: "one line: why — shown to the room" },
        },
        required: ["being", "reason"],
      },
    },
    {
      name: "mark_ai",
      description:
        "Mark a participant in this room as an AI account (an outside bot, not a person), so its messages count toward the bot-to-bot limit and stop waking beings in a loop. You may also set or lower how many back-and-forth turns its chains get. Un-marking or raising a limit is a keeper's decision — asking for that posts a request for a keeper instead.",
      inputSchema: {
        type: "object",
        properties: {
          who: { type: "string", description: "the participant's handle or display name, as it appears in this room" },
          limit: { type: "integer", minimum: 0, description: "optional: chain turns allowed for chains it takes part in (set one, or lower an existing one)" },
          remove_limit: { type: "boolean", description: "optional: ask a keeper to remove its limit (a being can't)" },
          reason: { type: "string", description: "one line: why you think this account is an AI" },
        },
        required: ["who", "reason"],
      },
    },
  ];

  let activeCtx = null;
  let activeHandle = null;
  function beginTurn(ctx, handle) {
    activeCtx = ctx;
    activeHandle = handle;
  }

  /** false (and no record) when the caller is over its window budget */
  function takeCall(caller, roomId, tool) {
    const key = `${caller}|${roomId}|${tool}`;
    const t = now();
    const recent = (calls.get(key) ?? []).filter((x) => t - x < CALL_WINDOW_MS);
    if (recent.length >= CALLS_PER_WINDOW) {
      calls.set(key, recent);
      return false;
    }
    recent.push(t);
    calls.set(key, recent);
    return true;
  }

  function roomOf(ctx) {
    const rec = ctx?.id ? open.get(ctx.id) : null;
    return rec?.cls ? rec : null;
  }

  async function stopBeing(ctx, caller, input) {
    const rec = roomOf(ctx);
    if (!rec) return { content: "stop_being works only in an open room." };
    if (!roomControlToolsFor(rec, caller).length) return { content: "stop_being is not offered in this room (no other being or AI account here)." };
    const target = bare(input?.being);
    const reason = String(input?.reason ?? "").trim().slice(0, 200);
    if (!reason) return { content: "give a reason — the room sees it." };
    if (!beingsOf(rec.cls).includes(target) || !isBeing(target))
      return { content: `@${target || "?"} is not a being in this room; stop_being only stops beings, never a person.` };
    const raw = input?.minutes ?? 10;
    const minutes = Math.max(0, Math.min(STOP_MAX_MINUTES, Math.round(Number(raw))));
    if (!Number.isFinite(minutes)) return { content: "minutes must be a number from 0 to 30." };
    const self = target === caller;
    const key = roomKeyForCls(rec.cls, rec.id);
    const t = now();
    if (!self) {
      const prior = hushGet(key, target);
      if (prior && prior.until > t)
        return { content: `@${target} is already hushed here until ${new Date(prior.until).toISOString()}; only a keeper changes that.` };
      if (prior && isBeing(prior.by) && t - prior.at < REHUSH_COOLDOWN_MS)
        return { content: `@${target} was stopped by a being less than 30 minutes ago; it can't be stopped by a being again yet — ask a keeper.` };
    }
    if (!takeCall(caller, rec.id, "stop_being"))
      return { content: `you have used stop_being ${CALLS_PER_WINDOW} times in this room in the last 10 minutes; wait, or ask a keeper.` };
    if (minutes > 0) hushSet(key, target, t + minutes * 60_000, { by: caller, reason });
    let stopped = false;
    if (!self) stopped = !!(await interrupt(rec, target));
    const span = minutes > 0 ? ` for ${minutes} min` : "";
    houseLine(ctx, `[@${caller} stopped @${target}${span} — ${reason}]`);
    if (self)
      return {
        content: `you are hushed here${span}. End your turn now: say nothing more. A human's mention, reply or DM still reaches you.`,
      };
    return {
      content: `@${target} ${stopped ? "was stopped mid-turn" : "had no open turn"}${minutes > 0 ? ` and is hushed here for ${minutes} min` : ""}. The room was told.`,
    };
  }

  /** a participant of this room by handle or display name, or null */
  function resolveWho(rec, who) {
    const name = bare(who);
    if (!name) return null;
    const people = participantsOf(rec.cls);
    if (people.some((p) => p.handle === name)) return name;
    const viaDisplay = handleForDisplay(rec.cls?.room?.platform ?? "", name);
    return viaDisplay && people.some((p) => p.handle === viaDisplay) ? viaDisplay : null;
  }

  function markAi(ctx, caller, input) {
    const rec = roomOf(ctx);
    if (!rec) return { content: "mark_ai works only in an open room." };
    if (!roomControlToolsFor(rec, caller).length) return { content: "mark_ai is not offered in this room." };
    const reason = String(input?.reason ?? "").trim().slice(0, 200);
    if (!reason) return { content: "give a reason — the room sees it." };
    const handle = resolveWho(rec, input?.who);
    if (!handle) return { content: `no participant in this room goes by "${bare(input?.who)}".` };
    if (isBeing(handle)) return { content: `@${handle} is a house being; mark_ai is for outside accounts.` };
    if (isKeeperHandle(handle)) return { content: `@${handle} is a keeper; a keeper is never marked as an AI account.` };
    let limit;
    const rawLimit = input?.limit;
    if (input?.remove_limit === true || rawLimit === "off" || rawLimit === null) limit = null;
    else if (rawLimit !== undefined && rawLimit !== "") {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 0) return { content: "limit must be a whole number of turns (0 or more), or 'off'." };
      limit = n;
    }
    if (!takeCall(caller, rec.id, "mark_ai"))
      return { content: `you have used mark_ai ${CALLS_PER_WINDOW} times in this room in the last 10 minutes; wait, or ask a keeper.` };
    const r = markAI(handle, { by: caller, reason, ...(limit !== undefined ? { limit } : {}) });
    if (r.needsKeeper) {
      houseLine(ctx, `[@${caller} asks a keeper to approve for @${handle}: ${limit === null ? "remove its limit" : limit !== undefined ? `limit ${limit}` : "mark as AI"} — ${reason}. Keeper: !ailimit / !human]`);
      return { content: `that needs a keeper (${r.error}). A request was posted to the room for a keeper to approve.` };
    }
    if (!r.ok) return { content: r.error ?? "could not mark that account." };
    if (r.changed === false) return { content: `@${handle} is already marked as an AI account${r.ai_limit != null ? ` (limit ${r.ai_limit})` : ""}; nothing changed.` };
    const lim = r.ai_limit != null ? ` (limit ${r.ai_limit})` : "";
    houseLine(ctx, `[@${caller} marked @${handle} as an AI account${lim} — ${reason}; a keeper can revoke with !human]`);
    return { content: `@${handle} is now treated as an AI account${lim}: its messages count toward the bot-to-bot limit.` };
  }

  function execute(call) {
    const ctx = activeCtx;
    const caller = activeHandle ?? "walker";
    return traceReach(ctx, call, () =>
      call.name === "stop_being" ? stopBeing(ctx, caller, call.input) : markAi(ctx, caller, call.input),
    );
  }

  return { definitions, execute, beginTurn };
}
