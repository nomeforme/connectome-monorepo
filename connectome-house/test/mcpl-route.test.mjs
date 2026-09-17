// @ts-check
/* harness/test/mcpl-route.test.mjs — the pure router: every action kind,
 * addressed vs ambient per posture, from-bot/from-self rules, unknown
 * sender → pseudonym, an asleep resident addressed → activates like a
 * visit (never a receipt), ambient → stays asleep, DM vs channel keys.
 * Every lookup is a stub; nothing touches disk. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeIncoming } from "../src/mcpl/route.mjs";
import { normalizeIncoming, normalizePush } from "../src/mcpl/normalize.mjs";

const PRESENT = "zz-present";
const RESIDENT = "zz-resident";
const BOT_ID = "bot-777";
const SERVER = {
  name: "mock-1",
  platform: "mock",
  being: PRESENT,
  // public: true — these fixtures predate the auth-gate and exercise
  // activation mechanics unrelated to it; the gate itself has its own
  // tests below, against a room that leaves `public` at its default.
  rooms: [
    { stream: "mock:g1:c1", title: "general", beings: [PRESENT, RESIDENT], public: true },
    { stream: "mock:dm:d1", title: "a dm" },
  ],
};

/** stub lookups: a tiny identity map with the bot's own id christened,
 * humans pseudonymized deterministically, one present + one resident */
function deps(overrides = {}) {
  const map = new Map([[`mock:${BOT_ID}`, PRESENT]]);
  const identityFor = ({ platform, id }) => {
    const key = `${platform}:${id}`;
    if (map.has(key)) return { handle: map.get(key), known: true };
    const handle = `${platform}-${id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6)}`;
    map.set(key, handle);
    return { handle, known: false };
  };
  return {
    server: SERVER,
    roomsOpen: () => null,
    identityFor,
    isBeing: (h) => h === PRESENT || h === RESIDENT,
    covenants: (h) =>
      h === RESIDENT
        ? { posture: "resident", dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 } }
        : { posture: "present", dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 } },
    roomKeyOf: (stream) => `mock:${stream}`,
    awakeOf: () => false,
    streakOf: () => 0,
    map,
    ...overrides,
  };
}

const incoming = (over = {}) =>
  normalizeIncoming({
    channelId: "mock:g1:c1",
    messageId: "m-1",
    author: { id: "u-alice", name: "alice" },
    timestamp: "t",
    content: [{ type: "text", text: "alice: hello there" }],
    metadata: {},
    tags: ["chat:ambient", "chat:from-human"],
    ...over,
  });

test("an unconfigured stream is ignored; history is kept, not poured", () => {
  const d = deps();
  assert.deepEqual(routeIncoming({ ...d, msg: incoming({ channelId: "mock:g9:c9" }) }), [
    { kind: "ignore", reason: "unconfigured" },
  ]);
  const hist = normalizeIncoming(incoming(), "history");
  assert.deepEqual(routeIncoming({ ...d, msg: hist }), [{ kind: "ignore", reason: "history-kept" }]);
});

