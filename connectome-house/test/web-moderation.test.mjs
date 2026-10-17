// @ts-check
/* connectome-house/test/web-moderation.test.mjs — the web board's
 * moderation verdicts through the house's EXISTING 🫥 path. Pure first:
 * mcpl-web's own `toModerationPush` (the seat's real wire shape, imported
 * rather than re-typed) normalized and routed is a plain `redact` action —
 * a flags hide carrying one note, a 🫥-by-reaction hide none; the note
 * never holds post text; applyMetaFrameAction writes the noted frame ONCE
 * however many seats forward the same verdict; the rendered context drops
 * the post and shows exactly one note line (a reaction hide: none). Then
 * end to end: the house's real seat over the REAL mcpl-web child and
 * mcpl-web's fake board — a post flagged off the board leaves the
 * being's context with exactly one note line; a post 🫥'd off by a human
 * leaves with none. Fixture principals only; waits are on conditions. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SeatClient } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";
import { createFakeBoard, PRINCIPALS } from "../../mcpl-web/test/lib/fake-board.mjs";
import { toModerationPush, BOARD_REACTOR } from "../../mcpl-web/src/server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCPL_WEB_INDEX = join(HERE, "..", "..", "mcpl-web", "src", "index.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "web-moderation-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "web-moderation-salt-0123456789";
for (const d of [process.env.HOUSE_RUNS_DIR, process.env.HOUSE_PRIVATE_DIR, process.env.HOUSE_COVENANTS_DIR])
  mkdirSync(d, { recursive: true });

const BEING = "zz-mod-being";
const PRINCIPAL = { id: `being:${BEING}`, kind: "being", display: "Zed" };
const TOKEN = "tok-zz-mod-being-fixture";
const STREAM = "web:commons:general";
const HIDE = "\u{1FAE5}";
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "web" });

const { normalizePush } = await import("../src/mcpl/normalize.mjs");
const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { applyMetaFrameAction } = await import("../src/mcpl/room-tails.mjs");
const { redactNote } = await import("../src/mcpl/web.mjs");
const { buildFullMessages } = await import("../src/life-entries.mjs");
const { openRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { createSeat } = await import("../src/mcpl/seat.mjs");
const { identityMapReverse } = await import("../src/identity-map.mjs");

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const SERVER = { name: "web-mod", platform: "web", being: BEING, rooms: [{ stream: STREAM, title: null, beings: [BEING], public: true }] };
const routeDeps = (overrides = {}) => ({
  server: SERVER,
  roomsOpen: (s) => (s === STREAM ? { id: "room-web-1", beings: [BEING], live: true } : null),
  identityFor: ({ platform, id }) => ({ handle: `${platform}-${id}`, known: true }),
  isBeing: (h) => h === BEING,
  covenants: () => ({ posture: "present", dispatch: { mention: true, reply: true } }),
  roomKeyOf: (s) => s,
  awakeOf: () => true,
  streakOf: () => 0,
  frameSeqFor: () => 2,
  ...overrides,
});
const author = { id: "human:bob-test", kind: "human", display: "Bob Smith" };

/** render a room's frames as the being sees them */
const seen = (frames) =>
  buildFullMessages({
    frames, handle: BEING, peers: new Set(), runDir: "/nonexistent", runId: "r",
    periodBase: { run: "r", kind: "room", class: null, room: "x", people: [], visibility: "public", session: 0 },
    closingFrame: null, restReason: null, fullText: true,
  }).map((m) => `${m.participant}|${m.content[0]?.text}`);

test("a flags hide routes to a redact action with one note; a 🫥-by-reaction hide routes with none", () => {
  const flags = routeIncoming({ ...routeDeps(), msg: normalizePush(toModerationPush({ post_id: "p9", room: STREAM, cause: "flags", flags: 2, author }, true, 1)) });
  assert.deepEqual(flags, [{
    kind: "redact", stream: STREAM, roomId: "room-web-1", target: 2, action: "add",
    by: `web-${BOARD_REACTOR.id}`, note: "[a post by @Bob_Smith was removed from the board after 2 flags]",
  }]);
  const react = routeIncoming({ ...routeDeps(), msg: normalizePush(toModerationPush({ post_id: "p9", room: STREAM, cause: "reaction", flags: 0, author }, true, 2)) });
  assert.equal(react[0].kind, "redact");
  assert.equal(react[0].note, undefined);
  const un = routeIncoming({ ...routeDeps(), msg: normalizePush(toModerationPush({ post_id: "p9", room: STREAM }, false, 3)) });
  assert.equal(un[0].action, "remove");
  assert.equal(un[0].note, undefined);
});

