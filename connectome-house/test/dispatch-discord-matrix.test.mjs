// @ts-check
/* connectome-house/test/dispatch-discord-matrix.test.mjs — the O1–O10
 * admit/answer decisions 00-stack-as-is.md §4.2 documents for the live
 * Discord axon, checked against the HOUSE's own dispatch: a real
 * mock-mcpl-server.mjs child, a discord-shaped fixture (real
 * `discord:<guild>:<channel>` / `discord:dm:<channel>` ids, `<@id>`
 * mention tokens), driven through `createSeat` — the same production
 * `mcpl/host.mjs` handshake -> `mcpl/route.mjs` (routeIncoming) ->
 * `dispatch.mjs` (decideActivation) path a live seat runs — with
 * `roomInput` stubbed to capture each turn's `targets`/`observe` (who, if
 * anyone, actually activated).
 *
 * O6 (the random-reply roll) and O7 (the bot-to-bot budget) are checked
 * by calling `routeIncoming` DIRECTLY instead, with an injected `rng`/
 * `streakOf` — createSeat's own `routeDeps()` (mcpl/seat.mjs, a NO-TOUCH
 * file) never threads either through, so there is no way to drive them
 * deterministically end-to-end through a real seat today; this is the
 * same direct-call convention test/mcpl-route.test.mjs and
 * test/dispatch.test.mjs already use for the identical reason.
 *
 * Where the house's actual behaviour differs from what 00 §4.2 documents
 * for the live axon, the difference is asserted AS THE HOUSE'S REAL
 * BEHAVIOUR and named `TODO` in a comment — never silently made to look
 * like parity. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTestament } from "./lib/fixtures.mjs";
import { waitFor } from "./lib/serve-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");

const RUNS = mkdtempSync(join(tmpdir(), "house-dispatch-matrix-runs-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "house-dispatch-matrix-private-"));
const ADDRESS = mkdtempSync(join(tmpdir(), "house-dispatch-matrix-address-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
process.env.HOUSE_COVENANTS_DIR = ADDRESS;
process.env.HOUSE_RESIDENTS = "";
process.env.HOUSE_IDENTITY_SALT = "dispatch-matrix-salt-0123456789";

const A = "matrix-a"; // this seat's own being (christened to BOT_ID below)
const B = "matrix-b"; // a second being sharing the same room, present but not this seat's own
const BOT_ID = "bot-a-777";
const GROUP = "discord:g1:c1";
const DM = "discord:dm:d1";

writeTestament(ADDRESS, A, { speaksFor: "discord", frontmatter: ["posture: present", "dispatch:", "  random_reply: 0"] });
writeTestament(ADDRESS, B, { speaksFor: "discord", frontmatter: ["posture: present"] });

// O3's DM sender must pass mcpl/link.mjs's OWN pre-gate first (a NO-TOUCH
// file, ahead of routeIncoming): an unlinked, non-keeper DM sender is
// refused there before routeIncoming ever runs at all — see the O3 test
// itself, which asserts exactly that refusal as a real, undocumented
// divergence from 00 §4.2's "any DM activates, from anyone". To also
// prove decideActivation's own "dm" path fires once a sender DOES pass
// the gate, "bob" is pre-identified and named a keeper (the one predicate
// admitsUnlistedDM actually checks besides `linked`).
const { identityFor: realIdentityFor } = await import("../src/identity-map.mjs");
const BOB = realIdentityFor({ platform: "discord", id: "bob-id", display: "bob" }).handle;
process.env.HOUSE_KEEPERS = BOB;

const FIXTURE = join(PRIVATE, "discord.fixture.json");
const RECORD = join(PRIVATE, "discord.record.jsonl");

/** a channels/incoming message, discord-shaped (metadata carries every id
 * field, matching mcpl/normalize.mjs's normalizeIncoming). */
function msg(id, { channelId = GROUP, author = "alice", text, mentions = [], rawContent = null, replyTo = null, replyToAuthorId = null, isBot = false } = {}) {
  return {
    channelId,
    messageId: id,
    author: { id: author, name: author },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text }],
    metadata: { mentions, rawContent, replyTo, replyToAuthorId, isBot },
  };
}