test("addressed by a platform mention token: the room opens, the present being activates, the sender is a pseudonym", () => {
  const d = deps();
  const msg = incoming({
    content: [{ type: "text", text: "alice: @bot hi" }],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> hi` },
    tags: ["chat:mention", "chat:from-human"],
  });
  const actions = routeIncoming({ ...d, msg });
  assert.deepEqual(actions[0], {
    kind: "open-room",
    platform: "mock",
    stream: "mock:g1:c1",
    title: "general",
    beings: [PRESENT, RESIDENT],
  });
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.equal(input.text, `@${PRESENT} hi`, "the platform token became the house's @mention");
  assert.equal(input.by, "mock-ualice");
  assert.equal(input.by_kind, "human");
  assert.deepEqual(input.targets, [PRESENT]);
  assert.equal(input.observe, undefined, "someone activated — never observe-only");
  assert.equal(input.reasons[PRESENT], "mention");
  assert.equal(input.reasons[RESIDENT], "asleep", "the resident sleeps and was not addressed");
  assert.equal(input.messageKind, "channel");
  assert.deepEqual(
    input.external,
    { platform: "mock", message_id: "m-1", author: "mock-ualice", reply_to: null },
    "the sender's handle, never its platform id",
  );
  assert.ok(!JSON.stringify(input).includes("u-alice"), "no action carries the raw author id");
  assert.ok(!actions.some((a) => a.kind === "receipt"), "the resident was not addressed");
});

test("ambient in a channel: nobody activates — the message still enters, as input with targets:[] and observe:true", () => {
  const d = deps();
  const actions = routeIncoming({ ...d, msg: incoming() });
  assert.ok(!actions.some((a) => a.kind === "ignore"), "the record is the single copy of the room — ambient still enters");
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.deepEqual(input.targets, []);
  assert.equal(input.observe, true, "nobody activated — recorded, no turn");
  assert.equal(input.text, "hello there", "the platform's `username: ` prefix is stripped");
});

test("a DM: kind dm, the present being activates by the dm rule, the key stays the server's channel id", () => {
  const d = deps();
  const msg = normalizePush({
    eventId: "evt-1",
    timestamp: "t",
    origin: { mcplChannelId: "mock:dm:d1", messageId: "p-1", authorId: "u-bob", authorName: "bob", isDM: true },
    tags: ["chat:dm", "chat:from-human"],
    payload: { content: [{ type: "text", text: "bob: psst" }] },
  });
  const actions = routeIncoming({ ...d, msg });
  assert.equal(actions[0].kind, "open-room");
  assert.deepEqual(actions[0].kind === "open-room" && actions[0].beings, [PRESENT], "a room with no roster gets the server's being");
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.equal(input.messageKind, "dm");
  assert.equal(input.stream, "mock:dm:d1");
  assert.equal(input.reasons[PRESENT], "dm");
});

test("a reply to the being's own message activates by the reply rule; reply_to resolves through the identity map", () => {
  const d = deps();
  const msg = incoming({
    metadata: { replyTo: "m-0", replyToAuthorId: BOT_ID, rawContent: "yes, that" },
    tags: ["chat:reply", "chat:from-human"],
  });
  const input = routeIncoming({ ...d, msg }).find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.equal(input.reasons[PRESENT], "reply");
  assert.equal(input.external.reply_to, "m-0");
});

test("an asleep resident addressed → activates like a visit, asleep or awake alike; never a receipt", () => {
  const d = deps();
  const msg = incoming({
    metadata: { rawContent: `@${RESIDENT} are you there` },
    tags: ["chat:ambient", "chat:from-human"],
  });
  const asleep = routeIncoming({ ...d, msg });
  assert.equal(asleep[0].kind, "open-room");
  const asleepInput = asleep.find((a) => a.kind === "input");
  assert.ok(asleepInput, "the message enters the record");
  assert.deepEqual(asleepInput.targets, [RESIDENT], "addressed — a visit reaches a sleeping resident too");
  assert.equal(asleepInput.observe, undefined, "someone activated — never observe-only");
  assert.ok(!asleep.some((a) => a.kind === "receipt"), "an addressed message never falls to the receipt path");

  const awake = routeIncoming({ ...d, awakeOf: (h) => h === RESIDENT, msg });
  const input = awake.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.deepEqual(input.targets, [RESIDENT]);
  assert.equal(input.observe, undefined, "someone activated — never observe-only");
  assert.ok(!awake.some((a) => a.kind === "receipt"));
});

test("an asleep resident NOT addressed (genuinely ambient) stays asleep — recorded, no turn, no receipt", () => {
  const d = deps();
  const msg = incoming({ metadata: { rawContent: "just chatting, nobody named" } });
  const actions = routeIncoming({ ...d, msg });
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.equal(input.reasons[RESIDENT], "asleep");
  assert.deepEqual(input.targets, []);
  assert.equal(input.observe, true, "nobody activated — recorded, no turn");
  assert.ok(!actions.some((a) => a.kind === "receipt"), "asleep+targeted never co-occur post-fix — the receipt path is now structurally dead for platform rooms");
});

test("from-self never enters; a known bot enters as resident, an unknown bot as walker, and the mention budget gates bot→bot", () => {
  const d = deps();
  assert.deepEqual(
    routeIncoming({ ...d, msg: incoming({ tags: ["chat:from-self", "chat:mention"] }) }),
    [{ kind: "ignore", reason: "from-self" }],
  );
  // a known being (the other bot's id christened to the resident's handle) mentioning the present being
  d.map.set("mock:bot-res", RESIDENT);
  const fromKnownBot = incoming({
    author: { id: "bot-res", name: "resident-bot" },
    metadata: { rawContent: `<@${BOT_ID}> ping`, isBot: true },
    tags: ["chat:mention", "chat:from-bot"],
  });
  const a1 = routeIncoming({ ...d, msg: fromKnownBot }).find((a) => a.kind === "input");
  assert.ok(a1 && a1.kind === "input");
  assert.equal(a1.by, RESIDENT);
  assert.equal(a1.by_kind, "resident");
  assert.deepEqual(a1.targets, [PRESENT], "budget 1, streak 0: the first bot mention is answered");
  // the streak at the budget: the mention is not answered, but the line still enters, observe-only
  const a2 = routeIncoming({ ...d, streakOf: () => 1, msg: fromKnownBot }).find((a) => a.kind === "input");
  assert.ok(a2 && a2.kind === "input");
  assert.deepEqual(a2.targets, []);
  assert.equal(a2.observe, true);
  // an unknown bot is a walker, never a human
  const fromStranger = incoming({
    author: { id: "bot-x", name: "some-bot" },
    metadata: { rawContent: `<@${BOT_ID}> hi`, isBot: true },
    tags: ["chat:mention", "chat:from-bot"],
  });
  const a3 = routeIncoming({ ...d, msg: fromStranger }).find((a) => a.kind === "input");
  assert.ok(a3 && a3.kind === "input");
  assert.equal(a3.by_kind, "walker");
  assert.match(a3.by, /^mock-botx/);
});

test("an image block becomes a share-blob action beside the input; an open room's roster wins over config", () => {
  const d = deps({ roomsOpen: (s) => (s === "mock:g1:c1" ? { id: "room-mock-abcd1234-x", beings: [PRESENT], live: true } : null) });
  const msg = incoming({
    content: [{ type: "text", text: "alice: look" }, { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> look` },
    tags: ["chat:mention", "chat:has-image", "chat:from-human"],
  });
  const actions = routeIncoming({ ...d, msg });
  assert.ok(!actions.some((a) => a.kind === "open-room"), "already open");
  const blob = actions.find((a) => a.kind === "share-blob");
  assert.ok(blob && blob.kind === "share-blob");
  assert.equal(blob.mime, "image/png");
  assert.equal(blob.bytes.toString(), "png-bytes");
  assert.equal(blob.by, "mock-ualice");
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.deepEqual(Object.keys(input.reasons), [PRESENT], "the open room's roster, not the config's");
  // an ambient image still enters the record — the blob attaches, the line
  // lands observe-only, but nobody is dispatched to answer it.
  const ambientImg = incoming({
    content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    tags: ["chat:ambient", "chat:has-image", "chat:from-human"],
  });
  const ambientActions = routeIncoming({ ...d, msg: ambientImg });
  assert.ok(!ambientActions.some((a) => a.kind === "ignore"), "the record is the single copy of the room");
  assert.ok(ambientActions.some((a) => a.kind === "share-blob"), "the shared image still attaches to the record");
  const ambientInput = ambientActions.find((a) => a.kind === "input");
  assert.ok(ambientInput);
  assert.deepEqual(ambientInput.targets, [], "nobody activates for an unaddressed image");
  assert.equal(ambientInput.observe, true);
});

