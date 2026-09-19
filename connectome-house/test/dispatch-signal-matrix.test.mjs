// @ts-check
/* connectome-house/test/dispatch-signal-matrix.test.mjs — the same
 * admit/answer matrix a Discord dispatch test would run (mention by
 * handle, quote-reply to the bot, DM, an independent-per-being
 * random-reply roll with a seeded RNG, the bot-to-bot mention budget,
 * ambient traffic, and group privacy), but driven end to end through the
 * REAL mcpl-signal server (../../mcpl-signal/src/index.mjs) talking to
 * mcpl-signal's own mock signal-cli (../../mcpl-signal/test/lib/
 * mock-signal-cli.mjs, reused rather than re-implemented), spawned as the
 * house's real stdio child by the house's real createHost (src/mcpl/
 * host.mjs), routed by the house's real routeIncoming (src/mcpl/
 * route.mjs) and decideActivation (src/dispatch.mjs) — never a stub of
 * the Signal wire itself.
 *
 * The two tests at the end were marked { todo } through R2-A/R2-B's own
 * rounds (dispatch.mjs and route.mjs read no `server.platform` of their
 * own, so wherever 00-stack-as-is.md §4.2 documents Signal and Discord as
 * needing to differ, the house didn't yet). harness-port R2-W (2026-09-17)
 * closed both: route.mjs's `fromBot` now falls back to the house's own
 * identity map (mcpl-signal has no bot-ness concept of its own to report),
 * and a platform-flavoured covenant default (discord.mjs/signal.mjs's own
 * DISPATCH_DEFAULTS, merged in by route.mjs) drives both the random-reply
 * suppression-by-other-target rule and Discord's one-winner lottery —
 * dispatch.mjs itself still reads no platform name at all. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHost } from "../src/mcpl/host.mjs";
import { routeIncoming } from "../src/mcpl/route.mjs";
import { normalizeIncoming } from "../src/mcpl/normalize.mjs";
import {
  createMockSignalCli,
  dataMessage,
  GROUP,
  mention,
  NUMBERS,
  UUIDS,
} from "../../mcpl-signal/test/lib/mock-signal-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCPL_SIGNAL_INDEX = join(HERE, "..", "..", "mcpl-signal", "src", "index.mjs");

const PRESENT = "zz-present"; // a hangout-style being: posture "present", no clock, no asleep gate
const RESIDENT = "zz-resident"; // a resident: posture "resident", asleep by default
const BEINGS = [PRESENT, RESIDENT];
const GROUP_STREAM = `signal:group:${GROUP.internal_id}`;
const DM_STREAM = `signal:dm:${UUIDS.alice}`;

const waitFor = async (fn, ms = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** mutable per-test dials `onIncoming` reads fresh on every call — this is
 * the same shape of stub `test/mcpl-route.test.mjs` hand-rolls for
 * routeIncoming's injected dependencies, just made live-mutable so one
 * spawned mcpl-signal instance can serve every test case in this file
 * (spawning a real child per case would be correct but needlessly slow). */
let currentRandomReply = 0;
let currentBudget = 1;
let currentStreak = 0;
let currentRng = Math.random;
let residentAwake = false;
/** @type {{id: string, handle: string}|null} a one-test-only identity
 * override: lets a single test pretend a given Signal uuid resolves to a
 * KNOWN BEING's handle, without disturbing every other test's identity map */
let identityOverride = null;

const identityMap = new Map([
  [UUIDS.bot, PRESENT], // the account itself — server.being
  [UUIDS.alice, "alice"],
  [UUIDS.carol, "carol"],
]);

function identityFor({ id }) {
  if (identityOverride && identityOverride.id === id)
    return { handle: identityOverride.handle, known: true };
  if (identityMap.has(id)) return { handle: identityMap.get(id), known: true };
  return { handle: `signal-${String(id).slice(0, 6)}`, known: false };
}
const isBeing = (handle) => BEINGS.includes(handle);
const awakeOf = (handle) => (handle === RESIDENT ? residentAwake : true);
const covenantFor = (handle) => ({
  posture: handle === RESIDENT ? "resident" : "present",
  dispatch: {
    mention: true,
    reply: true,
    dm: true,
    random_reply: currentRandomReply,
    bot_mention_budget: currentBudget,
  },
});

const ROUTE_SERVER = {
  name: "signal-matrix-test",
  platform: "signal",
  being: PRESENT,
  rooms: [
    { stream: GROUP_STREAM, title: null, beings: BEINGS, public: true },
    { stream: DM_STREAM, title: null, beings: BEINGS, public: true },
  ],
};

