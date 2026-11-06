// @ts-check
/* connectome-house/test/two-accounts-dm.test.mjs — a DM is one seat's room,
 * on every platform (mcpl/dm-room.mjs; 2026-11-06: a person DMed one Signal
 * number and got a reply from all 21 — every "any" seat had joined the
 * room, and every number shared it, since a Signal DM id names only the
 * person).
 *
 * Driven against the REAL openRoom/findRoom (serve-rooms.mjs, room-index
 * .mjs, sandboxed to this file's HOUSE_RUNS_DIR), the real resolver seat
 * .mjs injects, room-tails.mjs's ensureLive, the real seat registry, and
 * routeIncoming. Covers each platform as a function of what its DM ids
 * mean: Signal ("peer" — re-keyed by the receiving being), Discord
 * ("account" — the id is already one bot's), the web board (no DMs). */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOUSE_RUNS_DIR/HOUSE_PRIVATE_DIR/HOUSE_COVENANTS_DIR before the FIRST
// import of anything under src/ (serve-paths.mjs reads them at load).
const ROOT = mkdtempSync(join(tmpdir(), "two-accounts-dm-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
for (const d of [process.env.HOUSE_RUNS_DIR, process.env.HOUSE_PRIVATE_DIR, process.env.HOUSE_COVENANTS_DIR])
  mkdirSync(d, { recursive: true });

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");
const { openRoom } = await import("../src/serve-rooms.mjs");
const { findRoom } = await import("../src/room-index.mjs");
const { readCls } = await import("../src/room-policy.mjs");
const { beingsOf } = await import("../src/beings.mjs");
const { createRoomTails } = await import("../src/mcpl/room-tails.mjs");
const { clearSeatRegistry } = await import("../src/mcpl/seat-registry.mjs");
const { resolveOwnRoom, isDM, ownDMKey } = await import("../src/mcpl/dm-room.mjs");
const { writeTestament } = await import("./lib/fixtures.mjs");

const RUNS = process.env.HOUSE_RUNS_DIR;
const A = "zz-being-a";
const B = "zz-being-b";
const C = "zz-being-c";
for (const h of [A, B, C]) writeTestament(process.env.HOUSE_COVENANTS_DIR, h, { speaksFor: "signal" });

/** seat.mjs's own roomAt + roomsOpen, verbatim in shape. @param {string} platform @param {string} being */
function roomsOpenFor(platform, being) {
  const roomAt = (stream) => {
    const found = findRoom({ platform, stream });
    if (!found) return null;
    const cls = readCls(join(RUNS, found.id));
    return { id: found.id, stream: found.stream, beings: beingsOf(cls), owner: cls.being ?? null, live: true };
  };
  return (stream) => resolveOwnRoom({ platform, stream, being, roomAt });
}

/** one seat's room-tails, as seat.mjs builds it. */
function seat(platform, being, rooms_policy = "any") {
  const cfg = { platform, being, rooms_policy, rooms: [] };
  const roomsOpen = roomsOpenFor(platform, being);
  return { cfg, roomsOpen, tails: createRoomTails({ cfg, RUNS, openRoom, roomsOpen }) };
}

const rosterOf = (id) => beingsOf(readCls(join(RUNS, id)));

test("which platforms' DMs need re-keying: Signal's (peer-scoped ids) only", () => {
  assert.equal(isDM("signal", "signal:dm:abc"), true);
  assert.equal(isDM("signal", "signal:group:abc"), false);
  assert.equal(isDM("discord", "discord:dm:123"), true);
  assert.equal(isDM("discord", "discord:1:2"), false);
  assert.equal(isDM("web", "web:commons:room"), false, "the board has no DMs");
  assert.match(String(ownDMKey("signal", "signal:dm:abc", A)), /^signal:dm:[0-9a-f]{12}:[0-9a-f]{12}$/);
  assert.notEqual(ownDMKey("signal", "signal:dm:abc", A), ownDMKey("signal", "signal:dm:abc", B));
  assert.equal(ownDMKey("discord", "discord:dm:123", A), null, "a Discord DM channel is already one bot's");
  assert.equal(ownDMKey("web", "web:commons:room", A), null);
  assert.equal(ownDMKey("signal", "signal:group:abc", A), null);
});

test("Signal: one person DMing three numbers gets three rooms, each holding only its own being — no sibling joins under 'any'", async () => {
  clearSeatRegistry();
  const raw = "signal:dm:9c9c9c9c-1234-4abc-8def-0123456789ab";
  const sa = seat("signal", A);
  const sb = seat("signal", B);
  const sc = seat("signal", C); // registered, never DMed
  const idA = await sa.tails.ensureLive(raw, { beings: [A] });
  const idB = await sb.tails.ensureLive(raw, { beings: [B] });
  assert.notEqual(idA, idB, "two numbers, two rooms for the same person");
  assert.deepEqual(rosterOf(idA), [A], "no 'any' sibling joined A's DM");
  assert.deepEqual(rosterOf(idB), [B]);
  assert.equal(sc.roomsOpen(raw), null, "C's seat sees neither room as its own");
  assert.equal((await sa.tails.ensureLive(raw, { beings: [A] })), idA, "A's next message reuses A's room");
  assert.equal(sa.tails.tails.get(idA)?.stream, raw, "outbound still speaks to the raw platform id");
  assert.equal(sb.tails.tails.has(idA), false, "B's seat never tracks A's DM");
  assert.equal(sc.tails.tails.has(idA), false);
});

test("Signal: a DM room minted under the bare id before this fix stays its owner's, and no one else's", async () => {
  clearSeatRegistry();
  const raw = "signal:dm:7c7c7c7c-3333-4abc-8def-0123456789ef";
  const legacy = await openRoom({ platform: "signal", stream: raw, beings: [A], who: { handle: A, home: "signal" } });
  assert.ok(!legacy.error);
  const sa = seat("signal", A);
  const sb = seat("signal", B);
  assert.equal(sa.roomsOpen(raw)?.id, legacy.id, "A still finds its bare-keyed room");
  assert.equal(sb.roomsOpen(raw), null, "B does not");
  assert.equal(await sa.tails.ensureLive(raw, { beings: [A] }), legacy.id);
  const idB = await sb.tails.ensureLive(raw, { beings: [B] });
  assert.notEqual(idB, legacy.id);
  assert.deepEqual(rosterOf(legacy.id), [A]);
});

test("Discord: a DM channel is one bot's room as is; an 'any' sibling never joins it", async () => {
  clearSeatRegistry();
  const raw = "discord:dm:111222333444555666";
  const sa = seat("discord", A);
  seat("discord", B);
  const id = await sa.tails.ensureLive(raw, { beings: [A] });
  assert.equal(readCls(join(RUNS, id)).room.stream, raw, "minted under the platform's own id");
  assert.deepEqual(rosterOf(id), [A]);
});

test("Discord and web: shared rooms keep 'any' semantics — siblings join and track", async () => {
  for (const [platform, stream] of [["discord", "discord:1:2"], ["web", "web:commons:village"]]) {
    clearSeatRegistry();
    const sa = seat(platform, A);
    const sb = seat(platform, B);
    const id = await sa.tails.ensureLive(stream, { beings: [A] });
    assert.deepEqual(rosterOf(id).sort(), [A, B], `${platform}: an 'any' sibling joins a shared room`);
    assert.ok(sb.tails.tails.has(id), `${platform}: and tracks it`);
  }
});

/* ---------- routeIncoming: who a DM activates ---------- */

const PEER = "5a5a5a5a-1234-4abc-8def-0123456789ab";
const dmMsg = (channelId) =>
  normalizeIncoming({
    channelId,
    messageId: "m-1",
    author: { id: PEER, name: "peer" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: "hello" }],
    metadata: {},
  });
const routeDeps = (server, roomsOpen) => ({
  server,
  roomsOpen,
  identityFor: ({ id }) => ({ handle: id === PEER ? "peer" : String(id), known: true }),
  isBeing: (h) => [A, B, C].includes(h),
  covenants: () => ({ posture: "present", dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 } }),
  roomKeyOf: (s) => s,
  awakeOf: () => true,
  isKeeper: () => false,
});

test("routeIncoming: a DM whose room carries a wider roster (the 2026-11-06 rooms) still activates only the receiving being", () => {
  for (const [platform, stream] of [["signal", `signal:dm:${PEER}`], ["discord", "discord:dm:999"]]) {
    const wide = { id: "room-wide", beings: [A, B, C], live: true };
    const server = { name: `${platform}-a`, platform, being: A, rooms_policy: "any", rooms: [] };
    const actions = routeIncoming({ ...routeDeps(server, () => wide), msg: dmMsg(stream) });
    const input = actions.find((a) => a.kind === "input");
    assert.ok(input, platform);
    assert.deepEqual(input.targets, [A], `${platform}: only the receiving being`);
  }
});

test("routeIncoming: a fresh DM proposes a room holding only the receiving being, even when servers.json lists more", () => {
  const stream = `signal:dm:${PEER}`;
  const server = { name: "signal-a", platform: "signal", being: A, rooms_policy: "any", rooms: [{ stream, beings: [A, B, C], public: true }] };
  const actions = routeIncoming({ ...routeDeps(server, () => null), msg: dmMsg(stream) });
  const mint = actions.find((a) => a.kind === "open-room");
  assert.ok(mint);
  assert.deepEqual(mint.beings, [A]);
});