test("a message with no channel or no author is ignored, never guessed", () => {
  const d = deps();
  assert.deepEqual(routeIncoming({ ...d, msg: incoming({ channelId: null }) }), [{ kind: "ignore", reason: "no-channel" }]);
  assert.deepEqual(routeIncoming({ ...d, msg: incoming({ author: { id: null, name: "ghost" } }) }), [
    { kind: "ignore", reason: "no-author" },
  ]);
});

test("a platform mention by id alone (the text shows a display name, as Discord's cleanContent does): the being activates, never a receipt — the live 2026-09-10 symptom", () => {
  const d = deps({ map: new Map([[`mock:${BOT_ID}`, RESIDENT]]) });
  const map = new Map([[`mock:${BOT_ID}`, RESIDENT]]);
  d.identityFor = ({ platform, id }) =>
    map.has(`${platform}:${id}`)
      ? { handle: map.get(`${platform}:${id}`), known: true }
      : { handle: `${platform}-${id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6)}`, known: false };
  const msg = incoming({
    content: [{ type: "text", text: "alice: @vallynn hi" }],
    metadata: { mentions: [BOT_ID], rawContent: "@vallynn hi" },
    tags: ["chat:mention", "chat:from-human"],
  });
  const actions = routeIncoming({ ...d, msg });
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input && input.kind === "input");
  assert.equal(input.text, "@vallynn hi", "the platform's own rendering stands in the record");
  assert.deepEqual(input.targets, [RESIDENT], "the id in `mentions` is the address");
  assert.equal(input.reasons[RESIDENT], "mention");
  assert.equal(input.observe, undefined);
  assert.ok(!actions.some((a) => a.kind === "receipt"), "addressed while asleep is a visit, not a receipt");
});