let mock;
let host;
/** @type {{msg: import("../src/mcpl/normalize.mjs").IncomingMessage, actions: any[]}[]} */
let recorded = [];
let privacyFile;

before(async () => {
  mock = await createMockSignalCli({
    groups: [{ ...GROUP, members: [] }],
    identities: [{ number: NUMBERS.bot, uuid: UUIDS.bot }],
  });
  const dir = mkdtempSync(join(tmpdir(), "dispatch-signal-matrix-privacy-"));
  privacyFile = join(dir, "privacy.json");
  writeFileSync(privacyFile, JSON.stringify({ optOut: [] }));

  process.env.MCPL_SIGNAL_MATRIX_NUMBER = NUMBERS.bot;
  process.env.SIGNAL_CLI_URL = mock.url; // overridden here, read fresh by the spawned child —
  // never the box's real signal-cli, per this round's hard rule
  process.env.SIGNAL_GROUP_PRIVACY_FILE = privacyFile;

  host = createHost({
    server: {
      name: ROUTE_SERVER.name,
      platform: "signal",
      command: process.execPath,
      args: [MCPL_SIGNAL_INDEX, "--number-env", "MCPL_SIGNAL_MATRIX_NUMBER"],
      env: ["MCPL_SIGNAL_MATRIX_NUMBER", "SIGNAL_CLI_URL", "SIGNAL_GROUP_PRIVACY_FILE"],
      rooms: ROUTE_SERVER.rooms,
    },
    onIncoming: async (msg) => {
      const actions = routeIncoming({
        server: ROUTE_SERVER,
        msg,
        roomsOpen: () => null,
        identityFor,
        isBeing,
        covenants: (handle) => covenantFor(handle),
        roomKeyOf: (stream) => stream,
        awakeOf,
        streakOf: () => currentStreak,
        rng: currentRng,
      });
      recorded.push({ msg, actions });
      return { accepted: true };
    },
    log: () => {},
    requestTimeoutMs: 8000,
  });
  await host.start();
  await waitFor(() => mock.state.connections > 0);
  await waitFor(() => host.state.open.has(GROUP_STREAM), 8000);
});

after(async () => {
  host.stop();
  await mock.close();
});

function inputOf(rec) {
  return rec?.actions.find((a) => a.kind === "input");
}

test("mention by handle: a <@uuid> token targeting the account activates that being — 'mention'", async () => {
  const before = recorded.length;
  mock.emit(dataMessage({ text: "￼ lunch?", group: GROUP, mentions: [mention(UUIDS.bot, 0)] }));
  const rec = await waitFor(() => recorded.slice(before).find((r) => inputOf(r)));
  const input = inputOf(rec);
  assert.equal(input.reasons[PRESENT], "mention");
  assert.ok(input.targets.includes(PRESENT));
  assert.equal(input.reasons[RESIDENT], "asleep", "unaddressed and asleep — a mention of PRESENT is not a mention of RESIDENT");
});

test("quote-reply to the bot: a quote of the account's own earlier message activates it — 'reply'", async () => {
  const before = recorded.length;
  mock.emit(
    dataMessage({
      text: "yes that",
      group: GROUP,
      quote: { id: 1, author: NUMBERS.bot, authorUuid: UUIDS.bot, text: "earlier" },
    }),
  );
  const rec = await waitFor(() => recorded.slice(before).find((r) => inputOf(r)));
  const input = inputOf(rec);
  assert.equal(input.reasons[PRESENT], "reply");
  assert.ok(input.targets.includes(PRESENT));
});

test("a DM always activates, regardless of posture or awake state — 'dm'", async () => {
  residentAwake = false;
  const before = recorded.length;
  mock.emit(dataMessage({ text: "quick question" })); // no group => a DM from alice
  const rec = await waitFor(() => recorded.slice(before).find((r) => inputOf(r)));
  const input = inputOf(rec);
  assert.equal(input.messageKind, "dm");
  assert.equal(input.reasons[PRESENT], "dm");
  assert.equal(input.reasons[RESIDENT], "dm", "a DM reaches a sleeping resident like an in-app visit, not a receipt");
});

