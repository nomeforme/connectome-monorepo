// @ts-check
/* connectome-house/test/reattach-gaps.test.mjs — harness-port
 * 28-reattach-gaps, 2026-09-20: four small, real gaps the W6 being-hosted
 * port left behind (docs/harness-port/28-reattach-gaps.md has the full
 * account). Each test below exercises the REAL fixed function, not a
 * re-description of the bug.
 *
 * A — seat.mjs's `learnSelfDisplay` gated on `cfg.being_id` alone, which is
 * permanently null for a `hosted_by: "being"` seat (its account id instead
 * rides `cfg.self_id`, room-tails.mjs's own `createSelfTracker`/
 * `christenBeing` fallback list). A self-authored message never seeded
 * `self-display.mjs`, so `rewriteSelfMention` (adapters.mjs) never had a
 * `displayName` to rewrite with — a literal `@<bot display name>` mention
 * was a permanent no-op. Exercised through the real `createSeat` -> mock
 * MCPL child -> route.mjs pipeline (test/dispatch-discord-matrix.test.mjs's
 * own established seam), a `self_id`-only config (no `being_id` at all).
 *
 * B — remote-host.mjs's `wireDetached` never cleared `st.open`/
 * `st.channels`. After a being container restarts (a fresh child, a fresh
 * `platform.hello`, the house itself never restarted) the stale `st.open`
 * made `openStandingRooms` skip every configured room for that seat
 * forever — live today, 10 of 21 Discord seats stuck with `open: []`.
 * Exercised directly against `createRemoteHost` (no socket, no MockBeing —
 * the smallest seam that actually drives `openStandingRooms`/
 * `wireDetached`).
 *
 * C — adapters.mjs's `genericText` stripped a leading `[replying to …]`
 * line and a `username: ` prefix, but not the pre-rendered
 * `[#channel in server] ` header the discord pin's own push/event prose
 * carries when `rawContent` is null — live frames today:
 * `[#general in <server>] user: @<display> hey`. A pure unit test on
 * `genericText` itself.
 *
 * D — room-tails.mjs's `christenBeing` had no success-path log line at
 * all — "did it run" was unanswerable from the log. A pure unit test on
 * `christenBeing` itself, a stub `identityFor`/`rechristen`/`say`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTestament } from "./lib/fixtures.mjs";
import { waitFor } from "./lib/serve-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");

// ---------------------------------------------------------------------
// A — learnSelfDisplay's gate (seat.mjs), through the real seat/host/route
// pipeline (dispatch-discord-matrix.test.mjs's own createSeat+mock seam).
// ---------------------------------------------------------------------

const RUNS = mkdtempSync(join(tmpdir(), "reattach-gaps-runs-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "reattach-gaps-private-"));
const ADDRESS = mkdtempSync(join(tmpdir(), "reattach-gaps-address-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
process.env.HOUSE_COVENANTS_DIR = ADDRESS;
process.env.HOUSE_RESIDENTS = "";
process.env.HOUSE_IDENTITY_SALT = "reattach-gaps-salt-0123456789";

const BEING = "reattach-a"; // this seat's own being — self_id only, no being_id
const GROUP = "discord:g1:c1";
// made-up ids/names only (pii-discipline) — never a real account's.
const SELF_ID = "self-id-9001";
const DISPLAY = "vallynn-clone";

writeTestament(ADDRESS, BEING, {
  speaksFor: "discord",
  frontmatter: ["posture: present", "dispatch:", "  random_reply: 0"],
});

/** a discord-shaped channels/incoming message, plain (no normalizeIncoming
 * needed — the mock server forwards it verbatim, host.mjs normalizes it). */
function rawMsg(id, { authorId, authorName, text }) {
  return {
    channelId: GROUP,
    messageId: id,
    author: { id: authorId, name: authorName },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text }],
    metadata: { mentions: [], rawContent: null, replyTo: null, replyToAuthorId: null, isBot: false },
  };
}

const FIXTURE = join(PRIVATE, "reattach.fixture.json");
const RECORD = join(PRIVATE, "reattach.record.jsonl");
writeFileSync(
  FIXTURE,
  JSON.stringify({
    channels: [{ id: GROUP, type: "discord", label: "#general", direction: "bidirectional" }],
    history: {},
    script: [
      // a self-authored message — author.id === cfg.self_id, the ONLY id
      // this seat carries (no being_id at all, the being-hosted shape).
      { after_ms: 10, incoming: rawMsg("self-1", { authorId: SELF_ID, authorName: DISPLAY, text: `${DISPLAY}: hello` }) },
      // a literal `@<display>` mention — no `<@id>` token at all, the shape
      // a platform's own cleanContent rendering leaves behind.
      { after_ms: 60, incoming: rawMsg("mention-1", { authorId: "alice", authorName: "alice", text: `alice: @${DISPLAY} hi` }) },
    ],
  }),
);

