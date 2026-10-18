// @ts-check
/* connectome-house/test/room-platform-tools.test.mjs — a being's platform
 * seat tools in a live room turn (room-platform-tools.mjs): offered only in
 * a room of the being's own seat, exactly that seat's allowed being tools
 * (never the seat's speech), executed on that seat's child with this room's
 * own channel and message ids — an id from another room refused, every
 * failure a plain result. Fake seats first (registered straight into
 * mcpl/being-tools.mjs's registry, the one routes.mjs fills at boot), then
 * end to end: a real mcpl-web child against mcpl-web's fake board, a turn
 * whose stub being calls `web_flag_post` over the real seat socket. Every
 * wait is on a condition; each test owns its own rooms and seats. */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SeatClient } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";
import { createFakeBoard, PRINCIPALS } from "../../mcpl-web/test/lib/fake-board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCPL_WEB_INDEX = join(HERE, "..", "..", "mcpl-web", "src", "index.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "room-platform-tools-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "room-platform-tools-salt-0123456789";
for (const d of [process.env.HOUSE_RUNS_DIR, process.env.HOUSE_PRIVATE_DIR, process.env.HOUSE_COVENANTS_DIR])
  mkdirSync(d, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });

const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { covenantExcerpt, beginTurn } = await import("../src/room-turn.mjs");
const { registerSeat, clearSeats } = await import("../src/mcpl/being-tools.mjs");
const { platformToolsFor } = await import("../src/room-platform-tools.mjs");

const cleanups = [];
afterEach(() => clearSeats());
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

/** a seat whose child is a recorder: every callTool lands in `calls`,
 * answered with `reply` (an MCP text result) or thrown when `fail` is set.
 * @param {{reply?: any, fail?: string}} [opts] */
function fakeSeat({ reply = { ok: true }, fail } = {}) {
  /** @type {{name: string, args: any}[]} */
  const calls = [];
  return {
    calls,
    host: {
      async callTool(name, args) {
        calls.push({ name, args });
        if (fail) throw new Error(fail);
        return { content: [{ type: "text", text: JSON.stringify(reply) }] };
      },
    },
    snapshot: () => ({ open: [], rooms: [] }),
  };
}

/** a platform room for `being` (testament written), returned as its open rec */
async function room(platform, stream, being) {
  writeTestament(process.env.HOUSE_COVENANTS_DIR ?? "", being);
  const { id, error } = await openRoom({ platform, stream, title: "fixture", beings: [being] });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  return open.get(id);
}

/** a human's message in `rec` carrying platform message id `mid` */
async function post(rec, mid, text, by = "mara") {
  const r = await roomInput({ id: rec.id, by, text, external: { platform: rec.cls.room.platform, message_id: mid }, targets: [] });
  assert.ok(r.ok, JSON.stringify(r));
}

const offered = (rec, being) => covenantExcerpt(rec.id, being);
const platformNames = (ex) => ex.tools.filter((t) => /^(web|discord|signal)_/.test(t));

test("a web-seat room offers web_add_reaction / web_remove_reaction / web_flag_post, with definitions; never send/reply", async () => {
  const being = "zz-web-a";
  const rec = await room("web", "web:commons:alpha", being);
  registerSeat(/** @type {any} */ ({ name: "web-a", platform: "web", being, rooms: [] }), fakeSeat());
  const ex = offered(rec, being);
  assert.deepEqual(platformNames(ex), ["web_add_reaction", "web_remove_reaction", "web_flag_post", "web_open_room", "web_close_room", "web_reopen_room"]);
  const defs = Object.fromEntries((ex.toolDefs ?? []).map((d) => [d.name, d]));
  assert.ok(defs.web_flag_post, "the definition rides with the turn");
  assert.equal("channelId" in defs.web_add_reaction.inputSchema.properties, false, "the room is implicit");
  assert.deepEqual(defs.web_add_reaction.inputSchema.required, ["emoji"]);
  assert.ok(!ex.tools.some((t) => /send_message|reply_message/.test(t)));
  for (const t of platformNames(ex)) assert.ok(!t.includes("__"), "never membrane's `:` codec");
});

