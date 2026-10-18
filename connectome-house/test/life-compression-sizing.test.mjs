// @ts-check
/* covenant `compression_window_tokens`: a smaller model's memory folds in
 * requests sized to its own window (resident-life.mjs compressionSizing). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compressionSizing } from "../src/resident-life.mjs";

test("unset or nonsense leaves the library's defaults alone", () => {
  for (const v of [undefined, null, 0, -5, "big", NaN]) assert.deepEqual(compressionSizing(v), {}, String(v));
});

test("a 64k window: admitted against 64k, a third for prior summaries, a small reply", () => {
  const s = compressionSizing(65536);
  assert.deepEqual(s, { compressionContextBudgetTokens: 65536, compressionRecallBudgetTokens: 22937, compressionMaxTokens: 6553 });
  // head + recall + one max-size message + reply still leave room for tools and the instruction
  assert.ok(4000 + s.compressionRecallBudgetTokens + 10_000 + s.compressionMaxTokens < 65536 * 0.75);
});

test("a large window never asks for more reply than the library's own 16k floor", () => {
  assert.equal(compressionSizing(1_000_000).compressionMaxTokens, 16_000);
});
