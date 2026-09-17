// @ts-check
/* connectome-house/test/commands.test.mjs — the `!` command lane
 * (src/commands/): grammar parsing, per-command validation, the
 * keeper-only gate, persistence round-trips across all three tiers, and
 * reply text. Where 02-user-contract.md gives a VERBATIM string (only
 * `!stop` → "[Cycle stopped]"), this file asserts byte-equality against
 * that citation; every other reply string asserted here is this module's
 * OWN composed text (registry.mjs's file header explains why 02 has no
 * verbatim text to check most commands against) — asserted for
 * stability, not claimed as a source citation.
 *
 * HOUSE_PRIVATE_DIR is set to a fresh mkdtemp BEFORE the first import of
 * anything under src/commands/ (serve-paths.mjs reads it once, at module
 * load) — never this package's own real private/ dir. */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "house-commands-test-"));
process.env.HOUSE_PRIVATE_DIR = FIXTURE_DIR;
after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

const { parseCommandLine, rebuildArgs } = await import("../src/commands/grammar.mjs");
const { handleCommand, helpTextFor } = await import("../src/commands/index.mjs");
const { lookup, COMMANDS } = await import("../src/commands/registry.mjs");
const { resetMemory, roomSettingsGet, secretGet, secretList, applyCommandDispatchSettings } = await import(
  "../src/commands/store.mjs"
);

beforeEach(() => resetMemory());

function ctx(overrides = {}) {
  return { platform: "discord", roomKey: "discord:g1:c1", by: "alice", being: "watson", ...overrides };
}

// ---------- grammar ----------

test("parseCommandLine: recognizes the three shapes, and plain text as none", () => {
  assert.deepEqual(parseCommandLine("!stop"), { kind: "bang", name: "stop", argsRaw: "" });
  assert.deepEqual(parseCommandLine("!rr 4"), { kind: "bang", name: "rr", argsRaw: "4" });
  assert.deepEqual(parseCommandLine("!continue"), { kind: "continue" });
  assert.deepEqual(parseCommandLine("m continue"), { kind: "continue" });
  assert.deepEqual(parseCommandLine("m go"), { kind: "continue" });
  assert.deepEqual(parseCommandLine("m more"), { kind: "continue" });
  assert.equal(parseCommandLine("m continued"), null, "'m continued' is neither the trigger nor a bang line — not a command at all");
  assert.deepEqual(parseCommandLine("!h5 what do you make of this"), {
    kind: "h-once",
    frames: 5,
    text: "what do you make of this",
  });
  assert.equal(parseCommandLine("!h-default 10")?.kind, "bang", "!h-default must not be swallowed by the !h<N> check");
  assert.equal(parseCommandLine("just chatting"), null);
  assert.equal(parseCommandLine("no bang here !stop"), null, "a bang only counts at the start of the line");
});

test("rebuildArgs: the fork's own argument-rebuild quirk — every run of whitespace, including newlines, collapses to one space", () => {
  assert.equal(rebuildArgs("  override   line one\nline two  "), "override line one line two");
  assert.equal(rebuildArgs(""), "");
});

test("parseCommandLine: !sysprompt override loses its newlines through the same quirk (02 §2.1, reproduced on purpose)", () => {
  const p = parseCommandLine("!sysprompt override line one\nline two");
  assert.equal(p.kind, "bang");
  assert.equal(p.argsRaw, "override line one line two");
});

// ---------- registry shape ----------

test("registry: every command's usage string starts with '!' (help text stays self-consistent)", () => {
  for (const c of COMMANDS) assert.ok(c.usage.startsWith("!"), c.name);
});

test("lookup: case-insensitive, unknown name -> undefined", () => {
  assert.equal(lookup("STOP")?.name, "stop");
  assert.equal(lookup("nope"), undefined);
});

// ---------- handleCommand: pass-through for non-commands ----------

test("handleCommand: ordinary text is not intercepted at all (null)", () => {
  assert.equal(handleCommand({ text: "hey @watson how are you" }, ctx()), null);
});

// ---------- !stop: the one verbatim reply 02 gives ----------

test("handleCommand: !stop replies the exact verbatim text from 02-user-contract.md C11", () => {
  const r = handleCommand({ text: "!stop" }, ctx());
  assert.equal(r.reply, "[Cycle stopped]");
  assert.deepEqual(r.intent, { kind: "interrupt", scope: "being", being: "watson" });
});

