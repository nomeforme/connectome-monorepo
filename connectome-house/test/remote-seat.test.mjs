// @ts-check
/* connectome-house/test/remote-seat.test.mjs — harness-port W6-A,
 * 2026-09-19: a `hosted_by: "being"` server end to end, through the REAL
 * production entrypoint (`mcpl/routes.mjs`'s `bootSeats`) — no child
 * spawned, a FAKE being (`@connectome/seat-client`'s `MockBeing`, this
 * package's own established pattern — observe-only-two-seats.test.mjs)
 * over the ONE socket connection it already holds for its own turns,
 * doubling as this server's remote host's wire (this task's own mission:
 * "sends from the house to the being go over the same connection the
 * turn messages use"). In-process rather than a spawned `serve.mjs`
 * child (test/lib/serve-harness.mjs) — the same real `bootSeats`/
 * `createHouseSeatServer` entrypoints either way, chosen for this task's
 * own time budget; a spawned-process e2e is a straightforward follow-up,
 * not a gap in what this proves.
 *
 * Proves: `platform.hello` attaches the remote host (no command, no
 * child); the configured room auto-opens (`platform.open`, answered by
 * `platform.result`); a mention normalizes and turns for real
 * (MockBeing's own scripted `turn.event`/`turn.done`); the reply rides
 * `platform.call send_message`, answered by `platform.result`, recorded
 * in `external.jsonl`; typing rides `platform.notify` on and off; and a
 * simulated reconnect (`platform.hello` again, fresh connection) resumes
 * — `connected()` comes back true, and NO duplicate `platform.open` is
 * sent for a channel `st.open` already has (this task's own mission:
 * "no re-open of rooms already open — st.open stays"), the house's own
 * room staying the exact same id throughout. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBeing } from "@connectome/seat-client";
import { PLATFORM_ROOM } from "@connectome/seat-protocol";

const ROOT = mkdtempSync(join(tmpdir(), "remote-seat-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "remote-seat-test-salt-0123456789";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });

const { writeTestament } = await import("./lib/fixtures.mjs");
const { waitFor } = await import("./lib/serve-harness.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { remoteHostFor } = await import("../src/open-rooms.mjs");
const { bootSeats, stopSeats, seats } = await import("../src/mcpl/routes.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");
const { openRoom } = await import("../src/serve-rooms.mjs");

const BEING = "nix";
const SERVER_NAME = "remote-d1";
const STREAM = "discord:g1:remote";
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "discord" });

process.env.HOUSE_SANDBOX = "1";
process.env.HOUSE_MCPL_SERVERS = join(process.env.HOUSE_PRIVATE_DIR, "servers.json");
writeFileSync(
  process.env.HOUSE_MCPL_SERVERS,
  JSON.stringify({
    servers: [
      {
        name: SERVER_NAME,
        platform: "discord",
        being: BEING,
        hosted_by: "being",
        rooms: [{ stream: STREAM, title: "remote seat e2e", beings: [BEING], public: true }],
      },
    ],
  }),
);

/** discord-shaped incoming message (observe-only.test.mjs's own `msg()`). */
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

