// @ts-check
/* connectome-house/test/silent-turn-repro.test.mjs — docs/harness-port/
 * 31-silent-turn.md's own reproduction: a being activated (typing turned
 * on for its own seat) whose message nonetheless arrives as this room's
 * own `{duplicate: true}` (serve-rooms.mjs's `external.message_id` dedup —
 * some OTHER present seat's own independently-computed routing decision
 * won the race to record this exact message first) stalls SILENTLY —
 * room-tails.mjs's own `applyInputAction`, the `r.duplicate` branch, takes
 * `a.targets.includes(cfg.being)` as proof that a real turn was begun
 * elsewhere and returns without ever calling `turns.end`/`turns.
 * stopTyping` — no error, no log, no released turn, nothing, exactly the
 * shape the live incident this doc answers showed (typing on for
 * @plantoid, then nothing at all until an unrelated later message's own
 * duplicate happened to release it).
 *
 * `room-tails.mjs` is NOT owned by this task (Builder M owns mcpl/
 * {seat.mjs,turns.mjs,seat-bus.mjs}, room-turn.mjs, testaments.mjs, seat/
 * socket-seat.mjs) — this file proves the failure mode using the REAL,
 * unmodified `applyInputAction`/`roomInput` (imported straight from their
 * own modules, never stubbed) and then proves mcpl/seat.mjs's own
 * structural guard (added this task) recovers it deterministically: no
 * timing/race is needed to reproduce this — `roomInput` is injected
 * (mcpl/seat.mjs's own documented test seam) to return `{duplicate:true}`
 * unconditionally, precisely the shape the real dedup produces once some
 * OTHER seat's call has already won it.
 *
 * The affected being's testament copies the real live incident's own
 * non-Claude resident's covenant SHAPE (tools/skills/tts/endpoint/
 * use_api_key/mcp/max_context_frames/context_window/thinking/
 * prompt_caching — every field its real testament carries beyond a
 * Claude testament's own) — not its actual persona text, which is
 * keeper-facing and not this file's to copy. A second test below proves
 * that shape alone was never the throw the live incident's own first
 * hypothesis suspected: `covenantExcerpt`/`beginTurn` run clean against
 * it every time.
 *
 * harness-port 34 (docs/harness-port/34-typing-after-decision.md): the
 * mismatched-race root cause this file originally reproduced is fixed at
 * the cause now — typing only ever switches on off the ROOM's own
 * recorded decision (`roomInput`'s answer, `to` on a `{duplicate:true}`
 * one), never this seat's own speculative guess. The stubbed `roomInput`
 * below now carries `to: ["flora"]` (the shape the real one returns once
 * some OTHER seat's call has already recorded and named this being) so
 * this file continues to prove what it always proved second: the
 * structural guard (`turns.typing`/`open.get(roomId)?.turns`) still fires
 * as a BACKSTOP when a real room-side turn never actually arrives. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";
import { waitFor } from "./lib/serve-harness.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "silent-turn-repro-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "silent-turn-repro-test-salt-0123456789";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });

// the live incident's own non-Claude resident's covenant SHAPE, structure
// only (see this file's own header) — a fixture handle, never the real one.
const NON_CLAUDE_SHAPE = [
  "tools: [fetch, terminal, process, delegate]",
  "skills: [/workspace/skills/example-ontology, /workspace/skills/agent-spawning/collaboration]",
  "tts: {provider: some-tts, voice: clone:fixture, format: mp3}",
  "endpoint: http://FIXTURE_ENDPOINT_NOT_SET:1234/v1",
  "use_api_key: true",
  "mcp: [connectome]",
  "max_context_frames: 75",
  "context_window: 65536",
  "thinking: off",
  "prompt_caching: false",
];
writeTestament(process.env.HOUSE_COVENANTS_DIR, "flora", { speaksFor: "some-local-model.gguf", frontmatter: NON_CLAUDE_SHAPE });

const { openRoom } = await import("../src/serve-rooms.mjs");
const { open, attachSeat } = await import("../src/open-rooms.mjs");
const { beginTurn, covenantExcerpt } = await import("../src/room-turn.mjs");
const { createSeat } = await import("../src/mcpl/seat.mjs");

/** an already-NORMALIZED IncomingMessage (mcpl/normalize.mjs's own output
 * shape) — this test calls the captured `onIncoming` directly, bypassing
 * the real host's own wire/normalize step entirely (mcpl/seat.mjs's own
 * `hostOpts.createHost` test seam), so it must hand it what `normalize.mjs`
 * would have produced, not the raw platform envelope a real server sends. */
function msg(id, { channelId, author = "alice", text }) {
  return {
    envelope: "incoming",
    eventId: id,
    messageId: id,
    channelId,
    threadId: null,
    author: { id: author, name: author },
    timestamp: new Date().toISOString(),
    text,
    images: [],
    tags: [],
    metadata: {},
    mentions: [],
    replyTo: null,
    replyToAuthorId: null,
    rawContent: null,
    isDM: false,
    isBot: false,
  };
}

