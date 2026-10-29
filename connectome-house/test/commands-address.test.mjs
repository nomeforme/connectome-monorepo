// @ts-check
/* connectome-house/test/commands-address.test.mjs — `!` commands addressed
 * by a leading mention, read off the sender's own words (never the
 * platform's author-prefixed prose), and applied once across the N seats
 * every being holds on a platform. Three layers: grammar.mjs's
 * splitLeadingAddress, route.mjs's command lane, room-tails.mjs's
 * applyCommandAction (one winner, one reply). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatClient } from "@connectome/seat-client";

const ROOT = mkdtempSync(join(tmpdir(), "commands-address-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });

const { writeTestament } = await import("./lib/fixtures.mjs");
const { waitFor, framesOf } = await import("./lib/serve-harness.mjs");
for (const b of ["ava-x", "bex-x", "cy-x"]) writeTestament(process.env.HOUSE_COVENANTS_DIR, b);

const { splitLeadingAddress, parseCommandLine } = await import("../src/commands/grammar.mjs");
const { handleCommand } = await import("../src/commands/index.mjs");
const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");
const { genericText } = await import("../src/mcpl/adapters.mjs");
const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { applyCommandAction } = await import("../src/mcpl/room-tails.mjs");
const { memoryGet } = await import("../src/commands/store.mjs");
const fork = await import("../src/commands/fork-replies.mjs");

// ---------- grammar: splitLeadingAddress ----------

const UUID = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";

test("splitLeadingAddress: id tokens of every platform shape", () => {
  assert.deepEqual(splitLeadingAddress(`<@${UUID}> !stop`), { address: [{ id: UUID }], rest: "!stop" });
  assert.deepEqual(splitLeadingAddress("<@123456789012345678> !mt 500"), { address: [{ id: "123456789012345678" }], rest: "!mt 500" });
  assert.deepEqual(splitLeadingAddress("<@!42> !rr"), { address: [{ id: "42" }], rest: "!rr" });
  assert.deepEqual(splitLeadingAddress("<@being:ava-x> !stop"), { address: [{ id: "being:ava-x" }], rest: "!stop" });
  assert.deepEqual(splitLeadingAddress("￼ !stop"), { address: [{ id: "￼" }], rest: "!stop" });
});

test("splitLeadingAddress: literal display names, longest known name first, NFKC + case-insensitive, homoglyphs whole", () => {
  const names = ["сlαυdе opus 4.6", "сlαυdе", "Ava X"];
  assert.deepEqual(splitLeadingAddress("@сlαυdе opus 4.6 !stop", { names }), { address: [{ name: "сlαυdе opus 4.6" }], rest: "!stop" });
  assert.deepEqual(splitLeadingAddress("@СLΑΥDЕ OPUS 4.6 !stop", { names }).rest, "!stop");
  assert.deepEqual(splitLeadingAddress("@ava x !mt 5", { names }), { address: [{ name: "ava x" }], rest: "!mt 5" });
  // fullwidth letters fold under NFKC
  assert.deepEqual(splitLeadingAddress("@Ａｖａ X !mt 5", { names }).rest, "!mt 5");
  // unknown name: one word
  assert.deepEqual(splitLeadingAddress("@someone !stop", { names }), { address: [{ name: "someone" }], rest: "!stop" });
  // a known name inside a longer word is not that name
  assert.deepEqual(splitLeadingAddress("@Ava Xavier !stop", { names }).address, [{ name: "Ava" }]);
});

test("splitLeadingAddress: several mentions, separators, a mention-only line, a dot line, plain text", () => {
  assert.deepEqual(splitLeadingAddress(`<@${UUID}>, @bex-x: !stop`, { names: ["bex-x"] }), {
    address: [{ id: UUID }, { name: "bex-x" }],
    rest: "!stop",
  });
  assert.deepEqual(splitLeadingAddress("@ava-x"), { address: [{ name: "ava-x" }], rest: "" });
  assert.equal(parseCommandLine(splitLeadingAddress("@ava-x").rest), null);
  assert.deepEqual(splitLeadingAddress(".!stop"), { address: [], rest: ".!stop" });
  assert.equal(parseCommandLine(".!stop"), null, "a dot line is never a command");
  assert.deepEqual(splitLeadingAddress("!rr 5"), { address: [], rest: "!rr 5" });
  assert.deepEqual(splitLeadingAddress("hello @ava-x !stop"), { address: [], rest: "hello @ava-x !stop" });
});

// ---------- handleCommand: scope rules ----------

const sctx = (o = {}) => ({ platform: /** @type {const} */ ("discord"), roomKey: "discord:addr-room", by: "mara", being: "ava-x", isKeeper: () => false, ...o });

