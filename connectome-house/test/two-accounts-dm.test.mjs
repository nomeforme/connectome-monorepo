// @ts-check
/* connectome-house/test/two-accounts-dm.test.mjs — harness-port R2-W,
 * 2026-09-17 (mission task 2): routeIncoming's own decision layer must
 * look a Signal DM up by canonicalStream (stream-key.mjs), keyed by the
 * RECEIVING account, once a server ISN'T the platform's primary/first-
 * seated one — a peer DMing two house numbers belongs to two rooms, never
 * one shared room (a privacy bug, not just a mismatch).
 *
 * The first three tests below are a stub-level check (roomsOpen is a
 * plain Map read) of route.mjs's OWN lookup decision — the SAME direct-
 * routeIncoming convention test/mcpl-route.test.mjs and the O6/O7 tests
 * in dispatch-discord-matrix.test.mjs already use.
 *
 * GAP FLIPPED (harness-port R2-X, mission task 2): the fourth test below
 * drives the REAL seat-side half this file's own header used to name as
 * unproven — room-tails.mjs's `ensureLive`, MINTING (not just looking up)
 * by the same canonical, account-scoped key for a non-primary account —
 * so the two accounts' rooms really do end up as two distinct
 * DIRECTORIES on disk, never a shared one, while a single-server
 * (primary) room keeps minting under the exact raw stream, unchanged. */
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOUSE_RUNS_DIR/HOUSE_PRIVATE_DIR/HOUSE_COVENANTS_DIR before the FIRST
// import of anything under src/ (serve-paths.mjs reads them once, at
// module load — commands-wired.test.mjs's own header names this trap).
const ROOT = mkdtempSync(join(tmpdir(), "two-accounts-dm-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");

const PEER_UUID = "9c9c9c9c-1234-4abc-8def-0123456789ab";
const RAW_STREAM = `signal:dm:${PEER_UUID}`;
const BEING = "zz-two-accounts-being";

const dmMsg = () =>
  normalizeIncoming({
    channelId: RAW_STREAM,
    messageId: "m-1",
    author: { id: PEER_UUID, name: "peer" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: "hello" }],
    metadata: {},
  });

/** @param {{server: any, roomsOpenFn: (key: string) => any}} args */
function baseDeps({ server, roomsOpenFn }) {
  return {
    server,
    roomsOpen: roomsOpenFn,
    identityFor: ({ id }) => (id === PEER_UUID ? { handle: "peer", known: true } : { handle: String(id), known: true }),
    isBeing: (h) => h === BEING,
    covenants: () => ({
      posture: "present",
      dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 },
    }),
    roomKeyOf: (s) => s,
    awakeOf: () => true,
    isKeeper: () => false,
  };
}

test("two Signal servers (accounts), one peer DMing both: the primary account's lookup finds its already-open raw-keyed room; the non-primary account's does not — a fresh mint is proposed instead, never a shared room", () => {
  // today's on-disk reality: an existing room, minted before this task,
  // keyed by the bare RAW stream (no account segment) — the shape every
  // already-open Signal DM room has right now.
  const openRooms = new Map([[RAW_STREAM, { id: "room-existing", beings: [BEING], live: true }]]);
  const roomsOpenFn = (key) => openRooms.get(key) ?? null;

  const serverA = {
    name: "signal-a",
    platform: "signal",
    being: BEING,
    being_id: "acct-a",
    // primary unset -> defaults true (the platform's first-seated account)
    rooms: [{ stream: RAW_STREAM, beings: [BEING], public: true }],
  };
  const serverB = {
    name: "signal-b",
    platform: "signal",
    being: BEING,
    being_id: "acct-b",
    primary: false,
    rooms: [{ stream: RAW_STREAM, beings: [BEING], public: true }],
  };

  const actionsA = routeIncoming({ ...baseDeps({ server: serverA, roomsOpenFn }), msg: dmMsg() });
  const actionsB = routeIncoming({ ...baseDeps({ server: serverB, roomsOpenFn }), msg: dmMsg() });

  assert.equal(
    actionsA.some((a) => a.kind === "open-room"),
    false,
    "account A (primary) finds its already-open room via the raw-key fallback — no fresh mint",
  );
  assert.equal(
    actionsB.some((a) => a.kind === "open-room"),
    true,
    "account B (non-primary) does NOT find account A's room under its own canonical key — a distinct room is proposed instead of colliding into the same DM",
  );

  const inputA = actionsA.find((a) => a.kind === "input");
  const inputB = actionsB.find((a) => a.kind === "input");
  assert.ok(inputA && inputB, "both accounts still record the message");
  assert.deepEqual(inputA.targets, [BEING]);
  assert.deepEqual(inputB.targets, [BEING]);

  // the mint action itself still carries the RAW stream (this task's own
  // instruction: "a fresh mint still stores the raw key") — see this
  // file's own header for the one remaining seam this leaves.
  const mintB = actionsB.find((a) => a.kind === "open-room");
  assert.equal(mintB.stream, RAW_STREAM);
});

test("single-server Signal DM rooms are unchanged: the primary account's lookup still finds an already-open raw-keyed room exactly as before this task", () => {
  const openRooms = new Map([[RAW_STREAM, { id: "room-existing", beings: [BEING], live: true }]]);
  const roomsOpenFn = (key) => openRooms.get(key) ?? null;
  const server = {
    name: "signal-solo",
    platform: "signal",
    being: BEING,
    rooms: [{ stream: RAW_STREAM, beings: [BEING], public: true }],
  };
  const actions = routeIncoming({ ...baseDeps({ server, roomsOpenFn }), msg: dmMsg() });
  assert.equal(actions.some((a) => a.kind === "open-room"), false, "no fresh mint — the existing room is found");
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input);
  assert.equal(input.stream, RAW_STREAM);
});