test("silent stall reproduced: activated (typing on), then the REAL applyInputAction's own r.duplicate branch — no error, no room-side turn; NOT reproducible as a covenant-shape throw", async () => {
  const stream = "discord:g1:silent-turn-repro";
  const { id: roomId, error } = await openRoom({
    platform: "discord",
    stream,
    title: "silent-turn-repro fixture",
    beings: ["flora"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);

  /** @type {string[]} */
  const logLines = [];
  /** @type {{stream: string, on: boolean}[]} */
  const typingCalls = [];
  /** @type {any} */
  let capturedOnIncoming = null;

  // mcpl/seat.mjs's own documented test seams: `hostOpts.createHost`
  // (never a real spawned/remote transport) and `roomInput` (never the
  // real serve-rooms.mjs one) — both used here exactly as the module's
  // own JSDoc describes them, not a workaround.
  const seat = createSeat({
    server: {
      name: "flora-repro-seat",
      platform: "discord",
      being: "flora",
      rooms: [{ stream, title: "silent-turn-repro fixture", beings: ["flora"], public: true }],
    },
    log: (line) => logLines.push(line),
    hostOpts: {
      createHost: (opts) => {
        capturedOnIncoming = opts.onIncoming;
        return {
          state: { open: new Set(), self: {} },
          async start() {},
          stop() {},
          restart() {},
          async openChannel() {},
          typing(s, on) {
            typingCalls.push({ stream: s, on });
          },
          lifecycle() {},
          snapshot() {
            return {};
          },
        };
      },
    },
    // the exact shape serve-rooms.mjs's own roomInput returns once some
    // OTHER seat's own routing decision has already recorded this
    // message's external.message_id first — reproduced directly, no race
    // or true randomness needed (dispatch.mjs's own random_reply roll is
    // real Math.random(), called once per PRESENT seat independently; this
    // file only needs its OUTCOME, not to re-roll it). `to` names the
    // RECORDED (winning) decision's own targets (harness-port 34) — flora,
    // here, so applyInputAction's own `turns.activate` still fires.
    roomInput: async () => ({ ok: true, duplicate: true, to: ["flora"] }),
  });

  await seat.start();
  assert.ok(capturedOnIncoming, "the fake host factory captured onIncoming");

  await capturedOnIncoming(msg("race-msg-1", { channelId: stream, text: "alice: @flora are you there?" }));

  // harness-port 34: typing now switches on from INSIDE applyInputAction,
  // once roomInput() (the stub above) has actually resolved — no longer
  // synchronous within onIncoming itself, so a short poll (never a fixed
  // sleep) replaces what used to be an immediate assertion.
  await waitFor(() => (logLines.some((l) => l.includes("typing on") && l.includes("@flora")) ? true : null));

  // the structural guard (docs/harness-port/31-silent-turn.md) is
  // deterministic, not timer-based — it fires the moment apply() settles,
  // so a short poll (never a fixed sleep) is all this needs.
  await waitFor(() => (logLines.some((l) => l.includes("turn stalled")) ? true : null));

  assert.ok(
    logLines.some((l) => l.includes("turn stalled") && l.includes("@flora") && l.includes(stream)),
    `expected one house line naming the being, room(stream) and the stall; got: ${JSON.stringify(logLines)}`,
  );
  assert.ok(
    typingCalls.length >= 2 && typingCalls[typingCalls.length - 1].on === false,
    `expected typing to have been turned off after the stall was detected; got: ${JSON.stringify(typingCalls)}`,
  );
  assert.equal(
    open.get(roomId)?.turns?.get("flora"),
    undefined,
    "no real room-side turn was ever created for flora — room-turn.mjs's own beginTurn was never reached at all, so there is nothing there to release; the guard's job here is entirely the seat's own local typing/turn bookkeeping",
  );

  // rules out the live incident's own FIRST hypothesis directly: this
  // exact covenant shape never throws through beginTurn's own risky
  // section (room-turn.mjs) — attach a real seat and run it for real.
  attachSeat(roomId, {
    being: "flora",
    send() {},
  });
  const excerpt = covenantExcerpt(roomId, "flora");
  assert.equal(excerpt.model, "some-local-model.gguf");
  assert.deepEqual(excerpt.tools, ["fetch", "terminal", "process", "save_attachment", "attach_file"], "delegate is still logged as not-offered, never thrown");
  assert.equal(excerpt.thinking, false);
  assert.equal(excerpt.promptCaching, false);
  const rec = open.get(roomId);
  assert.doesNotThrow(() => beginTurn(rec, "flora"), "the plantoid-shaped covenant never throws through beginTurn's own risky section");
  assert.ok(rec.turns.get("flora"), "a real turn genuinely began and is now in flight — the covenant shape was never the problem");
});