test("a keeper's being_tools narrows the offer, and send_message / reply_message are stripped even when named", async () => {
  const being = "zz-web-b";
  const rec = await room("web", "web:commons:beta", being);
  registerSeat(/** @type {any} */ ({ name: "web-b", platform: "web", being, rooms: [], being_tools: ["flag_post", "send_message", "reply_message"] }), fakeSeat());
  assert.deepEqual(platformNames(offered(rec, being)), ["web_flag_post"]);
  const tools = platformToolsFor(rec, being);
  const r = await tools?.execute("web_send_message", { content: "hi" });
  assert.deepEqual(r, { ok: false, content: "web_send_message is not offered here" });
});

test("a Discord-seat room offers discord_add_reaction (the adapter's defaults); a Signal room what its adapter allows", async () => {
  const d = "zz-disc-a";
  const drec = await room("discord", "discord:111:222", d);
  registerSeat(/** @type {any} */ ({ name: "disc-a", platform: "discord", being: d, rooms: [] }), fakeSeat());
  const dn = platformNames(offered(drec, d));
  assert.ok(dn.includes("discord_add_reaction") && dn.includes("discord_remove_reaction"), dn.join(","));
  assert.ok(!dn.some((t) => /send_message|reply_message|send_dm/.test(t)));

  const s = "zz-sig-a";
  const srec = await room("signal", "signal:group:fixturegroup", s);
  registerSeat(/** @type {any} */ ({ name: "sig-a", platform: "signal", being: s, rooms: [] }), fakeSeat());
  assert.deepEqual(platformNames(offered(srec, s)), ["signal_list_groups", "signal_add_reaction"]);
});

test("no seat tools in any other room: another platform, another being's seat, or a being with no seat", async () => {
  const being = "zz-web-c";
  registerSeat(/** @type {any} */ ({ name: "web-c", platform: "web", being, rooms: [] }), fakeSeat());
  // the same being, in a Discord room it holds no Discord seat for
  const drec = await room("discord", "discord:333:444", being);
  assert.deepEqual(platformNames(offered(drec, being)), []);
  // a web room whose being has no seat at all
  const other = await room("web", "web:commons:gamma", "zz-web-noseat");
  assert.deepEqual(platformNames(offered(other, "zz-web-noseat")), []);
  assert.equal(platformToolsFor(other, "zz-web-noseat"), null);
});

test("execution: this room's channel and message ids reach the seat; another room's id is refused and never sent", async () => {
  const being = "zz-web-d";
  const seat = fakeSeat({ reply: { ok: true, post_id: "m-1", duplicate: false, flags: 1, threshold: 2, hidden: false, authorId: "human:x" } });
  registerSeat(/** @type {any} */ ({ name: "web-d", platform: "web", being, rooms: [] }), seat);
  const here = await room("web", "web:commons:delta", being);
  const there = await room("web", "web:commons:epsilon", "zz-web-d2");
  await post(here, "m-1", "an older post");
  await post(here, "m-2", "the newest post");
  await post(there, "m-x", "a post elsewhere");
  const tools = platformToolsFor(here, being);
  assert.ok(tools);

  const flagged = await tools.execute("web_flag_post", { post_id: "m-1", reason: "spam" });
  assert.equal(flagged.ok, true);
  assert.deepEqual(seat.calls.at(-1), { name: "flag_post", args: { post_id: "m-1", reason: "spam" } });
  assert.ok(!flagged.content.includes("authorId"), "the result is normalized");

  // omitted: the newest message someone else posted here; channel always the room's
  await tools.execute("web_add_reaction", { emoji: "👍" });
  assert.deepEqual(seat.calls.at(-1), { name: "add_reaction", args: { emoji: "👍", channelId: "web:commons:delta", messageId: "m-2" } });

  const n = seat.calls.length;
  const elsewhere = await tools.execute("web_add_reaction", { messageId: "m-x", emoji: "👍" });
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.content, /not a message in this room/);
  const otherChannel = await tools.execute("web_remove_reaction", { channelId: "web:commons:epsilon", messageId: "m-x", emoji: "👍" });
  assert.equal(otherChannel.ok, false);
  assert.equal(seat.calls.length, n, "nothing from another room ever reached the seat");
});

test("a seat that fails answers as a plain tool result, never a throw", async () => {
  const being = "zz-web-e";
  registerSeat(/** @type {any} */ ({ name: "web-e", platform: "web", being, rooms: [] }), fakeSeat({ fail: "web-e: no being is currently connected" }));
  const rec = await room("web", "web:commons:zeta", being);
  await post(rec, "z-1", "a post");
  const r = await platformToolsFor(rec, being)?.execute("web_flag_post", { quote: "a post" });
  assert.deepEqual(r, { ok: false, content: "not reachable right now: web-e: no being is currently connected" });
  const none = await platformToolsFor(await room("web", "web:commons:eta", being), being)?.execute("web_add_reaction", { emoji: "x" });
  assert.deepEqual(none, { ok: false, content: "web_add_reaction: no message in this room to act on" });
});

