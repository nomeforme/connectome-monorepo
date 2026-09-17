// @ts-check
/* harness/test/dispatch.test.mjs — who is speaking, and whether THIS being
 * answers (src/dispatch.mjs): every activation
 * reason, the bot-to-bot mention budget, an injected rng for the
 * random-reply roll, and a sleeping resident-postured being. Pure module
 * — no sandboxing needed, no filesystem touched. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideActivation, mentionsIn } from "../src/dispatch.mjs";

const DEFAULT_DISPATCH = {
  mention: true,
  reply: true,
  dm: true,
  random_reply: 0,
  bot_mention_budget: 1,
};

function covenant(overrides = {}, dispatchOverrides = {}) {
  return { posture: "present", ...overrides, dispatch: { ...DEFAULT_DISPATCH, ...dispatchOverrides } };
}

function message(overrides = {}) {
  return {
    by: "someone",
    text: "",
    mentions: [],
    reply_to: null,
    kind: "group",
    by_kind: "human",
    ...overrides,
  };
}

function room(overrides = {}) {
  return { beings: ["watson"], humans_present: 1, bot_mention_streak: 0, ...overrides };
}

test("mentionsIn: reuses mentions.mjs's grammar (word-boundary @tag match)", () => {
  assert.deepEqual(mentionsIn("hey @watson, look", ["watson", "other"]), ["watson"]);
  assert.deepEqual(mentionsIn("no mention here", ["watson"]), []);
  assert.deepEqual(mentionsIn("@watsonite isn't @watson", ["watson"]), ["watson"]);
});

test("decideActivation: explicit @mention activates with reason 'mention'", () => {
  const out = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covenant(),
    message: message({ text: "hey @watson", mentions: ["watson"] }),
    room: room(),
  });
  assert.deepEqual(out, { activate: true, reason: "mention", targets: ["watson"] });
});

test("decideActivation: a reply/quote to this being's message activates with reason 'reply'", () => {
  const out = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covenant(),
    message: message({ text: "following up", reply_to: "watson" }),
    room: room(),
  });
  assert.equal(out.activate, true);
  assert.equal(out.reason, "reply");
  assert.deepEqual(out.targets, ["watson"]);
});

test("decideActivation: a DM activates with reason 'dm'", () => {
  const out = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covenant(),
    message: message({ text: "hi", kind: "dm" }),
    room: room(),
  });
  assert.equal(out.activate, true);
  assert.equal(out.reason, "dm");
});

test("decideActivation: unaddressed, no random_reply configured -> reason 'none'", () => {
  const out = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covenant(),
    message: message({ text: "just chatting" }),
    room: room(),
  });
  assert.deepEqual(out, { activate: false, reason: "none", targets: [] });
});

test("decideActivation: unaddressed, random_reply rolled via injected rng -> reason 'random'", () => {
  const covWithRandom = covenant({}, { random_reply: 4 });
  // rng() * 4 floored to 0 triggers; a fixed rng lets the test be exact
  // rather than probabilistic.
  const hit = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covWithRandom,
    message: message({ text: "ambient chatter" }),
    room: room({ rng: () => 0 }),
  });
  assert.equal(hit.activate, true);
  assert.equal(hit.reason, "random");

  const miss = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covWithRandom,
    message: message({ text: "ambient chatter" }),
    room: room({ rng: () => 0.99 }),
  });
  assert.equal(miss.activate, false);
  assert.equal(miss.reason, "none");
});

test("decideActivation: a bot-to-bot mention is budgeted — activates while under budget, refused ('budget') once the streak is met", () => {
  const covBudget = covenant({}, { bot_mention_budget: 2 });
  const underBudget = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covBudget,
    message: message({ text: "@watson", mentions: ["watson"], by_kind: "resident" }),
    room: room({ bot_mention_streak: 1 }), // 1 < 2
  });
  assert.equal(underBudget.activate, true);
  assert.equal(underBudget.reason, "mention");

  const atBudget = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covBudget,
    message: message({ text: "@watson", mentions: ["watson"], by_kind: "resident" }),
    room: room({ bot_mention_streak: 2 }), // 2 >= 2
  });
  assert.equal(atBudget.activate, false);
  assert.equal(atBudget.reason, "budget");
});

test("decideActivation: the bot-to-bot budget never gates a HUMAN's mention, however high the streak reads", () => {
  const covBudget = covenant({}, { bot_mention_budget: 1 });
  const out = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covBudget,
    message: message({ text: "@watson", mentions: ["watson"], by_kind: "human" }),
    room: room({ bot_mention_streak: 99 }),
  });
  assert.equal(out.activate, true);
  assert.equal(out.reason, "mention");
});

test("decideActivation: a sleeping resident IS addressed (mention/reply/dm) — a platform visit, same as an in-app one: it activates regardless of `awake`", () => {
  const asleep = { handle: "watson", awake: false };
  const covResident = covenant({ posture: "resident" });
  const mentioned = decideActivation({
    being: asleep,
    covenant: covResident,
    message: message({ text: "@watson", mentions: ["watson"] }),
    room: room(),
  });
  assert.deepEqual(mentioned, { activate: true, reason: "mention", targets: ["watson"] });

  const replied = decideActivation({
    being: asleep,
    covenant: covResident,
    message: message({ text: "following up", reply_to: "watson" }),
    room: room(),
  });
  assert.equal(replied.activate, true);
  assert.equal(replied.reason, "reply");

  const dmed = decideActivation({
    being: asleep,
    covenant: covResident,
    message: message({ kind: "dm" }),
    room: room(),
  });
  assert.equal(dmed.activate, true);
  assert.equal(dmed.reason, "dm");
});

test("decideActivation: a sleeping resident that is NOT addressed stays 'asleep' — ambient traffic and a random-reply roll never wake it; the threshold carries an actual address instead", () => {
  const asleep = { handle: "watson", awake: false };
  const ambient = decideActivation({
    being: asleep,
    covenant: covenant({ posture: "resident" }),
    message: message({ text: "just chatting" }),
    room: room(),
  });
  assert.deepEqual(ambient, { activate: false, reason: "asleep", targets: [] });

  const covWithRandom = covenant({ posture: "resident" }, { random_reply: 4 });
  const wouldHaveRolled = decideActivation({
    being: asleep,
    covenant: covWithRandom,
    message: message({ text: "ambient chatter" }),
    room: room({ rng: () => 0 }), // would hit "random" if awake — see next test
  });
  assert.equal(wouldHaveRolled.activate, false);
  assert.equal(wouldHaveRolled.reason, "asleep", "sleep gates the random-reply roll too, not just plain ambient");
});

test("decideActivation: a bot-to-bot mention past budget still reads 'budget' while asleep, never 'asleep' — the budget check runs the same regardless of sleep state", () => {
  const asleep = { handle: "watson", awake: false };
  const covBudget = covenant({ posture: "resident" }, { bot_mention_budget: 1 });
  const out = decideActivation({
    being: asleep,
    covenant: covBudget,
    message: message({ text: "@watson", mentions: ["watson"], by_kind: "resident" }),
    room: room({ bot_mention_streak: 1 }),
  });
  assert.equal(out.activate, false);
  assert.equal(out.reason, "budget");
});

test("decideActivation: a resident-postured being that IS awake activates normally", () => {
  const out = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covenant({ posture: "resident" }),
    message: message({ text: "@watson", mentions: ["watson"] }),
    room: room(),
  });
  assert.equal(out.activate, true);
  assert.equal(out.reason, "mention");
});

test("decideActivation: a 'present' being ignores `awake` entirely — no clock, never 'asleep'", () => {
  const out = decideActivation({
    being: { handle: "watson", awake: false },
    covenant: covenant({ posture: "present" }),
    message: message({ text: "just chatting" }),
    room: room(),
  });
  assert.notEqual(out.reason, "asleep");
  assert.equal(out.reason, "none");
});

test("decideActivation: a dispatch flag turned off (mention: false) means a mention no longer activates on its own", () => {
  const out = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covenant({}, { mention: false }),
    message: message({ text: "@watson", mentions: ["watson"] }),
    room: room(),
  });
  assert.equal(out.activate, false);
  assert.equal(out.reason, "none");
});

test("decideActivation: targets names every roster member this message addresses, mention union reply_to, non-roster names dropped", () => {
  const out = decideActivation({
    being: { handle: "watson", awake: true },
    covenant: covenant(),
    message: message({ text: "@watson @other", mentions: ["watson", "other", "not-in-room"], reply_to: "yet-another" }),
    room: room({ beings: ["watson", "other"] }),
  });
  assert.deepEqual(new Set(out.targets), new Set(["watson", "other"]));
});

test("decideActivation: a structured mention (the platform rendered a display name in the text, the id resolved to the handle in `mentions`) activates — a sleeping resident included", () => {
  const asleep = { handle: "watson", awake: false };
  const d = decideActivation({
    being: asleep,
    covenant: covenant({ posture: "resident" }),
    // what Discord's cleanContent carries: the bot's display name, never `@watson`
    message: message({ text: "@Vallynn hi", mentions: ["watson"] }),
    room: room(),
  });
  assert.deepEqual(d, { activate: true, reason: "mention", targets: ["watson"] });
  const off = decideActivation({
    being: asleep,
    covenant: covenant({ posture: "resident" }, { mention: false }),
    message: message({ text: "@Vallynn hi", mentions: ["watson"] }),
    room: room(),
  });
  assert.equal(off.activate, false, "mention:false gates the structured form too");
  assert.equal(off.reason, "asleep");
});
