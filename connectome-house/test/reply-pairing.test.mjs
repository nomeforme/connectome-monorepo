/* the reply pairing never quotes a stale message: the live sequence of
 * 2026-10-11/12 in the cosmic spa — two quick quote-replies folded into one
 * turn, a later reply, then a plain mention — each answer quotes only the
 * message that woke it, and the mention is answered plain. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReplyQueue } from "../src/mcpl/outbound.mjs";

test("folded replies, a later reply, then a mention: no answer quotes a stale line", () => {
  const q = createReplyQueue();
  const R = "room", B = "fable";
  // zilla: "semiosphere vs qualia", "ooooh" — both replies, one turn
  q.push(R, B, "zilla-1");
  q.push(R, B, "zilla-2");
  assert.equal(q.take(R, B), "zilla-2", "the turn quotes the newest of what woke it");
  assert.equal(q.take(R, B), null, "its second chunk quotes nothing");
  // hours later Wib and Wob reply
  q.push(R, B, "wib-1");
  assert.equal(q.take(R, B), "wib-1", "the answer quotes Wib and Wob, not zilla's old line");
  // next morning a pending reply is superseded by 0xG's plain mention
  q.push(R, B, "wib-2");
  q.drop(R, B);
  assert.equal(q.take(R, B), null, "a mention is answered plain");
});

test("clear empties a room's ids only", () => {
  const q = createReplyQueue();
  q.push("a", "x", "1");
  q.push("b", "x", "2");
  q.clear("a");
  assert.equal(q.size("a", "x"), 0);
  assert.equal(q.take("b", "x"), "2");
});