test("end to end: a turn's web_flag_post rides tool.exec to the real mcpl-web child and flags the post on the board", async () => {
  const BEING = "zz-web-e2e";
  const PRINCIPAL = { id: `being:${BEING}`, kind: "being", display: "Zed" };
  const TOKEN = "tok-zz-web-e2e-fixture";
  const STREAM = "web:commons:general";
  writeTestament(process.env.HOUSE_COVENANTS_DIR ?? "", BEING);
  const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
  const { createSeat } = await import("../src/mcpl/seat.mjs");

  const board = await createFakeBoard({ tokens: { [TOKEN]: PRINCIPAL }, flagThreshold: 5 });
  cleanups.push(() => board.close());
  const { id: roomId } = await openRoom({ platform: "web", stream: STREAM, title: "commons #General", beings: [BEING] });

  const sockDir = mkdtempSync(join(tmpdir(), "room-platform-tools-sock-"));
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen({ path: join(sockDir, "seat.sock") });
  cleanups.push(async () => seatServer.close());

  // the stub being: on its turn, check the offer, flag the post, then finish
  /** @type {{offered?: string[], result?: any}} */
  const seen = {};
  let target = "";
  const being = new SeatClient({ path: join(sockDir, "seat.sock"), seatId: "zz-web-e2e-stub", being: BEING, room: roomId });
  being.on("tool.result", (m) => {
    seen.result = m;
    being.send({ type: "turn.done", room: m.room, turnId: m.turnId ?? seen.turnId });
  });
  being.on("turn.begin", (tb) => {
    seen.offered = tb.covenant.tools;
    seen.turnId = tb.turnId;
    being.send({ type: "tool.exec", room: tb.room, turnId: tb.turnId, callId: "c-flag-1", tool: "web_flag_post", input: { post_id: target, reason: "spam" } });
  });
  await being.connect();
  cleanups.push(() => being.close());
  await waitFor(() => (open.get(roomId)?.seat ? true : null));

  process.env.WEB_BOARD_URL = board.url;
  process.env.WEB_BOARD_TOKEN = TOKEN;
  const server = {
    name: "web-e2e",
    platform: "web",
    command: process.execPath,
    args: [MCPL_WEB_INDEX],
    env: ["WEB_BOARD_URL", "WEB_BOARD_TOKEN"],
    being: BEING,
    rooms: [{ stream: STREAM, title: null, beings: [BEING], public: true }],
  };
  const seat = createSeat({ server: /** @type {any} */ (server), log: () => {} });
  cleanups.push(() => seat.stop());
  await seat.start();
  registerSeat(/** @type {any} */ (server), seat);
  await waitFor(() => (board.subscribedCount() === 1 && seat.host.state.open.has(STREAM) ? true : null));

  const runDir = join(process.env.HOUSE_RUNS_DIR ?? "", roomId);
  const spam = board.emitPost({ author: PRINCIPALS.bob, text: "FLAG-ME buy pills now" });
  await waitFor(() => framesOf(runDir).find((f) => f.type === "message" && String(f.text ?? "").includes("FLAG-ME")));
  target = spam.id;

  const rec = open.get(roomId);
  const done = beginTurn(rec, BEING);
  const outcome = await done;
  assert.equal(outcome.kind, "done");
  assert.ok(seen.offered?.includes("web_flag_post") && seen.offered.includes("web_add_reaction"), JSON.stringify(seen.offered));
  assert.ok(!seen.offered.some((t) => /send_message|reply_message/.test(t)));
  assert.equal(seen.result?.ok, true, JSON.stringify(seen.result));
  assert.ok(board.state.flags.get(spam.id)?.has(PRINCIPAL.id), "the board counted the being's flag");
  const reach = framesOf(runDir).find((f) => f.type === "reach.result" && f.callId === "c-flag-1");
  assert.equal(reach?.ok, true);
  // the result names the message it landed on, then the platform's own payload
  const [onLine, ...rest] = String(reach.inline).split("\n");
  assert.match(onLine, /^on @.*: "FLAG-ME buy pills now"$/);
  assert.equal(JSON.parse(rest.join("\n")).post_id, spam.id);
});

