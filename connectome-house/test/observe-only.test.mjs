// @ts-check
/* connectome-house/test/observe-only.test.mjs — harness-port P-F,
 * 2026-09-17 (mission task 2; docs/harness-port/08-pilot-observe.md §2):
 * the `observe_only` servers-file field — config.mjs's own validation and
 * global-default two-step, the container-proof sandbox-refusal fix
 * (HOUSE_SANDBOX, not HOUSE_RUNS_DIR), and a real seat + mock MCPL server
 * end to end: a mention arrives, it is recorded, and NOT ONE outbound call
 * of any kind goes out (no send_message, no reply_message, no
 * channels/typing) — proven by an EMPTY record.jsonl. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");

// harness-port P-F, 2026-09-17: HOUSE_RUNS_DIR/HOUSE_PRIVATE_DIR must be
// set BEFORE the first import of anything under src/ that transitively
// reaches serve-paths.mjs (it reads them once, at module load, and caches
// the result — commands.test.mjs's own header names this same rule).
// config.mjs -> testaments.mjs -> serve-paths.mjs, so even the config-only
// tests below need this sandbox set up first, not just the seat tests.
const ROOT = mkdtempSync(join(tmpdir(), "observe-only-seat-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "observe-only-test-salt-0123456789";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });

const { writeTestament } = await import("./lib/fixtures.mjs");
const { framesOf, waitFor } = await import("./lib/serve-harness.mjs");

/* ---------------------------------------------------------------------- */
/* config.mjs: the observe_only field itself                              */
/* ---------------------------------------------------------------------- */

const { validateServer, loadServersConfig, sandboxRefusal } = await import("../src/mcpl/config.mjs");

const BASE_RAW_SERVER = {
  name: "d1",
  platform: "discord",
  command: "node",
  args: [],
  being: "watson",
};

const { createSeat } = await import("../src/mcpl/seat.mjs");
const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");

test("validateServer: observe_only unset stays unset (loadServersConfig's own job to default it); explicit true/false round-trips", () => {
  const unset = validateServer(BASE_RAW_SERVER);
  assert.equal(typeof unset, "object");
  assert.equal("observe_only" in unset, false, "left unset for loadServersConfig's two-step default");
  const on = validateServer({ ...BASE_RAW_SERVER, observe_only: true });
  assert.equal(on.observe_only, true);
  const off = validateServer({ ...BASE_RAW_SERVER, observe_only: false });
  assert.equal(off.observe_only, false);
});

function withServersFile(json) {
  const dir = mkdtempSync(join(tmpdir(), "observe-only-config-"));
  const path = join(dir, "servers.json");
  writeFileSync(path, JSON.stringify(json));
  return { dir, path };
}