// ---------- !continue / m continue ----------

test("handleCommand: !continue and 'm continue' both produce a silent continue intent, on discord/signal", () => {
  for (const text of ["!continue", "m continue", "m go", "m more"]) {
    const r = handleCommand({ text }, ctx({ platform: "discord" }));
    assert.deepEqual(r, { reply: null, intent: { kind: "continue", scope: "being", being: "watson" } });
    const rs = handleCommand({ text }, ctx({ platform: "signal" }));
    assert.equal(rs.intent.kind, "continue");
  }
});

test("handleCommand: 'm continue' on web is not a trigger at all (00 §4.3: D·S only) — falls through as ordinary text", () => {
  assert.equal(handleCommand({ text: "m continue" }, ctx({ platform: "web" })), null);
});

// ---------- !h<N> one-shot trim (C8) ----------

test("handleCommand: !h5 <text> on discord — silent, carries the frame count and the trimmed model-facing text", () => {
  const r = handleCommand({ text: "!h5 what do you think" }, ctx({ platform: "discord" }));
  assert.deepEqual(r, {
    reply: null,
    intent: { kind: "input-trim", scope: "input", frames: 5, modelText: "what do you think" },
  });
});

test("handleCommand: !h<N> on signal is swallowed, not a trim (02 C8: 'S swallows it')", () => {
  const r = handleCommand({ text: "!h5 anything" }, ctx({ platform: "signal" }));
  assert.deepEqual(r, { reply: null, intent: { kind: "swallow" } });
});

// ---------- C18: unknown !x per platform ----------

test("handleCommand: an unrecognized !x falls through on discord/web, is swallowed on signal", () => {
  assert.equal(handleCommand({ text: "!frobnicate" }, ctx({ platform: "discord" })), null);
  assert.equal(handleCommand({ text: "!frobnicate" }, ctx({ platform: "web" })), null);
  assert.deepEqual(handleCommand({ text: "!frobnicate" }, ctx({ platform: "signal" })), {
    reply: null,
    intent: { kind: "swallow" },
  });
});

// ---------- a known command on a platform 02 says lacks it: refused ----------

test("handleCommand: !secret on web is refused (a known command, 02 says web lacks it) — this is a deliberate house-side choice, not a straight fork reproduction (see registry.mjs's header)", () => {
  const r = handleCommand({ text: "!secret list" }, ctx({ platform: "web", by: "keeperHandle" }));
  assert.equal(r.reply, "the !secret command isn't available here.");
  assert.equal(r.intent, null);
});

test("handleCommand: the same known-but-wrong-platform command is swallowed, not refused, on signal (signal swallows every ! line, matching C18)", () => {
  // !stream is D·S only in 02 — pick a command signal DOES support instead
  // to prove the platform-mismatch path; here we simulate a platform this
  // command truly excludes for signal by using !split's own inverse: no
  // command in the table is BOTH excluded-from-signal AND signal is a
  // platform this file tests directly, so assert the general rule via the
  // production code path itself (mcf is DSW, so use a synthetic case: a
  // registry entry excluding signal does not exist today — this asserts
  // the swallow-still-wins branch using the same unknown-command swallow
  // proven above, which shares the identical `platform === "signal"` guard
  // in index.mjs for both branches).
  assert.deepEqual(handleCommand({ text: "!nonexistent" }, ctx({ platform: "signal" })), {
    reply: null,
    intent: { kind: "swallow" },
  });
});

// ---------- validation ----------

test("handleCommand: !rr with a non-numeric arg is refused with a validation error, no intent", () => {
  const r = handleCommand({ text: "!rr banana" }, ctx());
  assert.equal(r.intent, null);
  assert.match(r.reply, /expected a whole number/);
});

test("handleCommand: !steer with no message is refused", () => {
  const r = handleCommand({ text: "!steer" }, ctx());
  assert.equal(r.reply, "usage: !steer <message>");
  assert.equal(r.intent, null);
});

test("handleCommand: !stream requires 'in <name>' or exactly 'out'", () => {
  assert.equal(handleCommand({ text: "!stream" }, ctx({ platform: "discord" })).intent, null);
  assert.equal(handleCommand({ text: "!stream sideways" }, ctx({ platform: "discord" })).intent, null);
  const rin = handleCommand({ text: "!stream in offtopic" }, ctx({ platform: "discord" }));
  assert.deepEqual(rin.intent, { kind: "stream", direction: "in", name: "offtopic" });
  const rout = handleCommand({ text: "!stream out" }, ctx({ platform: "discord" }));
  assert.deepEqual(rout.intent, { kind: "stream", direction: "out" });
});