test("ambient group traffic: a sleeping resident owes nothing ('asleep'); a present being independently rolls the random-reply dice on a seeded rng", async () => {
  currentRandomReply = 2; // 1-in-2
  residentAwake = false;
  const calls = [0.9, 0.1];
  let i = 0;
  currentRng = () => calls[i++ % calls.length];

  const before1 = recorded.length;
  mock.emit(dataMessage({ text: "anyone around?", group: GROUP })); // floor(0.9*2)=1 — loses
  const rec1 = await waitFor(() => recorded.slice(before1).find((r) => inputOf(r)));
  const input1 = inputOf(rec1);
  assert.equal(input1.reasons[RESIDENT], "asleep");
  assert.equal(input1.reasons[PRESENT], "none", "0.9 does not win a 1-in-2 roll");
  assert.equal(input1.observe, true, "nobody activated — recorded, not dispatched");

  const before2 = recorded.length;
  mock.emit(dataMessage({ text: "anyone around still?", group: GROUP })); // floor(0.1*2)=0 — wins
  const rec2 = await waitFor(() => recorded.slice(before2).find((r) => inputOf(r)));
  const input2 = inputOf(rec2);
  assert.equal(input2.reasons[PRESENT], "random");
  assert.ok(input2.targets.includes(PRESENT));
  currentRng = Math.random;
  currentRandomReply = 0;
});

