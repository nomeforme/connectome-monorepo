// @ts-check
/* connectome-house/test/remote-seat-discord.test.mjs — harness-port
 * W6-R5, 2026-09-19: THE BUG, fixed end to end, over the real being-
 * hosted remote-seat path (test/remote-seat-signal.test.mjs's own
 * pattern, ported to Discord — a `MockBeing` standing in for the being's
 * own connection). A `<@bot-id>` mention of a being-hosted Discord seat
 * routed as `"claude-3-sonnet":"none"` before this task: the house only
 * ever learns a Discord child's own account id by parsing its stderr
 * connect line (mcpl/seat.mjs's `learnBeingId`), and for a being-hosted
 * seat that stderr is in the BEING's own container — the house never
 * saw it.
 *
 * Proves: `platform.hello`'s `capabilities.self.id` (mcpl/child.mjs's own
 * stderr parse, carried through platform-runner.mjs) reaches remote-
 * host.mjs's `state.self`; seat.mjs's own poll (`checkSelf`, via room-
 * tails.mjs's `createSelfTracker`) christens that id to the being's
 * handle; an inbound Discord message whose text carries `<@<id>>` then
 * resolves through `identityFor` to the being's own handle, routeIncoming
 * names `mention` as the activation reason, and the reply rides
 * `platform.call send_message` (a mention, never a reply-threaded call —
 * discord.mjs's own replyThreading only applies once a real `replyTo`
 * is on the message, absent here). */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBeing } from "@connectome/seat-client";
import { PLATFORM_ROOM } from "@connectome/seat-protocol";

const ROOT = mkdtempSync(join(tmpdir(), "remote-seat-discord-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "remote-seat-discord-test-salt-0123456789";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });

const { writeTestament } = await import("./lib/fixtures.mjs");
const { framesOf, waitFor } = await import("./lib/serve-harness.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");
const { remoteHostFor } = await import("../src/open-rooms.mjs");
const { bootSeats, stopSeats, seats } = await import("../src/mcpl/routes.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");
const { openRoom } = await import("../src/serve-rooms.mjs");
const { identityFor } = await import("../src/identity-map.mjs");

const BEING = "claude-haiku-4-5";
const SERVER_NAME = "remote-discord-1";
const STREAM = "discord:g1:remote-mention-test";
// a made-up 18-digit Discord snowflake shape only (pii-discipline) — the
// mission's own example id.
const FAKE_ID = "555000000000000001";
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
        rooms: [{ stream: STREAM, title: "remote discord mention e2e", beings: [BEING], public: true }],
      },
    ],
  }),
);

/** a Discord-shaped incoming message: rawContent carries the literal
 * `<@id>` token (discord.mjs's own MENTION_TOKEN_RE, `<@!?(\d+)>`). */
function discordMsg(id, { text, mentionId }) {
  return {
    channelId: STREAM,
    messageId: id,
    author: { id: "111111111111111111", name: "alice" },
    timestamp: new Date().toISOString(),
    content: [{ type: "text", text: `alice: ${text}` }],
    metadata: {
      mentions: [mentionId],
      rawContent: `<@${mentionId}> ${text}`,
      replyTo: null,
      replyToAuthorId: null,
      isBot: false,
    },
    tags: ["chat:mention", "chat:addressed", "chat:group", "chat:from-human"],
  };
}

test("a Discord <@bot-id> mention of the being's own announced account id activates it, and the answer rides platform.call send_message", async (t) => {
  const { id: roomId, error: openErr } = await openRoom({
    platform: "discord",
    stream: STREAM,
    title: "remote discord mention e2e",
    beings: [BEING],
  });
  assert.equal(openErr, undefined, `openRoom failed: ${openErr}`);

  const sockDir = mkdtempSync(join(tmpdir(), "remote-seat-discord-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen({ path: sockPath });

  const logLines = [];
  const seated = bootSeats({ log: (l) => logLines.push(l) });
  assert.deepEqual(seated, [SERVER_NAME], "the being-hosted discord server is seated with no command at all");

  const host = remoteHostFor(BEING, SERVER_NAME);
  assert.ok(host, "routes.mjs registered this server's remote host at boot");
  assert.equal(host.state.self, null, "no id announced yet");

  const calls = [];
  const being = new MockBeing({
    path: sockPath,
    seatId: `${BEING}-remote-discord`,
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
  // THE BUG's own shape: child.mjs's own stderr parse of discord-mcpl's
  // connect line, forwarded through platform.hello.capabilities.self.
  being.client.send({
    type: "platform.hello",
    room: PLATFORM_ROOM,
    server: SERVER_NAME,
    platform: "discord",
    being: BEING,
    tools: ["send_message", "reply_message"],
    channels: [{ id: STREAM, type: "discord", label: "g", direction: "bidirectional" }],
    capabilities: { grant: ["tools"], mode: "ready", self: { id: FAKE_ID } },
  });
  await waitFor(() => (host.connected() ? true : null));
  assert.deepEqual(host.state.self, { id: FAKE_ID }, "remote-host.mjs surfaces platform.hello's own self");

  // seat.mjs's own poll (checkSelf, ≤250ms) christens the id the moment
  // it sees it in host.state.self — never gated on the mention itself.
  await waitFor(() => {
    const who = identityFor({ platform: "discord", id: FAKE_ID, display: null });
    return who.handle === BEING ? true : null;
  });

  being.client.send({
    type: "platform.incoming",
    room: PLATFORM_ROOM,
    server: SERVER_NAME,
    msg: normalizeIncoming(discordMsg("d-1", { text: "are you there?", mentionId: FAKE_ID })),
  });

  const seat = seats.get(SERVER_NAME);
  await waitFor(() => (seat.snapshot().rooms.find((r) => r.stream === STREAM)?.run === roomId ? true : null));
  await waitFor(() => (calls.length >= 1 ? true : null));
  assert.equal(calls[0].name, "send_message", "a mention, never reply-threaded (no replyTo on this message)");
  assert.ok(calls[0].args?.content?.includes("hello — I am here"));

  // the seat's own one-line-per-message log (onIncoming) names the
  // activation reason — {being: "mention"}, THE BUG's own lost fact.
  assert.ok(
    logLines.some((l) => l.includes(`"${BEING}":"mention"`)),
    `expected a seat log line naming {${BEING}: "mention"}, got: ${JSON.stringify(logLines.filter((l) => l.includes("activates")))}`,
  );

  // the recorded input names the being by its real handle, never the raw
  // Discord snowflake (route.mjs's own rewriteMentions, exercised here
  // end to end through roomInput's own frame).
  const recorded = framesOf(join(process.env.HOUSE_RUNS_DIR, roomId));
  const text = JSON.stringify(recorded);
  assert.ok(text.includes(`@${BEING}`), "the recorded input names the being by its real handle");
  assert.ok(!text.includes(FAKE_ID), "the raw Discord id never rides in the recorded input");

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
