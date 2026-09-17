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
 * Two tests at the end are marked { todo } ON PURPOSE, per this round's
 * brief: dispatch.mjs and route.mjs are 100% platform-agnostic today (no
 * `server.platform` branch anywhere in either), so wherever
 * docs/harness-port/00-stack-as-is.md §4.2 documents Signal and Discord
 * as needing to differ, the house does not yet differ — this file names
 * that as a TODO, not a green, rather than either hiding it or failing
 * the whole suite over a gap this builder's brief says to report, not
 * fix (connectome-house/src/** is NO-TOUCH here; R2-A/R2-B own it). */
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
  "bot-to-bot budget SHOULD gate a same-platform bot's mention once its budget is spent (00-stack-as-is.md §4.2: one shared mechanism, not a designed Discord/Signal difference) — fails today because Signal cannot express chat:from-bot",
  {
    todo:
      "route.mjs:165 `const fromBot = msg.isBot || msg.tags.includes('chat:from-bot')` — " +
      "mcpl-signal's own facts() hardcodes isBot:false (mcpl-signal/src/envelopes.mjs, " +
      "confirmed in its README's own 'Missing outright' list: 'this server has no notion " +
      "of \"another bot\" at all'), so a Signal sender that resolves to a KNOWN BEING handle " +
      "is still by_kind:'human' in route.mjs, so dispatch.mjs's fromBeing gate " +
      "(`message.by_kind !== 'human'`) never engages and bot_mention_budget never blocks a " +
      "same-platform bot loop over Signal. PROPOSED house fix (src/mcpl/route.mjs, NOT " +
      "applied — out of this builder's owned files): change the fromBot line to " +
      "`const fromBot = msg.isBot || msg.tags.includes('chat:from-bot') || " +
      "(sender.known && isBeing(sender.handle));` — falls back to the house's own identity " +
      "map exactly as mcpl-signal's README itself says a host should ('a host decides " +
      "bot-ness by its own identity map').",
  },
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
  "random-reply DESIGNED asymmetry (00-stack-as-is.md §4.2): Discord's roll should be suppressed room-wide once ANY being was targeted, even a being other than the one rolling — dispatch.mjs/route.mjs have no cross-being check at all, so this fails on a Discord-shaped message today",
  {
    todo:
      "00-stack-as-is.md §4.2: 'Discord's random roll only fires when no bot was targeted at " +
      "all; Signal's fires for any group message the bot itself wasn't targeted by, including " +
      "ones mentioning other bots — a real behavioral asymmetry.' routeIncoming (src/mcpl/" +
      "route.mjs) calls decideActivation (src/dispatch.mjs) once per being with zero " +
      "cross-being coordination, so the CURRENT shape is uniformly Signal's (independent " +
      "per-being roll) for every platform including Discord — see the earlier green test in " +
      "this file for confirmation that Signal's own shape is correct today. PROPOSED house " +
      "fix (NOT applied — out of this builder's owned files): compute once per message, before " +
      "the per-being loop in route.mjs, `const anyTargeted = beings.some(b => mentions." +
      "includes(b) || reply_to === b)`, thread it into `room` as e.g. `room." +
      "any_being_targeted`, and give dispatch.mjs's random-roll branch a platform- or " +
      "covenant-conditioned check (a `dispatch.random_reply_suppressed_by_other_target` " +
      "covenant field, data not a code path, matching this project's own 'posture and " +
      "dispatch are covenant/config data' rule) that Discord's covenant sets true and " +
      "Signal's leaves false.",
  },
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
