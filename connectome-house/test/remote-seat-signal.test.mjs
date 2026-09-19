// @ts-check
/* connectome-house/test/remote-seat-signal.test.mjs — harness-port W6-R1,
 * 2026-09-19: THE BUG, fixed end to end, over the real being-hosted
 * remote-seat path (test/remote-seat.test.mjs's own pattern — the real
 * `bootSeats`/`createHouseSeatServer` entrypoints, a `MockBeing` standing
 * in for the being's own connection). A Signal mention carries the
 * mentioned account's UUID, never a phone number; before this task the
 * seat only ever christened `phoneId(number)`, so a Signal uuid mention
 * resolved to a fresh stranger handle instead of the being's own.
 *
 * Proves: `platform.hello`'s `capabilities.self.uuid` (mcpl-signal's own
 * announced identity, carried by a being's child through mcpl/child.mjs
 * and platform-runner.mjs) reaches `remote-host.mjs`'s `state.self`;
 * `seat.mjs`'s own poll (`checkSelf`) christens that uuid to the being's
 * handle (`room-tails.mjs`'s `christenBeing`, extended to a list of ids);
 * an inbound Signal message whose text carries `<@<uuid>>` then resolves
 * through `identityFor` to the being's own handle, `routeIncoming` names
 * `mention` as the activation reason, and the reply rides
 * `platform.call send_message` (a mention, never a reply-threaded call). */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MockBeing } from "@connectome/seat-client";
import { PLATFORM_ROOM } from "@connectome/seat-protocol";

const ROOT = mkdtempSync(join(tmpdir(), "remote-seat-signal-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "remote-seat-signal-test-salt-0123456789";
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
const { identityFor } = await import("../src/identity-map.mjs");

const BEING = "claude-haiku-4-5";
const SERVER_NAME = "remote-signal-1";
const STREAM = "signal:group:remote-mention-test";
// a made-up uuid and a 555 number only — never a real account's (pii-discipline)
const FAKE_UUID = "aaaaaaaa-0000-4000-8000-0000000000f1";
const FAKE_NUMBER = "+15550001299";
const numberId = createHash("sha256").update(FAKE_NUMBER).digest("hex");
writeTestament(process.env.HOUSE_COVENANTS_DIR, BEING, { speaksFor: "signal" });

process.env.HOUSE_SANDBOX = "1";
process.env.HOUSE_MCPL_SERVERS = join(process.env.HOUSE_PRIVATE_DIR, "servers.json");
writeFileSync(
  process.env.HOUSE_MCPL_SERVERS,
  JSON.stringify({
    servers: [
      {
        name: SERVER_NAME,
        platform: "signal",
        being: BEING,
        hosted_by: "being",
        rooms: [{ stream: STREAM, title: "remote signal mention e2e", beings: [BEING], public: true }],
      },
    ],
  }),
);

/** a Signal-shaped incoming message: rawContent carries the literal
 * `<@uuid>` token (mcpl-signal/src/envelopes.mjs's own facts()), which is
 * what adapters.mjs's genericText/rewriteMentions actually read. */
function signalMsg(id, { text, mentionUuid }) {
  return {
    channelId: STREAM,
    messageId: id,
    author: { id: "alice-uuid-0000-4000-8000-000000000002", name: "alice" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: `alice: ${text}` }],
    metadata: {
      mentions: [mentionUuid],
      rawContent: `<@${mentionUuid}> ${text}`,
      replyTo: null,
      replyToAuthorId: null,
      isBot: false,
    },
    tags: ["chat:mention", "chat:addressed", "chat:group", "chat:from-human"],
  };
}

test("a Signal mention token naming the being's own announced uuid activates it, and the answer rides platform.call send_message", async (t) => {
  const { id: roomId, error: openErr } = await openRoom({
    platform: "signal",
    stream: STREAM,
    title: "remote signal mention e2e",
    beings: [BEING],
  });
  assert.equal(openErr, undefined, `openRoom failed: ${openErr}`);

  const sockDir = mkdtempSync(join(tmpdir(), "remote-seat-signal-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen({ path: sockPath });

  const seated = bootSeats({ log: () => {} });
  assert.deepEqual(seated, [SERVER_NAME], "the being-hosted signal server is seated with no command at all");

  const host = remoteHostFor(BEING, SERVER_NAME);
  assert.ok(host, "routes.mjs registered this server's remote host at boot");
  assert.equal(host.state.self, null, "no uuid announced yet");

  const calls = [];
  const being = new MockBeing({
    path: sockPath,
    seatId: `${BEING}-remote-signal`,
    being: BEING,
    room: roomId,
    script: [{ kind: "event", event: { kind: "final", text: "hello — I am here" } }],
    waitForReady: true, // harness-port W8-A: closes the onEvent-attach race a grace sleep used to paper over
  });
  await being.connect();
  being.client.on("platform.open", (m) =>
    being.client.send({
      type: "platform.result",
      room: PLATFORM_ROOM,
      server: m.server,
      id: m.id,
      ok: true,
      result: { channel: { id: m.channelId } },
    }),
  );
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
  // THE BUG's own shape: mcpl-signal's initialize/channels/self, forwarded
  // through the being's own child into platform.hello.capabilities.self.
  being.client.send({
    type: "platform.hello",
    room: PLATFORM_ROOM,
    server: SERVER_NAME,
    platform: "signal",
    being: BEING,
    tools: ["send_message", "reply_message"],
    channels: [{ id: STREAM, type: "signal", label: "g", direction: "bidirectional" }],
    capabilities: { grant: ["tools"], mode: "ready", self: { uuid: FAKE_UUID, numberId } },
  });
  await waitFor(() => (host.connected() ? true : null));
  assert.deepEqual(host.state.self, { uuid: FAKE_UUID, numberId }, "remote-host.mjs surfaces platform.hello's own self");

  // seat.mjs's own poll (checkSelf, ≤250ms) christens the uuid the moment
  // it sees it in host.state.self — never gated on the mention itself.
  await waitFor(() => {
    const who = identityFor({ platform: "signal", id: FAKE_UUID, display: null });
    return who.handle === BEING ? true : null;
  });

  being.client.send({
    type: "platform.incoming",
    room: PLATFORM_ROOM,
    server: SERVER_NAME,
    msg: normalizeIncoming(signalMsg("s-1", { text: "are you there?", mentionUuid: FAKE_UUID })),
  });

  const seat = seats.get(SERVER_NAME);
  await waitFor(() => (seat.snapshot().rooms.find((r) => r.stream === STREAM)?.run === roomId ? true : null));
  await waitFor(() => (calls.length >= 1 ? true : null));
  assert.equal(calls[0].name, "send_message", "a mention, never reply-threaded (signal.mjs's own replyThreading, no replyTo here)");
  assert.ok(calls[0].args?.content?.includes("hello — I am here"));

  t.after(async () => {
    being.close();
    stopSeats();
    await seatServer.close();
    rmSync(sockDir, { recursive: true, force: true });
  });
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
