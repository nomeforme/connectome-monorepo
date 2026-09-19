// @ts-check
/* connectome-house/test/observe-only-two-seats.test.mjs — the exact race
 * bce2d29 fixes: TWO real MCPL platform seats sharing ONE house room —
 * the pilot's own shape, a second bot identity present in the same
 * channel as the one that actually answers. Seat 1 speaks for A,
 * observe_only: true (a silent, logging-only account); seat 2 speaks for
 * B, ordinary. Both seats' own mock MCPL servers push the SAME platform
 * message (same message_id) into the SAME stream — exactly what really
 * happens when two bot accounts sit in one Discord channel and both
 * receive the one gateway event.
 *
 * Before bce2d29, observe_only silenced EVERY being present
 * (`for (const being of beings) reasons[being] = "observe_only"`), so
 * whichever seat's own onIncoming ran first wrote the room's one
 * `external.message_id`-deduped "message" frame with NO targets at all
 * (serve-rooms.mjs's own roomInput records the FIRST arrival only,
 * `externalAlreadyRecorded`) — the SECOND seat's own (correct) targets
 * were then simply discarded as `{duplicate:true}`, and NOBODY ever
 * turned. bce2d29 fixes this by silencing only the seat's OWN being
 * (`reasons[server.being] = "observe_only"`), so seat 1's own
 * routeIncoming call still computes B's real decision too — whichever
 * seat's push lands first, B's own targeted turn is the one that gets
 * recorded and run.
 *
 * A REAL room (openRoom), a REAL being's-turn socket seat for B
 * (createHouseSeatServer + MockBeing, test/stream-command.test.mjs's own
 * pattern — attached BEFORE either platform seat starts, so `rec.seat`
 * is live the instant the message lands and a real turn actually runs),
 * and TWO REAL platform seats (mcpl/seat.mjs's createSeat, driven by
 * test/lib/mock-mcpl-server.mjs, test/observe-only.test.mjs's own
 * pattern). Both delivery orders are proven — bce2d29's own fix is
 * order-independent by construction (routeIncoming excludes the
 * observe_only seat's own being from the decision loop entirely, rather
 * than picking a winner) — but the race only shows itself when the
 * SILENCED seat's own message is the one recorded first, so that order
 * is exercised explicitly, first, and named as the regression it pins. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockBeing } from "@connectome/seat-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "observe-only-two-seats-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "observe-only-two-seats-test-salt-0123";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });

const { writeTestament } = await import("./lib/fixtures.mjs");
const { framesOf, waitFor } = await import("./lib/serve-harness.mjs");
const { createSeat } = await import("../src/mcpl/seat.mjs");
const { openRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");

// a FRESH pair of being handles per race (never reused across the two
// `runRace` calls below) — some of the house's own per-being bookkeeping
// (the alarms/life-budget accounting a seat's first start logs) is
// process-global, keyed by handle; reusing one handle across two
// successive races in the same test process was found live to make the
// SECOND race's turn silently never complete (a test-isolation trap, not
// a route.mjs bug — this file's own regression). Every race mints its own
// two handles and testaments instead.

/** discord-shaped incoming message (observe-only.test.mjs's own `msg()`). */
function msg(id, { channelId, author = "alice", text }) {
  return {
    channelId,
    messageId: id,
    author: { id: author, name: author },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text }],
    metadata: { mentions: [], rawContent: null, replyTo: null, replyToAuthorId: null, isBot: false },
  };
}

