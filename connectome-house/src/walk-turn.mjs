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
 * a known, named gap; see this round's report.
 *
 * harness-port W4-A, 2026-09-19: `turnBegin.room` (the wire envelope's own
 * field, stamped by room-turn.mjs's `beginTurn`) is threaded onto every
 * outgoing `turn.event`/`turn.error`/`turn.done`/`tool.exec` this turn
 * sends — one seat connection now answers turns for MANY rooms at once,
 * so the house can no longer infer which room a reply is for from the
 * connection itself (`SeatClient.send`'s own `{room: this.room, ...msg}`
 * spread lets an explicit `msg.room` here override that stale default).
 *
 * harness-port task 1 (docs/harness-port/36-address-audit.md): nothing
 * anywhere records what system text a being actually received — a room's
 * own frames.jsonl carries speech/reach, never the address that produced
 * them, and personaFor()/systemFor() (walk-address.mjs) are re-composed
 * fresh every turn and never kept. `writeAddressAudit` below overwrites
 * `<runsDir>/<room>/address.<handle>.md` with EXACTLY the string this
 * turn is about to send as `system` (line ~104's own `request.system`,
 * BEFORE `covenant.systemPromptOverride` or anything else could still
 * change it — there is nothing else that does, once `request` is built),
 * using atomic-write.mjs's own temp+rename helper (the same shape
 * alarm-store.mjs/identity-map.mjs/blob-root.mjs already share) so a
 * keeper's `!address` read (commands/registry.mjs) never sees a torn
 * file. No secrets ride in it: `request.system` is plain persona/standing/
 * room/tools prose (walk-address-strings.mjs), never a credential — the
 * ONE addition downstream of this write is auth.mjs's `OAuthIdentityAdapter
 * .#withIdentity()`, which prepends the FIXED literal string
 * `OAUTH_SYSTEM_IDENTITY` ("You are Claude Code, Anthropic's official CLI
 * for Claude.") ahead of `request.system` for an OAuth-routed being, only
 * inside the membrane adapter's own `complete()`/`stream()` — after this
 * write, never before, and never the bearer token itself (that rides as
 * an HTTP header/authToken field, per auth.mjs's own "No token value is
 * ever logged"). `runsDir` (deps.runsDir, normally `process.env.
 * HOUSE_RUNS_DIR`) is absent for every being today — see this file's own
 * report: the being containers mount no runs volume (docker-compose.yml's
 * `x-being` anchor names house-seat/shared-workspace/pi-agent/servers.json
 * /covenants only) — so this is an honest, logged-once no-op until a
 * keeper wires that mount + env var, exactly the same shape task 0 found
 * and fixed for HOUSE_COVENANTS_DIR. */
import { fitCacheBreakpoints } from "./cache-budget.mjs";
import { execViaHouse } from "./walk-frame.mjs";
import { atomicWriteFileSync } from "./atomic-write.mjs";
import { join } from "node:path";

const addressAuditWarned = new Set();

/** @param {string|undefined} runsDir @param {string} room @param {string} being
 * @param {string} system */
function writeAddressAudit(runsDir, room, being, system) {
  if (!runsDir) {
    if (!addressAuditWarned.has("no-runs-dir")) {
      addressAuditWarned.add("no-runs-dir");
      console.error(
        "[address-audit] HOUSE_RUNS_DIR not set for this being — turn addresses are not " +
          "being written to the record (a keeper needs to mount the runs volume and set " +
          "HOUSE_RUNS_DIR for being containers; docs/harness-port/36-address-audit.md).",
      );
    }
    return;
  }
  const path = join(runsDir, room, `address.${being}.md`);
  try {
    atomicWriteFileSync(path, system);
  } catch (e) {
    const key = `write-fail:${room}`;
    if (!addressAuditWarned.has(key)) {
      addressAuditWarned.add(key);
      console.error(`[address-audit] failed to write ${path}: ${e?.message ?? e}`);
    }
  }
}

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
 *   runsDir: string|undefined,
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
    runsDir,
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
   * @param {{turnId: string, room: string, context: {conversation?: any[], life?: {messages?: any[]}|null},
   *   covenant: {model: string, tools: string[], posture: string, maxTokens?: number,
   *     systemPromptOverride?: string, thinking?: boolean, promptCaching?: boolean}}} turnBegin
   * @param {{setCancel?: (cancel: () => void) => void}} [hooks]
   */
  async function runTurn(seat, turnBegin, hooks = {}) {
    const { turnId, context, covenant, room } = turnBegin;
    const model = mock ? "mock-model" : covenant.model;
    const maxTokens = Math.min(
      covenant.maxTokens ?? maxTokensDefault,
      maxOutputForModel(model) ?? Number.POSITIVE_INFINITY,
    );
    const tools = (covenant.tools ?? []).map(toolDefFor).filter(Boolean);
    // a being's own testament `thinking: off` (covenant.thinking === false,
    // room-turn.mjs's covenantExcerpt) overrides this walker's process-wide
    // --thinking flag for just this turn — never the reverse.
    const effectiveThinking = covenant.thinking === false ? undefined : thinking;
    const promptCaching =
      typeof covenant.promptCaching === "boolean"
        ? !mock && covenant.promptCaching
        : !mock && routeForModel(model) !== "bedrock";
    const request = {
      messages: [...(context.life?.messages ?? []), ...(context.conversation ?? [])],
      system: covenant.systemPromptOverride ?? systemFor({ being, covenant, context }),
      config: {
        model,
        maxTokens,
        ...(effectiveThinking && supportsThinking(model)
          ? usesAdaptiveThinking(model)
            ? { thinking: { enabled: true, type: "adaptive", display: "summarized" } }
            : { thinking: effectiveThinking }
          : {}),
      },
      ...(effectiveThinking && usesAdaptiveThinking(model)
        ? { providerParams: { output_config: { effort: thinkingEffort } } }
        : {}),
      tools,
      toolMode: mock ? "xml" : "native",
      promptCaching,
    };
    if (request.promptCaching) fitRequestBreakpoints(request, covenant.model ?? model);
    // task 1 (docs/harness-port/36-address-audit.md): once per turn, the
    // exact string about to ride as `system` above — before anything
    // downstream (auth.mjs's OAuth identity prepend) could still touch it.
    writeAddressAudit(runsDir, room, being, request.system);

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
            seat.send({ type: "turn.event", room, turnId, event: { kind: "tokens", text: chunk } });
          }
          break;
        }
        case "tool-calls": {
          if (!mock && segText.trim()) {
            interimCount++;
            seat.send({ type: "turn.event", room, turnId, event: { kind: "final", text: segText.trim() } });
          }
          segText = "";
          const results = await Promise.all(ev.calls.map((c) => execViaHouse(seat, room, turnId, c, pending)));
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
          seat.send({ type: "turn.error", room, turnId, message: ev.error?.message ?? String(ev.error) });
          return;
        case "aborted":
          clearTimeout(watchdog);
          // the house's own applyInterrupt already closed a house-initiated
          // abort; anything else (our idle watchdog) must still tell the
          // house, or this turn wedges open forever.
          if (!interruptedByHouse) seat.send({ type: "turn.error", room, turnId, message: "idle-watchdog" });
          return;
      }
    }
    clearTimeout(watchdog);

    const text = finalResponse?.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n") ?? "";
    const finalSeg = mock ? text : segText.trim() || (interimCount === 0 ? text : "");
    if (finalSeg) seat.send({ type: "turn.event", room, turnId, event: { kind: "final", text: finalSeg } });
    const usage = finalResponse?.usage ?? {};
    seat.send({ type: "turn.done", room, turnId, ...(Object.keys(usage).length ? { usage } : {}) });
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

/** harness-port W8-A, 2026-09-19: a re-delivered `turn.begin` (same
 * `turnId` — the house's own resume ring, socket-seat.mjs, can replay one
 * a being already answered) must never run the model twice. A bounded
 * FIFO of the last `cap` admitted ids — walker.mjs's own `seat.on(
 * "turn.begin", ...)` calls `admit()` before starting a turn; `false`
 * means "already seen, ignore".
 * @param {number} [cap] @returns {{admit: (turnId: string) => boolean}} */
export function createSeenTurns(cap = 500) {
  const seen = new Set();
  const order = [];
  return {
    admit(turnId) {
      if (seen.has(turnId)) return false;
      seen.add(turnId);
      order.push(turnId);
      if (order.length > cap) seen.delete(order.shift());
      return true;
    },
  };
}
