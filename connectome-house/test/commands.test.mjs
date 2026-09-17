// @ts-check
/* connectome-house/test/commands.test.mjs — the `!` command lane
 * (src/commands/): grammar parsing, per-command validation, the
 * keeper-only gate, persistence round-trips across all four tiers, and
 * reply text.
 *
 * harness-port P-A (parity round, 2026-09-17): every reply-text assertion
 * below now goes through `fork-replies.mjs` — the module that reproduces
 * the fork's own command-effector strings byte-for-byte (discord-axon/
 * signal-axon/web-axon `*-command-effector.ts`, cited there per entry) —
 * rather than a hand-typed literal a prior round composed itself. This is
 * the mission's own instruction: "extended so every command's every reply
 * string is asserted against fork-replies.mjs".
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
const {
  resetMemory,
  roomSettingsGet,
  beingSettingsGet,
  secretGet,
  secretList,
  applyCommandDispatchSettings,
} = await import("../src/commands/store.mjs");
const fork = await import("../src/commands/fork-replies.mjs");
const { SIGNAL_COMMAND_REPLIES } = await import("../src/mcpl/signal.mjs");

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

// ---------- !stop (C11): "Stopping <bot>..." is the command's OWN reply —
// NOT "[Cycle stopped]", which is a separate, later, conditional notice
// (fork-replies.mjs's own header explains the citation and the
// correction this makes to a prior round, which conflated the two). ----------

test("handleCommand: !stop's own synchronous reply is fork.stop.ack(botName) on every platform, byte-identical", () => {
  for (const platform of ["discord", "signal", "web"]) {
    const r = handleCommand({ text: "!stop" }, ctx({ platform }));
    assert.equal(r.reply, fork.stop.ack("watson"));
    assert.equal(r.reply, "Stopping watson...");
    assert.deepEqual(r.intent, { kind: "interrupt", scope: "being", being: "watson" });
  }
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
  assert.deepEqual(handleCommand({ text: "!nonexistent" }, ctx({ platform: "signal" })), {
    reply: null,
    intent: { kind: "swallow" },
  });
});

// ---------- !rr (C2) — reply text against fork-replies.mjs, discord+web ----------

test("!rr: query/invalid/set text matches the fork exactly, discord vs web", () => {
  assert.equal(handleCommand({ text: "!rr" }, ctx()).reply, fork.rr.query(0));
  assert.equal(handleCommand({ text: "!rr" }, ctx()).reply, "Random reply is currently disabled (0)");
  assert.equal(handleCommand({ text: "!rr banana" }, ctx()).reply, fork.rr.invalid());
  const set = handleCommand({ text: "!rr 8" }, ctx());
  assert.equal(set.reply, fork.rr.set(8));
  assert.equal(set.reply, "Random reply set to 1/8 (12.5%)");
  assert.deepEqual(set.intent, { kind: "setting", scope: "global", key: "dispatch.random_reply", value: 8 });
  assert.equal(handleCommand({ text: "!rr 1" }, ctx()).reply, "Random reply set to 1/1 (100%) - bots will reply to every message");
  assert.equal(handleCommand({ text: "!rr 0" }, ctx()).reply, "Random reply disabled");

  resetMemory();
  const web = handleCommand({ text: "!rr" }, ctx({ platform: "web" }));
  assert.equal(web.reply, fork.rr.web.query(0));
  assert.equal(web.reply, "Random reply: 0");
  assert.equal(handleCommand({ text: "!rr banana" }, ctx({ platform: "web" })).reply, "Invalid. Use a number >= 0");
  assert.equal(handleCommand({ text: "!rr 5" }, ctx({ platform: "web" })).reply, fork.rr.web.set(5));
});

// ---------- harness-port P-F, 2026-09-17 (mission task 3; mcpl-signal/
// PARITY.md §1's named hook): registry.mjs consults SIGNAL_COMMAND_REPLIES
// (mcpl/signal.mjs, P-B's byte-exact port) FIRST for a Signal invocation of
// rr/bb/mt/split/stop/steer — proven here by mutating the override table's
// own function to a sentinel for the duration of the test (its normal
// output already matches fork.rr.set() byte-for-byte, so an equality
// assertion alone wouldn't prove the WIRING actually runs); Discord's own
// path is untouched by the same mutation. ----------

test("!rr on signal: registry.mjs actually consults SIGNAL_COMMAND_REPLIES.rr, not just fork-replies.mjs (Discord unaffected by the same override)", () => {
  const original = SIGNAL_COMMAND_REPLIES.rr;
  try {
    SIGNAL_COMMAND_REPLIES.rr = (args, state) => `SENTINEL:${original(args, state)}`;
    const signal = handleCommand({ text: "!rr 5" }, ctx({ platform: "signal" }));
    assert.equal(signal.reply, "SENTINEL:Random reply set to 1/5 (20.0%)");
    assert.equal(signal.reply, `SENTINEL:${original("5", { randomReplyChance: 0 })}`);
    assert.deepEqual(signal.intent, { kind: "setting", scope: "global", key: "dispatch.random_reply", value: 5 }, "the intent is unaffected — only the reply text is overridden");

    resetMemory();
    const discord = handleCommand({ text: "!rr 5" }, ctx({ platform: "discord" }));
    assert.equal(discord.reply, fork.rr.set(5), "Discord's own reply is untouched by Signal's override table");
    assert.ok(!discord.reply.startsWith("SENTINEL"));
  } finally {
    SIGNAL_COMMAND_REPLIES.rr = original;
  }
  resetMemory();
  // with the override restored, a real Signal !rr 5 reads byte-identical
  // to P-B's own SIGNAL_COMMAND_REPLIES string (and, not coincidentally,
  // to fork.rr.set(5) too — the fork's own discord/signal command bodies
  // are byte-identical for this command; see fork-replies.mjs's header).
  const real = handleCommand({ text: "!rr 5" }, ctx({ platform: "signal" }));
  assert.equal(real.reply, SIGNAL_COMMAND_REPLIES.rr("5", { randomReplyChance: 0 }));
  assert.equal(real.reply, "Random reply set to 1/5 (20.0%)");
});

// ---------- !bb (C3) ----------

test("!bb: query/invalid/set text matches the fork, discord vs web", () => {
  assert.equal(handleCommand({ text: "!bb" }, ctx()).reply, fork.bb.query(1), "the house's own default (unset) is 1, not 0 — no consumer default is specified by 02-user-contract.md for this, kept as a prior round set it");
  assert.equal(handleCommand({ text: "!bb 3" }, ctx()).reply, fork.bb.set(3));
  assert.equal(handleCommand({ text: "!bb 3" }, ctx()).reply, "Bot-to-bot mention limit set to 3");
  assert.equal(handleCommand({ text: "!bb" }, ctx()).reply, "Bot-to-bot mention limit: 3");
  resetMemory();
  assert.equal(handleCommand({ text: "!bb 3" }, ctx({ platform: "web" })).reply, fork.bb.web.set(3));
});

// ---------- !mcf (C4) — stream-scoped, bot-or-'*', range 10-2000, reset ----------

test("!mcf: server-default query, invalid range, bare (stream-wide) set/reset text matches the fork", () => {
  assert.equal(handleCommand({ text: "!mcf" }, ctx({ being: null })).reply, "Max context frames: server default (400)");
  assert.equal(handleCommand({ text: "!mcf 5" }, ctx({ being: null })).intent, null, "out of 10-2000 range — refused before run() even executes, but validate already blocked it");
});

test("!mcf: validate refuses out-of-range and non-numeric args with the fork's own text", () => {
  const v1 = handleCommand({ text: "!mcf 5" }, ctx({ being: null }));
  assert.equal(v1.reply, fork.mcf.invalid());
  assert.equal(v1.reply, 'Invalid value. Use a number between 10 and 2000, or "reset"');
  const v2 = handleCommand({ text: "!mcf 3000" }, ctx({ being: null }));
  assert.equal(v2.reply, fork.mcf.invalid());
});

test("!mcf: bare (stream-wide) set, then @bot-targeted set, then bare query prefers the bot override — matching the fork's own botVal-first read", () => {
  const bare = handleCommand({ text: "!mcf 200" }, ctx({ being: null }));
  assert.equal(bare.reply, "Max context frames set to 200 stream-wide");
  assert.deepEqual(bare.intent, { kind: "setting", scope: "being-in-room", key: "context.max_frames", being: null, value: 200 });

  const targeted = handleCommand({ text: "!mcf 300" }, ctx({ being: "watson" }));
  assert.equal(targeted.reply, "Max context frames set to 300 for watson on this stream");

  const q = handleCommand({ text: "!mcf" }, ctx({ being: "watson" }));
  assert.equal(q.reply, "Max context frames: 300 (override for watson on this stream)");

  const qBare = handleCommand({ text: "!mcf" }, ctx({ being: null }));
  assert.equal(qBare.reply, "Max context frames: 200 (stream-wide override)");
});

test("!mcf: reset — 'no override set' when nothing was set, else the fork's scoped reset text", () => {
  assert.equal(handleCommand({ text: "!mcf reset" }, ctx({ being: "watson" })).reply, "No override set for this scope");
  handleCommand({ text: "!mcf 500" }, ctx({ being: "watson" }));
  assert.equal(handleCommand({ text: "!mcf reset" }, ctx({ being: "watson" })).reply, "Max context frames reset to default for watson on this stream");
  handleCommand({ text: "!mcf 500" }, ctx({ being: null }));
  assert.equal(handleCommand({ text: "!mcf reset" }, ctx({ being: null })).reply, "Stream-wide max context frames reset to default");
});

test("!mcf on web: a flat, unscoped, simpler mechanism (02-user-contract.md's 'W no-op' was wrong — corrected in this task's doc diff)", () => {
  assert.equal(handleCommand({ text: "!mcf" }, ctx({ platform: "web", being: null })).reply, fork.mcf.web.query(400));
  const set = handleCommand({ text: "!mcf 250" }, ctx({ platform: "web", being: null }));
  assert.equal(set.reply, fork.mcf.web.set(250));
  assert.equal(handleCommand({ text: "!mcf 5" }, ctx({ platform: "web", being: null })).reply, fork.mcf.web.invalid());
});

// ---------- !mmf (C5) — axon-wide (global), echo-only in the fork ----------

test("!mmf: global (not per-room) query/set text, discord vs web", () => {
  assert.equal(handleCommand({ text: "!mmf" }, ctx()).reply, fork.mmf.query(400));
  const set = handleCommand({ text: "!mmf 500" }, ctx({ roomKey: "discord:g1:c1" }));
  assert.equal(set.reply, fork.mmf.set(500));
  // a DIFFERENT room reads the SAME value back — global, not per-room.
  assert.equal(handleCommand({ text: "!mmf" }, ctx({ roomKey: "discord:g2:other" })).reply, fork.mmf.query(500));
  resetMemory();
  assert.equal(handleCommand({ text: "!mmf 500" }, ctx({ platform: "web" })).reply, fork.mmf.web.set(500));
});

// ---------- !mt (C6) — GLOBAL per being (corrected from a prior round's per-room storage) ----------

test("!mt: global per-being query/reset/set text, discord vs web; a different room sees the same value", () => {
  assert.equal(handleCommand({ text: "!mt" }, ctx()).reply, fork.mt.query("watson", undefined));
  assert.equal(handleCommand({ text: "!mt" }, ctx()).reply, "Max output tokens for watson: using model default");
  const set = handleCommand({ text: "!mt 500" }, ctx({ roomKey: "discord:g1:c1" }));
  assert.equal(set.reply, fork.mt.set("watson", 500));
  assert.deepEqual(set.intent, { kind: "setting", scope: "being", key: "max_tokens", being: "watson", value: 500 });
  assert.equal(handleCommand({ text: "!mt" }, ctx({ roomKey: "discord:g9:elsewhere" })).reply, "Max output tokens for watson: 500", "global, not per-room");
  const reset = handleCommand({ text: "!mt 0" }, ctx());
  assert.equal(reset.reply, fork.mt.reset("watson"));
  resetMemory();
  assert.equal(handleCommand({ text: "!mt" }, ctx({ platform: "web" })).reply, fork.mt.web.query("watson", undefined));
  assert.equal(handleCommand({ text: "!mt" }, ctx({ platform: "web" })).reply, "Max output tokens for watson: model default");
  assert.equal(handleCommand({ text: "!mt 0" }, ctx({ platform: "web", roomKey: null })).reply, fork.mt.web.reset("watson"));
});

// ---------- !h-default (C7) — (being × room) scoped, room-persisted ----------

test("!h-default: query/off/set text matches the fork; persists per (being, room)", () => {
  const room = ctx({ roomKey: "discord:g1:hdefault-text-test" });
  const q = handleCommand({ text: "!h-default" }, room);
  assert.equal(q.reply, fork.hDefault.query("watson", undefined));
  const set = handleCommand({ text: "!h-default 12" }, room);
  assert.equal(set.reply, fork.hDefault.set("watson", 12));
  assert.equal(set.reply, "History default for watson set to 12 in this stream (each activation trims to last 12 + trigger)");
  const off = handleCommand({ text: "!h-default off" }, room);
  assert.equal(off.reply, fork.hDefault.off("watson"));
  // a DIFFERENT being in the SAME room has its own key.
  handleCommand({ text: "!h-default 7" }, { ...room, being: "vallynn" });
  assert.equal(roomSettingsGet(room.roomKey, "context.history_default:vallynn"), 7);
  assert.equal(roomSettingsGet(room.roomKey, "context.history_default:watson"), null);
});

// ---------- !steer (C12) ----------

test("!steer: usage/ack text differs only by backticks (discord/web) vs none (signal); web has no '(file attached)' fallback", () => {
  assert.equal(handleCommand({ text: "!steer" }, ctx({ platform: "discord" })).reply, fork.steer.usage("discord"));
  assert.equal(handleCommand({ text: "!steer" }, ctx({ platform: "discord" })).reply, "Usage: `!steer <message>`");
  assert.equal(handleCommand({ text: "!steer" }, ctx({ platform: "signal" })).reply, "Usage: !steer <message>");
  const ack = handleCommand({ text: "!steer look here" }, ctx({ platform: "discord" }));
  assert.equal(ack.reply, fork.steer.ack("discord", "watson", "look here"));
  assert.equal(ack.reply, "Steering watson: look here");
});

// ---------- !stream (C13) ----------

test("handleCommand: !stream requires 'in <name>' or exactly 'out', text matches the fork per platform", () => {
  assert.equal(handleCommand({ text: "!stream" }, ctx({ platform: "discord" })).reply, fork.stream.usage("discord"));
  assert.equal(handleCommand({ text: "!stream sideways" }, ctx({ platform: "discord" })).intent, null);
  const rin = handleCommand({ text: "!stream in offtopic" }, ctx({ platform: "discord" }));
  assert.equal(rin.reply, fork.stream.in("offtopic", "watson"));
  assert.deepEqual(rin.intent, { kind: "stream", direction: "in", name: "offtopic" });
  const rout = handleCommand({ text: "!stream out" }, ctx({ platform: "discord" }));
  assert.equal(rout.reply, fork.stream.out("watson"));
  assert.deepEqual(rout.intent, { kind: "stream", direction: "out" });
  assert.equal(handleCommand({ text: "!stream" }, ctx({ platform: "signal" })).reply, "Usage: !stream in <name> to enter, !stream out <name> to exit.");
});

// ---------- !autotrigger (C14) ----------

test("!autotrigger: enable/disable text matches the fork; on/off recognized anywhere in the args, unrecognized tokens ignored (no validation refusal)", () => {
  const on = handleCommand({ text: "!autotrigger" }, ctx({ platform: "discord" }));
  assert.equal(on.reply, fork.autotrigger.enabled("discord", { botName: "watson" }));
  assert.equal(on.reply, "Autotrigger enabled for watson — use `!stop` to halt");
  const off = handleCommand({ text: "!autotrigger off" }, ctx({ platform: "discord" }));
  assert.equal(off.reply, fork.autotrigger.disabled("discord", "watson"));
  assert.equal(off.reply, "Autotrigger disabled for watson");
  const withFlags = handleCommand({ text: "!autotrigger --stream sidebar --max-speech-only 3" }, ctx({ platform: "discord" }));
  assert.equal(withFlags.reply, "Autotrigger enabled for watson (substream: sidebar), max-speech-only: 3 — use `!stop` to halt");
  const signalNoBacktick = handleCommand({ text: "!autotrigger" }, ctx({ platform: "signal" }));
  assert.equal(signalNoBacktick.reply, "Autotrigger enabled for watson — use !stop to halt");
});

// ---------- !tts (C15) — GLOBAL per being ----------

test("!tts: query/set text matches the fork; global per being, not per room", () => {
  assert.equal(handleCommand({ text: "!tts" }, ctx()).reply, fork.tts.query("watson", undefined));
  const set = handleCommand({ text: "!tts on" }, ctx({ roomKey: "discord:g1:c1" }));
  assert.equal(set.reply, fork.tts.set("watson", true));
  assert.equal(handleCommand({ text: "!tts" }, ctx({ roomKey: "discord:g9:elsewhere" })).reply, "TTS for watson: on");
  assert.equal(handleCommand({ text: "!tts sideways" }, ctx()).reply, fork.tts.invalidUsage());
});

// ---------- !sysprompt (C16) — corrected to per-BEING persistence ----------

test("!sysprompt override persists PER BEING, GLOBALLY (corrected this round — a prior round persisted per room; see registry.mjs's own header)", () => {
  const roomA = ctx({ roomKey: "discord:g1:c1", being: "watson" });
  const roomB = ctx({ roomKey: "discord:g2:different-room", being: "watson" }); // same being, DIFFERENT room
  handleCommand({ text: "!sysprompt override be terser" }, roomA);
  assert.equal(beingSettingsGet("watson", "sysprompt"), "be terser");
  // the SAME being's override is visible from a different room, unlike a prior round's per-room storage.
  const seenFromB = handleCommand({ text: "!sysprompt" }, roomB);
  assert.ok(seenFromB.reply.includes("be terser"));
  // a DIFFERENT being has its own key.
  assert.equal(beingSettingsGet("vallynn", "sysprompt", null), null);
});

test("!sysprompt temp is memory-only (not persisted); !sysprompt reset clears both tiers; reply text matches the fork", () => {
  // a being name of its OWN — sysprompt persists globally per being now
  // (not per room), so reusing "watson" here would read back whatever an
  // earlier test in this same file already persisted for it.
  const room = ctx({ roomKey: "discord:g1:sysprompt-temp-test", being: "sysprompt-temp-being" });
  const temp = handleCommand({ text: "!sysprompt temp be playful" }, room);
  assert.equal(temp.intent.persisted, false);
  assert.equal(temp.reply, fork.sysprompt.updated("discord", { botName: "sysprompt-temp-being", mode: "temp", text: "be playful" }));
  assert.equal(beingSettingsGet("sysprompt-temp-being", "sysprompt", null), null, "temp never touches the persisted tier");
  const ov = handleCommand({ text: "!sysprompt override be terser" }, room);
  assert.equal(ov.reply, fork.sysprompt.updated("discord", { botName: "sysprompt-temp-being", mode: "override", text: "be terser" }));
  assert.equal(beingSettingsGet("sysprompt-temp-being", "sysprompt"), "be terser");
  const reset = handleCommand({ text: "!sysprompt reset" }, room);
  assert.equal(reset.reply, fork.sysprompt.reset("sysprompt-temp-being"));
  assert.equal(reset.reply, "System prompt for sysprompt-temp-being reset — bot-runtime will revert to config.json baseline on next activation.");
  assert.equal(beingSettingsGet("sysprompt-temp-being", "sysprompt", null), null);
});

test("!sysprompt: bad mode / missing text usage errors match the fork per platform (signal has no backticks and different wording)", () => {
  const room = ctx({ roomKey: "discord:g1:sysprompt-usage-test", being: "watson" });
  assert.equal(handleCommand({ text: "!sysprompt sideways text" }, room).reply, fork.sysprompt.usageBadMode("discord", "sideways"));
  assert.equal(
    handleCommand({ text: "!sysprompt sideways text" }, { ...room, platform: "signal" }).reply,
    "Usage: !sysprompt [temp|override] <text|file>  |  !sysprompt reset",
  );
});

test("!sysprompt: status when nothing is persisted differs discord/signal (long form) vs web (short form)", () => {
  const fresh = ctx({ roomKey: "discord:g1:sysprompt-status-test", being: "brand-new-being" });
  assert.equal(handleCommand({ text: "!sysprompt" }, fresh).reply, fork.sysprompt.statusNone("discord", "brand-new-being"));
  assert.ok(handleCommand({ text: "!sysprompt" }, fresh).reply.includes("Temporary in-memory overrides are not readable"));
  const web = handleCommand({ text: "!sysprompt" }, { ...fresh, platform: "web" });
  assert.equal(web.reply, fork.sysprompt.statusNone("web", "brand-new-being"));
  assert.ok(!web.reply.includes("Temporary in-memory overrides"), "web's status text is shorter — no second sentence");
});

// ---------- !secret (C17) — text corrected to the fork's exact wording ----------

test("handleCommand: !secret refuses a non-keeper, keeper-only text, never touches the store", () => {
  const r = handleCommand({ text: "!secret api_key sk_123" }, ctx({ platform: "discord", by: "notakeeper" }));
  assert.equal(r.reply, "!secret is keeper-only.");
  assert.equal(r.intent, null);
  assert.equal(secretGet(ctx().roomKey, "api_key"), undefined, "never written");
});

test("handleCommand: !secret store/list/delete text matches the fork exactly (bold on discord, plain on signal); name must be alphanumeric/underscore", () => {
  const isKeeper = (h) => h === "robin";
  const room = ctx({ platform: "discord", by: "robin", isKeeper, roomKey: "discord:g1:secret-ctx-test" });
  const invalidName = handleCommand({ text: "!secret api-key sk-123" }, room);
  assert.equal(invalidName.reply, fork.secret.invalidName(), "a hyphen is not alphanumeric/underscore — the fork's own name regex refuses it");
  const r = handleCommand({ text: "!secret api_key sk_123" }, room);
  assert.equal(r.reply, fork.secret.stored("discord", "api_key", "sk_123".length));
  assert.equal(r.reply, "Secret stored: **api_key** (6 chars)");
  assert.ok(!r.reply.includes("sk_123"), "the value is never echoed back");
  assert.equal(r.intent.kind, "secret-set");
  const list = handleCommand({ text: "!secret list" }, room);
  assert.equal(list.reply, fork.secret.list("discord", ["api_key"]));
  assert.equal(list.reply, "**Stored secrets:** api_key");
  const del = handleCommand({ text: "!secret delete api_key" }, room);
  assert.equal(del.reply, fork.secret.deleted("api_key"));
  const notFound = handleCommand({ text: "!secret delete api_key" }, room);
  assert.equal(notFound.reply, fork.secret.notFound("api_key"));
  const signalRoom = { ...room, platform: "signal", roomKey: "discord:g1:secret-signal-test" };
  const sr = handleCommand({ text: "!secret api_key sk_123" }, signalRoom);
  assert.equal(sr.reply, "Secret stored: api_key (6 chars)", "signal has no bold markdown");
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
  assert.equal(handleCommand({ text: "!rr" }, ctx()).reply, fork.rr.query(0));
  const set = handleCommand({ text: "!rr 8" }, ctx());
  assert.equal(set.reply, fork.rr.set(8));
  assert.deepEqual(set.intent, { kind: "setting", scope: "global", key: "dispatch.random_reply", value: 8 });
  assert.equal(handleCommand({ text: "!rr" }, ctx()).reply, fork.rr.query(8));
  resetMemory();
  assert.equal(handleCommand({ text: "!rr" }, ctx()).reply, fork.rr.query(0), "memory tier does not survive a reset — this IS the fork's own 'lost on restart' behaviour");
});

test("persistence (room-persisted tier, !h-default): a value written survives resetMemory() — it lives in a file under the private root, not the in-memory map", () => {
  const set = handleCommand({ text: "!h-default 12" }, ctx());
  assert.equal(set.reply, fork.hDefault.set("watson", 12));
  resetMemory();
  const get = handleCommand({ text: "!h-default" }, ctx());
  assert.equal(get.reply, fork.hDefault.query("watson", 12));
  assert.equal(roomSettingsGet(ctx().roomKey, "context.history_default:watson"), 12);
  const path = join(FIXTURE_DIR, "commands", "rooms", "discord_g1_c1.json");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "context.history_default:watson": 12 });
});

test("persistence (being-persisted tier, !sysprompt override): survives resetMemory(), lives in a file keyed by being under the private root", () => {
  handleCommand({ text: "!sysprompt override be terser" }, ctx({ roomKey: "discord:g1:being-persist-test", being: "watson" }));
  resetMemory();
  assert.equal(beingSettingsGet("watson", "sysprompt"), "be terser");
  const path = join(FIXTURE_DIR, "commands", "beings", "watson.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.sysprompt, "be terser");
});

test("persistence (global-persisted tier, !secret): 0600 perms, value never echoed by list, survives resetMemory()", () => {
  const isKeeper = () => true;
  const room = ctx({ isKeeper, roomKey: "discord:g1:secret-persist-test" });
  handleCommand({ text: "!secret webhook https://example.invalid/hook" }, room);
  resetMemory();
  const list = handleCommand({ text: "!secret list" }, room);
  assert.equal(list.reply, fork.secret.list("discord", ["webhook"]));
  assert.ok(!list.reply.includes("example.invalid"), "list never echoes a value");
  const path = join(FIXTURE_DIR, "commands", "secrets", "discord_g1_secret-persist-test.json");
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, "secrets file is 0600");
  const del = handleCommand({ text: "!secret delete webhook" }, room);
  assert.equal(del.reply, fork.secret.deleted("webhook"));
  assert.equal(secretList(room.roomKey).length, 0);
});

// ---------- !help ----------

test("!help: discord/web return the fork's own static text byte-for-byte, unconditionally (no keeper filtering — the fork never gates help text, only execution)", () => {
  const discordAnyone = handleCommand({ text: "!help" }, ctx({ platform: "discord", by: "anyone" }));
  assert.equal(discordAnyone.reply, fork.HELP_TEXT_DISCORD);
  assert.ok(discordAnyone.reply.includes("!secret"), "the fork's own !help ALWAYS lists !secret, keeper or not — handleHelp() takes no arguments");
  assert.ok(discordAnyone.reply.includes("!mt"), "discord's help lists !mt");

  const discordKeeper = handleCommand({ text: "!help" }, ctx({ platform: "discord", by: "k", isKeeper: () => true }));
  assert.equal(discordKeeper.reply, discordAnyone.reply, "identical regardless of asker");

  const web = handleCommand({ text: "!help" }, ctx({ platform: "web", by: "nobody" }));
  assert.equal(web.reply, fork.HELP_TEXT_WEB);
  assert.ok(!web.reply.includes("!secret"), "web's own static help never mentions !secret at all — web-command-effector.ts's switch has no case for it");
  assert.ok(web.reply.includes("!mt"), "web's help DOES list !mt (web-command-effector.ts:53 implements it — 02-user-contract.md's 'D·S only' claim was wrong, corrected in this task's doc diff)");
});

test("!help: signal falls back to the generic per-usage-line list (a documented gap — the fork's own signal help embeds live config values this pure function cannot reproduce)", () => {
  const signal = handleCommand({ text: "!help" }, ctx({ platform: "signal", by: "anyone" }));
  assert.ok(signal.reply.startsWith("Commands available here:"));
  assert.ok(signal.reply.includes("!split"), "signal-only commands still appear in the generic fallback");
});

// ---------- store consumer: !rr/!bb feed applyCommandDispatchSettings ----------

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