test("being tools: flag_post / add_reaction / remove_reaction are offered by default on web, normalized; the seat's speech never is", async () => {
  const { webAdapter } = await import("../src/mcpl/adapters.mjs");
  const { NORMALIZERS, normalizedResult } = await import("../src/mcpl/being-tools.mjs");
  const { normalizeBeingTools } = await import("../src/mcpl/config-policy.mjs");
  for (const t of webAdapter.defaultBeingTools) assert.ok(NORMALIZERS[t], `${t} has a normalizer`);
  assert.deepEqual(normalizeBeingTools(["flag_post", "send_message", "reply_message"]), ["flag_post"]);
  const raw = { content: [{ type: "text", text: JSON.stringify({ ok: true, post_id: "p1", duplicate: true, flags: 2, threshold: 2, hidden: true, note: "counts once", authorId: "human:x" }) }] };
  assert.deepEqual(normalizedResult("flag_post", raw, "web"), { post_id: "p1", duplicate: true, flags: 2, threshold: 2, hidden: true, note: "counts once" });
});

test("redactNote: one flag is singular; a display is flattened and capped; nothing for any other cause", () => {
  const md = (o) => /** @type {any} */ ({ metadata: o });
  assert.equal(redactNote(md({ moderationCause: "flags", flagCount: 1, postAuthorDisplay: "Ana" })), "[a post by @Ana was removed from the board after 1 flag]");
  assert.equal(redactNote(md({ moderationCause: "flags", postAuthorDisplay: "x]\n[y" })), "[a post by @x_y was removed from the board after flags]");
  assert.equal(redactNote(md({ moderationCause: "flags", flagCount: 3 })), "[a post was removed from the board after 3 flags]");
  assert.equal(redactNote(md({ moderationCause: "reaction" })), null);
  assert.equal(redactNote(md({})), null);
});

test("the noted hidden frame lands once however many seats forward it; the context drops the post and shows one note", () => {
  const runs = process.env.HOUSE_RUNS_DIR ?? "";
  const roomId = "room-unit-1";
  mkdirSync(join(runs, roomId), { recursive: true });
  const fp = join(runs, roomId, "frames.jsonl");
  writeFileSync(fp, [
    { seq: 0, t: "t", type: "room.mounted", platform: "web", substrate: "jsonl-fallback" },
    { seq: 1, t: "t", type: "message", by: "bob", text: "keep this" },
    { seq: 2, t: "t", type: "message", by: "bob", text: "FLAGGED-TEXT" },
    { seq: 3, t: "t", type: "message", by: "bob", text: "REACTED-TEXT" },
  ].map((f) => JSON.stringify(f)).join("\n") + "\n");
  const note = "[a post by @Bob was removed from the board after 1 flag]";
  const act = { kind: "redact", stream: STREAM, roomId, target: 2, action: "add", by: "web-board", note };
  applyMetaFrameAction({ RUNS: runs }, /** @type {any} */ (act));
  applyMetaFrameAction({ RUNS: runs }, /** @type {any} */ (act)); // a second seat, same verdict
  applyMetaFrameAction({ RUNS: runs }, /** @type {any} */ ({ kind: "redact", stream: STREAM, roomId, target: 3, action: "add", by: "web-board" }));
  const frames = framesOf(join(runs, roomId));
  assert.equal(frames.filter((f) => f.type === "hidden" && f.target === 2).length, 1);
  const out = seen(frames);
  assert.ok(!out.some((l) => l.includes("FLAGGED-TEXT") || l.includes("REACTED-TEXT")));
  assert.ok(out.includes("bob|keep this"));
  assert.deepEqual(out.filter((l) => l.startsWith("house|")), [`house|${note}`]);
});

