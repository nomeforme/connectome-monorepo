// @ts-check
/* connectome-house/test/address-audit.test.mjs — docs/harness-port/
 * 36-address-audit.md's own round trip: walk-turn.mjs's `writeAddressAudit`
 * (called once per turn, right where `request.system` is finalized) writes
 * `<runsDir>/<room>/address.<handle>.md`, overwritten each turn with
 * EXACTLY the string sent as `system`; commands/registry.mjs's new
 * `!address` reads it back, keeper-only, log-only (never reaching the
 * model, never entering the room's own record) — the one way a keeper can
 * see what a being actually received, since nothing else records it.
 *
 * HOUSE_RUNS_DIR and HOUSE_PRIVATE_DIR are both sandboxed to fresh mkdtemp
 * dirs BEFORE the first import of anything under src/ — serve-paths.mjs's
 * RUNS/PRIVATE_ROOT are plain consts, frozen at first evaluation (same
 * discipline as address-reconcile.test.mjs / commands.test.mjs's own
 * headers explain). RUNS doubles as this test's OWN runsDir dependency for
 * `createTurnRunner`, so one fixture room dir serves both halves of the
 * round trip. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClass } from "./lib/fixtures.mjs";

const RUNS_DIR = mkdtempSync(join(tmpdir(), "address-audit-runs-"));
const PRIVATE_DIR = mkdtempSync(join(tmpdir(), "address-audit-private-"));
process.env.HOUSE_RUNS_DIR = RUNS_DIR;
process.env.HOUSE_PRIVATE_DIR = PRIVATE_DIR;

const { createTurnRunner } = await import("../src/walk-turn.mjs");
const { handleCommand } = await import("../src/commands/index.mjs");
const { roomSlug } = await import("../src/serve-room-open.mjs");

after(() => {
  rmSync(RUNS_DIR, { recursive: true, force: true });
  rmSync(PRIVATE_DIR, { recursive: true, force: true });
  delete process.env.HOUSE_RUNS_DIR;
  delete process.env.HOUSE_PRIVATE_DIR;
});

function fakeSeat() {
  const sent = [];
  return { sent, send: (msg) => (sent.push(msg), true) };
}

/** matches walk-turn-covenant.test.mjs's own fakeMembrane shape. */
function fakeMembrane(events) {
  return {
    streamYielding(_req) {
      let i = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () =>
              i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true },
          };
        },
        cancel() {},
        provideToolResults() {},
      };
    },
  };
}

function baseDeps({ membrane, being = "aria", systemFor = () => "a system prompt", withRunsDir = true }) {
  return {
    being,
    mock: false,
    membraneFor: () => membrane,
    maxOutputForModel: () => undefined,
    routeForModel: () => "anthropic",
    supportsThinking: () => true,
    usesAdaptiveThinking: () => false,
    thinking: undefined,
    thinkingEffort: "medium",
    maxTokensDefault: 16384,
    streamIdleMs: 45000,
    idleWatchdogMs: 90000,
    systemFor,
    toolDefFor: () => null,
    pending: { add() {}, settle() {}, size: () => 0 },
    runsDir: withRunsDir ? RUNS_DIR : undefined,
  };
}

const DONE_EVENTS = [{ type: "complete", response: { content: [{ type: "text", text: "hi" }], usage: {} } }];

/* ========================================================================
 * 1. writeAddressAudit (via runTurn): overwrites the exact system string
 * ======================================================================== */

test("runTurn: writes <runsDir>/<room>/address.<handle>.md with EXACTLY the string sent as `system`", async () => {
  const membrane = fakeMembrane(DONE_EVENTS);
  const { runTurn } = createTurnRunner(
    baseDeps({ membrane, systemFor: () => "You are seated here as aria.\n\nThis is the whole composed address." }),
  );
  await runTurn(fakeSeat(), { turnId: "t1", room: "room-fixture-1", context: { conversation: [] }, covenant: { model: "mock", tools: [], posture: "resident" } });

  const written = readFileSync(join(RUNS_DIR, "room-fixture-1", "address.aria.md"), "utf8");
  assert.equal(written, "You are seated here as aria.\n\nThis is the whole composed address.");
});

test("runTurn: a second turn OVERWRITES, never appends — the file always reads as the being's CURRENT turn only", async () => {
  const membrane = fakeMembrane(DONE_EVENTS);
  const { runTurn } = createTurnRunner(baseDeps({ membrane, systemFor: () => "first turn's address" }));
  const seat = fakeSeat();
  const begin = (room) => ({ turnId: "t", room, context: { conversation: [] }, covenant: { model: "mock", tools: [], posture: "resident" } });
  await runTurn(seat, begin("room-fixture-2"));
  const { runTurn: runTurn2 } = createTurnRunner(baseDeps({ membrane, systemFor: () => "second turn's address, wholly different" }));
  await runTurn2(seat, begin("room-fixture-2"));

  const written = readFileSync(join(RUNS_DIR, "room-fixture-2", "address.aria.md"), "utf8");
  assert.equal(written, "second turn's address, wholly different");
  assert.ok(!written.includes("first turn"), "no trace of the prior turn's address rides along");
});

