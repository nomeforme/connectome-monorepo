#!/usr/bin/env node
// @ts-check
/* connectome-house/test/lib/stub-walker.mjs — a stand-in for W-A's own
 * walker.mjs (docs/harness-port/13-walker-port.md), used ONLY by this
 * package's own tests until that entry point lands (this task's brief
 * explicitly allows exactly this: "a stub script in test/lib/ that
 * speaks the protocol stands in"). Speaks the being side of the seat
 * protocol via `@connectome/seat-client`'s raw `SeatClient` closely
 * enough to prove `serve-walks.mjs`'s spawn/attach/restart contract:
 * reads `--being`/`--seat`/`--room` off argv (the exact CLI docs/
 * harness-port/13-walker-port.md names), connects, and answers every
 * `turn.begin` with one `final` speech event naming the turn's own id,
 * then `turn.done`. Never a real model call — a protocol fixture, not a
 * walker; exits 0 on the house's own `close` verb or SIGTERM.
 *
 * harness-port W4-A, 2026-09-19: `--room` is now OPTIONAL (serve-
 * walks.mjs's own spawn is per-being, never per-room) — its own handshake
 * falls back to the being's own handle as a harmless placeholder room the
 * house's attach logic never reads (walker.mjs's real entry point does
 * the same; see its own header). Rewritten off the raw `SeatClient`
 * rather than `MockBeing` (connectome-seat-client, NO-TOUCH): `MockBeing`
 * stamps every outgoing message with its OWN fixed handshake-time room,
 * which only ever matched real turns while `--room <id>` was always
 * passed 1:1. Now that one seat can serve MANY rooms, every reply below
 * threads `room: turnBegin.room` explicitly instead (the same pattern
 * walk-turn.mjs's real entry point uses) — `SeatClient.send`'s own
 * `{room: this.room, ...msg}` spread lets that explicit field override
 * the connection's stale default, with no seat-client package edit. */
import { SeatClient } from "@connectome/seat-client";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const being = arg("being");
const seatAddr = arg("seat");
const room = arg("room") || being;
// `node --test`'s own default file discovery runs every file under test/
// (test/lib/mock-mcpl-server.mjs's own header names this exact trap) —
// with no argv and nothing that spawned it on purpose, exit clean rather
// than fail the whole suite. A real caller (serve-walks.mjs's own spawn)
// always names --being/--seat (never --room, harness-port W4-A: the new
// per-being spawn omits it), so the argv check alone is sufficient —
// unlike mock-mcpl-server.mjs, this file is spawned from INSIDE a real
// test's own process tree (test -> spawned serve.mjs -> spawned
// stub-walker.mjs), so an additional `process.env.NODE_TEST_CONTEXT`
// check (tried here first, then reverted) is actively wrong: Node's
// default child_process.spawn inherits the whole parent env, so that var
// rides down through BOTH spawn hops and made a REAL, correctly-invoked
// stub-walker exit immediately — found live via a hung/failing test this
// same task fixed.
if (!being || !seatAddr) process.exit(0);

/** the same "unix:<path>" / "tcp://host:port" / "host:port" grammar every
 * other seat-address reader in this repo uses (duplicated here rather
 * than adding a runtime dependency for three lines). */
function parseSeatAddr(addr) {
  if (addr.startsWith("unix:")) return { path: addr.slice("unix:".length) };
  const tcp = addr.startsWith("tcp://") ? addr.slice("tcp://".length) : addr;
  const at = tcp.lastIndexOf(":");
  if (at === -1) throw new Error(`stub-walker: bad --seat address: ${addr}`);
  return { host: tcp.slice(0, at), port: Number(tcp.slice(at + 1)) };
}

const client = new SeatClient({
  ...parseSeatAddr(seatAddr),
  seatId: `stub-${being}-${process.pid}`,
  being,
  room,
  reconnect: true,
});

client.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// one in-flight turn at a time PER ROOM, matching the real walker's own
// cap=1 default — this stub never needs concurrency, only correctness:
// every reply names the SAME room its own turn.begin named.
client.on("turn.begin", (turnBegin) => {
  const turnRoom = turnBegin.room;
  client.send({
    type: "turn.event",
    room: turnRoom,
    turnId: turnBegin.turnId,
    event: { kind: "final", text: `stub-walker heard turn ${turnBegin.turnId}` },
  });
  client.send({ type: "turn.done", room: turnRoom, turnId: turnBegin.turnId });
});

client.connect().catch((e) => {
  console.error(`stub-walker: connect failed: ${e.message}`);
  process.exit(1);
});