test("once the platform's display name for the being is known (self-display.mjs), the literal '@vallynn' in the text is rewritten to the being's own handle before it enters the record", () => {
  const map = new Map([[`mock:${BOT_ID}`, RESIDENT]]);
  const d = deps({
    server: { ...SERVER, being: RESIDENT, displayName: "vallynn" },
    map,
  });
  d.identityFor = ({ platform, id }) =>
    map.has(`${platform}:${id}`)
      ? { handle: map.get(`${platform}:${id}`), known: true }
      : { handle: `${platform}-${id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6)}`, known: false };
  const msg = incoming({
    content: [{ type: "text", text: "alice: @vallynn hi" }],
    metadata: { mentions: [BOT_ID], rawContent: "@vallynn hi" },
    tags: ["chat:mention", "chat:from-human"],
  });
  const actions = routeIncoming({ ...d, msg });
  const input = actions.find((a) => a.kind === "input");
  assert.equal(
    input.text,
    `@${RESIDENT} hi`,
    "the display name is rewritten to the being's handle, not left as the platform's own rendering",
  );
  assert.deepEqual(input.targets, [RESIDENT]);
});

test("an unknown displayName leaves the text untouched — a case-insensitive, word-bounded match only", () => {
  const map = new Map([[`mock:${BOT_ID}`, RESIDENT]]);
  const d = deps({ server: { ...SERVER, being: RESIDENT, displayName: null }, map });
  d.identityFor = ({ platform, id }) =>
    map.has(`${platform}:${id}`)
      ? { handle: map.get(`${platform}:${id}`), known: true }
      : { handle: `${platform}-${id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6)}`, known: false };
  const msg = incoming({
    content: [{ type: "text", text: "alice: @vallynnite hi" }],
    metadata: {},
  });
  const actions = routeIncoming({
    ...deps({ server: { ...SERVER, being: RESIDENT, displayName: "vallynn" } }),
    msg,
  });
  const input = actions.find((a) => a.kind === "input");
  assert.equal(input.text, "@vallynnite hi", "a longer word containing the display name is left alone");
});

/* ---------------------------------------------------------------------- */
/* the group/channel auth-gate: public defaults false, only a linked      */
/* sender or the keeper wakes a being in a room that leaves it unset      */
/* ---------------------------------------------------------------------- */