test("handleCommand: being-scoped command runs once per target, replies joined", () => {
  const r = handleCommand("!stop", sctx({ targets: ["ava-x", "bex-x"], roomBeings: ["ava-x", "bex-x", "cy-x"] }));
  assert.deepEqual(r.intents, [
    { kind: "interrupt", scope: "being", being: "ava-x" },
    { kind: "interrupt", scope: "being", being: "bex-x" },
  ]);
  assert.equal(r.reply, `${fork.stop.ack("ava-x")}\n${fork.stop.ack("bex-x")}`);
  assert.deepEqual(r.intent, r.intents[0]);
});

test("handleCommand: bare !stop in a multi-being room targets every being in flight (being null); in a lone room, that being", () => {
  const multi = handleCommand("!stop", sctx({ targets: [], roomBeings: ["ava-x", "bex-x"] }));
  assert.deepEqual(multi.intents, [{ kind: "interrupt", scope: "being", being: null }]);
  const lone = handleCommand("!stop", sctx({ being: "cy-x", targets: [], roomBeings: ["bex-x"] }));
  assert.deepEqual(lone.intents, [{ kind: "interrupt", scope: "being", being: "bex-x" }]);
});

test("handleCommand: bare !mt in a multi-being room asks for a name; global !rr runs once", () => {
  const mt = handleCommand("!mt 500", sctx({ targets: [], roomBeings: ["ava-x", "bex-x"] }));
  assert.deepEqual(mt.intents, []);
  assert.match(mt.reply, /@being !mt 500/);
  const rr = handleCommand("!rr 4", sctx({ targets: ["ava-x", "bex-x"], roomBeings: ["ava-x", "bex-x"] }));
  assert.equal(rr.intents.length, 1);
});

test("handleCommand: !stop minutes are keeper-only, 0-120, carried as hushMinutes", () => {
  const scoped = { targets: ["ava-x"], roomBeings: ["ava-x"] };
  assert.match(handleCommand("!stop 10", sctx(scoped)).reply, /keeper-only/);
  assert.deepEqual(handleCommand("!stop 10", sctx(scoped)).intents, []);
  const k = handleCommand("!stop 10", sctx({ ...scoped, isKeeper: () => true }));
  assert.deepEqual(k.intents, [{ kind: "interrupt", scope: "being", being: "ava-x", hushMinutes: 10 }]);
  const z = handleCommand("!stop 0", sctx({ ...scoped, isKeeper: () => true }));
  assert.equal(z.intents[0].hushMinutes, 0);
  assert.match(handleCommand("!stop 500", sctx({ ...scoped, isKeeper: () => true })).reply, /0-120/);
});

// ---------- route: the command lane ----------

const GROUP = "signal:group:YWRkci1ncm91cA==";
const ids = { [UUID]: "ava-x", "uuid-bex": "bex-x", "uuid-mara": "mara", "111": "ava-x", "222": "bex-x" };
function deps(server, overrides = {}) {
  return {
    server,
    roomsOpen: () => ({ id: "r1", beings: ["ava-x", "bex-x", "cy-x"], live: true }),
    identityFor: ({ id }) => ({ handle: ids[id] ?? String(id), known: true }),
    isBeing: (h) => ["ava-x", "bex-x", "cy-x"].includes(h),
    covenants: () => ({ posture: "present", dispatch: { mention: true, reply: true, dm: true, random_reply: 0 } }),
    roomKeyOf: (s) => s,
    awakeOf: () => true,
    ...overrides,
  };
}
const signalServer = (being) => ({ name: `sig-${being}`, platform: "signal", being, rooms: [{ stream: GROUP, beings: ["ava-x", "bex-x", "cy-x"] }] });

/** what mcpl-signal pushes: the prose carries the author prefix and a
 * readable @name; rawContent carries the sender's own words with tokens */
