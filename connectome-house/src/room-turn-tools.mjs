// @ts-check
/* connectome-house/src/room-turn-tools.mjs — room-turn.mjs's own tool.exec
 * router, extracted to keep that file under its own line-length ratchet
 * (already over it, 465 lines, when this round began — this module must
 * not push it back over). Owns two things:
 *
 *   - `houseToolCtxFor`: the ctx house-tools.mjs's modules read via
 *     `beginTurn(ctx, handle)` — record-tools.mjs needs `owner`+`runDir`;
 *     media-tools.mjs needs `runDir`; user-notes.mjs needs `owner`+
 *     `humans`+`runDir`+`ownerKind`; resident-tools/-house/-proposals.mjs
 *     need `owner`+`being`+`ownerKind`+`id`+`cls`+`life`. Every module's
 *     `execute()` needs `trace.frame`/`trace.result` (trace.mjs's
 *     `traceReach` contract). `ctx.life` here is the house tool's own
 *     STATS view (life.json's `.stats` + `.note` — counts, never the
 *     model-prompt life EXCERPT `beginTurn`'s own `context.life` carries;
 *     the two are deliberately different shapes for two different
 *     readers). `ctx.stagedWork`/`ctx.ownContinuation` are left OUT,
 *     named here rather than guessed: nothing in this round arms
 *     stage-tools.mjs's staged-work discipline or a resident's own-period
 *     continuation from a live seat, and per-call ctx is rebuilt fresh
 *     every tool.exec (nothing persists a mutation like `ctx.
 *     stageContinues` between calls yet) — both stay unreachable through
 *     task_continue until a caller wires per-room state AND arms one of
 *     the two flags. See this round's report.
 *
 *   - `handleToolExec`: a house tool (record/media/notes/stage/resident)
 *     routes to `executeHouseTool`, framed ONCE by its own module's
 *     `ctx.trace` (traceReach already writes reach+reach.result); every
 *     OTHER tool (`continue_substream`, a registered platform executor, or
 *     the honest "not offered here" refusal) keeps the SAME generic
 *     reach/reach.result framing room-turn.mjs always wrote — a house
 *     tool never gets that second, duplicate frame.
 */
import { existsSync, readFileSync } from "node:fs";
import { readCls } from "./room-policy.mjs";
import { ownerKindOf } from "./serve-identity.mjs";
import { roomPeople } from "./room-reach.mjs";
import { lifePathFor } from "./serve-room-open.mjs";
import { isHouseTool, executeHouseTool } from "./house-tools.mjs";
import { seatFor } from "./open-rooms.mjs";
import { primaryBeingOf } from "./room-seats.mjs";
import { ATTACH_MAX_BYTES, LOCAL_TOOL_NAMES } from "./local-tools.mjs";
import { storeSharedMedia } from "./media-share.mjs";

/** `handle`'s own life.json, read for its STATS section only (message/
 * summary/period counts, the last period, the kept note) — resident-
 * house.mjs's `ownClockSection` reads exactly this shape off `ctx.life`.
 * Honest null off no compiled life, or an unreadable/partial file. */
function houseLifeStatsFor(rec, handle) {
  const cls = rec.cls ?? readCls(rec.runDir);
  const path = lifePathFor(rec.runDir, handle, primaryBeingOf(cls));
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { ...(raw.stats ?? {}), note: raw.note ?? null };
  } catch {
    return null;
  }
}

/** @param {{id: string, runDir: string, cls: any}} rec @param {string} handle
 * @param {(rec: any, fields: object) => object} appendTurnFrame */
function houseToolCtxFor(rec, handle, appendTurnFrame) {
  const cls = rec.cls ?? readCls(rec.runDir);
  return {
    id: rec.id,
    runDir: rec.runDir,
    owner: cls?.owner ?? null,
    ownerKind: ownerKindOf(cls),
    being: primaryBeingOf(cls),
    cls: cls?.class ?? null,
    life: houseLifeStatsFor(rec, handle),
    humans: new Set(roomPeople(cls, handle).others),
    trace: {
      // every reach carries whose it is: with several beings' turns open
      // in one room, "whoever speaks next" is not reliably the caller
      frame: (type, data) => appendTurnFrame(rec, { type, ...(type === "reach" ? { by: handle } : {}), ...data }),
      result: (payload) => ({
        inline: typeof payload === "string" ? payload : JSON.stringify(payload),
      }),
    },
  };
}

/** one live `tool.exec`. A house tool routes to `executeHouseTool`, framed
 * once by its own module; `continue_substream` is a house-native verb,
 * answered directly; everything else routes through this room's
 * registered platform executor, or an honest refusal — both keep the
 * SAME generic reach/reach.result framing room-turn.mjs always wrote.
 * @param {{id: string, runDir: string, cls: any, seat?: any}} rec
 * @param {{handle: string, calledContinueSubstream?: boolean}} turn
 * @param {{callId: string, tool: string, input?: any}} msg
 * @param {{appendTurnFrame: (rec: any, fields: object) => object,
 *   platformExecutorFor: (roomId: string) => any}} deps */