test("loadServersConfig: observe_only defaults OFF globally; a server's own explicit override always wins", () => {
  const { dir, path } = withServersFile({
    servers: [
      { ...BASE_RAW_SERVER, name: "d1" },
      { ...BASE_RAW_SERVER, name: "d2", observe_only: true },
    ],
  });
  try {
    const { servers, errors } = loadServersConfig({ HOUSE_MCPL_SERVERS: path });
    assert.deepEqual(errors, []);
    assert.equal(servers.find((s) => s.name === "d1").observe_only, false, "global default OFF");
    assert.equal(servers.find((s) => s.name === "d2").observe_only, true, "per-server override wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadServersConfig: a GLOBAL observe_only:true is the default every silent server inherits", () => {
  const { dir, path } = withServersFile({
    observe_only: true,
    servers: [{ ...BASE_RAW_SERVER, name: "d1" }, { ...BASE_RAW_SERVER, name: "d2", observe_only: false }],
  });
  try {
    const { servers } = loadServersConfig({ HOUSE_MCPL_SERVERS: path });
    assert.equal(servers.find((s) => s.name === "d1").observe_only, true, "inherits the global default");
    assert.equal(servers.find((s) => s.name === "d2").observe_only, false, "its own explicit override wins over the global");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------- */
/* the container-proof fix: sandboxRefusal keys on HOUSE_SANDBOX, not      */
/* HOUSE_RUNS_DIR (a real deployment sets HOUSE_RUNS_DIR too)              */
/* ---------------------------------------------------------------------- */

test("sandboxRefusal: a REAL deployment (HOUSE_RUNS_DIR set, no HOUSE_SANDBOX) is never refused — the container-proof bug this task fixes", () => {
  const env = {
    HOUSE_MCPL_SERVERS: "/workspace/house-config/servers.json",
    HOUSE_RUNS_DIR: "/workspace/runs",
    HOUSE_PRIVATE_DIR: "/workspace/private",
  };
  assert.equal(sandboxRefusal(env), null, "HOUSE_RUNS_DIR alone must never mean 'this is a test'");
});

test("sandboxRefusal: a sandboxed test (HOUSE_SANDBOX=1) still refuses a servers file outside HOUSE_PRIVATE_DIR", () => {
  const env = {
    HOUSE_MCPL_SERVERS: "/somewhere/else/servers.json",
    HOUSE_SANDBOX: "1",
    HOUSE_PRIVATE_DIR: "/tmp/sandbox-private",
  };
  assert.ok(sandboxRefusal(env), "still refused — the box's own real bot must never be seated by a test");
});

test("sandboxRefusal: HOUSE_SANDBOX without HOUSE_PRIVATE_DIR at all is refused (nothing to scope the check to)", () => {
  const env = { HOUSE_MCPL_SERVERS: "/x/servers.json", HOUSE_SANDBOX: "1" };
  assert.ok(sandboxRefusal(env));
});

test("sandboxRefusal: HOUSE_SANDBOX=1 with the servers file genuinely under HOUSE_PRIVATE_DIR is allowed", () => {
  const env = {
    HOUSE_MCPL_SERVERS: "/tmp/sandbox-private/servers.json",
    HOUSE_SANDBOX: "1",
    HOUSE_PRIVATE_DIR: "/tmp/sandbox-private",
  };
  assert.equal(sandboxRefusal(env), null);
});

test("sandboxRefusal: no servers file named at all is never a refusal, sandboxed or not", () => {
  assert.equal(sandboxRefusal({ HOUSE_SANDBOX: "1", HOUSE_PRIVATE_DIR: "/x" }), null);
});

/* ---------------------------------------------------------------------- */
/* a real seat + a real mock MCPL server: observe_only end to end         */
/* ---------------------------------------------------------------------- */

const BEING = "aria";
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "discord" });


function rowsOf(recordPath) {
  try {
    return readFileSync(recordPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function msg(id, { channelId, author = "alice", text }) {
  return {
    channelId,
    messageId: id,
    author: { id: author, name: author },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text }],
    metadata: { mentions: [], rawContent: null, replyTo: null, replyToAuthorId: null, isBot: false },
  };
}

const seatsToStop = [];
after(async () => {
  for (const s of seatsToStop) s.stop();
});

test("observe_only seat: a direct mention is recorded in the room, but NOT ONE outbound call of any kind goes out", async () => {
  const stream = "discord:g1:observe-only";
  const fixture = join(process.env.HOUSE_PRIVATE_DIR, "observe-only.fixture.json");
  const record = join(process.env.HOUSE_PRIVATE_DIR, "observe-only.record.jsonl");
  writeFileSync(
    fixture,
    JSON.stringify({
      channels: [{ id: stream, type: "discord", label: "c", direction: "bidirectional" }],
      history: {},
      script: [
        { after_ms: 30, incoming: msg("oo-1", { channelId: stream, text: `@${BEING} are you there?` }) },
      ],
    }),
  );
  const seat = createSeat({
    server: {
      name: "observe-only-1",
      platform: "discord",
      command: "node",
      args: [MOCK, fixture, record],
      env: [],
      being: BEING,
      rooms: [{ stream, title: "observe-only e2e", beings: [BEING], public: true }],
      mock: true,
      observe_only: true,
    },
    log: () => {},
  });
  seatsToStop.push(seat);
  await seat.start();

  const roomId = await waitFor(() => seat.snapshot().rooms.find((r) => r.stream === stream)?.run ?? null);
  await waitFor(() => (framesOf(join(process.env.HOUSE_RUNS_DIR, roomId)).some((f) => f.type === "message") ? true : null));

  const frames = framesOf(join(process.env.HOUSE_RUNS_DIR, roomId));
  const recorded = frames.find((f) => f.type === "message" && f.text.includes("are you there"));
  assert.ok(recorded, "the mention IS recorded — observe_only records everything");
  assert.equal(recorded.to, undefined, "never an activation — observe_only never activates a being");

  // give the (non-existent) outbound path every chance to have fired.
  await new Promise((r) => setTimeout(r, 400));
  const calls = rowsOf(record).filter((r) => r.kind === "tools/call" || r.kind === "channels/typing");
  assert.deepEqual(calls, [], "no send_message/reply_message/typing/reaction — nothing of any kind goes out");

  assert.equal(seat.snapshot().observe_only, true, "GET /api/mcpl (routes.mjs's own handleMcplGet) surfaces this via snapshot()");
});

test("a NON-observe_only seat is unaffected: the same mention DOES answer", async () => {
  const stream = "discord:g1:not-observe-only";
  const fixture = join(process.env.HOUSE_PRIVATE_DIR, "live.fixture.json");
  const record = join(process.env.HOUSE_PRIVATE_DIR, "live.record.jsonl");
  writeFileSync(
    fixture,
    JSON.stringify({
      channels: [{ id: stream, type: "discord", label: "c", direction: "bidirectional" }],
      history: {},
      script: [{ after_ms: 30, incoming: msg("live-1", { channelId: stream, text: `@${BEING} ping` }) }],
    }),
  );
  const seat = createSeat({
    server: {
      name: "not-observe-only-1",
      platform: "discord",
      command: "node",
      args: [MOCK, fixture, record],
      env: [],
      being: BEING,
      rooms: [{ stream, title: "control e2e", beings: [BEING], public: true }],
      mock: true,
      observe_only: false,
    },
    log: () => {},
  });
  seatsToStop.push(seat);
  await seat.start();
  assert.equal(seat.snapshot().observe_only, false);
  const roomId = await waitFor(() => seat.snapshot().rooms.find((r) => r.stream === stream)?.run ?? null);
  const frames = await waitFor(() => {
    const fs = framesOf(join(process.env.HOUSE_RUNS_DIR, roomId));
    return fs.some((f) => f.type === "message" && f.to?.length) ? fs : null;
  });
  const recorded = frames.find((f) => f.type === "message" && f.text.includes("ping"));
  assert.deepEqual(recorded.to, [BEING], "an ordinary seat DOES activate — the gate is observe_only-specific");
});

/* ---------------------------------------------------------------------- */
/* routeIncoming, direct call (bce2d29): observe_only silences ONLY this  */
/* seat's own being — every other being present in the room keeps its own */
/* ordinary decision (test/dispatch-discord-matrix.test.mjs's own          */
/* directDeps/routeIncoming pure-call pattern, reused here).               */
/* ---------------------------------------------------------------------- */


const PR_A = "kestrel"; // this seat's own (silenced) being — pure call, no testament needed
const PR_B = "linden"; // the other being present — keeps its ordinary decision
const PR_STREAM = "discord:g2:pure-route";

function pureDeps() {
  return {
    server: {
      name: "pure-route",
      platform: "discord",
      being: PR_A,
      observe_only: true,
      rooms: [{ stream: PR_STREAM, title: "pure route", beings: [PR_A, PR_B], public: true }],
    },
    roomsOpen: () => null,
    identityFor: ({ id }) => ({ handle: id, known: true }),
    isBeing: (h) => h === PR_A || h === PR_B,
    covenants: () => ({
      posture: "present",
      dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 },
    }),
    roomKeyOf: (s) => s,
    awakeOf: () => true,
    isKeeper: () => false,
  };
}

function pureMsg(id, text) {
  return normalizeIncoming({
    channelId: PR_STREAM,
    messageId: id,
    author: { id: "alice", name: "alice" },
    content: [{ type: "text", text }],
    metadata: {},
  });
}

test("routeIncoming direct: a mention of the OTHER being present still activates it — observe_only silences only this seat's own being (bce2d29)", () => {
  const r = routeIncoming({ ...pureDeps(), msg: pureMsg("pr-1", `alice: @${PR_B} you there?`) });
  const input = r.find((a) => a.kind === "input");
  assert.equal(input.reasons[PR_A], "observe_only", "this seat's own being is always silenced");
  assert.equal(input.reasons[PR_B], "mention", "the OTHER being present keeps its ordinary decision");
  assert.deepEqual(input.targets, [PR_B], "the other being answers");
  assert.equal(input.observe, undefined, "someone activated — never observe-only for the room as a whole");
});

test("routeIncoming direct: a mention of THIS seat's own (silenced) being activates nobody — the other being's own honest, ordinary reason still shows", () => {
  const r = routeIncoming({ ...pureDeps(), msg: pureMsg("pr-2", `alice: @${PR_A} you there?`) });
  const input = r.find((a) => a.kind === "input");
  assert.equal(input.reasons[PR_A], "observe_only");
  assert.equal(input.reasons[PR_B], "none", "B was never addressed and random_reply is 0 — B's own honest, ordinary reason");
  assert.deepEqual(input.targets, [], "nobody activates — the mention named only the silenced seat");
  assert.equal(input.observe, true);
});

test("routeIncoming direct: an ambient message — this seat's own being never even rolls (excluded from the decision loop entirely), the other being's random-reply decision is the ordinary one (random_reply: 0, deterministic 'none')", () => {
  const r = routeIncoming({ ...pureDeps(), msg: pureMsg("pr-3", "alice: just chatting") });
  const input = r.find((a) => a.kind === "input");
  assert.equal(input.reasons[PR_A], "observe_only");
  assert.equal(input.reasons[PR_B], "none");
  assert.deepEqual(input.targets, []);
  assert.equal(input.observe, true);
});