test("a flag must name its post: no newest-message fallback; quote resolves it, ambiguity refuses, and the result names the target", async () => {
  const being = "zz-web-q";
  const seat = fakeSeat({ reply: { ok: true, post_id: "q-1", duplicate: false, flags: 1, threshold: 1, hidden: true } });
  registerSeat(/** @type {any} */ ({ name: "web-q", platform: "web", being, rooms: [] }), seat);
  const rec = await room("web", "web:commons:theta", being);
  await post(rec, "q-1", "his number is 555 and he sleeps alone, visit him tonight");
  await post(rec, "q-2", "morning! what's new on here?");
  await post(rec, "q-3", "morning all");
  const tools = platformToolsFor(rec, being);
  assert.ok(tools);
  const n = seat.calls.length;

  const bare = await tools.execute("web_flag_post", { reason: "doxxing" });
  assert.equal(bare.ok, false);
  assert.match(bare.content, /name the post: pass quote/);
  const ambiguous = await tools.execute("web_flag_post", { quote: "MORNING", reason: "x" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.content, /matches 2 messages[\s\S]*Nothing was done/);
  const missing = await tools.execute("web_flag_post", { quote: "not in the room" });
  assert.equal(missing.ok, false);
  assert.equal(seat.calls.length, n, "no refused flag ever reached the seat");

  const ok = await tools.execute("web_flag_post", { quote: "sleeps   alone", reason: "doxxing" });
  assert.equal(ok.ok, true);
  assert.deepEqual(seat.calls.at(-1), { name: "flag_post", args: { post_id: "q-1", reason: "doxxing" } });
  assert.match(ok.content, /^on @.*: "his number is 555 and he sleeps alone, visit him tonight"\n/);

  // a reaction may still fall back to the newest message, or use a quote (newest match)
  await tools.execute("web_add_reaction", { emoji: "👍" });
  assert.equal(seat.calls.at(-1).args.messageId, "q-3");
  await tools.execute("web_add_reaction", { emoji: "👍", quote: "morning" });
  assert.equal(seat.calls.at(-1).args.messageId, "q-3");
  await tools.execute("web_add_reaction", { emoji: "👍", quote: "what's new" });
  assert.equal(seat.calls.at(-1).args.messageId, "q-2");
});

test("rooms: open_room carries the title (a public title is guarded), close_room closes THIS room, reopen_room names one; results are picked", async () => {
  const being = "zz-web-rooms";
  const rec = await room("web", "web:commons:rooms-here", being);
  const seat = fakeSeat({ reply: { ok: true, room: { id: "web:commons:tea", title: "Tea", archived: false }, created_by: "being:x" } });
  registerSeat(/** @type {any} */ ({ name: "web-r", platform: "web", being, rooms: [], audience: "external" }), seat);
  const ex = offered(rec, being);
  const defs = Object.fromEntries((ex.toolDefs ?? []).map((d) => [d.name, d]));
  assert.deepEqual(defs.web_close_room.inputSchema.properties, {}, "the room to close is this one");
  assert.ok(defs.web_close_room.description.endsWith("(In this room only.)"));
  assert.ok(!defs.web_open_room.description.includes("In this room only"));
  const tools = /** @type {any} */ (platformToolsFor(rec, being));
  const opened = await tools.execute("web_open_room", { title: "Tea" });
  assert.equal(opened.ok, true);
  assert.deepEqual(JSON.parse(opened.content), { room: { id: "web:commons:tea", title: "Tea", archived: false } });
  assert.deepEqual(seat.calls.at(-1), { name: "open_room", args: { title: "Tea" } });
  await tools.execute("web_close_room", {});
  assert.deepEqual(seat.calls.at(-1), { name: "close_room", args: { channelId: "web:commons:rooms-here" } });
  const other = await tools.execute("web_close_room", { channelId: "web:commons:elsewhere" });
  assert.equal(other.ok, false, "another room is never closed from here");
  await tools.execute("web_reopen_room", { room: "web:commons:tea" });
  assert.deepEqual(seat.calls.at(-1), { name: "reopen_room", args: { room: "web:commons:tea" } });
  const n = seat.calls.length;
  const leak = await tools.execute("web_open_room", { title: "call +15555550123" });
  assert.equal(leak.ok, false);
  assert.match(leak.content, /phone/);
  assert.equal(seat.calls.length, n, "a guarded title is never sent");
});