test("runTurn: covenant.systemPromptOverride is what actually rides as `system` — the audit file reflects THAT, not systemFor()'s own return", async () => {
  const membrane = fakeMembrane(DONE_EVENTS);
  const { runTurn } = createTurnRunner(baseDeps({ membrane, systemFor: () => "systemFor()'s own text, never sent this turn" }));
  await runTurn(fakeSeat(), {
    turnId: "t1",
    room: "room-fixture-override",
    context: { conversation: [] },
    covenant: { model: "mock", tools: [], posture: "resident", systemPromptOverride: "the override, verbatim" },
  });
  const written = readFileSync(join(RUNS_DIR, "room-fixture-override", "address.aria.md"), "utf8");
  assert.equal(written, "the override, verbatim");
});

test("runTurn: runsDir absent (today's being-container default) never throws and writes nothing — an honest no-op, logged once", async () => {
  const membrane = fakeMembrane(DONE_EVENTS);
  const { runTurn } = createTurnRunner(baseDeps({ membrane, withRunsDir: false, systemFor: () => "would-be address" }));
  const seen = [];
  const originalError = console.error;
  console.error = (msg) => seen.push(String(msg));
  try {
    await runTurn(fakeSeat(), { turnId: "t1", room: "room-fixture-no-runsdir", context: { conversation: [] }, covenant: { model: "mock", tools: [], posture: "resident" } });
  } finally {
    console.error = originalError;
  }
  assert.ok(
    !existsSync(join(RUNS_DIR, "room-fixture-no-runsdir", "address.aria.md")),
    "no file written when runsDir is absent",
  );
  assert.ok(seen.some((l) => l.includes("[address-audit]") && l.includes("HOUSE_RUNS_DIR")), "the gap is logged, not silent");
});

/* ========================================================================
 * 2. !address (commands/registry.mjs, via commands/index.mjs's handleCommand)
 * ======================================================================== */

function keeperCtx(overrides = {}) {
  return { platform: "discord", roomKey: null, by: "keeper1", being: null, isKeeper: () => true, ...overrides };
}

test("!address: keeper-only — a non-keeper is refused, no file read at all", () => {
  const result = handleCommand("!address aria", {
    platform: "discord",
    roomKey: `discord:${roomSlug("chan-refused")}`,
    by: "rando",
    being: null,
    isKeeper: () => false,
  });
  assert.equal(result.reply, "!address is keeper-only.");
});

test("!address: no address file written yet — an honest gap, never a guess", () => {
  const runDir = join(RUNS_DIR, "room-fixture-empty");
  writeClass(runDir, { room: { platform: "discord", stream: "chan-empty" } });
  const result = handleCommand("!address aria", keeperCtx({ roomKey: `discord:${roomSlug("chan-empty")}` }));
  assert.match(result.reply, /no address file written yet/);
  assert.match(result.reply, /@aria/);
});

test("!address: reads back exactly what runTurn wrote — first 300 chars + the real length, for the named being", async () => {
  const runDir = join(RUNS_DIR, "room-fixture-roundtrip");
  writeClass(runDir, { room: { platform: "discord", stream: "chan-roundtrip" } });

  const longText = "the composed address, ".repeat(20); // > 300 chars
  const membrane = fakeMembrane(DONE_EVENTS);
  const { runTurn } = createTurnRunner(baseDeps({ membrane, being: "aria", systemFor: () => longText }));
  await runTurn(fakeSeat(), {
    turnId: "t1",
    room: "room-fixture-roundtrip",
    context: { conversation: [] },
    covenant: { model: "mock", tools: [], posture: "resident" },
  });

  const result = handleCommand("!address aria", keeperCtx({ roomKey: `discord:${roomSlug("chan-roundtrip")}` }));
  assert.match(result.reply, new RegExp(`${longText.length} chars written`));
  assert.ok(result.reply.includes(longText.slice(0, 300)), "the reply's own head matches the file's first 300 chars exactly");
  assert.equal(result.intent, null, "log-only — nothing for the room loop to apply, same as !unmute");
});

test("!address: @handle targeting form (ctx.being, no positional arg) resolves the same way as a positional handle", async () => {
  const runDir = join(RUNS_DIR, "room-fixture-targeted");
  writeClass(runDir, { room: { platform: "discord", stream: "chan-targeted" } });
  const membrane = fakeMembrane(DONE_EVENTS);
  const { runTurn } = createTurnRunner(baseDeps({ membrane, being: "vallynn", systemFor: () => "vallynn's own address" }));
  await runTurn(fakeSeat(), {
    turnId: "t1",
    room: "room-fixture-targeted",
    context: { conversation: [] },
    covenant: { model: "mock", tools: [], posture: "resident" },
  });
  const result = handleCommand("!address", keeperCtx({ roomKey: `discord:${roomSlug("chan-targeted")}`, being: "vallynn" }));
  assert.match(result.reply, /@vallynn/);
  assert.match(result.reply, /vallynn's own address/);
});

test("!address: a synthetic/walk-class room (no roomKey at all) names the gap honestly rather than guessing a run directory", () => {
  const result = handleCommand("!address aria", keeperCtx({ roomKey: null }));
  assert.match(result.reply, /carries no platform\/stream/);
});
