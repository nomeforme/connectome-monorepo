// @ts-check
/* connectome-house/test/cache-budget.test.mjs — fitCacheBreakpoints's own
 * rule, ported from the reference harness's cache-budget.test.mjs (its
 * "the rule itself" section only — pure, no I/O). That file's own
 * integration tests drove the OLD walk-turn.mjs/walk-address.mjs/
 * resident-life.mjs/walk-resume.mjs machinery end to end; this port's
 * turn runner takes its request pre-rendered from the house instead (see
 * walk-turn.mjs's own header), so there is no equivalent request-assembly
 * path here to exercise the same way — this round's own walk-e2e.test.mjs
 * covers a real turn's wire shape instead. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitCacheBreakpoints } from "../src/cache-budget.mjs";

const flagged = (text) => ({ participant: "house", content: [{ type: "text", text }], cacheBreakpoint: true });
const plain = (text) => ({ participant: "house", content: [{ type: "text", text }] });

test("fitCacheBreakpoints: within budget, the same array back", () => {
  const msgs = [flagged("a"), plain("b"), flagged("c"), flagged("d"), flagged("e")];
  const fit = fitCacheBreakpoints(msgs);
  assert.equal(fit.messages, msgs);
  assert.deepEqual([fit.supplied, fit.kept], [4, 4]);
});

test("fitCacheBreakpoints: over budget, the first two and last two stay; inputs never mutated", () => {
  const msgs = ["a", "b", "c", "d", "e", "f", "g"].map(flagged);
  const fit = fitCacheBreakpoints(msgs);
  const kept = fit.messages.flatMap((m) => (m.cacheBreakpoint ? [m.content[0].text] : []));
  assert.deepEqual(kept, ["a", "b", "f", "g"]);
  assert.deepEqual([fit.supplied, fit.kept], [7, 4]);
  assert.ok(msgs.every((m) => m.cacheBreakpoint === true), "the original messages keep their flags");
  assert.equal(fit.messages[0], msgs[0], "a kept message is the same object");
  assert.deepEqual(fit.messages[2].content, msgs[2].content, "a dropped one loses only its flag");
});

test("fitCacheBreakpoints: a flag membrane can't place (empty text, thinking only) neither counts nor goes", () => {
  const dud = flagged("");
  const thinking = { participant: "x", content: [{ type: "thinking", thinking: "…" }], cacheBreakpoint: true };
  const msgs = [flagged("a"), dud, flagged("b"), thinking, flagged("c"), flagged("d")];
  const fit = fitCacheBreakpoints(msgs);
  assert.equal(fit.messages, msgs);
  assert.deepEqual([fit.supplied, fit.kept], [4, 4]);
});

test("fitCacheBreakpoints: a smaller ceiling keeps ⌊max/2⌋ from the front, the rest from the back", () => {
  const fit = fitCacheBreakpoints(["a", "b", "c", "d", "e"].map(flagged), 3);
  const kept = fit.messages.flatMap((m) => (m.cacheBreakpoint ? [m.content[0].text] : []));
  assert.deepEqual(kept, ["a", "d", "e"]);
});