/** @type {any[]} */
const roomInputCalls = [];
const { createSeat } = await import("../src/mcpl/seat.mjs");
const { selfDisplayFor } = await import("../src/mcpl/self-display.mjs");
const seat = createSeat({
  server: {
    name: "reattach-pilot",
    platform: "discord",
    command: "node",
    args: [MOCK, FIXTURE, RECORD],
    env: [],
    being: BEING,
    self_id: SELF_ID, // W6-R5 shape: self_id only, being_id never set
    rooms: [{ stream: GROUP, title: "general", beings: [BEING], public: true }],
    mock: true,
  },
  log: () => {},
  openRoom: async () => ({ id: "room-reattach", state: "open" }),
  roomInput: async (args) => {
    roomInputCalls.push(args);
    return { ok: true };
  },
});
await seat.start();

after(async () => {
  seat.stop();
  rmSync(RUNS, { recursive: true, force: true });
  rmSync(PRIVATE, { recursive: true, force: true });
  rmSync(ADDRESS, { recursive: true, force: true });
});

const { createRemoteHost } = await import("../src/mcpl/remote-host.mjs");
const { genericText } = await import("../src/mcpl/adapters.mjs");
const { christenBeing } = await import("../src/mcpl/room-tails.mjs");

test("A — a self-authored message (author.id === cfg.self_id, no being_id set) seeds the platform display name — THE BUG: learnSelfDisplay's gate read being_id alone, permanently null for a being-hosted seat", async () => {
  await waitFor(() => (selfDisplayFor("discord", BEING) === DISPLAY ? true : null));
  assert.equal(selfDisplayFor("discord", BEING), DISPLAY);
});

test("A — a later literal `@<display> hi` (no <@id> token) resolves through the real seat -> route.mjs pipeline to the being's own handle and activates it", async () => {
  await waitFor(() => (roomInputCalls.some((c) => c.external?.message_id === "mention-1") ? true : null));
  const c = roomInputCalls.find((c) => c.external?.message_id === "mention-1");
  assert.ok(c, "the mention message reached roomInput");
  assert.deepEqual(c.targets, [BEING], "rewriteSelfMention resolved the literal @display to the being's own handle, which route.mjs then activated");
  assert.ok(c.text.includes(`@${BEING}`), "the recorded text names the being by its real handle");
  assert.equal(c.observe, undefined, "someone activated — never observe-only");
});

// ---------------------------------------------------------------------
// B — wireDetached (remote-host.mjs), driven directly (no socket/MockBeing
// needed — createRemoteHost's own `receive`/`wireDetached` are the exact
// seam the bug lives in).
// ---------------------------------------------------------------------


test("B — wireDetached clears st.open/st.channels: a fresh hello after a detach re-opens every configured room, not just the first one (THE BUG: a restarted being's container never got its rooms opened again, silently, forever)", async () => {
  const STREAM = "discord:g2:reattach-b";
  /** @type {any[]} */
  const sent = [];
  const host = createRemoteHost({
    server: { name: "s-reattach-b", platform: "discord", rooms: [{ stream: STREAM, title: null }] },
    onIncoming: async () => ({ accepted: true }),
    log: () => {},
  });
  const send = (m) => {
    sent.push(m);
    // answer platform.open at once, as a being's own child would.
    if (m.type === "platform.open")
      queueMicrotask(() =>
        host.receive(
          { type: "platform.result", server: "s-reattach-b", id: m.id, ok: true, result: { channel: { id: m.channelId } } },
          send,
        ),
      );
    return true;
  };
  const hello = {
    type: "platform.hello",
    server: "s-reattach-b",
    platform: "discord",
    being: "nix",
    tools: ["send_message"],
    channels: [{ id: STREAM, type: "discord", label: "g", direction: "bidirectional" }],
  };

  host.receive(hello, send);
  await waitFor(() => (host.state.open.has(STREAM) ? true : null));
  assert.equal(sent.filter((m) => m.type === "platform.open").length, 1, "opened once on the first hello");

  // the being's container restarts: its own seat detaches, then a fresh
  // hello lands (the house itself is never restarted — st.open is this
  // host's OWN memory, unrelated to whatever the new child actually knows).
  host.wireDetached();
  assert.equal(host.state.open.size, 0, "wireDetached clears st.open — the fix");
  assert.equal(host.state.channels.size, 0, "wireDetached clears st.channels too");

  host.receive(hello, send);
  await waitFor(() => (sent.filter((m) => m.type === "platform.open").length >= 2 ? true : null));
  // the second platform.open's own platform.result answer still resolves on
  // a later microtask than the count above — wait for the OPEN itself to
  // land in st.open, not just the outbound request to have been sent.
  await waitFor(() => (host.state.open.has(STREAM) ? true : null));
  assert.equal(sent.filter((m) => m.type === "platform.open").length, 2, "the next hello re-opens the room — before this fix, st.open still had it and openStandingRooms skipped it forever");
  assert.ok(host.state.open.has(STREAM), "re-opened and tracked again");
});