function signalMsg({ prose, raw, mentions = [], replyTo = null, replyToAuthorId = null, author = "uuid-mara" }) {
  return normalizeIncoming({
    channelId: GROUP,
    messageId: `m-${Math.random()}`,
    author: { id: author, name: "Keeper" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: prose }],
    metadata: { rawContent: raw, mentions, replyTo, replyToAuthorId, isBot: false },
  });
}

test("route: a Signal mention + !stop parses off rawContent, not the author-prefixed prose", () => {
  const msg = signalMsg({ prose: "Keeper: @ava !stop", raw: `<@${UUID}> !stop`, mentions: [UUID] });
  const actions = routeIncoming({ ...deps(signalServer("ava-x")), msg });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "command");
  assert.deepEqual(actions[0].targets, ["ava-x"]);
  assert.deepEqual(actions[0].intents, [{ kind: "interrupt", scope: "being", being: "ava-x" }]);
});

test("route: a seat whose being isn't addressed ignores `@a !stop` — nothing admitted", () => {
  const msg = signalMsg({ prose: "Keeper: @ava !stop", raw: `<@${UUID}> !stop`, mentions: [UUID] });
  assert.deepEqual(routeIncoming({ ...deps(signalServer("bex-x")), msg }), [{ kind: "ignore", reason: "command-for-other" }]);
});

test("route: a quote-reply to a being makes that being the command's target", () => {
  const msg = signalMsg({ prose: "Keeper: !mt 300", raw: "!mt 300", replyTo: "171", replyToAuthorId: "uuid-bex" });
  const mine = routeIncoming({ ...deps(signalServer("bex-x")), msg });
  assert.equal(mine[0].kind, "command");
  assert.deepEqual(mine[0].targets, ["bex-x"]);
  assert.equal(mine[0].intents[0].being, "bex-x");
  assert.deepEqual(routeIncoming({ ...deps(signalServer("ava-x")), msg }), [{ kind: "ignore", reason: "command-for-other" }]);
});

test("route: a being's own `!stop` is ordinary speech, never a command", () => {
  const msg = signalMsg({ prose: "ava: !stop", raw: "!stop", author: UUID });
  const actions = routeIncoming({ ...deps(signalServer("bex-x")), msg });
  assert.ok(!actions.some((a) => a.kind === "command"));
  assert.ok(actions.some((a) => a.kind === "input"));
});

test("route: a literal @Display Name (homoglyphs) resolves through beingDisplays", () => {
  const msg = signalMsg({ prose: "Keeper: @сlαυdе x !stop", raw: "@сlαυdе x !stop" });
  const displays = () => ({ "cy-x": ["сlαυdе x"] });
  const r = routeIncoming({ ...deps(signalServer("cy-x")), msg, beingDisplays: displays });
  assert.deepEqual(r[0].targets, ["cy-x"]);
  assert.deepEqual(routeIncoming({ ...deps(signalServer("ava-x")), msg, beingDisplays: displays }), [
    { kind: "ignore", reason: "command-for-other" },
  ]);
});

test("route: Discord closed-channel prose (`[replying to …]` then `[#ch in G] Name:`) reads as the sender's words", () => {
  const prose = "[replying to @bex]\n[#general in Guild] Keeper: <@111> !stop";
  const msg = normalizeIncoming({
    channelId: "discord:9:8",
    messageId: "d-1",
    author: { id: "uuid-mara", name: "Keeper" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: prose }],
    metadata: {},
  });
  assert.equal(genericText(msg), "<@111> !stop");
  const server = { name: "dc-ava", platform: "discord", being: "ava-x", rooms: [{ stream: "discord:9:8", beings: ["ava-x", "bex-x"] }] };
  const r = routeIncoming({ ...deps(server), msg });
  assert.equal(r[0].kind, "command");
  assert.deepEqual(r[0].targets, ["ava-x"]);
});

// ---------- applyCommandAction across seats: one winner ----------

/** every seat's deps over the one shared room; `spoken` collects replies */
function seatDeps(being, roomId, spoken) {
  return {
    cfg: { platform: "signal", being },
    ensureLive: async () => roomId,
    roomInput,
    speak: async (_id, _stream, text, opts) => void spoken.push({ being, text, opts }),
    say: () => {},
    trackRoom: () => {},
    tails: new Map(),
  };
}

