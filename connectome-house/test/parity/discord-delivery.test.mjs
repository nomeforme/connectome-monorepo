// @ts-check
/* harness-port P-C, 2026-09-17 — connectome-house/test/parity/discord-
 * delivery.test.mjs — the conformance harness the mission asked for: a
 * recorded-exchange fixture replayed through the REAL house (createSeat,
 * src/mcpl/seat.mjs — a read-only import, not an edit; this task owns
 * speak.mjs/outbound.mjs/discord.mjs, which is what's actually under
 * test here) against the house's own REAL mock MCPL server
 * (test/lib/mock-mcpl-server.mjs), asserting the outbound tools/call
 * rows the mock server records — text, reply target, chunking, and
 * attachment shape — against the fork's own expected Discord behaviour,
 * row by row (docs/harness-port/02-user-contract.md §9's "L1 — replay
 * against mock MCPL servers"; docs/harness-port/PARITY-discord.md is the
 * scoreboard this file's rows back).
 *
 * The fixture's own tools/list DECLARES `reply_message` (the real
 * discord-mcpl server does expose it) — the point of case 1 is proving
 * the house never calls it for Discord regardless, matching
 * adapters.mjs's `discordAdapter.replyThreading: false` (this task,
 * folding in the coordinator's relayed finding). */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendFrames, writeClass, writeFrames, writeTestament } from "../lib/fixtures.mjs";
import { waitFor } from "../lib/serve-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "..", "lib", "mock-mcpl-server.mjs");

