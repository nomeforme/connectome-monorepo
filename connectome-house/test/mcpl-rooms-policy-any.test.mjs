// @ts-check
/* connectome-house/test/mcpl-rooms-policy-any.test.mjs — harness-port
 * W5-A, 2026-09-19: a per-server `rooms_policy: "any"` field — axon
 * parity, every stream a server delivers is a standing room, never
 * ignored for being unconfigured; defaults it public unless an explicit
 * rooms[] entry says otherwise. Pure routeIncoming, same stub-level
 * convention as mcpl-route.test.mjs's own gated-room tests — nothing
 * touches disk or a real seat.
 *
 * DMs open under "any" too (a deliberate call, not the default DM gate):
 * the fleet's own Signal axon answered EVERY DM unconditionally, no
 * linking concept at all — `else if (!isGroupMessage) { ... shouldActivate
 * = true; activationReason = 'dm'; }`, no sender check whatsoever
 * (signal-axon/src/grpc/components/signal-message-receptor.ts:448-455,
 * read directly on sfo). "any" is meant as parity with that seat, so an
 * unlisted DM answers too — admitsUnlistedDM itself is untouched (still
 * exercised by the "listed" tests below); only its call site in
 * routeIncoming is skipped when rooms_policy is "any". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { admitsUnlistedDM, routeIncoming } from "../src/mcpl/route.mjs";
import { normalizeIncoming } from "../src/mcpl/normalize.mjs";

const PRESENT = "zz-any-present";
const BOT_ID = "bot-any-777";

/** @param {object} [overrides] */
function deps(overrides = {}) {
  const identityFor = ({ id }) =>
    id === BOT_ID
      ? { handle: PRESENT, known: true } // the mentioned being's own id
      : { handle: `mock-${id}`, known: true, linked: false };
  return {
    roomsOpen: () => null,
    identityFor,
    isBeing: (h) => h === PRESENT,
    covenants: () => ({
      posture: "present",
      dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 },
    }),
    roomKeyOf: (stream) => `mock:${stream}`,
    awakeOf: () => true,
    isKeeper: () => false,
    ...overrides,
  };
}

const groupMsg = () =>
  normalizeIncoming({
    channelId: "mock:unlisted-group:c9",
    messageId: "m-1",
    author: { id: "u-alice", name: "alice" },
    timestamp: "t",
    content: [{ type: "text", text: "alice: @bot hi" }],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> hi` },
    tags: ["chat:mention", "chat:from-human"],
  });

const dmMsg = () =>
  normalizeIncoming({
    channelId: "mock:dm:u-stranger",
    messageId: "m-2",
    author: { id: "u-stranger", name: "stranger" },
    timestamp: "t",
    content: [{ type: "text", text: "stranger: hello" }],
    metadata: {},
    tags: ["chat:dm", "chat:from-human"],
  });

/* ---------------------------------------------------------------------- */
/* group stream: "listed" (default) ignores, "any" opens it, public       */
/* ---------------------------------------------------------------------- */

test('rooms_policy default ("listed"): an unconfigured group stream is ignored, exactly as before this field existed', () => {
  const server = { name: "s", platform: "mock", being: PRESENT, rooms: [] };
  const actions = routeIncoming({ ...deps(), server, msg: groupMsg() });
  assert.deepEqual(actions, [{ kind: "ignore", reason: "unconfigured" }]);
});

test('rooms_policy "any": an unconfigured group stream is a standing room — input (not ignore), and public (no gate, no notice)', () => {
  const server = { name: "s", platform: "mock", being: PRESENT, rooms: [], rooms_policy: "any" };
  const actions = routeIncoming({ ...deps(), server, msg: groupMsg() });
  assert.ok(!actions.some((a) => a.kind === "ignore"), 'never ignored under "any"');
  const opened = actions.find((a) => a.kind === "open-room");
  assert.ok(opened, "a fresh mint — no room was configured or open");
  assert.deepEqual(opened.beings, [PRESENT], "no matching rooms[] entry: the server's own being alone");
  const input = actions.find((a) => a.kind === "input");
  assert.deepEqual(input.targets, [PRESENT], "mentioned, and never gated — activates");
  assert.equal(input.notice, undefined, 'public by default under "any": no unlinked-room template');
  assert.equal(input.reasons[PRESENT], "mention");
});

test('rooms_policy "any": an explicit rooms[] entry for the same stream still applies its own title/beings/public', () => {
  const server = {
    name: "s",
    platform: "mock",
    being: PRESENT,
    rooms: [
      { stream: "mock:unlisted-group:c9", title: "named", beings: [PRESENT, "zz-other"], public: false },
    ],
    rooms_policy: "any",
    identity_gate: "rooms",
  };
  const actions = routeIncoming({ ...deps(), server, msg: groupMsg() });
  const opened = actions.find((a) => a.kind === "open-room");
  assert.equal(opened.title, "named");
  assert.deepEqual(opened.beings, [PRESENT, "zz-other"]);
  const input = actions.find((a) => a.kind === "input");
  assert.equal(input.notice, true, 'an explicit public:false still gates an unlinked sender, even under "any"');
});

/* ---------------------------------------------------------------------- */
/* DM: "listed" keeps admitsUnlistedDM's own gate; "any" answers anyone   */
/* ---------------------------------------------------------------------- */

test("rooms_policy default (\"listed\"): an unlisted DM from an unlinked stranger is ignored — admitsUnlistedDM's own gate, unchanged", () => {
  const server = { name: "s", platform: "mock", being: PRESENT, rooms: [], identity_gate: "dm" };
  const actions = routeIncoming({ ...deps(), server, msg: dmMsg() });
  assert.deepEqual(actions, [{ kind: "ignore", reason: "unconfigured" }]);
});

test('rooms_policy "any": an unlisted DM from an unlinked stranger answers too — the deliberate axon-parity call above, not the DM gate default', () => {
  const server = { name: "s", platform: "mock", being: PRESENT, rooms: [], rooms_policy: "any" };
  const actions = routeIncoming({ ...deps(), server, msg: dmMsg() });
  assert.ok(!actions.some((a) => a.kind === "ignore"));
  const input = actions.find((a) => a.kind === "input");
  assert.equal(input.messageKind, "dm");
  assert.deepEqual(input.targets, [PRESENT], "a DM always activates — gating never applies to DMs regardless");
  assert.equal(input.reasons[PRESENT], "dm");
});

test("admitsUnlistedDM itself is untouched by this task — only its call site in routeIncoming is skipped by \"any\"", () => {
  assert.equal(
    admitsUnlistedDM({
      messageKind: "dm",
      sender: { known: true, handle: "x", linked: false },
      isKeeper: () => false,
    }),
    false,
    "an unlinked, non-keeper DM sender still fails the predicate on its own",
  );
});