async function routeOnEverySeat(roomId, raw, mentions = []) {
  const msg = signalMsg({ prose: `Keeper: ${raw}`, raw, mentions });
  const beings = ["ava-x", "bex-x", "cy-x"];
  const roomsOpen = () => ({ id: roomId, beings, live: true });
  const spoken = [];
  for (const being of beings) {
    const actions = routeIncoming({ ...deps(signalServer(being), { roomsOpen }), msg });
    for (const a of actions)
      if (a.kind === "command") await applyCommandAction(seatDeps(being, roomId, spoken), a, { messageId: msg.messageId, text: raw });
  }
  return spoken;
}

async function openTrio(stream) {
  const { id, error } = await openRoom({ platform: "signal", stream, title: "addr", beings: ["ava-x", "bex-x", "cy-x"] });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  return id;
}

test("three seats, bare `!rr 5`: one record, one reply", async () => {
  const id = await openTrio("signal:group:cnItdHJpbw==");
  const spoken = await routeOnEverySeat(id, "!rr 5");
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, fork.rr.set(5));
  assert.equal(memoryGet(null, "dispatch.random_reply", 0), 5);
  const lines = framesOf(join(process.env.HOUSE_RUNS_DIR, id)).filter((f) => f.type === "message" && f.text === "!rr 5");
  assert.equal(lines.length, 1);
});

test("three seats, bare `!mt 500` in a multi-being room: refused with the naming hint, once", async () => {
  const id = await openTrio("signal:group:bXQtdHJpbw==");
  const spoken = await routeOnEverySeat(id, "!mt 500");
  assert.equal(spoken.length, 1);
  assert.match(spoken[0].text, /name one: @being !mt 500/);
});

test("three seats, `@a @b !stop`: both turns interrupted, one reply", async (t) => {
  const id = await openTrio("signal:group:c3RvcC10cmlv");
  const sockDir = mkdtempSync(join(tmpdir(), "commands-address-sock-"));
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: join(sockDir, "seat.sock") });
  for (const being of ["ava-x", "bex-x"]) {
    const client = new SeatClient({ path: join(sockDir, "seat.sock"), seatId: `${being}-stop`, being, room: id });
    await client.connect();
    t.after(() => client.close());
  }
  t.after(async () => server.close());
  await waitFor(() => (open.get(id)?.seats?.size === 2 ? true : null));
  await roomInput({ id, by: "mara", text: "@ava-x @bex-x hi", targets: ["ava-x", "bex-x"] });
  await waitFor(() => (open.get(id).turns.size === 2 ? true : null));

  const spoken = await routeOnEverySeat(id, `<@${UUID}> <@uuid-bex> !stop`, [UUID, "uuid-bex"]);
  assert.equal(spoken.length, 1, "one reply across every seat");
  assert.equal(spoken[0].text, `${fork.stop.ack("ava-x")}\n${fork.stop.ack("bex-x")}`);
  await waitFor(() => (open.get(id).turns.size === 0 ? true : null));
  const aborted = framesOf(join(process.env.HOUSE_RUNS_DIR, id)).filter((f) => f.type === "aborted");
  assert.equal(aborted.length, 2);
});

test("bare `!stop` in a multi-being room interrupts every being with a turn in flight", async (t) => {
  const id = await openTrio("signal:group:YmFyZS1zdG9w");
  const sockDir = mkdtempSync(join(tmpdir(), "commands-address-sock2-"));
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: join(sockDir, "seat.sock") });
  for (const being of ["ava-x", "cy-x"]) {
    const client = new SeatClient({ path: join(sockDir, "seat.sock"), seatId: `${being}-bare`, being, room: id });
    await client.connect();
    t.after(() => client.close());
  }
  t.after(async () => server.close());
  await waitFor(() => (open.get(id)?.seats?.size === 2 ? true : null));
  await roomInput({ id, by: "mara", text: "hi both", targets: ["ava-x", "cy-x"] });
  await waitFor(() => (open.get(id).turns.size === 2 ? true : null));
  const spoken = await routeOnEverySeat(id, "!stop");
  assert.equal(spoken.length, 1);
  await waitFor(() => (open.get(id).turns.size === 0 ? true : null));
});
