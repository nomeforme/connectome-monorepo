// @ts-check
/* connectome-house/test/signal-parity.test.mjs — builder P-B, platform-
 * reach parity round (2026-09-17). Three things this round actually
 * closed, each with its own table-driven proof, plus one golden-vector
 * check confirming a claim PARITY.md makes about work already in place
 * before this round:
 *
 * 1. Signal's outbound typing indicator must stay off, matching the
 *    fork exactly (signal-axon/src/axon-modules/signal-afferent.ts:
 *    523-527 — `sendTypingIndicator` was a literal no-op; the live gRPC
 *    speech path never sent one at all). `signal.typing` (src/mcpl/
 *    signal.mjs) returns a capability string that cannot ride the grant.
 * 2. `SIGNAL_COMMAND_REPLIES` (src/mcpl/signal.mjs) reproduces the fork's
 *    `SignalCommandEffector` reply strings byte-for-byte for six commands
 *    (signal-axon/src/grpc/components/signal-command-effector.ts, cited
 *    per case below). Not yet wired into the command lane (registry.mjs
 *    is P-A's — see PARITY.md and signal.mjs's own header comment for the
 *    named hook); this is the golden table the hook will read.
 * 3. The split algorithm (mcpl-signal/src/outbound.mjs's `splitMessage`,
 *    ported from signal-axon/src/grpc/utils/message-splitter.ts) cuts an
 *    identical input at an identical boundary to the fork's own function
 *    — reproduced here as a literal port of the fork's algorithm run
 *    against the same fixture text, so a future change to either copy
 *    that breaks the match fails loudly. */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOST_GRANT_ALLOWLIST } from "../src/mcpl/grant.mjs";
import { SIGNAL_COMMAND_REPLIES, typing as signalTyping } from "../src/mcpl/signal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { splitMessage } = await import(join(HERE, "..", "..", "mcpl-signal", "src", "outbound.mjs"));

test("signal typing: the wire shape's capability can never ride the host grant (fork parity: Signal never sent one)", () => {
  const started = signalTyping("signal:group:g1", true);
  const stopped = signalTyping("signal:dm:u1", false);
  for (const shape of [started, stopped]) {
    assert.equal(typeof shape.capability, "string");
    assert.ok(
      !HOST_GRANT_ALLOWLIST.includes(shape.capability),
      `typing capability "${shape.capability}" must never appear in HOST_GRANT_ALLOWLIST`,
    );
  }
  assert.deepEqual(started.params, { channelId: "signal:group:g1", op: "start" });
  assert.deepEqual(stopped.params, { channelId: "signal:dm:u1", op: "stop" });
});

// signal-command-effector.ts:251-281
test("SIGNAL_COMMAND_REPLIES.rr matches SignalCommandEffector.handleRandomReply byte-for-byte", () => {
  const rr = SIGNAL_COMMAND_REPLIES.rr;
  assert.equal(rr("", { randomReplyChance: 0 }), "Random reply is currently disabled (0)");
  assert.equal(rr("", { randomReplyChance: 200 }), "Random reply: 1/200 (0.5%)");
  assert.equal(
    rr("-3", {}),
    "Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)",
  );
  assert.equal(rr("0", {}), "Random reply disabled");
  assert.equal(rr("1", {}), "Random reply set to 1/1 (100%) - bots will reply to every message");
  assert.equal(rr("10", {}), "Random reply set to 1/10 (10.0%)");
});

// signal-command-effector.ts:283-309
test("SIGNAL_COMMAND_REPLIES.bb matches SignalCommandEffector.handleBotToBotLimit byte-for-byte", () => {
  const bb = SIGNAL_COMMAND_REPLIES.bb;
  assert.equal(bb("", { maxBotMentionsPerConversation: 0 }), "Bot-to-bot mentions are currently disabled (0)");
  assert.equal(bb("", { maxBotMentionsPerConversation: 1 }), "Bot-to-bot mention limit: 1");
  assert.equal(bb("-1", {}), "Invalid value. Use a number >= 0 (0 = disabled)");
  assert.equal(bb("0", {}), "Bot-to-bot mentions disabled");
  assert.equal(bb("3", {}), "Bot-to-bot mention limit set to 3");
});

