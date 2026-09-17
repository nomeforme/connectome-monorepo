// @ts-check
/* harness-port P-C, 2026-09-17 — connectome-house/test/parity/split-and-
 * error.test.mjs — L0 golden tables (docs/harness-port/02-user-
 * contract.md §9) for two pure outbound.mjs functions this task ported
 * 1:1 from the fork: splitForDiscordFork (discord-axon/src/grpc/utils/
 * message-splitter.ts's splitMessage) and providerErrorNotice
 * (connectome-agent-core/src/connectome-effector.ts's
 * formatErrorForChat). Every expected value below is HAND-TRACED against
 * the fork's own source, cited at each case — not against this port's
 * own output (that would test nothing). Pure; nothing touches disk. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { providerErrorNotice, splitForDiscordFork } from "../../src/mcpl/outbound.mjs";

test("splitForDiscordFork: content at or under the limit is one chunk, untouched", () => {
  assert.deepEqual(splitForDiscordFork("", 10), []);
  assert.deepEqual(splitForDiscordFork("hello", 10), ["hello"]);
  assert.deepEqual(splitForDiscordFork("x".repeat(10), 10), ["x".repeat(10)]);
});

test("splitForDiscordFork: prefers the last newline at/before the limit (message-splitter.ts's own first preference)", () => {
  // "aaaaa\nbbbbb\nccccc" (17 chars), limit=12: lastIndexOf('\n', 12) is
  // index 11 (the SECOND \n) — the fork's own algorithm cuts there, not
  // at the first newline, because lastIndexOf searches backward from 12.
  const text = "aaaaa\nbbbbb\nccccc";
  const out = splitForDiscordFork(text, 12);
  assert.deepEqual(out, ["aaaaa\nbbbbb", "ccccc"]);
});

test("splitForDiscordFork: no newline near the limit falls back to the last space", () => {
  const text = "one two three four five six seven"; // 34 chars
  const out = splitForDiscordFork(text, 20);
  // lastIndexOf(' ', 20) inside "one two three four f" -> the space before "four"
  assert.equal(out[0], "one two three four");
  assert.ok(out[0].length <= 20);
  assert.equal(out.join(" "), text);
});

test("splitForDiscordFork: no newline or space near the limit hard-cuts at exactly the limit", () => {
  const text = "a".repeat(30);
  const out = splitForDiscordFork(text, 12);
  assert.equal(out[0].length, 12);
  assert.equal(out.join(""), text);
});

test("splitForDiscordFork: every chunk is <= limit, and rejoining (trim-aware) recovers all non-whitespace content — any input length", () => {
  const inputs = [
    "short",
    "line one\nline two\nline three\n\nparagraph two, quite a bit longer than the others here",
    "no-newlines-or-spaces-".repeat(40),
    "mixed short\nand a very ".padEnd(500, "long ") + "\nend",
  ];
  for (const text of inputs) {
    const out = splitForDiscordFork(text, 50);
    for (const c of out) assert.ok(c.length <= 50, `chunk exceeds limit: ${JSON.stringify(c)}`);
    const rejoined = out.join("");
    // every non-whitespace character survives, in order (the fork's own
    // .trim() between cuts only ever removes whitespace at a cut boundary)
    assert.equal(rejoined.replace(/\s+/g, ""), text.replace(/\s+/g, ""));
  }
});

// ---- providerErrorNotice: connectome-agent-core/src/connectome-
// effector.ts:31-56 `formatErrorForChat`, ported 1:1 ----

test("providerErrorNotice: a pre-formatted [Refused: ...] passes through unchanged (under 500 chars)", () => {
  const msg = "[Refused: violence] the model declined to continue";
  assert.equal(providerErrorNotice("resident", msg), msg);
});

test("providerErrorNotice: a pre-formatted [Model stop_reason=...] passes through unchanged", () => {
  const msg = "[Model stop_reason=max_tokens] (no additional detail from replay)";
  assert.equal(providerErrorNotice("resident", msg), msg);
});

test("providerErrorNotice: a [Refused:...]/[Model stop_reason=...] notice over 500 chars is truncated with a literal '...'", () => {
  const msg = `[Refused: x] ${"y".repeat(600)}`;
  const out = providerErrorNotice("resident", msg);
  assert.equal(out.length, 503); // 500 + "..."
  assert.ok(out.endsWith("..."));
  assert.equal(out.slice(0, 500), msg.slice(0, 500));
});

test("providerErrorNotice: a JSON API error body becomes [Anthropic API <type>] <message> — UNtruncated, matching the fork", () => {
  const body = { type: "error", error: { type: "overloaded_error", message: "x".repeat(600) } };
  const msg = `529 ${JSON.stringify(body)}`;
  const out = providerErrorNotice("resident", msg);
  assert.equal(out, `[Anthropic API overloaded_error] ${"x".repeat(600)}`);
});

test("providerErrorNotice: a JSON body with no error.message falls through to the generic [Error] shape", () => {
  const msg = '400 {"type":"not_an_error_shape"}';
  const out = providerErrorNotice("resident", msg);
  assert.equal(out, `[Error] ${msg}`);
});

test("providerErrorNotice: anything else falls back to [Error] <message>, truncated at 500 with a literal '...'", () => {
  assert.equal(providerErrorNotice("resident", "socket hang up"), "[Error] socket hang up");
  const long = "z".repeat(600);
  const out = providerErrorNotice("resident", long);
  assert.equal(out, `[Error] ${"z".repeat(500)}...`);
});

test("providerErrorNotice: an undefined message is handled honestly, never throws", () => {
  assert.equal(providerErrorNotice("resident", undefined), "[Error] ");
});