function rowsOf(recordPath) {
  try {
    return readFileSync(recordPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const teardowns = [];
after(async () => {
  for (const fn of teardowns.reverse()) await fn();
});

/** one full two-seat race: a room with roster [A, B], A's platform seat
 * observe_only, B's platform seat ordinary, B's real turn over a socket
 * seat — both mock platform servers push the SAME message_id into the
 * SAME stream, `aAfterMs`/`bAfterMs` controlling which one's push is
 * actually delivered (and recorded) first.
 * @param {{name: string, aAfterMs: number, bAfterMs: number}} opts */
async function runRace({ name, aAfterMs, bAfterMs }) {
  const A = `kestrel-${name}`; // this race's own observe_only seat's being — never answers
  const B = `linden-${name}`; // this race's own ordinary seat's being — the one that actually turns
  writeTestament(process.env.HOUSE_COVENANTS_DIR, A, { speaksFor: "discord" });
  writeTestament(process.env.HOUSE_COVENANTS_DIR, B, { speaksFor: "discord" });

  const stream = `discord:g3:two-seats-${name}`;
  const messageId = `race-${name}`;

  const { id: roomId, error } = await openRoom({
    platform: "discord",
    stream,
    title: `two seats e2e (${name})`,
    beings: [A, B],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);

  // B's real being's-turn seat — attached BEFORE either platform seat
  // starts, so `rec.seat` is already live the instant the message lands
  // (test/stream-command.test.mjs's own note: a seat attached later would
  // never reach a turn already in flight; here, attached first, it's
  // simply always there to receive one).
  const sockDir = mkdtempSync(join(tmpdir(), `observe-only-two-seats-sock-${name}-`));
  const sockPath = join(sockDir, "seat.sock");
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen({ path: sockPath });
  const being = new MockBeing({
    path: sockPath,
    seatId: `${B}-two-seats-${name}`,
    being: B,
    room: roomId,
    script: [{ kind: "event", event: { kind: "final", text: `${B} answers, ${name}` } }],
  });
  await being.connect();
  await waitFor(() => (open.get(roomId)?.seat ? true : null));
  assert.equal(open.get(roomId).seat.being, B, "the room's one being's-turn seat is B's — A never holds it (observe_only)");

  const fixtureA = join(process.env.HOUSE_PRIVATE_DIR, `two-seats-${name}-a.fixture.json`);
  const recordA = join(process.env.HOUSE_PRIVATE_DIR, `two-seats-${name}-a.record.jsonl`);
  writeFileSync(
    fixtureA,
    JSON.stringify({
      channels: [{ id: stream, type: "discord", label: "c", direction: "bidirectional" }],
      history: {},
      script: [{ after_ms: aAfterMs, incoming: msg(messageId, { channelId: stream, text: `alice: @${B} are you there?` }) }],
    }),
  );
  const fixtureB = join(process.env.HOUSE_PRIVATE_DIR, `two-seats-${name}-b.fixture.json`);
  const recordB = join(process.env.HOUSE_PRIVATE_DIR, `two-seats-${name}-b.record.jsonl`);
  writeFileSync(
    fixtureB,
    JSON.stringify({
      channels: [{ id: stream, type: "discord", label: "c", direction: "bidirectional" }],
      history: {},
      script: [{ after_ms: bAfterMs, incoming: msg(messageId, { channelId: stream, text: `alice: @${B} are you there?` }) }],
    }),
  );

  const seatA = createSeat({
    server: {
      name: `two-seats-${name}-a`,
      platform: "discord",
      command: "node",
      args: [MOCK, fixtureA, recordA],
      env: [],
      being: A,
      rooms: [{ stream, title: `two seats e2e (${name})`, beings: [A, B], public: true }],
      mock: true,
      observe_only: true,
    },
    log: () => {},
  });
  const seatB = createSeat({
    server: {
      name: `two-seats-${name}-b`,
      platform: "discord",
      command: "node",
      args: [MOCK, fixtureB, recordB],
      env: [],
      being: B,
      rooms: [{ stream, title: `two seats e2e (${name})`, beings: [A, B], public: true }],
      mock: true,
      observe_only: false,
    },
    log: () => {},
  });

  teardowns.push(async () => {
    seatA.stop();
    seatB.stop();
    await being.close();
    await seatServer.close();
  });

  await seatA.start();
  await seatB.start();

  // exactly one turn for B: its one speech frame lands in the room's own record.
  await waitFor(() =>
    framesOf(join(process.env.HOUSE_RUNS_DIR, roomId)).some(
      (f) => f.type === "speech" && f.by === B && f.inline === `${B} answers, ${name}`,
    )
      ? true
      : null,
  );
  // harness-port W7-b: seat.mjs's own tail is now bus-driven (near-
  // instant) with only a slow (5s) sweep as a backstop, so poll for the
  // actual outbound call rather than assuming any fixed poll cadence.
  const callsB = await waitFor(() => {
    const rows = rowsOf(recordB).filter(
      (r) => r.kind === "tools/call" && (r.name === "send_message" || r.name === "reply_message"),
    );
    return rows.length ? rows : null;
  });
  // a moment more for seat A to have shown a bug too, if there were one.
  await new Promise((r) => setTimeout(r, 300));

  const frames = framesOf(join(process.env.HOUSE_RUNS_DIR, roomId));
  const messageFrames = frames.filter((f) => f.type === "message" && f.text.includes("are you there"));
  assert.equal(messageFrames.length, 1, "the message frame is recorded exactly once (external.message_id dedup)");
  assert.deepEqual(
    messageFrames[0].to,
    [B],
    "the recorded frame's own targets name B — whichever seat wrote it first, bce2d29 computed B's real decision",
  );
  const speechFrames = frames.filter((f) => f.type === "speech" && !f.interim && f.by === B);
  assert.equal(speechFrames.length, 1, "exactly one speech frame");

  const callsA = rowsOf(recordA).filter((r) => r.kind === "tools/call" || r.kind === "channels/typing");
  assert.deepEqual(callsA, [], "seat 1 (observe_only, A) makes NO outbound call of any kind");
  assert.equal(callsB.length, 1, "exactly one outbound send, through seat 2 (B)");
  assert.ok(callsB[0].arguments?.content?.includes(`${B} answers, ${name}`));
}

test("two seats, one room: the observe_only seat's own push delivered FIRST still lets B answer — the exact race bce2d29 fixes (before it: observe_only silenced every being, so the first-recorded message carried no targets and B's own arrival was discarded as a duplicate, with nobody ever turning)", async () => {
  await runRace({ name: "a-first", aAfterMs: 20, bAfterMs: 300 });
});

test("two seats, one room, reverse delivery order (seat 2 first): same single turn, same single outbound send — bce2d29's fix is order-independent", async () => {
  await runRace({ name: "b-first", aAfterMs: 300, bAfterMs: 20 });
});