// signal-command-effector.ts:635-662
test("SIGNAL_COMMAND_REPLIES.mt matches SignalCommandEffector.handleMaxTokens byte-for-byte", () => {
  const mt = SIGNAL_COMMAND_REPLIES.mt;
  assert.equal(
    mt("", { being: "aria", maxOutputTokens: undefined }),
    "Max output tokens for aria: using model default",
  );
  assert.equal(mt("", { being: "aria", maxOutputTokens: 512 }), "Max output tokens for aria: 512");
  assert.equal(mt("-5", { being: "aria" }), "Invalid value. Use a number >= 0 (0 = reset to model default)");
  assert.equal(mt("0", { being: "aria" }), "Max output tokens for aria reset to model default");
  assert.equal(mt("256", { being: "aria" }), "Max output tokens for aria set to 256");
});

// signal-command-effector.ts:675-709 — Signal's own command
test("SIGNAL_COMMAND_REPLIES.split matches SignalCommandEffector.handleSplit byte-for-byte", () => {
  const split = SIGNAL_COMMAND_REPLIES.split;
  assert.equal(
    split("", { current: 0, def: 400 }),
    'Message split: native (no aggressive splitting; Signal "see more" handles long messages). Default: 400 chars.',
  );
  assert.equal(
    split("", { current: 250, def: 400 }),
    "Message split threshold: 250 chars. Default: 400 chars.",
  );
  assert.equal(split("auto", { def: 400 }), "Message split threshold set to 400 chars.");
  assert.equal(
    split("native", {}),
    'Message split disabled — full message sent in one shot (capped at Signal\'s 4096 limit). Users will see "see more" for long content.',
  );
  assert.equal(
    split("off", {}),
    'Message split disabled — full message sent in one shot (capped at Signal\'s 4096 limit). Users will see "see more" for long content.',
  );
  assert.equal(split("120", {}), "Message split threshold set to 120 chars.");
  assert.equal(
    split("-1", {}),
    "Invalid value. Use: !split N (N>=0) | !split auto | !split native | !split off",
  );
});

// signal-command-effector.ts:711-731
test("SIGNAL_COMMAND_REPLIES.stop and .steer match the fork byte-for-byte", () => {
  assert.equal(SIGNAL_COMMAND_REPLIES.stop("", { being: "aria" }), "Stopping aria...");
  assert.equal(SIGNAL_COMMAND_REPLIES.steer("", { being: "aria" }), "Usage: !steer <message>");
  assert.equal(
    SIGNAL_COMMAND_REPLIES.steer("look east", { being: "aria" }),
    "Steering aria: look east",
  );
});

/** signal-axon/src/grpc/utils/message-splitter.ts's own algorithm, ported
 * here verbatim (not imported — the fork isn't a dependency of this repo)
 * so this test can assert mcpl-signal's `splitMessage` produces the SAME
 * chunks for the SAME input, per the mission's own instruction ("test
 * with the same input → same chunks"). */
function forkSplitMessage(content, maxLength = 400) {
  if (content.length <= maxLength) return [content];
  const chunks = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let breakPoint = maxLength;
    const paragraphBreak = remaining.lastIndexOf("\n\n", maxLength);
    if (paragraphBreak > maxLength * 0.5) {
      breakPoint = paragraphBreak + 2;
    } else {
      const sentenceBreaks = [". ", "! ", "? ", ".\n", "!\n", "?\n"];
      let bestSentenceBreak = -1;
      for (const sep of sentenceBreaks) {
        const idx = remaining.lastIndexOf(sep, maxLength);
        if (idx > bestSentenceBreak && idx > maxLength * 0.3) bestSentenceBreak = idx + sep.length;
      }
      if (bestSentenceBreak > 0) {
        breakPoint = bestSentenceBreak;
      } else {
        const spaceBreak = remaining.lastIndexOf(" ", maxLength);
        if (spaceBreak > maxLength * 0.3) breakPoint = spaceBreak + 1;
      }
    }
    chunks.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }
  return chunks.filter((c) => c.length > 0);
}

test("split boundaries: mcpl-signal's splitMessage matches the fork's message-splitter.ts on identical input", () => {
  const cases = [
    "short message, no split needed",
    "Paragraph one is here.\n\nParagraph two follows after a real blank line and runs on for a while so the cut has somewhere to land.\n\nParagraph three closes it out.",
    "First sentence ends here. Second sentence follows right after. " +
      "Third sentence keeps going a bit longer than the others to push the cut point past the paragraph threshold entirely.",
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix twentyseven twentyeight twentynine thirty",
    "a".repeat(950), // no break points at all — forces the hard maxLength cut
  ];
  for (const text of cases) {
    for (const maxLength of [50, 120, 400]) {
      assert.deepEqual(
        splitMessage(text, maxLength),
        forkSplitMessage(text, maxLength),
        `mismatch at maxLength=${maxLength} for: ${text.slice(0, 40)}…`,
      );
    }
  }
});
