// @ts-check
/* connectome-house/test/two-accounts-dm.test.mjs — harness-port R2-W,
 * 2026-09-17 (mission task 2): routeIncoming's own decision layer must
 * look a Signal DM up by canonicalStream (stream-key.mjs), keyed by the
 * RECEIVING account, once a server ISN'T the platform's primary/first-
 * seated one — a peer DMing two house numbers belongs to two rooms, never
 * one shared room (a privacy bug, not just a mismatch).
 *
 * Every lookup here is a stub (roomsOpen is a plain Map read) — this is
 * the SAME direct-routeIncoming convention test/mcpl-route.test.mjs and
 * the O6/O7 tests in dispatch-discord-matrix.test.mjs already use, and it
 * is deliberately the right altitude for what this task actually owns:
 * route.mjs's OWN lookup decision. What this file does NOT (and cannot)
 * prove: that the two accounts' rooms end up as two distinct DIRECTORIES
 * on disk — that also needs seat.mjs's own `ensureLive`/`roomsOpen` calls
 * (mcpl/seat.mjs, NO-TOUCH for this task) to thread the same canonical key
 * through at MINT time, not only at lookup time. Named here, and in this
 * task's own report, as the one remaining seam. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeIncoming } from "../src/mcpl/route.mjs";
import { normalizeIncoming } from "../src/mcpl/normalize.mjs";

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