writeFileSync(
  FIXTURE,
  JSON.stringify({
    channels: [
      { id: GROUP, type: "discord", label: "#general", direction: "bidirectional" },
      { id: DM, type: "discord", label: "dm", direction: "bidirectional" },
    ],
    history: {},
    script: [
      // O1 — an explicit @mention activates the mentioned being.
      { after_ms: 10, incoming: msg("o1-mention", { text: "alice: @matrix-a hi", mentions: [BOT_ID], rawContent: `<@${BOT_ID}> hi` }) },
      // O2 — a reply to the being's own prior message activates it, with no mention token at all.
      { after_ms: 20, incoming: msg("o2-reply", { text: "alice: following up", replyTo: "some-earlier-id", replyToAuthorId: BOT_ID }) },
      // O3 — a DM always activates, PER 00 §4.2. In the house, this is true
      // only once past mcpl/link.mjs's own unlinked-DM pre-gate (a NO-TOUCH
      // file) — see both O3 tests below: one proves the gate itself (a
      // stranger's DM never reaches roomInput at all — a real, undocumented
      // divergence from "any DM activates, from anyone"), the other proves
      // decideActivation's own "dm" path fires once a sender (here, a
      // keeper) is past it.
      { after_ms: 30, incoming: msg("o3-dm-stranger", { channelId: DM, author: "carol-id", text: "carol: hello there" }) },
      { after_ms: 40, incoming: msg("o3-dm-keeper", { channelId: DM, author: "bob-id", text: "bob: hello there" }) },
      // O4 — ambient, unaddressed, matrix-a explicitly configured to random_reply: 0 (harness-port W6-R3, K1 fix: a SILENT covenant on a real platform now rolls at the platform default, 1000 — see the dedicated K1 test below; this message stays deterministic by asking explicitly for 0).
      { after_ms: 50, incoming: msg("o4-ambient", { text: "alice: just chatting" }) },
      // O5 — Discord's own dot-prefix opt-out (00 §4.2: "any non-DM message starting with '.' is skipped entirely"). See the TODO below — this is NOT implemented in route.mjs today, so this message is NOT skipped; it is asserted as ambient (today's real behaviour), not as evidence of parity.
      { after_ms: 60, incoming: msg("o5-dotprefix", { text: ".ignore me, please" }) },
    ],
  }),
);

/** @type {any[]} */
const roomInputCalls = [];
const { createSeat } = await import("../src/mcpl/seat.mjs");
const seat = createSeat({
  server: {
    name: "matrix-pilot",
    platform: "discord",
    identity_gate: "dm", // O3 below exercises the DM gate itself (default is off)
    command: "node",
    args: [MOCK, FIXTURE, RECORD],
    env: [],
    being: A,
    being_id: BOT_ID,
    rooms: [
      { stream: GROUP, title: "general", beings: [A, B], public: true },
      { stream: DM, title: "a dm", beings: [A], public: true },
    ],
    mock: true,
  },
  log: () => {},
  openRoom: async () => ({ id: "room-matrix", state: "open" }),
  roomInput: async (args) => {
    roomInputCalls.push(args);
    return { ok: true };
  },
});
await seat.start();

after(async () => {
  seat.stop();
  rmSync(RUNS, { recursive: true, force: true });
  rmSync(PRIVATE, { recursive: true, force: true });
  rmSync(ADDRESS, { recursive: true, force: true });
});

function callFor(messageId) {
  // roomInput's own arg shape carries no messageId, only `external.message_id`.
  return roomInputCalls.find((c) => c.external?.message_id === messageId);
}

const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");