export async function handleToolExec(rec, turn, msg, deps) {
  const { appendTurnFrame, platformExecutorFor } = deps;
  const { callId, tool, input } = msg;
  const seat = seatFor(rec, turn.handle);
  if (msg.local) {
    const result = recordLocalTool(rec, turn, msg, appendTurnFrame);
    if (seat) seat.send({ type: "tool.result", room: rec.id, callId, ok: result.ok, content: result.content });
    return;
  }
  if (isHouseTool(tool)) {
    const ctx = houseToolCtxFor(rec, turn.handle, appendTurnFrame);
    const result = await executeHouseTool(tool, input ?? {}, ctx, turn.handle, callId);
    if (seat) seat.send({ type: "tool.result", room: rec.id, callId, ok: !!result.ok, content: result.content });
    return;
  }
  appendTurnFrame(rec, { type: "reach", by: turn.handle, tool, input: input ?? {}, callId });
  let result;
  if (tool === "continue_substream") {
    turn.calledContinueSubstream = true;
    const reason = typeof input?.reason === "string" && input.reason ? `: ${input.reason}` : "";
    result = { ok: true, content: `Continuation scheduled${reason}` };
  } else {
    const executor = platformExecutorFor(rec.id);
    try {
      result = executor
        ? await executor.execute(tool, input ?? {})
        : { ok: false, content: `${tool} is not offered here` };
    } catch (e) {
      result = { ok: false, content: `error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  appendTurnFrame(rec, {
    type: "reach.result",
    callId,
    ok: !!result.ok,
    inline: typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? null),
  });
  if (seat) seat.send({ type: "tool.result", room: rec.id, callId, ok: !!result.ok, content: result.content });
}

/** a tool the being ran in its own container (local-tools.mjs): checked
 * against what this turn granted, framed like any reach, and any file
 * attach_file handed over stored and recorded as the being's own
 * attachment (the seat sends it out). A local result for a tool the turn
 * never granted is refused, never recorded as done.
 * @returns {{ok: boolean, content: any}} */
function recordLocalTool(rec, turn, msg, appendTurnFrame) {
  const { callId, tool, input, local } = msg;
  const ctx = houseToolCtxFor(rec, turn.handle, appendTurnFrame);
  const granted = LOCAL_TOOL_NAMES.has(tool) && (turn.tools ?? []).includes(tool);
  ctx.trace.frame("reach", { tool, input: input ?? {}, callId });
  if (!granted) {
    const content = `${tool} is not offered here`;
    ctx.trace.frame("reach.result", { callId, ok: false, inline: content });
    return { ok: false, content };
  }
  let content = local.content;
  for (const a of local.attach ?? []) {
    const bytes = Buffer.from(a.data, "base64");
    const stored =
      bytes.length > ATTACH_MAX_BYTES
        ? { error: "over 8MB" }
        : storeSharedMedia({ bytes, contentType: a.mime, filename: a.filename, origin: { via: "being", by: turn.handle }, runId: rec.id });
    if (stored.error) {
      content = `Error: ${a.filename} could not be attached (${stored.error})`;
      continue;
    }
    appendTurnFrame(rec, {
      type: "media.attached",
      by: turn.handle,
      path: stored.path,
      kind: stored.kind,
      seen_by_model: false,
      requested_by: "model",
      sha: stored.path.slice("blob/".length),
      mime: stored.mime,
      filename: a.filename,
    });
  }
  ctx.trace.frame("reach.result", { callId, ok: !!local.ok, ...ctx.trace.result(content) });
  return { ok: !!local.ok, content };
}

/** harness-port W3-A/W6-R3 (K2 fix, 2026-09-19) — room-turn.mjs's
 * `covenantExcerpt` own static-field binder (house/covenants/README.md's
 * field table, "carried, unconsumed" entries): a testament's own
 * `max_tokens`/`tools`/`thinking`/`prompt_caching` fields, each yielding
 * when a room-scoped `!` override already set one. `tools` INTERSECTS the
 * testament's own list with `offeredNames` (house tools ∪ this room's
 * platform executor) — a name in neither is dropped and named once in a
 * `[turn] tools not offered: …` log line, never a throw. No `tools:`
 * field at all now offers NONE — the fleet's own default
 * (`bot-runtime.ts:1299`, `this.config.tools ?? []`; secure-by-default,
 * opt in per tool). Confirmed safe for speech: a being's final answer is
 * a `turn.event` (`room-turn.mjs`'s `foldTurnEvent`), never a `tool.exec`
 * call, so an empty `tools` list still answers — and `offeredNames`
 * itself never carried speech anyway (no round yet registers a real
 * platform executor, room-turn.mjs's own header; `mcpl/discord.mjs`'s/
 * `signal.mjs`'s `DEFAULT_BEING_TOOLS` leaves `send_message`/
 * `reply_message`/`send_dm` out on purpose once one is). `thinking`
 * yields `true` for `on`, `false` for `off`, undefined when unset (the
 * walker's own default then applies); `promptCaching` rides through
 * only when the testament sets a real boolean.
 * @param {Record<string, any>|null} cov @param {Set<string>} offeredNames
 * @param {string} handle @param {number|undefined} mtOverride */
export function resolveCovenantFields(cov, offeredNames, handle, mtOverride) {
  const maxTokens = mtOverride ?? (typeof cov?.max_tokens === "number" ? cov.max_tokens : undefined);
  const covTools = Array.isArray(cov?.tools) ? cov.tools : null;
  let tools;
  if (covTools) {
    const unknown = covTools.filter((name) => !offeredNames.has(name));
    if (unknown.length) console.error(`[turn] tools not offered: ${unknown.join(", ")} (testament for @${handle})`);
    tools = covTools.filter((name) => offeredNames.has(name));
  } else {
    tools = [];
  }
  return {
    maxTokens,
    tools,
    // a testament's `thinking: on` now binds too (it used to be ignored —
    // only `off` did anything, and the walker's own default is off, so no
    // being ever thought); pre-3.7 models stay safe behind supportsThinking
    thinking: cov?.thinking === "off" || cov?.thinking === false ? false : cov?.thinking === "on" || cov?.thinking === true ? true : undefined,
    promptCaching: typeof cov?.prompt_caching === "boolean" ? cov.prompt_caching : undefined,
  };
}