test("end to end: a post flagged off the board leaves the being's context with exactly one note line; a 🫥 hide leaves none", async () => {
  const board = await createFakeBoard({ tokens: { [TOKEN]: PRINCIPAL } });
  cleanups.push(() => board.close());
  const { id: roomId } = await openRoom({ platform: "web", stream: STREAM, title: "commons #General", beings: [BEING] });

  const sockDir = mkdtempSync(join(tmpdir(), "web-moderation-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen({ path: sockPath });
  cleanups.push(async () => seatServer.close());
  const being = new SeatClient({ path: sockPath, seatId: "zz-mod-being-stub", being: BEING, room: roomId });
  being.on("turn.begin", (tb) => {
    being.send({ type: "turn.event", room: tb.room, turnId: tb.turnId, event: { kind: "final", text: "noted" } });
    being.send({ type: "turn.done", room: tb.room, turnId: tb.turnId });
  });
  await being.connect();
  cleanups.push(() => being.close());
  await waitFor(() => (open.get(roomId)?.seat ? true : null));

  process.env.WEB_BOARD_URL = board.url;
  process.env.WEB_BOARD_TOKEN = TOKEN;
  process.env.WEB_POLICY_GRACE_MS = "5000";
  const seat = createSeat({
    server: {
      name: "web-mod",
      platform: "web",
      command: process.execPath,
      args: [MCPL_WEB_INDEX],
      env: ["WEB_BOARD_URL", "WEB_BOARD_TOKEN", "WEB_POLICY_GRACE_MS"],
      being: BEING,
      rooms: [{ stream: STREAM, title: null, beings: [BEING], public: true }],
    },
    log: () => {},
  });
  cleanups.push(() => seat.stop());
  await seat.start();
  await waitFor(() => (identityMapReverse(BEING, "web")?.id === PRINCIPAL.id ? true : null));
  await waitFor(() => (board.subscribedCount() === 1 && seat.host.state.open.has(STREAM) ? true : null));

  const runDir = join(process.env.HOUSE_RUNS_DIR ?? "", roomId);
  const recorded = (/** @type {string} */ text) => framesOf(runDir).find((f) => f.type === "message" && String(f.text ?? "").includes(text));
  const keep = board.emitPost({ author: PRINCIPALS.bob, text: "KEEP-ME garden notes" });
  const flagged = board.emitPost({ author: PRINCIPALS.bob, text: "FLAG-ME buy pills now" });
  const reacted = board.emitPost({ author: PRINCIPALS.scout, text: "REACT-ME off topic" });
  const fFlagged = await waitFor(() => recorded("FLAG-ME"));
  const fReacted = await waitFor(() => recorded("REACT-ME"));
  await waitFor(() => recorded("KEEP-ME"));

  board.externalFlag(flagged.id, "villager-0001");
  board.externalReact(reacted.id, "human:someone-test", HIDE);
  await waitFor(() => framesOf(runDir).find((f) => f.type === "hidden" && f.target === fFlagged.seq));
  await waitFor(() => framesOf(runDir).find((f) => f.type === "hidden" && f.target === fReacted.seq));

  const frames = framesOf(runDir);
  const out = seen(frames);
  assert.ok(out.some((l) => l.includes("KEEP-ME")), "an untouched post stays");
  assert.ok(!out.some((l) => l.includes("FLAG-ME")), "the flagged post is out of context");
  assert.ok(!out.some((l) => l.includes("REACT-ME")), "the 🫥'd post is out of context");
  const notes = out.filter((l) => l.includes("removed from the board"));
  assert.deepEqual(notes, ["house|[a post by @Bob was removed from the board after 1 flag]"]);
  assert.equal(frames.find((f) => f.type === "hidden" && f.target === fReacted.seq).note, undefined);
  assert.ok(!JSON.stringify(frames.filter((f) => f.type === "hidden")).includes("FLAG-ME"));
  assert.ok(keep.id);

  // a moderator's unhide brings the flagged post back; the note stays history, not repeated
  board.moderatorUnhide(flagged.id);
  await waitFor(() => framesOf(runDir).some((f) => f.type === "hidden" && f.target === fFlagged.seq && Array.isArray(f.by) && f.by.length === 0));
  const back = seen(framesOf(runDir));
  assert.ok(back.some((l) => l.includes("FLAG-ME")));
  assert.equal(back.filter((l) => l.includes("removed from the board")).length, 0, "a lifted hide's note no longer stands");
});