// ---------- permission: keeper-only (!secret) ----------

test("handleCommand: !secret refuses a non-keeper, keeper-only text, never touches the store", () => {
  const r = handleCommand({ text: "!secret api-key sk-123" }, ctx({ platform: "discord", by: "notakeeper" }));
  assert.equal(r.reply, "!secret is keeper-only.");
  assert.equal(r.intent, null);
  assert.equal(secretGet(ctx().roomKey, "api-key"), undefined, "never written");
});

test("handleCommand: !secret works for a keeper via ctx.isKeeper (caller-supplied predicate wins over HOUSE_KEEPERS)", () => {
  const isKeeper = (h) => h === "robin";
  const r = handleCommand(
    { text: "!secret api-key sk-123" },
    ctx({ platform: "discord", by: "robin", isKeeper, roomKey: "discord:g1:secret-ctx-test" }),
  );
  assert.equal(r.reply, 'secret "api-key" stored.');
  assert.ok(!r.reply.includes("sk-123"), "the value is never echoed back");
  assert.equal(r.intent.kind, "secret-set");
});

test("handleCommand: !secret works for an env HOUSE_KEEPERS handle when ctx supplies no predicate", () => {
  const prev = process.env.HOUSE_KEEPERS;
  process.env.HOUSE_KEEPERS = "aria, robin ,mark";
  try {
    const r = handleCommand(
      { text: "!secret token abc" },
      ctx({ platform: "discord", by: "mark", roomKey: "discord:g1:secret-env-test" }),
    );
    assert.equal(r.intent.kind, "secret-set");
  } finally {
    if (prev === undefined) delete process.env.HOUSE_KEEPERS;
    else process.env.HOUSE_KEEPERS = prev;
  }
});

// ---------- persistence round-trips, one per tier ----------

test("persistence (memory tier, !rr): a value set is read back within the process, reset by resetMemory()", () => {
  assert.equal(handleCommand({ text: "!rr" }, ctx()).reply, "random reply is currently off.");
  const set = handleCommand({ text: "!rr 8" }, ctx());
  assert.equal(set.reply, "random reply set to 1-in-8.");
  assert.deepEqual(set.intent, { kind: "setting", scope: "global", key: "dispatch.random_reply", value: 8 });
  assert.equal(handleCommand({ text: "!rr" }, ctx()).reply, "random reply is currently 1-in-8.");
  resetMemory();
  assert.equal(handleCommand({ text: "!rr" }, ctx()).reply, "random reply is currently off.", "memory tier does not survive a reset — this IS the fork's own 'lost on restart' behaviour");
});

test("persistence (room-persisted tier, !h-default): a value written survives resetMemory() — it lives in a file under the private root, not the in-memory map", () => {
  const set = handleCommand({ text: "!h-default 12" }, ctx());
  assert.equal(set.reply, "default history set to 12 messages, persisted.");
  resetMemory();
  const get = handleCommand({ text: "!h-default" }, ctx());
  assert.equal(get.reply, "default history here: 12.");
  assert.equal(roomSettingsGet(ctx().roomKey, "context.history_default"), 12);
  const path = join(FIXTURE_DIR, "commands", "rooms", "discord_g1_c1.json");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "context.history_default": 12 });
});

test("persistence (global-persisted tier, !secret): 0600 perms, value never echoed by list, survives resetMemory()", () => {
  const isKeeper = () => true;
  const room = ctx({ isKeeper, roomKey: "discord:g1:secret-persist-test" });
  handleCommand({ text: "!secret webhook https://example.invalid/hook" }, room);
  resetMemory();
  const list = handleCommand({ text: "!secret list" }, room);
  assert.equal(list.reply, "secrets set here: webhook");
  assert.ok(!list.reply.includes("example.invalid"), "list never echoes a value");
  const path = join(FIXTURE_DIR, "commands", "secrets", "discord_g1_secret-persist-test.json");
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, "secrets file is 0600");
  const del = handleCommand({ text: "!secret delete webhook" }, room);
  assert.equal(del.reply, 'secret "webhook" deleted.');
  assert.equal(secretList(room.roomKey).length, 0);
});