// no `public` — the default, gated room; only `beings: [PRESENT]` present
// so the gate's own effect (never the resident's asleep path) is what
// each assertion below is isolating.
const GATED_SERVER = {
  name: "mock-1",
  platform: "mock",
  being: PRESENT,
  rooms: [{ stream: "mock:g2:c2", title: "gated", beings: [PRESENT] }],
};
const gatedMsg = (over = {}) =>
  incoming({
    channelId: "mock:g2:c2",
    content: [{ type: "text", text: "alice: @bot hi" }],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> hi` },
    tags: ["chat:mention", "chat:from-human"],
    ...over,
  });
const humanIdentityFor =
  (linked) =>
  ({ platform, id }) =>
    id === BOT_ID
      ? { handle: PRESENT, known: true } // the mentioned being's own id, never the sender
      : {
          handle: `${platform}-${id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6)}`,
          known: true,
          linked,
        };

test("gated room: an unlinked mention carries input.notice, never wakes the being, and no receipt either", () => {
  const d = deps({ server: GATED_SERVER, identityFor: humanIdentityFor(false) });
  const actions = routeIncoming({ ...d, msg: gatedMsg() });
  const input = actions.find((a) => a.kind === "input");
  assert.equal(input.notice, true, "an addressed unlinked sender gets the template");
  assert.deepEqual(input.targets, [], "never wakes a being");
  assert.equal(input.observe, true);
  assert.equal(input.reasons[PRESENT], "unlinked-room");
  assert.ok(!actions.some((a) => a.kind === "receipt"), "the notice replaces the receipt path here");
});

test("gated room: an unlinked ambient message is observed with no turn, and no notice", () => {
  const d = deps({ server: GATED_SERVER, identityFor: humanIdentityFor(false) });
  const actions = routeIncoming({ ...d, msg: gatedMsg({ tags: ["chat:ambient", "chat:from-human"], metadata: {}, content: [{ type: "text", text: "alice: just chatting" }] }) });
  const input = actions.find((a) => a.kind === "input");
  assert.equal(input.notice, undefined, "not addressed — no notice");
  assert.deepEqual(input.targets, []);
  assert.equal(input.observe, true);
});

test("gated room: a linked mention wakes the being; no notice", () => {
  const d = deps({ server: GATED_SERVER, identityFor: humanIdentityFor(true) });
  const input = routeIncoming({ ...d, msg: gatedMsg() }).find((a) => a.kind === "input");
  assert.deepEqual(input.targets, [PRESENT]);
  assert.equal(input.reasons[PRESENT], "mention");
});

test("gated room: the keeper's mention wakes the being even while unlinked", () => {
  const d = deps({
    server: GATED_SERVER,
    identityFor: ({ id }) =>
      id === BOT_ID
        ? { handle: PRESENT, known: true }
        : { handle: "zz-keeper", known: true, linked: false },
    isKeeper: (h) => h === "zz-keeper",
  });
  const input = routeIncoming({ ...d, msg: gatedMsg() }).find((a) => a.kind === "input");
  assert.deepEqual(input.targets, [PRESENT]);
});

test("gated room: random wake never rolls the dice for an unlinked sender, though the same covenant fires it once the room is public", () => {
  const covenants = () => ({
    posture: "present",
    dispatch: { mention: true, reply: true, dm: true, random_reply: 1, bot_mention_budget: 1 },
  });
  const ambient = incoming({ channelId: "mock:g2:c2" });
  const gated = deps({ server: GATED_SERVER, identityFor: humanIdentityFor(false), covenants });
  const gatedInput = routeIncoming({ ...gated, msg: ambient, rng: () => 0 }).find((a) => a.kind === "input");
  assert.deepEqual(gatedInput.targets, [], "gated: the dice are never rolled");

  const publicServer = { ...GATED_SERVER, rooms: [{ ...GATED_SERVER.rooms[0], public: true }] };
  const open = deps({ server: publicServer, identityFor: humanIdentityFor(false), covenants });
  const openInput = routeIncoming({ ...open, msg: ambient, rng: () => 0 }).find((a) => a.kind === "input");
  assert.deepEqual(openInput.targets, [PRESENT], "same covenant, public room: the roll fires");
});

test("public room: an unlinked mention wakes the being, exactly as before this field existed", () => {
  const publicServer = { ...GATED_SERVER, rooms: [{ ...GATED_SERVER.rooms[0], public: true }] };
  const d = deps({ server: publicServer, identityFor: humanIdentityFor(false) });
  const actions = routeIncoming({ ...d, msg: gatedMsg() });
  const input = actions.find((a) => a.kind === "input");
  assert.deepEqual(input.targets, [PRESENT]);
  assert.equal(input.notice, undefined);
});

test("gated room: a bot sender is never templated — decideActivation runs as usual, budget included", () => {
  const d = deps({ server: GATED_SERVER });
  d.map.set("mock:bot-res", RESIDENT); // a known being (another seat's bot) sending here
  const msg = gatedMsg({
    author: { id: "bot-res", name: "resident-bot" },
    metadata: { rawContent: `<@${BOT_ID}> ping`, isBot: true },
    tags: ["chat:mention", "chat:from-bot"],
  });
  const actions = routeIncoming({ ...d, msg });
  const input = actions.find((a) => a.kind === "input");
  assert.equal(input.notice, undefined, "a bot sender is never gated or templated");
  assert.equal(input.by_kind, "resident");
  assert.deepEqual(input.targets, [PRESENT], "budget 1, streak 0: the first bot mention is answered");
});
