#!/usr/bin/env node
// @ts-check
/* connectome-house/src/walker.mjs — the being's own turn on membrane, as
 * a process that attaches to the house through the seat protocol.
 *
 *   node src/walker.mjs --being <handle> --seat <unix:/path|tcp://host:port|stdio> [--room <id>]
 *
 * `--room` is required for a socket seat (every seat-protocol message
 * carries `room`; @connectome/seat-client's SeatClient needs it to
 * handshake) and unused for stdio (implicit — one child, one branch).
 *
 * Attaches over the named transport, waits for `turn.begin`, runs the
 * turn on membrane (the mock adapter when HOUSE_MOCK_MODEL=1 or --mock —
 * mock-adapter.mjs), streams `turn.event`s, answers `tool.exec`/
 * `tool.result` round trips, sends `turn.done`/`turn.error`. Composition
 * root: builds every dependency once, matching the reference harness's
 * walk.mjs's own role, but far smaller — the house already renders each
 * turn's context and covenant; this file only ever runs ONE turn at a
 * time, never owns a record, never owns history.
 *
 * Tools that need the house (record/media/notes — W-B's this round) are
 * not registered here; `registerTools` (walk-turn.mjs) is the seam a
 * future module calls into, from its own file, before this process's
 * first turn begins. */
import { resolveAuth } from "./auth.mjs";
import {
  adapterForModel,
  maxOutputForModel,
  routeForModel,
  supportsThinking,
  usesAdaptiveThinking,
} from "./providers.mjs";
import { createMockAdapters } from "./mock-adapter.mjs";
import { createModelBoundary } from "./walk-membrane.mjs";
import { createTurnRunner, registerTools, toolDefFor } from "./walk-turn.mjs";
import { makePendingToolCalls } from "./walk-frame.mjs";
import { systemFor } from "./walk-address.mjs";
import { parseWalkerArgs } from "./walk-args.mjs";
import { StdioSeat } from "./walk-stdin-verbs.mjs";

export { registerTools };

/** @param {{seat: string, room: string|null, being: string}} args */
async function attachSeat({ seat: seatArg, room, being }) {
  if (seatArg === "stdio") {
    const seat = new StdioSeat();
    await seat.connect();
    return seat;
  }
  if (!room) {
    console.error("usage: --room <id> is required for a socket seat (--seat unix:...|tcp://...)");
    process.exit(1);
  }
  const { SeatClient, parseSeatAddr } = await import("@connectome/seat-client");
  const addr = parseSeatAddr(seatArg);
  const client = new SeatClient({
    ...addr,
    seatId: `${being}-${process.pid}`,
    being,
    room,
    reconnect: true,
  });
  await client.connect();
  return client;
}

async function main() {
  const args = parseWalkerArgs(process.argv.slice(2));
  const seat = await attachSeat(args);
  console.error(`[walker] @${args.being} attached over ${args.seat}${args.room ? ` (room ${args.room})` : ""}`);

  const auth = args.mock ? { kind: "none", source: "mock" } : await resolveAuth();
  const { mockAdapter } = args.mock ? createMockAdapters() : { mockAdapter: null };
  const { membraneFor } = createModelBoundary({ mock: args.mock, auth, adapterForModel, routeForModel, mockAdapter });
  const pending = makePendingToolCalls();
  const { runTurn } = createTurnRunner({
    being: args.being,
    mock: args.mock,
    membraneFor,
    maxOutputForModel,
    routeForModel,
    supportsThinking,
    usesAdaptiveThinking,
    thinking: args.thinking,
    thinkingEffort: args.thinkingEffort,
    maxTokensDefault: args.maxTokens,
    streamIdleMs: args.streamIdleMs,
    idleWatchdogMs: args.idleWatchdogMs,
    systemFor,
    toolDefFor,
    pending,
  });

  /** the currently in-flight turn's own cancel — a mid-turn `interrupt`
   * calls it; null between turns (nothing to abort). */
  let cancelCurrent = null;

  seat.on("tool.result", (msg) => {
    pending.settle(msg);
  });
  seat.on("interrupt", () => {
    cancelCurrent?.();
  });
  // `close`/`participant`/`house.frame`: this walker holds no local state
  // any of them would update (the house re-renders context fresh every
  // turn) — logged, never acted on.
  seat.on("close", (msg) => console.error(`[walker] room close (${msg.mode}) — the seat stays up`));
  seat.on("turn.begin", (turnBegin) => {
    void runTurn(seat, turnBegin, { setCancel: (fn) => (cancelCurrent = fn) })
      .catch((e) => {
        console.error(`[walker] turn ${turnBegin.turnId} failed: ${e?.message ?? e}`);
        seat.send({ type: "turn.error", turnId: turnBegin.turnId, message: String(e?.message ?? e) });
      })
      .finally(() => {
        cancelCurrent = null;
      });
  });

  const stayAlive = setInterval(() => {
    if (!seat.isLive()) {
      clearInterval(stayAlive);
      console.error("[walker] seat is no longer live — exiting");
      process.exit(0);
    }
  }, 5000);
  stayAlive.unref?.();
}

main().catch((e) => {
  console.error(`[walker] fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