test("the real seat/host/route/dispatch pipeline delivers the four scripted messages that should land (O5's dotted one stays out)", async () => {
  await waitFor(() => (roomInputCalls.length >= 4 ? true : null), 15000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(roomInputCalls.length, 4);
});

test("O1 — an explicit @mention activates the mentioned being (00 §4.2, discord-message-receptor.ts:117-122)", () => {
  const c = callFor("o1-mention");
  assert.ok(c, "the mention message reached roomInput");
  assert.deepEqual(c.targets, [A]);
  assert.equal(c.observe, undefined, "someone activated — never observe-only");
});

test("O2 — a reply to the being's own message activates it, mention-free (00 §4.2, discord-message-receptor.ts:203-211)", () => {
  const c = callFor("o2-reply");
  assert.ok(c);
  assert.deepEqual(c.targets, [A]);
});

test("O3 gap — TODO: 00 §4.2 says 'any DM activates, from anyone'; the house's mcpl/link.mjs pre-gate (a NO-TOUCH file, ahead of routeIncoming) refuses an unlinked, non-keeper stranger's DM before routeIncoming ever runs — never entering the record at all. A real, undocumented divergence, distinct from O8-O10's argued ones in 02 §8.", () => {
  const c = callFor("o3-dm-stranger");
  assert.equal(c, undefined, "TODO: 00 §4.2 would predict this DM activates; the house's own link gate refuses it first instead");
});

test("O3 — once past the link gate (here, a keeper sender), a DM activates (dispatch.mjs's own 'dm' path, 00 §4.2)", () => {
  const c = callFor("o3-dm-keeper");
  assert.ok(c);
  assert.deepEqual(c.targets, [A]);
  assert.equal(c.home, "discord");
});

test("O4 — ambient, unaddressed, matrix-a EXPLICITLY configured to random_reply: 0 (K1 fix: explicit always wins): nobody activates, the message still enters the record (observe:true)", () => {
  const c = callFor("o4-ambient");
  assert.ok(c);
  assert.deepEqual(c.targets, []);
  assert.equal(c.observe, true);
});

test("O5 — Discord's dot-prefix opt-out (00 §4.2: 'any non-DM message starting with \".\" is skipped entirely'): the dotted message never reaches roomInput", () => {
  assert.equal(callFor("o5-dotprefix"), undefined);
});

// ---------------------------------------------------------------------
// O6, O7: driven directly through routeIncoming (mcpl/route.mjs) +
// decideActivation (dispatch.mjs) — see the file header for why createSeat
// itself cannot drive these two deterministically.
// ---------------------------------------------------------------------


const DIRECT_SERVER = {
  name: "matrix-direct",
  platform: "discord",
  being: A,
  rooms: [{ stream: GROUP, title: "general", beings: [A, B], public: true }],
};

/** the platform ids the O6-O10 fixtures use, mapped to real handles —
 * critically including BOT_ID -> A, since mention resolution (route.mjs's
 * own `handleOf`) depends on this to turn `<@bot-a-777>` into `@matrix-a`
 * the roster actually matches. */
const DIRECT_IDENTITY = { alice: "alice", [BOT_ID]: A, "bot-b-id": B };

function directDeps({ rng, streakOf, dispatch = {} } = {}) {
  return {
    server: DIRECT_SERVER,
    roomsOpen: () => null,
    identityFor: ({ id }) => ({ handle: DIRECT_IDENTITY[id] ?? id, known: true }),
    isBeing: (h) => h === A || h === B,
    covenants: () => ({
      posture: "present",
      dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1, ...dispatch },
    }),
    roomKeyOf: (s) => s,
    awakeOf: () => true,
    isKeeper: () => false,
    ...(rng ? { rng } : {}),
    ...(streakOf ? { streakOf } : {}),
  };
}

const ambientMsg = normalizeIncoming({
  channelId: GROUP,
  messageId: "o6-ambient",
  author: { id: "alice", name: "alice" },
  content: [{ type: "text", text: "alice: ambient chatter" }],
  metadata: {},
});

test("O6 — FIXED (harness-port R2-W, 2026-09-17): Discord's random-reply roll is now a one-winner lottery, one seeded draw for the whole room — a winning draw activates only the FIRST eligible being in roster order, never every present being off the same shared rng (dispatch.mjs's own random_reply_single_winner default, discord.mjs's DISPATCH_DEFAULTS, merged in by route.mjs)", () => {
  const hit = routeIncoming({ ...directDeps({ rng: () => 0, dispatch: { random_reply: 4 } }), msg: ambientMsg });
  const inputHit = hit.find((a) => a.kind === "input");
  assert.deepEqual(inputHit.targets, [A], "one seeded draw, one winner — the FIRST eligible being in roster order (A), never both");
  assert.equal(inputHit.reasons[B], "none", "B was eligible too but did not hold the lottery's own single draw");
  const miss = routeIncoming({ ...directDeps({ rng: () => 0.99, dispatch: { random_reply: 4 } }), msg: ambientMsg });
  const inputMiss = miss.find((a) => a.kind === "input");
  assert.deepEqual(inputMiss.targets, []);
  assert.equal(inputMiss.observe, true);
});

test("O6 — FIXED: a shared favourable roll never activates more than one being at once (the bug the old 'O6 gap' test named is closed)", () => {
  const hit = routeIncoming({ ...directDeps({ rng: () => 0, dispatch: { random_reply: 4 } }), msg: ambientMsg });
  const inputHit = hit.find((a) => a.kind === "input");
  assert.equal(inputHit.targets.length, 1, "ONE winner from one shared-rng roll — a true lottery, not an independent-roll pile-up");
});

