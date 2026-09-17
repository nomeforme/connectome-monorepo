// @ts-check
/* connectome-house/test/commands-wired.test.mjs — harness-port R2-W,
 * 2026-09-17 (mission task 1): the command lane's own PLUMBING, at the
 * two seams this round's owned files actually touch:
 *
 * 1. route.mjs's routeIncoming calls handleCommand right after sender/by
 *    are computed, before the "unconfigured" ignore check — a recognized
 *    command short-circuits to a SINGLE `{kind: "command", ...}` action,
 *    never an `open-room`/`input` action (never a room turn, never an
 *    activation), carrying whatever `reply`/`intent` commands/index.mjs's
 *    own handleCommand already returns (commands.test.mjs is what proves
 *    THAT part correct; this file only proves route.mjs hands it through
 *    unmodified, at the right point in the pipeline).
 * 2. room-turn.mjs's own intent hooks (`applyInterrupt`/`applySteer`) —
 *    a `!stop`/`!steer` INTENT actually reaching an open turn, end to end
 *    through a real socket seat (createHouseSeatServer + a raw
 *    SeatClient, seat-abort.test.mjs's own pattern).
 *
 * NAMED GAP (this task's own report): nothing yet calls handleCommand's
 * OWN reply through a live seat's speak path, nor applies its OWN intent
 * automatically — that requires touching mcpl/seat.mjs, NO-TOUCH for this
 * task (the reply/intent hand-off from routeIncoming to a live seat is
 * the one piece of task 1 this round could not finish; see also
 * commands/store.mjs's and room-turn.mjs's own "KNOWN GAP" notes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatClient } from "@connectome/seat-client";

// HOUSE_RUNS_DIR/HOUSE_PRIVATE_DIR/HOUSE_COVENANTS_DIR MUST be set before
// the FIRST import of anything under src/ — serve-paths.mjs reads them
// once, at module load, and route.mjs's own import chain (below) already
// reaches commands/store.mjs, which reads PRIVATE_DIR the same way
// (commands.test.mjs's own header names this exact trap). Setting them
// later would leave the whole rest of this process's module graph
// pointed at a stale/inherited path forever.
const ROOT = mkdtempSync(join(tmpdir(), "commands-wired-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });

const { writeTestament } = await import("./lib/fixtures.mjs");
const { waitFor, framesOf } = await import("./lib/serve-harness.mjs");
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");
writeTestament(process.env.HOUSE_COVENANTS_DIR, "zz-wired-being", { speaksFor: "discord" });

// ---------------------------------------------------------------------
// 1. routeIncoming's own command-lane short-circuit — a pure, direct call
//    (the same convention test/mcpl-route.test.mjs and the O6/O7 tests in
//    dispatch-discord-matrix.test.mjs already use).
// ---------------------------------------------------------------------

const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");

const BEING = "zz-wired-being";
// discord-shaped, not "mock" — commands/registry.mjs's own platform sets
// (DSW/DS/S_ONLY) never include "mock"; every command this file exercises
// would be refused/unavailable on an unregistered platform, which is not
// what this file means to test.
const STREAM = "discord:g1:c1";
const SERVER = {
  name: "wired-discord",
  platform: "discord",
  being: BEING,
  rooms: [{ stream: STREAM, beings: [BEING], public: true }],
};

function deps(overrides = {}) {
  return {
    server: SERVER,
    roomsOpen: () => null,
    identityFor: ({ id }) => ({ handle: String(id), known: true }),
    isBeing: (h) => h === BEING,
    covenants: () => ({
      posture: "present",
      dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 },
    }),
    roomKeyOf: (s) => s,
    awakeOf: () => true,
    isKeeper: () => false,
    ...overrides,
  };
}

const cmdMsg = (text) =>
  normalizeIncoming({
    channelId: STREAM,
    messageId: "m-cmd",
    author: { id: "keeper-1", name: "keeper" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text }],
    metadata: {},
  });

test("!stop short-circuits to a single {kind:'command'} action carrying an interrupt intent — no open-room, no input, no activation", () => {
  const actions = routeIncoming({ ...deps(), msg: cmdMsg("!stop") });
  assert.equal(actions.length, 1, "the command lane short-circuits — nothing else runs for this message");
  assert.equal(actions[0].kind, "command");
  assert.equal(actions[0].reply, "[Cycle stopped]");
  assert.deepEqual(actions[0].intent, { kind: "interrupt", scope: "being", being: BEING });
  assert.equal(actions[0].being, BEING);
  assert.equal(
    actions.some((a) => a.kind === "input" || a.kind === "open-room"),
    false,
    "never a room turn, never an activation",
  );
});

test("!rr 5 short-circuits to a 'command' action carrying a setting intent, and the room never opens for it", () => {
  const actions = routeIncoming({ ...deps(), msg: cmdMsg("!rr 5") });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "command");
  assert.deepEqual(actions[0].intent, {
    kind: "setting",
    scope: "global",
    key: "dispatch.random_reply",
    value: 5,
  });
});

test("!help short-circuits with the platform's own command list as `reply`, no intent", () => {
  const actions = routeIncoming({ ...deps(), msg: cmdMsg("!help") });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "command");
  assert.ok(actions[0].reply.startsWith("Commands available here:"));
  assert.equal(actions[0].intent, null);
});

test("ordinary text (not a command) is untouched — falls through to the usual room-admission pipeline exactly as before this task", () => {
  const actions = routeIncoming({ ...deps(), msg: cmdMsg("hey there") });
  assert.ok(actions.some((a) => a.kind === "input"), "an ordinary message still becomes an input action");
  assert.ok(!actions.some((a) => a.kind === "command"));
});

test("a command reaches the lane even for a stream this server hasn't configured/opened yet (03-house-design.md §5: the lane runs BEFORE room admission)", () => {
  const unconfigured = normalizeIncoming({
    channelId: "discord:unconfigured:1",
    messageId: "m-cmd-2",
    author: { id: "keeper-1", name: "keeper" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: "!help" }],
    metadata: {},
  });
  const r = routeIncoming({ ...deps(), msg: unconfigured });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "command");
});

// ---------------------------------------------------------------------
// 2. room-turn.mjs's own intent hooks, end to end through a real socket
//    seat (seat-abort.test.mjs's own house-only setup: openRoom + a bare
//    unix-socket seat server; a raw SeatClient that never answers
//    turn.begin, so the turn stays open until this test acts on it).
// ---------------------------------------------------------------------

const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { applyInterrupt, applySteer } = await import("../src/room-turn.mjs");

async function seatedRoom(t, streamSuffix) {
  const { id, error } = await openRoom({
    platform: "synthetic",
    stream: `commands-wired-${streamSuffix}`,
    title: "a synthetic room, for commands-wired.test.mjs only",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);

  const sockDir = mkdtempSync(join(tmpdir(), `commands-wired-sock-${streamSuffix}-`));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  const client = new SeatClient({ path: sockPath, seatId: `aria-${streamSuffix}`, being: "aria", room: id });
  /** @type {Record<string, unknown>[]} */
  const seen = [];
  client.on("*", (m) => seen.push(m));
  await client.connect();
  t.after(() => client.close());
  t.after(async () => server.close());

  await waitFor(() => (open.get(id)?.seat ? true : null));
  await roomInput({ id, by: "mara", text: "@aria are you there?" });
  await waitFor(() => (open.get(id).turn ? true : null));

  return { id, runDir, seen };
}