test("single-server Signal DM, no room open yet at all: mints once, under the raw stream, same as before this task", () => {
  const roomsOpenFn = () => null;
  const server = {
    name: "signal-solo-fresh",
    platform: "signal",
    being: BEING,
    rooms: [{ stream: RAW_STREAM, beings: [BEING], public: true }],
  };
  const actions = routeIncoming({ ...baseDeps({ server, roomsOpenFn }), msg: dmMsg() });
  const mint = actions.find((a) => a.kind === "open-room");
  assert.ok(mint, "no existing room anywhere — a fresh mint is proposed");
  assert.equal(mint.stream, RAW_STREAM);
});

// ---------------------------------------------------------------------
// GAP FLIPPED (harness-port R2-X, mission task 2): the REAL seat-side
// half — room-tails.mjs's own `ensureLive`, against the REAL `openRoom`
// (serve-rooms.mjs, sandboxed to this file's own HOUSE_RUNS_DIR) — two
// accounts really do get two run directories on disk for the same peer.
// ---------------------------------------------------------------------

const { openRoom } = await import("../src/serve-rooms.mjs");
const { findRoom } = await import("../src/room-index.mjs");
const { createRoomTails } = await import("../src/mcpl/room-tails.mjs");
const { writeTestament } = await import("./lib/fixtures.mjs");

writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "signal" });

/** the same shape mcpl/seat.mjs's own `roomsOpen` closure is — a plain
 * forward onto findRoom, injected into createRoomTails exactly as
 * seat.mjs injects its own. @param {string} platform */
function roomsOpenFor(platform) {
  return (stream) => {
    const found = findRoom({ platform, stream });
    return found ? { id: found.id, beings: [BEING], live: true } : null;
  };
}

test("ensureLive: two Signal servers (accounts) DMed by the same peer mint TWO distinct run directories on disk, never a shared one", async () => {
  const PEER2 = "8b8b8b8b-2222-4abc-8def-0123456789cd";
  const rawStream = `signal:dm:${PEER2}`;

  const cfgA = { platform: "signal", being: BEING, being_id: "acct-a2" }; // primary defaults true
  const cfgB = { platform: "signal", being: BEING, being_id: "acct-b2", primary: false };
  const tailsA = createRoomTails({ cfg: cfgA, RUNS: process.env.HOUSE_RUNS_DIR, openRoom, roomsOpen: roomsOpenFor("signal") });
  const tailsB = createRoomTails({ cfg: cfgB, RUNS: process.env.HOUSE_RUNS_DIR, openRoom, roomsOpen: roomsOpenFor("signal") });

  const idA = await tailsA.ensureLive(rawStream, { title: null, beings: [BEING] });
  const idB = await tailsB.ensureLive(rawStream, { title: null, beings: [BEING] });

  assert.notEqual(idA, idB, "two accounts, two rooms for the same peer — never a shared one");
  assert.ok(existsSync(join(process.env.HOUSE_RUNS_DIR, idA)), "account A's run dir exists");
  assert.ok(existsSync(join(process.env.HOUSE_RUNS_DIR, idB)), "account B's run dir exists");

  // a repeat call for either account REUSES its own room — never a third mint.
  const idA2 = await tailsA.ensureLive(rawStream, { title: null, beings: [BEING] });
  const idB2 = await tailsB.ensureLive(rawStream, { title: null, beings: [BEING] });
  assert.equal(idA2, idA, "account A's next message reuses its own room");
  assert.equal(idB2, idB, "account B's next message reuses its own room");

  // account A (primary) keeps minting under the exact raw stream —
  // unchanged from before this task; account B's own on-disk key is the
  // canonical, account-scoped one (the only seam available to distinguish
  // it without touching room-index.mjs/serve-rooms.mjs, both NO-TOUCH).
  const { readCls } = await import("../src/room-policy.mjs");
  const clsA = readCls(join(process.env.HOUSE_RUNS_DIR, idA));
  assert.equal(clsA.room.stream, rawStream, "the primary account's fresh mint still stores the raw stream");
});

test("single-server Signal DM room (real openRoom): resolves as before — one mint, then reused, always under the raw stream", async () => {
  const PEER3 = "7c7c7c7c-3333-4abc-8def-0123456789ef";
  const rawStream = `signal:dm:${PEER3}`;
  const cfg = { platform: "signal", being: BEING }; // no being_id/number_id/primary at all — the common single-account shape
  const tails = createRoomTails({ cfg, RUNS: process.env.HOUSE_RUNS_DIR, openRoom, roomsOpen: roomsOpenFor("signal") });

  const id1 = await tails.ensureLive(rawStream, { title: null, beings: [BEING] });
  const id2 = await tails.ensureLive(rawStream, { title: null, beings: [BEING] });
  assert.equal(id1, id2, "the second call reuses the same room — one mint only");

  const { readCls } = await import("../src/room-policy.mjs");
  const cls = readCls(join(process.env.HOUSE_RUNS_DIR, id1));
  assert.equal(cls.room.stream, rawStream);
});