test("B — a mere reconnect of the same wire (no detach at all) still never double-opens: two hellos back to back on one attached connection", async () => {
  const STREAM = "discord:g2:reattach-b2";
  /** @type {any[]} */
  const sent = [];
  const host = createRemoteHost({
    server: { name: "s-reattach-b2", platform: "discord", rooms: [{ stream: STREAM, title: null }] },
    onIncoming: async () => ({ accepted: true }),
    log: () => {},
  });
  const send = (m) => {
    sent.push(m);
    if (m.type === "platform.open")
      queueMicrotask(() =>
        host.receive(
          { type: "platform.result", server: "s-reattach-b2", id: m.id, ok: true, result: { channel: { id: m.channelId } } },
          send,
        ),
      );
    return true;
  };
  const hello = {
    type: "platform.hello",
    server: "s-reattach-b2",
    platform: "discord",
    being: "nix",
    tools: ["send_message"],
    channels: [{ id: STREAM, type: "discord", label: "g", direction: "bidirectional" }],
  };
  host.receive(hello, send);
  await waitFor(() => (host.state.open.has(STREAM) ? true : null));
  host.receive(hello, send); // no wireDetached in between — the wire never dropped
  await new Promise((r) => setTimeout(r, 150)); // openStandingRooms's every chance to (wrongly) re-open
  assert.equal(sent.filter((m) => m.type === "platform.open").length, 1, "st.open survives an in-place hello repeat — only a real detach clears it");
});

// ---------------------------------------------------------------------
// C — genericText's third strip rule (adapters.mjs).
// ---------------------------------------------------------------------


test("C — genericText strips a pre-rendered `[#channel in server] user: ` header (the discord pin's own push/event prose when rawContent is null) before the author strip runs", () => {
  const msg = {
    rawContent: null,
    text: "[#general in some-server] alice: @vallynn hey",
    author: { name: "alice" },
  };
  assert.equal(genericText(msg), "@vallynn hey");
});

test("C — the header strip composes with the existing [replying to …] strip and the author strip, in either order the two could appear", () => {
  const withReply = {
    rawContent: null,
    text: "[replying to m1]\nalice: hi",
    author: { name: "alice" },
  };
  assert.equal(genericText(withReply), "hi");
  const plain = { rawContent: null, text: "alice: no header here", author: { name: "alice" } };
  assert.equal(genericText(plain), "no header here", "a message with no header at all is unaffected");
});

// ---------------------------------------------------------------------
// D — christenBeing's success-path log line (room-tails.mjs).
// ---------------------------------------------------------------------


test("D — christenBeing logs a success line naming @<being> and the platform:kind once an id actually needs a rechristen — THE BUG: no success-path log at all, 'did it run' was unanswerable", () => {
  /** @type {string[]} */
  const say = [];
  const cfg = { platform: "discord", being: "new-being", self_id: "acct-123" };
  let rechristened = null;
  christenBeing(
    cfg,
    () => ({ handle: "old-handle" }),
    (from, to) => {
      rechristened = [from, to];
    },
    (l) => say.push(l),
  );
  assert.deepEqual(rechristened, ["old-handle", "new-being"]);
  assert.ok(
    say.some((l) => l.includes("christened @new-being as discord:self_id")),
    `expected a success line naming discord:self_id, got: ${JSON.stringify(say)}`,
  );
  assert.ok(!say.some((l) => l.includes("acct-123")), "the full platform id never rides in the line");
});

test("D — no rechristen needed (identityFor already answers the being's own handle): no success line, no noise", () => {
  /** @type {string[]} */
  const say = [];
  const cfg = { platform: "discord", being: "same-being", self_id: "acct-999" };
  christenBeing(cfg, () => ({ handle: "same-being" }), () => {}, (l) => say.push(l));
  assert.equal(say.length, 0);
});