test("group privacy (opt-out): once the group is listed in the live privacy file, ambient traffic never reaches the house at all — no channels/incoming, no push/event", async () => {
  const beforeCount = recorded.length;
  writeFileSync(privacyFile, JSON.stringify({ optOut: [GROUP.internal_id] }));
  const later = new Date(Date.now() + 5000);
  // bump mtime so mcpl-signal's own live-reload (mtime-diffed) sees the edit
  const { utimesSync } = await import("node:fs");
  utimesSync(privacyFile, later, later);

  // give the real server's own file-watch a moment, then confirm an ambient
  // message never shows up as a recorded incoming/pushed event at all — a
  // fixed wait here, not waitFor-until-true, because the assertion IS the
  // absence of an event; waitFor has nothing true to wait for.
  await new Promise((r) => setTimeout(r, 300));
  mock.emit(dataMessage({ text: "ambient, now opted out", group: GROUP }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    recorded.length,
    beforeCount,
    "the privacy-dropped message never reached onIncoming at all — mcpl-signal's own admit() rule, exercised for real, not stubbed",
  );

  // a DM is never subject to group privacy — confirms the drop above was
  // group-specific, not a stalled connection
  const before2 = recorded.length;
  mock.emit(dataMessage({ text: "dm still works" }));
  const rec = await waitFor(() => recorded.slice(before2).find((r) => inputOf(r)));
  assert.equal(inputOf(rec).messageKind, "dm");

  // restore for any later test in this file
  writeFileSync(privacyFile, JSON.stringify({ optOut: [] }));
  const later2 = new Date(Date.now() + 10000);
  const { utimesSync: u2 } = await import("node:fs");
  u2(privacyFile, later2, later2);
  await new Promise((r) => setTimeout(r, 300));
});

test(
  "bot-to-bot budget FIXED (harness-port R2-W, 2026-09-17): route.mjs's fromBot now also falls back to the house's own identity map — a Signal sender that resolves to a KNOWN BEING handle counts as a bot even though mcpl-signal itself has no notion of one (its own facts() hardcodes isBot:false; README's 'Missing outright' list), so bot_mention_budget now blocks a same-platform bot loop over Signal exactly as it already did over Discord",
  async () => {
    currentBudget = 0; // any bot-authored mention should be blocked at once
    currentStreak = 0;
    identityOverride = { id: UUIDS.carol, handle: RESIDENT }; // carol's uuid "is" a known being
    const before = recorded.length;
    mock.emit(
      dataMessage({ text: "￼ ping", group: GROUP, from: "carol", mentions: [mention(UUIDS.bot, 0)] }),
    );
    const rec = await waitFor(() => recorded.slice(before).find((r) => inputOf(r)));
    const input = inputOf(rec);
    assert.equal(
      input.reasons[PRESENT],
      "budget",
      "a same-platform bot's mention should be budget-blocked with bot_mention_budget:0",
    );
    identityOverride = null;
    currentBudget = 1;
  },
);

test(
  "random-reply DESIGNED asymmetry FIXED (harness-port R2-W, 2026-09-17): Discord's roll is now suppressed room-wide once ANY being was targeted, even a being other than the one rolling — route.mjs computes `anyTargeted` once per message and threads it into `room.any_being_targeted`; dispatch.mjs's random branch honours a covenant-data field (`dispatch.random_reply_suppressed_by_other_target`, discord.mjs's own DISPATCH_DEFAULTS: true) that Discord's covenant carries and Signal's leaves false — see this file's own earlier green tests for confirmation that Signal's independent-roll shape is untouched",
  () => {
    const msg = normalizeIncoming({
      channelId: "discord:g1:c1",
      messageId: "d-1",
      author: { id: "human-1", name: "dana" },
      timestamp: "t",
      content: [{ type: "text", text: "<@resident-discord-id> hi" }],
      metadata: { mentions: ["resident-discord-id"], isDM: false },
      tags: ["chat:ambient", "chat:from-human"],
    });
    currentRandomReply = 1; // 1-in-1: certain to fire if the roll is attempted at all
    const actions = routeIncoming({
      server: {
        name: "discord-test",
        platform: "discord",
        being: PRESENT,
        rooms: [{ stream: "discord:g1:c1", beings: BEINGS, public: true }],
      },
      msg,
      roomsOpen: () => null,
      identityFor: (a) =>
        a.id === "resident-discord-id" ? { handle: RESIDENT, known: true } : { handle: "dana", known: true },
      isBeing,
      covenants: (handle) => covenantFor(handle),
      roomKeyOf: (stream) => stream,
      awakeOf: () => true,
      streakOf: () => 0,
      rng: () => 0, // certain to win any roll attempted
    });
    const input = actions.find((a) => a.kind === "input");
    assert.equal(input.reasons[RESIDENT], "mention", "the targeted being activates via mention, as expected on every platform");
    assert.notEqual(
      input.reasons[PRESENT],
      "random",
      "Discord should suppress PRESENT's random roll entirely because RESIDENT was targeted in the same message",
    );
    currentRandomReply = 0;
  },
);


// ---------------------------------------------------------------------
// K1 (harness-port W6-R3): the same random_reply precedence fix, proven
// on Signal — a SILENT covenant (no random_reply key at all, matching
// mcpl/seat.mjs's real post-fix wiring for a being with no testament
// setting and no `!rr`) rolls at Signal's own platform default (1000,
// mcpl/signal.mjs's DISPATCH_DEFAULTS), not COVENANT_DEFAULTS' 0.
// ---------------------------------------------------------------------

test("K1 — an unconfigured being on Signal rolls at the platform default (1000): a winning seeded draw activates", () => {
  const msg = normalizeIncoming({
    channelId: GROUP_STREAM,
    messageId: "k1-signal-ambient",
    author: { id: UUIDS.alice, name: "alice" },
    timestamp: "t",
    content: [{ type: "text", text: "alice: just chatting" }],
    metadata: {},
    tags: ["chat:ambient", "chat:from-human"],
  });
  const silentCovenant = () => ({
    posture: "present",
    dispatch: { mention: true, reply: true, dm: true, bot_mention_budget: 1 }, // no random_reply key at all
  });
  const actions = routeIncoming({
    server: ROUTE_SERVER,
    msg,
    roomsOpen: () => null,
    identityFor,
    isBeing,
    covenants: silentCovenant,
    roomKeyOf: (stream) => stream,
    awakeOf: () => true,
    streakOf: () => 0,
    rng: () => 0, // Math.floor(0 * 1000) === 0 -> a win, but ONLY if chance is actually a positive number
  });
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input.targets.includes(PRESENT), "a silent covenant on Signal must still roll, at the fleet's own 1000 default — this was the K1 bug (a defaulted 0 always won instead)");
});

test("K1 — the effective chance is really 1000 on Signal too: rng=0.005 misses (floor(5)=5) but would win at chance<=100 (floor(0.5)=0)", () => {
  const msg = normalizeIncoming({
    channelId: GROUP_STREAM,
    messageId: "k1-signal-ambient-2",
    author: { id: UUIDS.alice, name: "alice" },
    timestamp: "t",
    content: [{ type: "text", text: "alice: just chatting some more" }],
    metadata: {},
    tags: ["chat:ambient", "chat:from-human"],
  });
  const silentCovenant = () => ({
    posture: "present",
    dispatch: { mention: true, reply: true, dm: true, bot_mention_budget: 1 },
  });
  const actions = routeIncoming({
    server: ROUTE_SERVER,
    msg,
    roomsOpen: () => null,
    identityFor,
    isBeing,
    covenants: silentCovenant,
    roomKeyOf: (stream) => stream,
    awakeOf: () => true,
    streakOf: () => 0,
    rng: () => 0.005,
  });
  const input = actions.find((a) => a.kind === "input");
  assert.equal(input.targets.includes(PRESENT), false, "a win here would mean the fallback chance is far smaller than the fleet's own 1000");
});