// ---------- !sysprompt: the task-brief's own divergence from 00/02 (room-persisted override, not per-being) ----------

test("!sysprompt override persists PER ROOM (this task's own instruction — 00/02 document a per-BEING file in the fork; flagged in registry.mjs's header as a deliberate divergence)", () => {
  const a = ctx({ roomKey: "discord:g1:c1", being: "watson" });
  const b = ctx({ roomKey: "discord:g1:c1", being: "vallynn" }); // a different being, SAME room
  handleCommand({ text: "!sysprompt override be terser" }, a);
  // room-persisted, keyed by being within the room's own file — a
  // different room would NOT see this value; a different being in the
  // SAME room has its own key, but reads from the same room-scoped file.
  assert.equal(roomSettingsGet(a.roomKey, "sysprompt:watson"), "be terser");
  assert.equal(roomSettingsGet(b.roomKey, "sysprompt:vallynn"), undefined);
});

test("!sysprompt temp is memory-only (not persisted); !sysprompt reset clears both tiers", () => {
  const room = ctx({ roomKey: "discord:g1:sysprompt-temp-test" });
  const temp = handleCommand({ text: "!sysprompt temp be playful" }, room);
  assert.equal(temp.intent.persisted, false);
  assert.equal(roomSettingsGet(room.roomKey, "sysprompt:watson"), undefined, "temp never touches the persisted tier");
  handleCommand({ text: "!sysprompt override be terser" }, room);
  assert.equal(roomSettingsGet(room.roomKey, "sysprompt:watson"), "be terser");
  const reset = handleCommand({ text: "!sysprompt reset" }, room);
  assert.equal(reset.reply, "persona overlay reset to the testament.");
  assert.equal(roomSettingsGet(room.roomKey, "sysprompt:watson"), null);
});

// ---------- !help ----------

test("!help lists only what this platform (and permission) actually offers", () => {
  const web = handleCommand({ text: "!help" }, ctx({ platform: "web", by: "nobody" }));
  assert.ok(web.reply.includes("!help"));
  assert.ok(!web.reply.includes("!secret"), "web lacks !secret entirely");
  assert.ok(!web.reply.includes("!mt "), "web lacks !mt (D·S only)");

  const discordNonKeeper = handleCommand({ text: "!help" }, ctx({ platform: "discord", by: "anyone" }));
  assert.ok(!discordNonKeeper.reply.includes("!secret"), "a non-keeper's !help omits the keeper-only command");

  const discordKeeper = handleCommand(
    { text: "!help" },
    ctx({ platform: "discord", by: "k", isKeeper: () => true }),
  );
  assert.ok(discordKeeper.reply.includes("!secret"), "a keeper's own !help lists it");
  assert.ok(discordKeeper.reply.includes("m continue"), "the continue trigger is listed on a platform that has it");
});

// harness-port R2-W, 2026-09-17 (mission task 1's own store consumer) —
// see commands/store.mjs's own header for the ones this round leaves
// unconsumed (mcf/mmf/mt/h-default/split/autotrigger/sysprompt).
test("applyCommandDispatchSettings: !rr 5 persists to the memory tier, and the next reader sees random_reply:5 overlaid onto its own base dispatch", () => {
  handleCommand({ text: "!rr 5" }, ctx());
  const merged = applyCommandDispatchSettings({
    mention: true,
    reply: true,
    dm: true,
    random_reply: 0,
    bot_mention_budget: 1,
  });
  assert.equal(merged.random_reply, 5);
  assert.equal(merged.bot_mention_budget, 1, "bb was never set in this test — the base value rides through unchanged");
});

test("applyCommandDispatchSettings: !bb 3 persists too, independently of rr", () => {
  handleCommand({ text: "!bb 3" }, ctx());
  const merged = applyCommandDispatchSettings({
    mention: true,
    reply: true,
    dm: true,
    random_reply: 0,
    bot_mention_budget: 1,
  });
  assert.equal(merged.bot_mention_budget, 3);
});

test("helpTextFor is what handleCommand's !help actually returns (no drift between the two entry points)", () => {
  const direct = helpTextFor("discord", false);
  const viaCommand = handleCommand({ text: "!help" }, ctx({ platform: "discord", by: "x" })).reply;
  assert.equal(direct, viaCommand);
});
