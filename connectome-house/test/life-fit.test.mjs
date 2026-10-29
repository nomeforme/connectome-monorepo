// @ts-check
/* connectome-house/test/life-fit.test.mjs — a compiled life that no longer
 * fits its being: a budget mismatch is noticed; "over" is a hard limit only
 * where the covenant names its model's window; the turn-side fallback sets
 * aside the oldest verbatim lines before any recollection, keeps the
 * address and the newest line, never orphans a tool pair, and marks the
 * gap; capped hydration restores full text newest-first only within the
 * budget. Fixtures only. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedTrunkBudget, fitLife, lifeFit, roughTokens } from "../src/life-fit.mjs";
import { hydrateTail } from "../src/life-entries.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "life-fit-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const text = (t) => [{ type: "text", text: t }];
const head = { participant: "keeper", content: text("The address, read once:\n\nyou are a test being") };
const verbatim = (i, n = 400) => ({ participant: "zz-human", content: text(`line ${i} ` + "v".repeat(n)), ref: { run: "r", seq: i } });
const recollection = (i, n = 400) => ({ participant: "zz-being", content: text(`recollection ${i} ` + "r".repeat(n)) });

test("the budget a covenant compiles for, and a mismatch against it", () => {
  assert.equal(expectedTrunkBudget({ life_budget_tokens: 36000 }), 27000);
  assert.equal(expectedTrunkBudget({}), 90000, "the defaults: 120000 × 0.75");
  const cov = { life_budget_tokens: 36000, context_window: 65536 };
  assert.equal(lifeFit(cov, { budget: { maxTokens: 90000 }, messages: [] }).mismatch, true);
  assert.equal(lifeFit(cov, { budget: { maxTokens: 27000 }, messages: [] }).mismatch, false);
});

test("over is a hard limit only where the covenant names the model's window", () => {
  const big = { budget: { maxTokens: 27000 }, messages: Array.from({ length: 400 }, (_, i) => verbatim(i)) };
  const small = lifeFit({ life_budget_tokens: 36000, context_window: 65536 }, big);
  assert.equal(small.limit, 36000);
  assert.equal(small.over, true);
  const claude = lifeFit({ life_budget_tokens: 36000 }, big);
  assert.equal(claude.limit, null);
  assert.equal(claude.over, false);
});

test("fitLife sets aside the oldest verbatim lines first, keeps recollections, address and the newest line", () => {
  const msgs = [head, recollection(1), verbatim(2), verbatim(3), recollection(4), verbatim(5), verbatim(6), verbatim(7)];
  const limit = roughTokens(msgs) - 150; // room for everything but ~2 verbatim lines
  const { messages, dropped } = fitLife(msgs, limit);
  assert.ok(dropped >= 1);
  assert.ok(roughTokens(messages) <= limit, "fits");
  const texts = messages.map((m) => m.content[0].text);
  assert.ok(texts[0].startsWith("The address"), "address first");
  assert.match(texts[1], /older lines of your life are set aside/, "the gap is marked");
  assert.ok(texts.some((t) => t.startsWith("recollection 1")) && texts.some((t) => t.startsWith("recollection 4")), "recollections kept");
  assert.ok(!texts.some((t) => t.startsWith("line 2 ")), "the oldest verbatim line went first");
  assert.ok(texts.at(-1).startsWith("line 7 "), "the newest line stays");
});

test("fitLife reaches recollections only when verbatim lines can't make room, and never orphans a tool pair", () => {
  const use = { participant: "zz-being", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }], ref: { run: "r", seq: 2 } };
  const res = { participant: "zz-being", content: [{ type: "tool_result", toolUseId: "t1", content: "y".repeat(2000) }] };
  const msgs = [head, recollection(1, 2000), use, res, verbatim(4, 10)];
  const { messages } = fitLife(msgs, roughTokens([head, verbatim(4, 10)]) + 80);
  const blocks = messages.flatMap((m) => m.content);
  assert.ok(!blocks.some((b) => b.type === "tool_result"), "the result went with its use");
  assert.ok(!blocks.some((b) => b.type === "tool_use"));
  assert.ok(!blocks.some((b) => b.text?.startsWith("recollection 1")), "a recollection goes once nothing verbatim is left");
  assert.equal(fitLife(msgs, 1e9).dropped, 0, "nothing set aside when it fits");
});

test("capped hydration restores full text newest-first, only within the budget", () => {
  const runDir = join(ROOT, "hyd");
  mkdirSync(runDir, { recursive: true });
  const full = (i) => `full text ${i} ` + "f".repeat(4000);
  writeFileSync(join(runDir, "frames.jsonl"), [1, 2, 3].map((i) => JSON.stringify({ seq: i, type: "message", by: "zz-human", text: full(i) })).join("\n") + "\n");
  const excerpt = (i) => `excerpt ${i}`;
  const cm = { getAllMessages: () => [1, 2, 3].map((i) => ({ content: text(excerpt(i)), metadata: { ref: { run: "hyd", seq: i } } })) };
  const msgs = [1, 2, 3].map((i) => ({ participant: "zz-human", content: text(excerpt(i)) }));
  const uncapped = hydrateTail(/** @type {any} */ (cm), msgs, ROOT);
  assert.equal(uncapped.hydrated, 3, "no cap: every line restored, as before");
  const capped = hydrateTail(/** @type {any} */ (cm), msgs, ROOT, { maxTokens: 2200 }); // room for ~two full lines
  assert.equal(capped.hydrated, 2);
  assert.equal(capped.messages[0].content[0].text, excerpt(1), "the oldest keeps its excerpt");
  assert.equal(capped.messages[2].content[0].text, full(3), "the newest is whole");
  assert.ok(roughTokens(capped.messages) <= 2200);
});
