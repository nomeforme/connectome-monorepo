// @ts-check
/* connectome-house/test/signal-two-seats.test.mjs — the 2026-09-19 21:49
 * two-beings-on-Signal incident's own regression, at the same stub-level
 * convention two-accounts-dm.test.mjs and mcpl-rooms-policy-any.test.mjs
 * already use: pure `routeIncoming` for the activation decision, the REAL
 * `openRoom`/`createRoomTails` (sandboxed to this file's own
 * HOUSE_RUNS_DIR) for the room-opening half — no spawned child, no mock
 * platform server, no being's-turn socket; the mechanism under test never
 * needed one.
 *
 * Bug A: a seat's own `trackRoom` fired only once THAT seat's own
 * platform child delivered its copy of a message — the second consumer's
 * own delivery lag (30s, live) delayed a sibling being's reply by however
 * long its own copy took to land, even though the house already knew the
 * room. Fixed house-side (mcpl/seat-registry.mjs, reached from
 * room-tails.mjs's `ensureLive`): the moment ANY seat opens a room, every
 * OTHER matching seat starts tracking it AT ONCE — proven below via B's
 * own `tails` map, populated before B's own `ensureLive` is ever called.
 *
 * Bug B: under "any", a second seat's own being never joined an existing
 * room's roster on its own — a mention of it routed against a roster that
 * never named it. Fixed the same way: a policy-"any" sibling not yet a
 * participant joins as a resident (the same `addParticipant(...,
 * "config", "resident")` openRoom's own `mergeConfiguredBeings` uses) the
 * moment the room is touched — proven below via the room's own roster on
 * disk, then via routeIncoming actually activating the joined being on a
 * mention (`reasons[being] === "mention"`), which it could not before
 * (the room's roster used to name only the minting being).
 *
 * Exercised both delivery orders (a-first, b-first) — the fix is
 * order-independent by construction (seat-registry.mjs has no notion of
 * "first", only "every OTHER registered seat on this platform"). */
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOUSE_RUNS_DIR/HOUSE_PRIVATE_DIR/HOUSE_COVENANTS_DIR before the FIRST
// import of anything under src/ (serve-paths.mjs reads them once, at
// module load — every in-process test file in this suite names this trap).
const ROOT = mkdtempSync(join(tmpdir(), "signal-two-seats-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
// "alice" (roomInput's own `by`) needs a known identity — room-multi-seat.
// test.mjs's own convention: a private root is enough (knownHandle).
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "alice"), { recursive: true });

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { writeTestament } = await import("./lib/fixtures.mjs");
const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { findRoom } = await import("../src/room-index.mjs");
const { readCls } = await import("../src/room-policy.mjs");
const { beingsOf } = await import("../src/beings.mjs");
const { createRoomTails } = await import("../src/mcpl/room-tails.mjs");
const { clearSeatRegistry } = await import("../src/mcpl/seat-registry.mjs");
const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");

const PLATFORM = "signal";

/** the same shape mcpl/seat.mjs's own `roomsOpen` closure is, but reading
 * the room's CURRENT roster off disk each time (never a fixed snapshot) —
 * so a caller (routeIncoming below) sees a roster this test's own
 * `mergeConfiguredBeings`/`addParticipant` side effects have just grown. */
function roomsOpenFor(platform) {
  return (stream) => {
    const found = findRoom({ platform, stream });
    if (!found) return null;
    const runDir = join(process.env.HOUSE_RUNS_DIR, found.id);
    return { id: found.id, beings: beingsOf(readCls(runDir)), live: true };
  };
}

/** routeIncoming's own stub deps (two-accounts-dm.test.mjs's own convention). */
function depsFor(server) {
  return {
    server,
    roomsOpen: roomsOpenFor(PLATFORM),
    identityFor: ({ id }) => ({ handle: String(id), known: true }),
    isBeing: (h) => h === server.__A || h === server.__B,
    covenants: () => ({
      posture: "present",
      dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 },
    }),
    roomKeyOf: (s) => s,
    awakeOf: () => true,
    isKeeper: () => false,
  };
}

/** a mention-of-`target` group message, alice speaking. */
function mentionMsg(stream, target, id) {
  return normalizeIncoming({
    channelId: stream,
    messageId: id,
    author: { id: "alice", name: "alice" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: `alice: @${target} are you there?` }],
    metadata: { mentions: [target], rawContent: `<@${target}> are you there?` },
    tags: ["chat:mention", "chat:from-human"],
  });
}

