// @ts-check
/* connectome-house/test/speak-thinking-strip.test.mjs — harness-port W3-A,
 * 2026-09-18, mission task 3: a pre-agentic model (`claude-3-opus` probe)
 * emits literal `<thinking>…</thinking>` text rather than a real thinking
 * block. connectome-agent-core/src/utils.ts:64's own `cleanSpeechContent`
 * strips it before a platform send; mcpl/speak.mjs's `speak()` now does
 * the same on the house's outbound path — the RECORD (frames.jsonl,
 * appendTurnFrame) is untouched by this file's own change, so no test
 * here re-covers that; this file is only the platform-send half. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpeaker } from "../src/mcpl/speak.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "speak-thinking-strip-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });

/** a bare speaker: a stub host recording every callTool, matching
 * settings-consumers.test.mjs's own `stubSpeaker` helper. */
function stubSpeaker(roomId) {
  mkdirSync(join(process.env.HOUSE_RUNS_DIR, roomId), { recursive: true });
  const calls = [];
  const host = {
    state: { tools: [] },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {};
    },
  };
  const cfg = { platform: "discord", being: "aria", being_id: null, limit: 4000, observe_only: false };
  const speaker = createSpeaker({ cfg, host, stats: { sent: 0, undelivered: 0 }, say: () => {}, RUNS: process.env.HOUSE_RUNS_DIR });
  return { speaker, calls };
}

test("speak(): a thinking block is stripped from the platform send", async () => {
  const { speaker, calls } = stubSpeaker("thinking-strip-1");
  await speaker.speak("thinking-strip-1", "general", "<thinking>let me reason about this</thinking>Hello there!", { by: "aria" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.content, "Hello there!");
});

test("speak(): text with no thinking block is unaffected", async () => {
  const { speaker, calls } = stubSpeaker("thinking-strip-2");
  await speaker.speak("thinking-strip-2", "general", "just an ordinary reply", { by: "aria" });
  assert.equal(calls[0].args.content, "just an ordinary reply");
});

test("speak(): a thinking block spanning newlines is stripped in full", async () => {
  const { speaker, calls } = stubSpeaker("thinking-strip-3");
  const text = "<thinking>\nstep one\nstep two\n</thinking>The answer is 4.";
  await speaker.speak("thinking-strip-3", "general", text, { by: "aria" });
  assert.equal(calls[0].args.content, "The answer is 4.");
});