const bumMsg = normalizeIncoming({
  channelId: GROUP,
  messageId: "o7-bot-mention",
  author: { id: "bot-b-id", name: "matrix-b" },
  content: [{ type: "text", text: `matrix-b: <@${BOT_ID}> hey` }],
  metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> hey`, isBot: true },
  tags: ["chat:from-bot"],
});

test("O7 — the bot-to-bot mention budget: under budget activates, at/over budget refuses (routeIncoming direct call, injected streakOf) — the sole anti-loop mechanism (00 §4.2), reset only by a human message", () => {
  const underBudget = routeIncoming({ ...directDeps({ streakOf: () => 0 }), msg: bumMsg });
  const under = underBudget.find((a) => a.kind === "input");
  assert.deepEqual(under.targets, [A], "streak 0 < budget 1 — activates");

  const atBudget = routeIncoming({ ...directDeps({ streakOf: () => 1 }), msg: bumMsg });
  const at = atBudget.find((a) => a.kind === "input");
  assert.deepEqual(at.targets, [], "streak 1 >= budget 1 — refused ('budget'), never a plain miss");
  assert.equal(at.observe, true);
});

test("O7 — a HUMAN's mention is never budget-gated, however high the streak reads (00 §4.2: reset only by a human message; this module never resets the counter itself, it only reads it — but it must never apply the gate to a human sender at all)", () => {
  const humanMention = normalizeIncoming({
    channelId: GROUP,
    messageId: "o7-human-mention",
    author: { id: "alice", name: "alice" },
    content: [{ type: "text", text: `alice: <@${BOT_ID}> hey` }],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> hey` },
  });
  const r = routeIncoming({ ...directDeps({ streakOf: () => 99 }), msg: humanMention });
  const input = r.find((a) => a.kind === "input");
  assert.deepEqual(input.targets, [A]);
});

// ---------------------------------------------------------------------
// O8, O9, O10: 02-user-contract.md §8's own "cannot be reproduced exactly"
// table names these three as DELIBERATE, ARGUED changes (not gaps) — the
// house answers every addressed being, in order, rather than racing.
// Asserted here as the house's real (and intentionally different)
// behaviour, each tagged with its own 02 §8 citation.
// ---------------------------------------------------------------------

test("O8 (02 §8, argued change) — a second address during a cycle is NOT dropped: every being this message addresses is targeted at once, not just the being answering an already-open cycle (the house has no notion of 'already busy' at routeIncoming's own layer at all — that serialization, if any, is the room loop's job downstream, not route.mjs's)", () => {
  const bothMentioned = normalizeIncoming({
    channelId: GROUP,
    messageId: "o8-both",
    author: { id: "alice", name: "alice" },
    content: [{ type: "text", text: "alice: @matrix-a @matrix-b look at this" }],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> @matrix-b look at this` },
  });
  const r = routeIncoming({ ...directDeps(), msg: bothMentioned });
  const input = r.find((a) => a.kind === "input");
  assert.deepEqual(new Set(input.targets), new Set([A, B]), "both addressed beings are targeted together — the fork instead drops a second address mid-cycle (00 §4.2, connectome-effector.ts:153-161); 02 §8 names this an argued change, not a bug to reproduce");
});

test("O9 (02 §8, argued change) — an attachment addressed to 2+ beings: EVERY addressed being answers, not only the alphabetically-first (the fork's own attachment-processing optimization has no equivalent here — routeIncoming shares one `share-blob` action across every target, not gated by roster order)", () => {
  const withImage = normalizeIncoming({
    channelId: GROUP,
    messageId: "o9-attachment",
    author: { id: "alice", name: "alice" },
    content: [
      { type: "text", text: "alice: @matrix-a @matrix-b check this out" },
      { type: "image", data: Buffer.from("fake-bytes").toString("base64"), mimeType: "image/png" },
    ],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> @matrix-b check this out` },
  });
  const r = routeIncoming({ ...directDeps(), msg: withImage });
  const input = r.find((a) => a.kind === "input");
  assert.deepEqual(new Set(input.targets), new Set([A, B]), "the fork answers only the alphabetically-first targeted being when an attachment is present (00 §4.2); the house does not special-case attachments at all here — 02 §8 argues this on purpose");
  assert.equal(r.filter((a) => a.kind === "share-blob").length, 1, "one share-blob action, not gated per-being");
});

