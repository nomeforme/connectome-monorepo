// @ts-check
/* connectome-house/test/signal-uuid-mention.test.mjs — THE BUG (harness-
 * port W6-R1, 2026-09-19), pure: a Signal group message whose text
 * carries `<@<uuid>>` — the mentioned account's own uuid, never a phone
 * number (mcpl-signal/src/envelopes.mjs's `replaceMentions`) — routed
 * with a stub `identityFor` standing in for a seat that has ALREADY
 * christened that uuid to the being's own handle (room-tails.mjs's
 * `christenBeing`, seat.mjs's `checkSelf` — this task's own wiring,
 * exercised end to end in test/remote-seat-signal.test.mjs instead of
 * here). Proves the two things THE BUG actually broke: the activation
 * reason is `mention` (never a fresh stranger pseudonym), and the
 * recorded text names the being by its real handle. No socket, no disk
 * beyond identity-map.mjs's own lookups — routeIncoming's every other
 * dependency is a stub, mcpl-route.test.mjs's own established shape. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeIncoming } from "../src/mcpl/route.mjs";
import { normalizeIncoming } from "../src/mcpl/normalize.mjs";

const BEING = "claude-haiku-4-5";
// a made-up uuid only (pii-discipline) — the shape mcpl-signal's own
// MENTION_TOKEN_RE requires: 36 chars, hex + dashes.
const FAKE_UUID = "aaaaaaaa-0000-4000-8000-0000000000f1";
const STREAM = "signal:group:g1";

const SERVER = {
  name: "signal-uuid-test",
  platform: "signal",
  being: BEING,
  rooms: [{ stream: STREAM, title: "the porch", beings: [BEING], public: true }],
};

/** a seat that has ALREADY christened FAKE_UUID to BEING (this task's own
 * mission: "the seat christens every id it knows for its being" —
 * `self.uuid` included) — the one fact this test exists to assume, since
 * seat.mjs/room-tails.mjs's own wiring is proven live elsewhere. */
function identityFor({ platform, id }) {
  if (platform === "signal" && id === FAKE_UUID) return { handle: BEING, known: true };
  const handle = `${platform}-${String(id).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6)}`;
  return { handle, known: false };
}

const deps = {
  server: SERVER,
  roomsOpen: () => null,
  identityFor,
  isBeing: (h) => h === BEING,
  covenants: () => ({
    posture: "present",
    dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 },
  }),
  roomKeyOf: (stream) => stream,
  awakeOf: () => true,
  streakOf: () => 0,
};

test("a Signal <@uuid> mention token, once the uuid is christened, activates the being by handle — not a stranger pseudonym", () => {
  const msg = normalizeIncoming({
    channelId: STREAM,
    messageId: "s-1",
    author: { id: "bbbbbbbb-1111-4111-8111-000000000002", name: "alice" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: `alice: are you there?` }],
    metadata: {
      mentions: [FAKE_UUID],
      rawContent: `<@${FAKE_UUID}> are you there?`,
      replyTo: null,
      replyToAuthorId: null,
      isBot: false,
    },
    tags: ["chat:mention", "chat:addressed", "chat:group", "chat:from-human"],
  });

  const actions = routeIncoming({ ...deps, msg });
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input", "the message entered as input, never ignored");
  assert.deepEqual(input.targets, [BEING], "the uuid mention resolved to the being itself");
  assert.equal(input.reasons[BEING], "mention", "{being: \"mention\"} — the activation THE BUG lost");
  assert.equal(input.text, `@${BEING} are you there?`, "the recorded text names the being by its real handle");
  assert.ok(!input.text.includes(FAKE_UUID), "the raw uuid never rides in the recorded text");
});