const RUNS = mkdtempSync(join(tmpdir(), "house-parity-discord-runs-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "house-parity-discord-private-"));
const ADDRESS = mkdtempSync(join(tmpdir(), "house-parity-discord-address-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
process.env.HOUSE_COVENANTS_DIR = ADDRESS;
process.env.HOUSE_RESIDENTS = "";
process.env.HOUSE_IDENTITY_SALT = "parity-discord-salt-0123456789";

const BEING = "zz-parity-discord";
const STREAM = "discord:g1:c1";
const ROOM_ID = "room-parity-discord-fixture";
writeTestament(ADDRESS, BEING, { frontmatter: ["posture: present"] });

const runDir = join(RUNS, ROOM_ID);
writeClass(runDir, { room: { platform: "discord", stream: STREAM }, beings: [BEING] });
writeFrames(runDir, []);

const FIXTURE = join(PRIVATE, "discord.fixture.json");
const RECORD = join(PRIVATE, "discord.record.jsonl");
// `reply_message` IS declared — the mock platform genuinely offers it,
// exactly like the real discord-mcpl server does. Case 1 below proves
// the house doesn't reach for it anyway, for Discord.
const TOOLS = [
  {
    name: "send_message",
    inputSchema: { type: "object", properties: { channelId: { type: "string" }, content: { type: "string" }, files: { type: "array" } }, required: ["channelId"] },
  },
  {
    name: "reply_message",
    inputSchema: { type: "object", properties: { channelId: { type: "string" }, messageId: { type: "string" }, content: { type: "string" } }, required: ["channelId", "messageId"] },
  },
];
// one real inbound message, addressed to BEING by its own literal handle
// (dispatch.mjs's mentionsIn scans for exactly this — no identity-map
// pre-registration needed) — this is what actually seeds seat.mjs's own
// pendingReply queue (createReplyQueue, outbound.mjs) via the REAL
// createHost → routeIncoming → roomInput pipeline. Writing a "message"
// frame straight to frames.jsonl does NOT do this (seat.mjs's onFrame
// "message" branch relays OUTWARD; it never touches pendingReply) — this
// script step exists so case 1 below tests the real gate, not a replyTo
// that was null anyway.
writeFileSync(
  FIXTURE,
  JSON.stringify({
    channels: [{ id: STREAM, type: "discord", label: "#general", direction: "bidirectional" }],
    tools: TOOLS,
    script: [
      {
        after_ms: 50,
        incoming: {
          channelId: STREAM,
          messageId: "platform-msg-1",
          author: { id: "user-alice", name: "alice" },
          timestamp: new Date().toISOString(),
          content: [{ type: "text", text: "@zz-parity-discord hello" }],
          metadata: { isBot: false },
        },
      },
    ],
  }),
);

const { createSeat } = await import("../../src/mcpl/seat.mjs");

/** @type {any[]} */
const roomInputCalls = [];
const seat = createSeat({
  server: {
    name: "parity-discord",
    platform: "discord",
    command: "node",
    args: [MOCK, FIXTURE, RECORD],
    env: [],
    being: BEING,
    being_id: "bot-parity-0001",
    rooms: [{ stream: STREAM, title: "#general", beings: [BEING], public: true }],
    mock: true,
  },
  log: () => {},
  openRoom: async () => ({ id: ROOM_ID, state: "open" }),
  roomInput: async (args) => {
    roomInputCalls.push(args);
    return { ok: true };
  },
});

before(async () => {
  await seat.start();
  // let the mock server finish its channels/register handshake before any
  // frame is appended — mirrors mcpl-sweep.test.mjs's own settling wait.
  await new Promise((r) => setTimeout(r, 300));
});
after(async () => {
  seat.stop();
  for (const d of [RUNS, PRIVATE, ADDRESS]) rmSync(d, { recursive: true, force: true });
});

/** the mock server's own record.jsonl — every tools/call row it saw */
const recordRows = () =>
  readFileSync(RECORD, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const sendCalls = () => recordRows().filter((r) => r.kind === "tools/call" && r.name === "send_message");
const replyCalls = () => recordRows().filter((r) => r.kind === "tools/call" && r.name === "reply_message");

let seq = 1;

test("O16 — a plain final speech with a REAL pending reply target is sent PLAIN, never as reply_message (Discord's fork: bare channel.send, always)", async () => {
  // the fixture's own script (above) already fired the incoming message
  // by now (after_ms: 50) — wait for the real routeIncoming pipeline to
  // have recorded it (proving `targets` named BEING and pendingReply was
  // actually pushed a real platform message id, not a null we'd pass
  // trivially).
  await waitFor(() =>
    roomInputCalls.find((c) => c.external?.message_id === "platform-msg-1" && c.targets?.includes(BEING)),
  );
  appendFrames(runDir, [
    { seq: seq++, t: new Date().toISOString(), type: "speech", by: BEING, inline: "hi alice" },
  ]);
  const calls = await waitFor(() => {
    const s = sendCalls();
    return s.length > 0 ? s : null;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.content, "hi alice");
  assert.equal(calls[0].arguments.channelId, STREAM);
  assert.equal(replyCalls().length, 0, "reply_message must NEVER be called for discord — matches the fork exactly, even with a real pending reply target and the tool available");
});

test("O13 — a long speech splits at 1900 (discord.mjs's LIMIT), fork-identical chunk boundaries; every chunk its own send_message", async () => {
  const before_ = sendCalls().length;
  const para = "word ".repeat(500).trim(); // ~2500 chars, no newlines — forces a space-boundary cut
  appendFrames(runDir, [
    { seq: seq++, t: new Date().toISOString(), type: "speech", by: BEING, inline: para },
  ]);
  const calls = await waitFor(() => {
    const s = sendCalls().slice(before_);
    return s.length >= 2 ? s : null;
  });
  for (const c of calls) assert.ok(c.arguments.content.length <= 1900, `chunk over 1900: ${c.arguments.content.length}`);
  assert.equal(
    calls.map((c) => c.arguments.content).join(" ").replace(/\s+/g, " "),
    para.replace(/\s+/g, " "),
    "chunks rejoin to the original words, in order — nothing dropped or reordered",
  );
});

test("O27 — an attachment (media.attached) is delivered as a real send_message file, never inlined as base64 text", async () => {
  process.env.HOUSE_BLOB_ROOT = mkdtempSync(join(tmpdir(), "house-parity-discord-blobs-"));
  const { putBlob, addRef } = await import("../../src/blob-root.mjs");
  const { sha } = putBlob(Buffer.from("fake-png-bytes"), { mime: "image/png", ext: ".png" });
  addRef(sha, { run: ROOM_ID, seq: 1 });
  const before_ = sendCalls().length;
  appendFrames(runDir, [
    {
      seq: seq++,
      t: new Date().toISOString(),
      type: "media.attached",
      by: BEING,
      kind: "image",
      sha,
      path: `blob/${sha}`,
      filename: "photo.png",
      requested_by: "model",
    },
  ]);
  const calls = await waitFor(() => {
    const s = sendCalls().slice(before_);
    return s.length > 0 ? s : null;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments.files, [{ path: calls[0].arguments.files[0].path, name: "photo.png" }]);
  assert.ok(calls[0].arguments.files[0].path.endsWith(`${sha}.png`));
});
