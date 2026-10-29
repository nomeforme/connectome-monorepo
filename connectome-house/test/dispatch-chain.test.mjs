// @ts-check
/* dispatch.mjs's room-wide fences: an AI-marked sender counts as non-human,
 * `room.chain` replaces the per-seat streak, the sender's `ai_limit`
 * tightens the budget, the per-being turn cap, and hush. Pure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideActivation, pickRandomReplyLotteryWinner } from "../src/dispatch.mjs";

const cov = (d = {}) => ({
  posture: "present",
  dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1, ...d },
});
const msg = (o = {}) => ({ by: "fey-x", text: "", mentions: [], reply_to: null, kind: "group", by_kind: "human", ...o });
const room = (o = {}) => ({ beings: ["pl-x", "qu-x"], humans_present: 1, ...o });
const decide = (m, r, c = cov(), handle = "pl-x") =>
  decideActivation({ being: { handle, awake: true }, covenant: c, message: msg(m), room: room(r) });

test("an AI-marked 'human' sender is budget-gated on reply; a real human never is", () => {
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai" }, { chain: 1 }).reason, "budget");
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai" }, { chain: 0 }).reason, "reply");
  assert.equal(decide({ reply_to: "pl-x" }, { chain: 9 }).reason, "reply");
  assert.equal(decide({ reply_to: "pl-x", by_kind: "walker" }, { chain: 1 }).reason, "budget");
});

test("the larger of room.chain and the seat's bot_mention_streak gates", () => {
  const m = { by_kind: "resident", mentions: ["pl-x"] };
  assert.equal(decide(m, { chain: 0, bot_mention_streak: 0 }).reason, "mention");
  assert.equal(decide(m, { chain: 0, bot_mention_streak: 5 }).reason, "budget");
  assert.equal(decide(m, { chain: 1, bot_mention_streak: 0 }).reason, "budget");
  assert.equal(decide(m, { bot_mention_streak: 1 }).reason, "budget", "falls back to the streak");
});

test("the sender's ai_limit tightens the budget below the covenant's", () => {
  const c = cov({ bot_mention_budget: 3 });
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai" }, { chain: 1 }, c).reason, "reply");
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai", sender_ai_limit: 1 }, { chain: 1 }, c).reason, "budget");
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai", sender_ai_limit: 0 }, { chain: 0 }, c).reason, "budget");
});

test("turn-cap: a being past its turns since a human stops answering non-human traffic; a human still wakes it", () => {
  const c = cov({ bot_mention_budget: 99 });
  const r = { chain: 0, turns_since_human: { "pl-x": 6 } };
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai" }, r, c).reason, "turn-cap");
  assert.equal(decide({ mentions: ["pl-x"], by_kind: "resident" }, r, c).reason, "turn-cap");
  assert.equal(decide({ reply_to: "pl-x" }, r, c).reason, "reply");
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai" }, { turns_since_human: { "pl-x": 5 } }, c).reason, "reply");
  const tight = cov({ bot_mention_budget: 99, max_turns_without_human: 2 });
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai" }, { turns_since_human: { "pl-x": 2 } }, tight).reason, "turn-cap");
  assert.equal(
    decide({ reply_to: "qu-x", sender_kind: "ai", text: "", mentions: [] }, { turns_since_human: { "pl-x": 9 } }, c, "qu-x").reason,
    "reply",
    "the cap is per being",
  );
});

test("hush: blocks non-human wakes and the random roll; a human mention/reply/DM still wakes", () => {
  const r = { hushed: ["pl-x"], rng: () => 0 };
  assert.equal(decide({ reply_to: "pl-x", sender_kind: "ai" }, r).reason, "hushed");
  assert.equal(decide({ mentions: ["pl-x"], by_kind: "resident" }, r).reason, "hushed");
  assert.equal(decide({ mentions: ["pl-x"] }, r).reason, "mention");
  assert.equal(decide({ reply_to: "pl-x" }, r).reason, "reply");
  assert.equal(decide({ kind: "dm" }, r).reason, "dm");
  assert.equal(decide({ kind: "dm", sender_kind: "ai" }, r).reason, "hushed");
  assert.equal(decide({ text: "ambient" }, r, cov({ random_reply: 1 })).reason, "hushed");
  assert.equal(decide({ text: "ambient" }, { rng: () => 0 }, cov({ random_reply: 1 })).reason, "random");
  assert.equal(decide({ reply_to: "qu-x", sender_kind: "ai" }, r, cov(), "qu-x").reason, "reply", "only the hushed being");
});

test("the lottery never picks a hushed being", () => {
  const winner = pickRandomReplyLotteryWinner({
    beings: [{ handle: "pl-x" }, { handle: "qu-x" }],
    covenantsFor: () => cov({ random_reply: 1 }),
    message: msg(),
    room: room({ hushed: ["pl-x"], rng: () => 0 }),
  });
  assert.equal(winner, "qu-x");
});
