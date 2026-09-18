// @ts-check
/* connectome-house/src/stage-tools.mjs — a staged-work discipline's one
 * tool: `task_continue`, a being's elective return for the next tranche
 * of staged work. Bounded by HOUSE_STAGE_MAX_CONTINUES (default 6), reset
 * each human message. Mounted only while ctx.stagedWork is armed;
 * `deps.requestContinue` enqueues the continuation on the room's own
 * turn lane — the caller decides what that means (room-turn.mjs's own
 * concern), this module only asks for it and reports the budget.
 *
 * Ported from a private deployment (2026-09-18): generic already — no
 * archive vocabulary in the source, only its own doc citations changed.
 */
import { traceReach } from "./trace.mjs";

const MAX_CONTINUES = Number(process.env.HOUSE_STAGE_MAX_CONTINUES || 6);

/** @param {{ requestContinue: (job: {room: string, handle: string}) => void }} deps */
export function makeStageTools(deps) {
  const definitions = [
    {
      name: "task_continue",
      description:
        "Return for another turn of your own after this one ends. In your own period or a visit: the thread you are following — when you find yourself writing \"I'd want to know…\" or \"I haven't checked that yet\" at the end of a message, this is the moment: say where the thread stands, then call this, and check it next turn (or reach now, within this one). Not calling it is how a thread ends; the pause is whole. Under a human's staged request: the next tranche — say where the manifest stands first. Bounded (your covenant's returns_per_period, or the stage budget per human message); at the cap, say where things stand and stop.",
      inputSchema: {
        type: "object",
        properties: {
          next: {
            type: "string",
            description: "one line: the next tranche as the manifest names it",
          },
        },
        required: ["next"],
      },
    },
  ];

  let activeCtx = null;
  let activeHandle = null;
  function beginTurn(ctx, handle) {
    activeCtx = ctx;
    activeHandle = handle;
  }

  function run(input) {
    const ctx = activeCtx;
    if (!ctx) return { content: "staged work is not armed here" };
    // own continuation: armed by the period itself rather than a staged
    // request, bounded by returns_per_period instead of the stage budget.
    // A human-armed staged request on the same room takes precedence.
    const own = !ctx.stagedWork && !!ctx.ownContinuation;
    if (!ctx.stagedWork && !own)
      return { content: "staged mode is not armed on this room — a staged request arms it." };
    const max = own
      ? Number.isFinite(ctx.ownReturnsMax)
        ? ctx.ownReturnsMax
        : MAX_CONTINUES
      : MAX_CONTINUES;
    const used = ctx.stageContinues ?? 0;
    if (used >= max)
      return {
        content: own
          ? `this period's returns are spent (${used}/${max}, your covenant's returns_per_period). Say where the thread stands and let the turn end — a ledger line keeps it for a later period, and a visitor's word renews the count.`
          : `the stage budget for this human message is spent (${used}/${MAX_CONTINUES} returns). Report where the manifest stands and rest — the work is resumable from the record, and a human word renews the budget.`,
      };
    ctx.stageContinues = used + 1;
    ctx.continuedThisTurn = true; // read by the turn-close wiring
    deps.requestContinue({ room: ctx.id, handle: activeHandle ?? "walker" });
    const next = input?.next ? ` — next: ${input.next}` : "";
    return {
      content: own
        ? `you will return to this after the turn ends (${ctx.stageContinues}/${max} returns this period)${next}. Say where the thread stands before you close the turn; not calling this again is how it ends.`
        : `you will return for the next tranche after this turn ends (${ctx.stageContinues}/${MAX_CONTINUES} returns this budget)${next}. Close this turn with the manifest's standing.`,
    };
  }

  /** reach/reach.result world-facts, trace.mjs's shared shape */
  function execute(call) {
    const ctx = activeCtx;
    return traceReach(ctx, call, () => run(call.input));
  }

  return { definitions, execute, beginTurn };
}