test("applyInterrupt (!stop's own intent hook): an open turn ends aborted, the seat receives an interrupt message, the room itself stays open", async (t) => {
  const { id, runDir, seen } = await seatedRoom(t, "interrupt");

  const applied = applyInterrupt(open.get(id));
  assert.equal(applied, true, "a turn was genuinely open to interrupt");

  await waitFor(() => (open.get(id).turn === null ? true : null));
  assert.equal(open.get(id).status, "open", "the room stays open — only the turn's own outcome is aborted");

  const frames = framesOf(runDir);
  const last = frames[frames.length - 1];
  assert.equal(last.type, "aborted");
  assert.equal(last.reason, "interrupted (!stop)");

  await waitFor(() => (seen.some((m) => m.type === "interrupt") ? true : null));
  assert.ok(seen.some((m) => m.type === "interrupt" && m.by === "house"));

  // idempotent / honest on a room with nothing open: a second call is a
  // no-op, never a throw.
  assert.equal(applyInterrupt(open.get(id)), false);
});

test("applySteer (!steer's own intent hook): a line reaches the open turn's seat, and is recorded as an ordinary message frame", async (t) => {
  const { id, runDir, seen } = await seatedRoom(t, "steer");

  const applied = applySteer(open.get(id), { by: "mara", text: "look over there instead" });
  assert.equal(applied, true, "a turn was genuinely open to steer");

  await waitFor(() => (seen.some((m) => m.type === "line") ? true : null));
  const line = seen.find((m) => m.type === "line");
  assert.equal(line.by, "mara");
  assert.equal(line.text, "look over there instead");

  const frames = framesOf(runDir);
  // the room's own admitting message ("@aria are you there?") is ALSO a
  // "message" frame by "mara" — match the steer's own text specifically,
  // not just the first "message" frame from this sender.
  const recorded = frames.find((f) => f.type === "message" && f.by === "mara" && f.text === "look over there instead");
  assert.ok(recorded, "the steer's own text is recorded as an ordinary message frame");
  assert.equal(recorded.text, "look over there instead");

  // the turn is still open afterward — a steer never ends it.
  assert.ok(open.get(id).turn, "steering does not close the turn");
});

test("applyInterrupt/applySteer on a room with no open turn at all: a silent no-op, never a throw", async () => {
  const { id } = await (async () => {
    const r = await openRoom({
      platform: "synthetic",
      stream: "commands-wired-idle",
      title: "idle room, no turn ever opened",
      beings: ["aria"],
    });
    return r;
  })();
  const rec = open.get(id);
  assert.equal(applyInterrupt(rec), false);
  assert.equal(applySteer(rec, { by: "mara", text: "hello?" }), false);
});
