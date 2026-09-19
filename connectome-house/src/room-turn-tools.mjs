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
import { beingsOf } from "./beings.mjs";
import { ownerKindOf } from "./serve-identity.mjs";
import { roomPeople } from "./room-reach.mjs";
import { lifePathFor } from "./serve-room-open.mjs";
import { isHouseTool, executeHouseTool } from "./house-tools.mjs";

/** the primary being a room's own class.json names — `cls.being` when
 * set, else the first of `beingsOf(cls)` — the same resolution
 * room-turn.mjs's own `renderLifeExcerpt` already uses, duplicated here
 * (a one-liner) rather than imported across files for it. */
function primaryBeingOf(cls) {
  const roster = beingsOf(cls);
  return typeof cls?.being === "string" && cls.being ? cls.being : (roster[0] ?? null);
}

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
      frame: (type, data) => appendTurnFrame(rec, { type, ...data }),
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
  if (isHouseTool(tool)) {
    const ctx = houseToolCtxFor(rec, turn.handle, appendTurnFrame);
    const result = await executeHouseTool(tool, input ?? {}, ctx, turn.handle, callId);
    if (rec.seat) rec.seat.send({ type: "tool.result", room: rec.id, callId, ok: !!result.ok, content: result.content });
    return;
  }
  appendTurnFrame(rec, { type: "reach", tool, input: input ?? {}, callId });
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
  if (rec.seat) rec.seat.send({ type: "tool.result", room: rec.id, callId, ok: !!result.ok, content: result.content });
}

/** harness-port W3-A, 2026-09-18 — room-turn.mjs's `covenantExcerpt` own
 * static-field binder (house/covenants/README.md's field table, "carried,
 * unconsumed" entries): a testament's own `max_tokens`/`tools`/`thinking`/
 * `prompt_caching` fields, each yielding when a room-scoped `!` override
 * already set one. `tools` INTERSECTS the testament's own list with
 * `offeredNames` (house tools ∪ this room's platform executor) — a name in
 * neither is dropped and named once in a `[turn] tools not offered: …` log
 * line, never a throw; no `tools:` field at all keeps the old behaviour
 * (offer everything this room has). `thinking` only ever yields `false`
 * (a testament's `on`/unset changes nothing — the walker's own default
 * still applies); `promptCaching` rides through only when the testament
 * sets a real boolean.
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
    tools = [...offeredNames];
  }
  return {
    maxTokens,
    tools,
    thinking: cov?.thinking === "off" ? false : undefined,
    promptCaching: typeof cov?.prompt_caching === "boolean" ? cov.prompt_caching : undefined,
  };
}