test("O10 (02 §8, argued change) — several addressed beings are named together in ONE room's single `targets` list, not as independent concurrent processes (the fork runs one process per bot; 02 §8 argues a room's own serial turn queue answering in order is the house's deliberate replacement, which is the room loop's job downstream of this list, not routeIncoming's)", () => {
  const bothMentioned = normalizeIncoming({
    channelId: GROUP,
    messageId: "o10-both",
    author: { id: "alice", name: "alice" },
    content: [{ type: "text", text: "alice: @matrix-a @matrix-b go" }],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> @matrix-b go` },
  });
  const r = routeIncoming({ ...directDeps(), msg: bothMentioned });
  const input = r.find((a) => a.kind === "input");
  assert.equal(input.targets.length, 2, "one input action, two targets — ordering among them is the room loop's to serialize, not this list's own concern");
});


// ---------------------------------------------------------------------
// K1 (harness-port W6-R3): random_reply's real precedence — an explicit
// testament/room-override value beats a `!rr` runtime setting, which
// beats the platform's own silent-covenant default (discord.mjs's
// DISPATCH_DEFAULTS.random_reply = 1000, the fleet's own
// RANDOM_REPLY_CHANCE), which beats COVENANT_DEFAULTS' 0 fallback (only
// reached with no platform at all). Driven directly through routeIncoming
// with a bespoke SILENT covenants mock (no random_reply key at all —
// mcpl/seat.mjs's own real wiring, post-fix, produces exactly this shape
// for a being with no explicit setting and no `!rr`) rather than
// directDeps (whose own default of 0 is a deliberate, explicit test
// stand-in, not silence).
// ---------------------------------------------------------------------

function silentCovenantDeps({ rng }) {
  return {
    server: DIRECT_SERVER,
    roomsOpen: () => null,
    identityFor: ({ id }) => ({ handle: DIRECT_IDENTITY[id] ?? id, known: true }),
    isBeing: (h) => h === A || h === B,
    // no `random_reply` key at all — a being with no testament/room-
    // override setting and no `!rr` override, exactly as mcpl/seat.mjs's
    // fixed `covenants` wiring now produces (K1).
    covenants: () => ({ posture: "present", dispatch: { mention: true, reply: true, dm: true, bot_mention_budget: 1 } }),
    roomKeyOf: (s) => s,
    awakeOf: () => true,
    isKeeper: () => false,
    ...(rng ? { rng } : {}),
  };
}

test("K1 — an unconfigured being on Discord rolls at the platform default (1000): a winning seeded draw activates", () => {
  const hit = routeIncoming({ ...silentCovenantDeps({ rng: () => 0 }), msg: ambientMsg });
  const inputHit = hit.find((a) => a.kind === "input");
  assert.deepEqual(inputHit.targets, [A], "chance 1000, roll 0 -> a win (Discord's own one-winner lottery default applies too, so exactly one being)");
});

test("K1 — the effective chance is really 1000 (not some other positive fallback): rng=0.005 misses at 1000 (floor(5)=5) but would WIN at chance<=100 (floor(0.5)=0) — pins the magnitude, not just chance>0", () => {
  const miss = routeIncoming({ ...silentCovenantDeps({ rng: () => 0.005 }), msg: ambientMsg });
  const inputMiss = miss.find((a) => a.kind === "input");
  assert.deepEqual(inputMiss.targets, [], "a win here would mean the fallback chance is far smaller than the fleet's own 1000 (RANDOM_REPLY_CHANCE)");
});

test("a being is never woken by its own message, even one quoting a mention of it (echoed back through another account)", () => {
  const selfMsg = normalizeIncoming({
    channelId: GROUP,
    messageId: "self-quote",
    author: { id: BOT_ID, name: A },
    content: [{ type: "text", text: `${A}: you wrote "<@${BOT_ID}> can you see this" — no image came through` }],
    metadata: { mentions: [BOT_ID], rawContent: `you wrote "<@${BOT_ID}> can you see this"`, isBot: true },
    tags: ["chat:from-bot"],
  });
  const actions = routeIncoming({ ...directDeps({ streakOf: () => 0 }), msg: selfMsg });
  const input = actions.find((a) => a.kind === "input");
  assert.ok(!input.targets.includes(A), "its own words never activate it");
  assert.equal(input.reasons[A], undefined, "the author isn't even considered");
});
