// @ts-check
/* connectome-house/src/walk-turn.mjs — one being's one turn on membrane:
 * request assembly from the house's own turn.begin (context + covenant),
 * the stream's tokens/tool-calls/usage/complete/aborted events folded
 * into turn.event sends, and every tool call round-tripped through the
 * house via tool.exec/tool.result (walk-frame.mjs) — the house is the
 * record's sole writer. `createTurnRunner(deps)` returns `runTurn(seat,
 * turnBegin, hooks)`; walker.mjs stays the composition root and owns the
 * interrupt hookup (`hooks.setCancel`, called once the stream exists, so
 * a mid-turn `interrupt` message can reach it).
 *
 * Reduced from the reference harness's walk-turn.mjs: no archive/loom/
 * media/paint/stage/resident tool mounts (a being with no archive is
 * this port's only mode) and no citation/frag/want/altitude speech
 * modules (a declarative address-registry.mjs section system this port
 * doesn't carry) — every tool call this turn makes is a remote one,
 * named by `covenant.tools`, resolved by `deps.toolDefFor`. No per-walker
 * life dedupe by frame seq either: the house's rendered
 * `context.conversation` carries no seq for a walker to key on at all —
 * a known, named gap; see this round's report. */
import { fitCacheBreakpoints } from "./cache-budget.mjs";
import { execViaHouse } from "./walk-frame.mjs";

/**
 * @param {{
 *   being: string, mock: boolean, membraneFor: (modelId: string) => any,
 *   maxOutputForModel: (m: string) => number|undefined,
 *   routeForModel: (m: string) => string,
 *   supportsThinking: (m: string) => boolean,
 *   usesAdaptiveThinking: (m: string) => boolean,
 *   thinking: {enabled: true, budgetTokens: number}|undefined,
 *   thinkingEffort: string, maxTokensDefault: number,
 *   streamIdleMs: number, idleWatchdogMs: number,
 *   systemFor: (f: object) => string,
 *   toolDefFor: (name: string) => object|null,
 *   pending: ReturnType<typeof import("./walk-frame.mjs").makePendingToolCalls>,
 * }} deps
 */
export function createTurnRunner(deps) {
  const {
    being,
    mock,
    membraneFor,
    maxOutputForModel,
    routeForModel,
    supportsThinking,
    usesAdaptiveThinking,
    thinking,
    thinkingEffort,
    maxTokensDefault,
    streamIdleMs,
    idleWatchdogMs,
    systemFor,
    toolDefFor,
    pending,
  } = deps;

  const fitWarned = new Set();
  function fitRequestBreakpoints(request, name) {
    const fit = fitCacheBreakpoints(request.messages);
    request.messages = fit.messages;
    const key = `${name}:${fit.supplied}`;
    if (fit.kept === fit.supplied || fitWarned.has(key)) return;
    fitWarned.add(key);
    console.error(
      `[cache] ${name}: ${fit.supplied} cache breakpoints supplied, ${fit.kept} kept ` +
        "(the first and last; the middle seams dropped)",
    );
  }

  /**
   * @param {{send: (msg: Record<string, unknown>) => boolean}} seat
   * @param {{turnId: string, context: {conversation?: any[], life?: {messages?: any[]}|null},
   *   covenant: {model: string, tools: string[], posture: string, maxTokens?: number, systemPromptOverride?: string}}} turnBegin
   * @param {{setCancel?: (cancel: () => void) => void}} [hooks]
   */
  async function runTurn(seat, turnBegin, hooks = {}) {
    const { turnId, context, covenant } = turnBegin;
    const model = mock ? "mock-model" : covenant.model;
    const maxTokens = Math.min(
      covenant.maxTokens ?? maxTokensDefault,
      maxOutputForModel(model) ?? Number.POSITIVE_INFINITY,
    );
    const tools = (covenant.tools ?? []).map(toolDefFor).filter(Boolean);
    const request = {
      messages: [...(context.life?.messages ?? []), ...(context.conversation ?? [])],
      system: covenant.systemPromptOverride ?? systemFor({ being, covenant, context }),
      config: {
        model,
        maxTokens,
        ...(thinking && supportsThinking(model)
          ? usesAdaptiveThinking(model)
            ? { thinking: { enabled: true, type: "adaptive", display: "summarized" } }
            : { thinking }
          : {}),
      },
      ...(thinking && usesAdaptiveThinking(model)
        ? { providerParams: { output_config: { effort: thinkingEffort } } }
        : {}),
      tools,
      toolMode: mock ? "xml" : "native",
      promptCaching: !mock && routeForModel(model) !== "bedrock",
    };
    if (request.promptCaching) fitRequestBreakpoints(request, covenant.model ?? model);

    let finalResponse = null;
    let segText = "";
    let interimCount = 0;
    const stream = membraneFor(model).streamYielding(request, { idleTimeoutMs: streamIdleMs });
    let watchdog = null;
    let interruptedByHouse = false;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => stream.cancel(), idleWatchdogMs);
      watchdog.unref?.();
    };
    armWatchdog();
    hooks.setCancel?.(() => {
      interruptedByHouse = true;
      stream.cancel();
    });

    for await (const ev of stream) {
      armWatchdog();
      switch (ev.type) {
        case "tokens": {
          const chunk = ev.meta && ev.meta.visible === false ? "" : (ev.content ?? ev.text ?? "");
          if (chunk) {
            if (!mock) segText += chunk;
            seat.send({ type: "turn.event", turnId, event: { kind: "tokens", text: chunk } });
          }
          break;
        }
        case "tool-calls": {
          if (!mock && segText.trim()) {
            interimCount++;
            seat.send({ type: "turn.event", turnId, event: { kind: "final", text: segText.trim() } });
          }
          segText = "";
          const results = await Promise.all(ev.calls.map((c) => execViaHouse(seat, turnId, c, pending)));
          try {
            stream.provideToolResults(results);
          } catch {
            /* raced a cancel — the aborted event right behind this frames the wall */
          }
          break;
        }
        case "complete":
          finalResponse = ev.response;
          break;
        case "error":
          clearTimeout(watchdog);
          seat.send({ type: "turn.error", turnId, message: ev.error?.message ?? String(ev.error) });
          return;
        case "aborted":
          clearTimeout(watchdog);
          // the house's own applyInterrupt already closed a house-initiated
          // abort; anything else (our idle watchdog) must still tell the
          // house, or this turn wedges open forever.
          if (!interruptedByHouse) seat.send({ type: "turn.error", turnId, message: "idle-watchdog" });
          return;
      }
    }
    clearTimeout(watchdog);

    const text = finalResponse?.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n") ?? "";
    const finalSeg = mock ? text : segText.trim() || (interimCount === 0 ? text : "");
    if (finalSeg) seat.send({ type: "turn.event", turnId, event: { kind: "final", text: finalSeg } });
    const usage = finalResponse?.usage ?? {};
    seat.send({ type: "turn.done", turnId, ...(Object.keys(usage).length ? { usage } : {}) });
  }

  return { runTurn };
}

/** the walker's own tool-definition registry: a hook for a module that
 * needs the house (record/media/notes — W-B's this round) to advertise
 * its own JSON-schema definitions, keyed by name — `covenant.tools` (the
 * wire's own offered NAMES only) is looked up here per turn. */
const registry = new Map();
/** @param {{name: string, description: string, inputSchema: object}[]} defs */
export function registerTools(defs) {
  for (const d of defs) registry.set(d.name, d);
}
/** @param {string} name @returns {object|null} */
export function toolDefFor(name) {
  return registry.get(name) ?? null;
}