/** one full pair: `first`'s own `ensureLive` mints the room alone (no
 * configured roster at all — an "any" room is discovered dynamically);
 * `second` never calls its own `ensureLive` before the assertions below —
 * bug A/B's fix must reach it purely house-side.
 * @param {{name: string, first: string, second: string}} opts */
async function runPair({ name, first, second }) {
  // this file's own two pairs are independent — the registry is a
  // house-lifetime singleton in production (routes.mjs's `stopSeats`
  // clears it); a bare `createRoomTails` here has no such teardown of its
  // own, so a PRIOR pair's registrations would otherwise leak into this
  // one's roster (found live: all four handles joined one room).
  clearSeatRegistry();
  writeTestament(process.env.HOUSE_COVENANTS_DIR, first, { speaksFor: PLATFORM });
  writeTestament(process.env.HOUSE_COVENANTS_DIR, second, { speaksFor: PLATFORM });

  const stream = `signal:group:any-${name}`;
  const cfgFirst = { platform: PLATFORM, being: first, rooms: [], rooms_policy: "any" };
  const cfgSecond = { platform: PLATFORM, being: second, rooms: [], rooms_policy: "any" };
  const tailsFirst = createRoomTails({
    cfg: cfgFirst,
    RUNS: process.env.HOUSE_RUNS_DIR,
    openRoom,
    roomsOpen: roomsOpenFor(PLATFORM),
  });
  const tailsSecond = createRoomTails({
    cfg: cfgSecond,
    RUNS: process.env.HOUSE_RUNS_DIR,
    openRoom,
    roomsOpen: roomsOpenFor(PLATFORM),
  });

  // `first` alone opens the room — `second` has done NOTHING yet: no
  // ensureLive call, no message, nothing. The incident's own worst case
  // (a dropped/very-late second consumer) is `second` never showing up
  // here at all before the assertions below.
  const roomId = await tailsFirst.ensureLive(stream, { title: `any-policy pair (${name})` });
  assert.ok(existsSync(join(process.env.HOUSE_RUNS_DIR, roomId)), "the room minted on disk");

  // bug A: `second`'s own seat is ALREADY tracking the room — house-side,
  // never through its own (never-sent) copy.
  assert.ok(
    tailsSecond.tails.has(roomId),
    "`second`'s own tails map already tracks the room, before its own ensureLive ever ran",
  );
  // bug B: `second`'s being is already a resident on disk, the same way.
  const runDir = join(process.env.HOUSE_RUNS_DIR, roomId);
  assert.deepEqual(
    beingsOf(readCls(runDir)).slice().sort(),
    [first, second].slice().sort(),
    "the room's own roster already names both beings — `second` joined proactively",
  );

  // a mention of `second` now activates it — impossible before this fix,
  // since the room's own roster used to name only `first`.
  const server = { name: `sts-${name}-first`, platform: PLATFORM, being: first, rooms: [], rooms_policy: "any", __A: first, __B: second };
  const msg = mentionMsg(stream, second, `m-${name}`);
  const actions = routeIncoming({ ...depsFor(server), msg });
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input, "an input action for the mention");
  assert.ok(input.targets.includes(second), "the mention activates `second`");
  assert.equal(input.reasons[second], "mention", 'reasons[second] === "mention" — the roster now holds both');

  // recording that same message through roomInput, then its OWN duplicate
  // (as `second`'s own late copy would be) — one frame, never two.
  const r1 = await roomInput({
    id: roomId,
    by: "alice",
    text: msg.text,
    targets: [second],
    observe: false,
    external: { platform: PLATFORM, message_id: msg.messageId },
  });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.unseated, [second], "recorded and targeted — no being's-turn seat attached in this test, so honestly unseated");
  const r2 = await roomInput({
    id: roomId,
    by: "alice",
    text: msg.text,
    targets: [second],
    observe: false,
    external: { platform: PLATFORM, message_id: msg.messageId },
  });
  assert.equal(r2.duplicate, true, "`second`'s own late copy of the same message dedups, never a second record");
}

test("signal-two-seats: A mints the room, B never calls its own ensureLive — B tracks and joins before its own delivery, then a mention of B activates it", async () => {
  await runPair({ name: "a-first", first: "kestrel-sts-a", second: "linden-sts-a" });
});

test("signal-two-seats: symmetric — B mints the room, A never calls its own ensureLive — same guarantees in reverse", async () => {
  await runPair({ name: "b-first", first: "linden-sts-b", second: "kestrel-sts-b" });
});

// every mkdtemp sandbox above (ROOT) is left in place — deferred-ops:
// never rm'd from a test, the OS reaps /tmp.
