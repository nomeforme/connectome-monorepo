#!/usr/bin/env node
// @ts-check
/* connectome-house/src/walker.mjs — the being's own turn on membrane, as
 * ONE always-on process attached to the house through the seat protocol,
 * seated to EVERY room the house finds it present in.
 *
 *   node src/walker.mjs --being <handle> --seat <unix:/path|tcp://host:port|stdio> [--room <id>] [--max-concurrent <n>]
 *
 * harness-port W4-A, 2026-09-19 — the fleet's own problem this answers:
 * "each container had bots that were always listening everywhere they
 * were added" (a process per (bot, room), a memory footprint that scales
 * with rooms, a process start before the first model call). The house's
 * own attach rule lives in open-rooms.mjs/seat/socket-seat.mjs: the
 * handshake names only a BEING (`--room` is now OPTIONAL, and legacy —
 * naming one still selects the single-room handshake a few tests keep;
 * its absence is the new default), and the house attaches this one
 * connection to every open room whose roster already names this being,
 * plus any room that opens later. `--room` is still required in spirit
 * for the wire's own handshake schema (every seat message carries a
 * non-empty `room` string) — when none is named, this file sends the
 * being's own handle as a harmless placeholder; the house's attach logic
 * never reads it (`seatBeing`, open-rooms.mjs), only individual TURN
 * messages' own `room` field matters from here on (room-turn.mjs stamps
 * it explicitly on every send now — see walk-turn.mjs's own header).
 *
 * Attaches over the named transport, then answers `turn.begin` for
 * whichever rooms it's seated to — ONE turn in flight PER ROOM, up to a
 * per-being concurrency cap (`--max-concurrent`, default 1, the fleet's
 * own one-cycle-per-bot posture): a room whose `turn.begin` arrives at
 * the cap QUEUES (this file's own `queue`/`startTurn`) rather than being
 * refused — the house tolerates the wait (no timeout shorter than a
 * model call; `beginTurn`'s own promise simply resolves later). Runs the
 * turn on membrane (the mock adapter when HOUSE_MOCK_MODEL=1 or --mock —
 * mock-adapter.mjs), streams `turn.event`s, answers `tool.exec`/
 * `tool.result` round trips, sends `turn.done`/`turn.error`. Composition
 * root: builds every dependency once, matching the reference harness's
 * walk.mjs's own role, but far smaller — the house already renders each
 * turn's context and covenant; this process's own per-room state is
 * nothing but its in-flight turns (the house re-renders context fresh
 * every `turn.begin`), never owns a record, never owns history.
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
import { houseToolDefinitions } from "./house-tools.mjs";

export { registerTools };

// the house's own tool SCHEMAS (record/media/notes/stage/resident,
// house-tools.mjs) — registered once, here, so `toolDefFor` (walk-turn.mjs)
// resolves a real definition for every name `covenant.tools` names
// (room-turn.mjs's own `covenantExcerpt`). This process never EXECUTES a
// house tool itself (that's room-turn.mjs's `handleToolExec`, house-side,
// a separate process) — only the JSON-schema half is needed here, so the
// requestContinue/requestClose overrides mountHouseTools() would otherwise
// take are irrelevant in this process and left at their no-op default.
registerTools(houseToolDefinitions());

/** @param {{seat: string, room: string|null, being: string}} args */
async function attachSeat({ seat: seatArg, room, being }) {
  if (seatArg === "stdio") {
    const seat = new StdioSeat();
    await seat.connect();
    return seat;
  }
  const { SeatClient, parseSeatAddr } = await import("@connectome/seat-client");
  const addr = parseSeatAddr(seatArg);
  const client = new SeatClient({
    ...addr,
    seatId: `${being}-${process.pid}`,
    being,
    // no --room named (the new default): the handshake still needs SOME
    // non-empty `room` string (every seat message's own schema requires
    // one) — the being's own handle is a harmless placeholder the house's
    // attach logic never reads (open-rooms.mjs's `seatBeing` attaches by
    // BEING, not by this field); every actual turn carries its own real
    // room explicitly instead (room-turn.mjs's `beginTurn`).
    room: room || being,
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
  // HOUSE_MOCK_HOUSE_TOOL=1 (test-only): scripts a record_list call
  // instead of the default archive-flavored mock script — mock-adapter.
  // mjs's own header names why.
  const { mockAdapter } = args.mock
    ? createMockAdapters({ mockHouseTool: process.env.HOUSE_MOCK_HOUSE_TOOL === "1" })
    : { mockAdapter: null };
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

  // per-room concurrency: at most `args.maxConcurrent` turns run at once
  // (the fleet's own one-cycle-per-bot posture, default 1) — a room's
  // `turn.begin` past the cap QUEUES (FIFO) rather than being refused;
  // the house tolerates the wait (beginTurn's own promise just resolves
  // later, no timeout shorter than a model call). `cancels` tracks each
  // room's own live cancel fn (`hooks.setCancel`, walk-turn.mjs) so a
  // mid-turn `interrupt` for room X never cancels room Y's turn.
  /** @type {Map<string, () => void>} */
  const cancels = new Map();
  /** @type {Record<string, unknown>[]} */
  const queue = [];
  const roomOf = (msg) => (typeof msg.room === "string" && msg.room ? msg.room : args.room || args.being);

  function startTurn(turnBegin) {
    const room = roomOf(turnBegin);
    // observable proof this turn's own context actually carried the
    // room's identity (room-turn.mjs's `beginTurn`, this round's own
    // addition) — read by test/walker-tools-e2e.test.mjs off this
    // process's stderr, since nothing else in this walker's own state
    // would otherwise surface it.
    console.error(`[walker] turn.begin context.room=${JSON.stringify(turnBegin.context?.room ?? null)}`);
    void runTurn(seat, turnBegin, { setCancel: (fn) => cancels.set(room, fn) })
      .catch((e) => {
        console.error(`[walker] turn ${turnBegin.turnId} failed: ${e?.message ?? e}`);
        seat.send({ type: "turn.error", room, turnId: turnBegin.turnId, message: String(e?.message ?? e) });
      })
      .finally(() => {
        cancels.delete(room);
        const next = queue.shift();
        if (next) startTurn(next);
      });
  }

  seat.on("tool.result", (msg) => {
    pending.settle(msg);
  });
  seat.on("interrupt", (msg) => {
    const room = roomOf(msg);
    const cancel = cancels.get(room);
    if (cancel) {
      cancel();
      return;
    }
    // not yet started (still queued behind the cap) — drop it rather
    // than let a stale interrupt reach a turn that hasn't begun.
    const i = queue.findIndex((q) => roomOf(q) === room);
    if (i !== -1) queue.splice(i, 1);
  });
  // `close`/`participant`/`house.frame`: this walker holds no local state
  // any of them would update (the house re-renders context fresh every
  // turn) — logged, never acted on.
  seat.on("close", (msg) => console.error(`[walker] room close (${msg.mode}) — the seat stays up`));
  seat.on("turn.begin", (turnBegin) => {
    const room = roomOf(turnBegin);
    if (cancels.size >= args.maxConcurrent) {
      queue.push(turnBegin);
      console.error(
        `[walker] turn.begin for room ${room} queued (cap ${args.maxConcurrent}, ${cancels.size} in flight)`,
      );
      return;
    }
    startTurn(turnBegin);
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