function rowsOf(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** wire a MockBeing's own client to also answer the platform.* side —
 * `opens`/`calls`/`notifies` are shared arrays across every connection
 * this test makes, so a reconnect's own (lack of) traffic is visible on
 * the same tally. */
function wirePlatformAnswers(being, { opens, calls, notifies }) {
  being.client.on("platform.open", (m) => {
    opens.push(m);
    being.client.send({
      type: "platform.result",
      room: PLATFORM_ROOM,
      server: m.server,
      id: m.id,
      ok: true,
      result: { channel: { id: m.channelId } },
    });
  });
  being.client.on("platform.call", (m) => {
    calls.push(m);
    being.client.send({
      type: "platform.result",
      room: PLATFORM_ROOM,
      server: m.server,
      id: m.id,
      ok: true,
      result: { content: [{ type: "text", text: JSON.stringify({ messageId: `m${calls.length}` }) }] },
    });
  });
  being.client.on("platform.notify", (m) => notifies.push(m));
}

test("hosted_by: being — hello attaches, a mention turns, the reply rides platform.call, typing rides platform.notify, and a reconnect resumes without a duplicate room open", async (t) => {
  // pre-opened (observe-only-two-seats.test.mjs's own pattern) so its real
  // id can be given to MockBeing up front — W4-A's seat serves whichever
  // rooms `seatBeing`/`attachRegisteredSeat` finds it in, but MockBeing's
  // own unqualified sends (turn.event/turn.done) fall back to the ONE
  // `room` its constructor was given (connectome-seat-client/src/seat-
  // client.mjs's `send`), so that value has to be the real room here —
  // this task's own report names the mismatch this test's first draft hit.
  const { id: roomId, error: openErr } = await openRoom({
    platform: "discord",
    stream: STREAM,
    title: "remote seat e2e",
    beings: [BEING],
  });
  assert.equal(openErr, undefined, `openRoom failed: ${openErr}`);
  const runDir = join(process.env.HOUSE_RUNS_DIR, roomId);

  const sockDir = mkdtempSync(join(tmpdir(), "remote-seat-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen({ path: sockPath });

  const seated = bootSeats({ log: () => {} });
  assert.deepEqual(seated, [SERVER_NAME], "the being-hosted server is seated with no command at all");

  const host = remoteHostFor(BEING, SERVER_NAME);
  assert.ok(host, "routes.mjs registered this server's remote host at boot (open-rooms.mjs)");
  assert.equal(host.connected(), false, "not attached until a being says hello");
  assert.equal(host.state.state, "waiting", "createRemoteHost's own addition to createHost's state union");

  const opens = [];
  const calls = [];
  const notifies = [];
  const being1 = new MockBeing({
    path: sockPath,
    seatId: `${BEING}-remote-1`,
    being: BEING,
    room: roomId,
    script: [{ kind: "event", event: { kind: "final", text: "hello from nix" } }],
  });
  await being1.connect();
  wirePlatformAnswers(being1, { opens, calls, notifies });
  // socket-seat-protocol's own SocketSeatServer attaches its onEvent
  // listener only after the handshake's own promise resolves (a
  // microtask) — SeatClient.connect() itself resolves on the local
  // "connect" event alone, no house round-trip awaited, so a hello
  // written in the very same tick can race ahead of that attachment and
  // be silently dropped (found live writing this test). A being's own
  // real bridge (platform-runner.mjs) never sends this fast in practice;
  // this test gives the house's own onSeat its turn first.
  await new Promise((r) => setTimeout(r, 100));

  being1.client.send({
    type: "platform.hello",
    room: PLATFORM_ROOM,
    server: SERVER_NAME,
    platform: "discord",
    being: BEING,
    tools: ["send_message", "reply_message"],
    channels: [{ id: STREAM, type: "discord", label: "c", direction: "bidirectional" }],
  });
  await waitFor(() => (host.connected() ? true : null));
  assert.equal(host.state.state, "ready");
  await waitFor(() => (opens.length >= 1 ? true : null));
  assert.equal(opens[0].channelId, STREAM, "the configured room auto-opened (openStandingRooms)");

  being1.client.send({
    type: "platform.incoming",
    room: PLATFORM_ROOM,
    server: SERVER_NAME,
    msg: normalizeIncoming(msg("r-1", { channelId: STREAM, text: `alice: @${BEING} are you there?` })),
  });

  const seat = seats.get(SERVER_NAME);
  await waitFor(() => (seat.snapshot().rooms.find((r) => r.stream === STREAM)?.run === roomId ? true : null));
  await waitFor(() => {
    const rows = rowsOf(join(runDir, "frames.jsonl"));
    return rows.some((f) => f.type === "speech" && !f.interim && f.by === BEING) ? true : null;
  });
  await waitFor(() => (calls.length >= 1 ? true : null));

  assert.equal(calls[0].name, "send_message", "discord's own adapter never threads a native reply (speak.mjs)");
  assert.ok(calls[0].args?.content?.includes("hello from nix"), "the turn's own final speech, verbatim");

  const outboundRows = rowsOf(join(runDir, "external.jsonl"));
  const sent = outboundRows.find((r) => r.direction === "out" && r.by === BEING);
  assert.ok(sent, "the outbound ledger row (mcpl/outbound.mjs's recordOutbound)");
  assert.equal(sent.delivered, true);
  assert.equal(sent.message_id, "m1", "messageIdOf parsed platform.result's own content text, unchanged from a spawned host");

  await waitFor(() => (notifies.some((n) => n.method === "channels/typing" && n.params?.op === "start") ? true : null));
  await waitFor(() => (notifies.some((n) => n.method === "channels/typing" && n.params?.op === "stop") ? true : null));
  assert.ok(
    notifies.every((n) => n.method === "channels/typing" || n.method === "inference/lifecycle"),
    `every platform.notify on this run should be typing or lifecycle: ${JSON.stringify(notifies)}`,
  );

  /* ---- simulated reconnect: hello again, on a fresh connection ---- */
  const opensBeforeReconnect = opens.length;
  being1.close();
  await waitFor(() => (host.connected() === false ? true : null));
  assert.equal(host.state.state, "ready", "state is kept for the snapshot across a detach (this task's own mission)");

  const being2 = new MockBeing({
    path: sockPath,
    seatId: `${BEING}-remote-2`,
    being: BEING,
    room: "unattached",
    script: [{ kind: "event", event: { kind: "final", text: "hello again from nix" } }],
  });
  await being2.connect();
  wirePlatformAnswers(being2, { opens, calls, notifies });
  await new Promise((r) => setTimeout(r, 100)); // same race as being1's own connect, above
  being2.client.send({
    type: "platform.hello",
    room: PLATFORM_ROOM,
    server: SERVER_NAME,
    platform: "discord",
    being: BEING,
    tools: ["send_message", "reply_message"],
    channels: [{ id: STREAM, type: "discord", label: "c", direction: "bidirectional" }],
  });
  await waitFor(() => (host.connected() ? true : null));
  await new Promise((r) => setTimeout(r, 300)); // openStandingRooms's every chance to (wrongly) re-open
  assert.equal(opens.length, opensBeforeReconnect, "no duplicate platform.open — st.open already had this channel");
  assert.equal(
    seat.snapshot().rooms.find((r) => r.stream === STREAM)?.run,
    roomId,
    "the same room throughout — a reconnect never reopens it",
  );

  t.after(async () => {
    being1.close();
    being2.close();
    stopSeats();
    await seatServer.close();
    rmSync(sockDir, { recursive: true, force: true });
  });
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
