// @ts-check
/* mcpl-signal/test/server.test.mjs — the server in-process over a
 * PassThrough pair (test/lib/wire.mjs's openWire as the host side), the mock
 * signal-cli behind it: image inlining, duplicate envelopes, the
 * receive socket's reconnect, privacy applied on the way in, from-self
 * on an open channel, a phone-only contact answered through the private
 * number map, channels/publish, the split on send, the grace path
 * when no policy ever arrives, and a PII conformance sweep (no fixture
 * phone number in any log line, host-bound request, or tool result). */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { McplConnection } from "@animalabs/mcpl-core";
import { openWire } from "./lib/wire.mjs";
import { readConfig } from "../src/config.mjs";
import { phoneId } from "../src/envelopes.mjs";
import { createServer } from "../src/server.mjs";
import { createSignalCli } from "../src/signal-cli.mjs";
import {
  createMockSignalCli,
  dataMessage,
  editMessageEnvelope,
  GROUP,
  NUMBERS,
  reactionEnvelope,
  remoteDeleteEnvelope,
  syncSent,
  UUIDS,
} from "./lib/mock-signal-cli.mjs";

const GROUP_STREAM = `signal:group:${GROUP.internal_id}`;
const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** a server + a host wire over PassThroughs; returns both */
async function boot(mock, envOver = {}, { grant = true } = {}) {
  const env = {
    SIGNAL_CLI_URL: mock.url,
    SIGNAL_NUMBER: NUMBERS.bot,
    SIGNAL_POLICY_GRACE_MS: "300",
    ...envOver,
  };
  const config = readConfig([], env);
  if (typeof config === "string") throw new Error(config);
  const logs = [];
  const log = (l) => logs.push(l);
  const client = createSignalCli({ ...config, log, backoffMs: { min: 50, max: 200 } });
  const s2h = new PassThrough();
  const h2s = new PassThrough();
  const conn = McplConnection.fromStreams(h2s, s2h);
  const server = createServer({ conn, client, config, log });
  const wire = openWire({ readable: s2h, writable: h2s, requestTimeoutMs: 3000 });
  const inbound = [];
  wire.onRequest(async (method, params) => {
    inbound.push({ method, params });
    if (method === "push/event") return { accepted: true };
    if (method === "channels/incoming")
      return { results: params.messages.map((m) => ({ messageId: m.messageId, accepted: true })) };
    if (method === "channels/register" || method === "channels/changed")
      return {
        results: (params.channels ?? params.added).map((d) => ({ id: d.id, accepted: true })),
      };
    return undefined;
  });
  const started = server.start();
  await wire.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { mcpl: { version: "0.5", featureSets: true } } },
    clientInfo: { name: "t", version: "0" },
  });
  wire.notify("notifications/initialized");
  if (grant)
    await wire.request("featureSets/update", {
      effectiveCapabilities: [
        "tools",
        "pushEvents",
        "channels.register",
        "channels.lifecycle",
        "channels.publish",
        "channels.incoming",
        "channels.typing",
      ],
    });
  await started;
  return { server, wire, client, inbound, logs, config };
}

let mock;
before(async () => {
  mock = await createMockSignalCli({
    groups: [{ ...GROUP, members: [] }],
    identities: [{ number: NUMBERS.bot, uuid: UUIDS.bot }],
    attachments: { img1: Buffer.from("png-bytes-here"), big: Buffer.alloc(200), pdf1: Buffer.from("%PDF-1.4 tiny"), long1: Buffer.from("the whole long message text") },
  });
});
after(async () => {
  await mock.close();
});

test("a PDF sent untagged rides as a resource block with its bytes; a long message's text carrier replaces the body", async () => {
  const { server, wire, inbound, client } = await boot(mock, {});
  await wire.request("channels/open", { channelId: GROUP_STREAM });
  await waitFor(() => client.state.connected);
  mock.emit(
    dataMessage({
      text: "",
      group: GROUP,
      timestamp: 1700000099001,
      attachments: [{ id: "pdf1", contentType: "application/pdf", filename: "paper.pdf", size: 13 }],
    }),
  );
  mock.emit(
    dataMessage({
      text: "the whole lo",
      group: GROUP,
      timestamp: 1700000099002,
      attachments: [{ id: "long1", contentType: "text/x-signal-plain", size: 27 }],
    }),
  );
  await waitFor(() => inbound.filter((x) => x.method === "channels/incoming").length >= 2);
  const [pdfMsg, longMsg] = inbound.filter((x) => x.method === "channels/incoming").map((x) => x.params.messages[0]);
  assert.deepEqual(pdfMsg.content[1], {
    type: "resource",
    uri: `data:application/pdf;base64,${Buffer.from("%PDF-1.4 tiny").toString("base64")}`,
    mimeType: "application/pdf",
    name: "paper.pdf",
    size: 13,
  });
  assert.equal(pdfMsg.content.length, 2, "no note for a file that was delivered");
  assert.equal(longMsg.content[0].text, "alice: the whole long message text");
  assert.equal(longMsg.content.length, 1);
  server.stop();
  wire.close();
});

test("images inline as base64 blocks under the cap; over it, a note; duplicates dedupe", async () => {
  const { server, wire, inbound, client } = await boot(mock, {
    SIGNAL_ATTACHMENT_MAX_BYTES: "100",
    SIGNAL_FILE_MAX_BYTES: "100",
  });
  await wire.request("channels/open", { channelId: GROUP_STREAM });
  const e = dataMessage({
    text: "look",
    group: GROUP,
    attachments: [
      { id: "img1", contentType: "image/png", filename: "a.png", size: 14 },
      { id: "big", contentType: "image/jpeg", filename: "b.jpg", size: 200 },
    ],
  });
  await waitFor(() => client.state.connected);
  mock.emit(e);
  mock.emit(e);
  const inc = await waitFor(() => inbound.find((x) => x.method === "channels/incoming"));
  const msg = inc.params.messages[0];
  assert.equal(msg.content[0].text, "alice: look");
  assert.deepEqual(msg.content[1], {
    type: "image",
    data: Buffer.from("png-bytes-here").toString("base64"),
    mimeType: "image/png",
    name: "a.png",
    size: Buffer.from("png-bytes-here").length,
  });
  assert.match(
    msg.content[2].text,
    /^\[attachment: b\.jpg \(image\/jpeg, 200 bytes\) — not inlined\]$/,
  );
  assert.ok(msg.tags.includes("chat:has-image"));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    inbound.filter((x) => x.method === "channels/incoming").length,
    1,
    "the duplicate was dropped",
  );
  assert.equal(server.state.counts.deduped, 1);
  server.stop();
  wire.close();
});

test("the receive socket reconnects with backoff after signal-cli drops it", async () => {
  const { server, wire, client, inbound } = await boot(mock);
  await waitFor(() => client.state.connected);
  const before = mock.state.connections;
  mock.dropSockets();
  await waitFor(() => mock.state.connections > before && client.state.connected);
  assert.ok(client.state.reconnects >= 1);
  mock.emit(dataMessage({ text: "still here" }));
  await waitFor(() =>
    inbound.find(
      (x) => x.method === "push/event" && JSON.stringify(x.params).includes("still here"),
    ),
  );
  server.stop();
  wire.close();
});

test("privacy on the way in: opt-in strips the dot; from-self rides an open channel; the closed-channel miss counts", async () => {
  const { server, wire, client, inbound } = await boot(mock, {
    SIGNAL_GROUP_PRIVACY_MODE: "opt-in",
  });
  await waitFor(() => client.state.connected);
  mock.emit(dataMessage({ text: "ambient, not opted in", group: GROUP }));
  mock.emit(dataMessage({ text: ".a dot lets me in", group: GROUP }));
  await waitFor(() => server.state.dropReasons["not-opted-in"] === 1);
  await waitFor(() => server.state.counts.missed === 1, 3000);
  assert.equal(
    inbound.filter((x) => x.method === "push/event").length,
    0,
    "a closed channel forwards only addressed",
  );
  await wire.request("channels/open", { channelId: GROUP_STREAM });
  mock.emit(dataMessage({ text: ".now on the open channel", group: GROUP }));
  const inc = await waitFor(() => inbound.find((x) => x.method === "channels/incoming"));
  assert.equal(inc.params.messages[0].content[0].text, "alice: now on the open channel");
  assert.equal(
    inc.params.messages[0].metadata.rawContent,
    ".now on the open channel",
    "raw keeps the dot; prose drops it",
  );
  mock.emit(syncSent({ text: "from my other device", group: GROUP }));
  const own = await waitFor(() =>
    inbound.find(
      (x) => x.method === "channels/incoming" && JSON.stringify(x.params).includes("other device"),
    ),
  );
  assert.ok(own.params.messages[0].tags.includes("chat:from-self"));
  assert.equal(own.params.messages[0].author.id, UUIDS.bot);
  assert.ok(!JSON.stringify(inbound).includes("555"), "no number on the wire, ever");
  server.stop();
  wire.close();
});

test("a phone-only contact: digest id on the wire, answered through the private number map; publish; split", async () => {
  const { server, wire, client } = await boot(mock, { SIGNAL_MAX_MESSAGE_LENGTH: "40" });
  await waitFor(() => client.state.connected);
  mock.emit(dataMessage({ text: "hello from a number", from: "phoneOnly" }));
  const digest = phoneId(NUMBERS.phoneOnly);
  const stream = `signal:dm:${digest}`;
  await waitFor(() => server.state.channels.has(stream));
  const before = mock.state.sent.length;
  const r = await wire.request("tools/call", {
    name: "send_message",
    arguments: {
      channelId: stream,
      content: "first paragraph of the answer.\n\nsecond paragraph, over the limit.",
    },
  });
  const j = JSON.parse(/** @type {any} */ (r).content[0].text);
  assert.equal(j.messageIds.length, 2, "split at the paragraph");
  const sends = mock.state.sent.slice(before);
  assert.deepEqual(sends[0].recipients, [NUMBERS.phoneOnly], "the number reaches signal-cli only");
  assert.equal(sends[0].message, "first paragraph of the answer.");
  assert.equal(sends[1].message, "second paragraph, over the limit.");
  assert.ok(
    !JSON.stringify(server.snapshot()).includes("555"),
    "the snapshot never carries a number",
  );
  const pub = await wire.request("channels/publish", {
    channelId: GROUP_STREAM,
    content: [{ type: "text", text: "published" }],
  });
  assert.equal(/** @type {any} */ (pub).delivered, true);
  assert.match(/** @type {any} */ (pub).messageId, /^aaaaaaaa-.*:\d+$/);
  assert.deepEqual(mock.state.sent.at(-1).recipients, [GROUP.id]);
  await assert.rejects(
    wire.request("tools/call", {
      name: "send_message",
      arguments: { channelId: `signal:dm:${"f".repeat(64)}`, content: "x" },
    }),
    /not been seen/,
  );
  server.stop();
  wire.close();
});

test("outbound <@id> tokens (the house's own mention grammar) become real Signal mentions on send_message/reply_message/channels/publish; unresolved never puts a raw id on the wire; a mention past the first chunk still carries real offsets", async () => {
  const { server, wire, client, logs } = await boot(mock);
  await waitFor(() => client.state.connected);
  // alice is seen once (her uuid known); a phone-only contact's digest is
  // known once its number map entry exists
  mock.emit(dataMessage({ text: "hi", group: GROUP }));
  await waitFor(() => server.state.channels.has(GROUP_STREAM));
  mock.emit(dataMessage({ text: "hi from a number", from: "phoneOnly" }));
  const digest = phoneId(NUMBERS.phoneOnly);
  await waitFor(() => server.state.channels.has(`signal:dm:${digest}`));
  const unknown = "0".repeat(64);

  const before = mock.state.sent.length;
  const r = await wire.request("tools/call", {
    name: "send_message",
    arguments: {
      channelId: GROUP_STREAM,
      content: `hey <@${UUIDS.alice}> and <@${digest}> and <@${unknown}>`,
    },
  });
  assert.ok(!(/** @type {any} */ (r)).isError, JSON.stringify(r));
  const sent = mock.state.sent[before];
  assert.equal(
    sent.message,
    "hey ￼ and ￼ and ",
    "the unresolved token is dropped clean — alice and the digest resolve, the unknown id does not",
  );
  assert.ok(!sent.message.includes("<@"), "never a raw id on the wire");
  assert.deepEqual(
    sent.mentions.map((m) => m.author),
    [UUIDS.alice, NUMBERS.phoneOnly],
    "a uuid resolves as itself; the digest resolves through the private number map",
  );
  for (const m of sent.mentions) assert.equal(sent.message[m.start], "￼", "the offset lands on the placeholder");
  assert.ok(logs.some((l) => l.includes(unknown) && l.includes("dropped")), "the drop is logged, naming why");

  // reply_message and channels/publish share the same send path
  await wire.request("channels/open", { channelId: GROUP_STREAM });
  const replyR = await wire.request("tools/call", {
    name: "reply_message",
    arguments: { channelId: GROUP_STREAM, messageId: `${UUIDS.alice}:1`, content: `re: <@${UUIDS.alice}>` },
  });
  assert.ok(!(/** @type {any} */ (replyR)).isError, JSON.stringify(replyR));
  assert.deepEqual(mock.state.sent.at(-1).mentions, [{ start: 4, length: 1, author: UUIDS.alice }]);
  const pubR = await wire.request("channels/publish", {
    channelId: GROUP_STREAM,
    content: [{ type: "text", text: `<@${UUIDS.alice}> published` }],
  });
  assert.equal(/** @type {any} */ (pubR).delivered, true);
  assert.deepEqual(mock.state.sent.at(-1).mentions, [{ start: 0, length: 1, author: UUIDS.alice }]);

  assert.deepEqual(mock.state.violations, [], "every /v2/send body this test produced was well-shaped");
  server.stop();
  wire.close();
});

test("a mention past the first chunk carries its own, chunk-local offset — not silently dropped by the old 'mentions only on chunk 0' gate", async () => {
  const { server: server2, wire: wire2 } = await boot(mock, { SIGNAL_MAX_MESSAGE_LENGTH: "90" });
  const before2 = mock.state.sent.length;
  const filler = "x".repeat(60);
  const split = await wire2.request("tools/call", {
    name: "send_message",
    arguments: {
      channelId: GROUP_STREAM,
      content: `${filler}\n\nsecond chunk mentions <@${UUIDS.alice}> here`,
    },
  });
  const splitIds = JSON.parse(/** @type {any} */ (split).content[0].text).messageIds;
  assert.equal(splitIds.length, 2, "split at the paragraph");
  const chunks = mock.state.sent.slice(before2);
  assert.deepEqual(chunks[0].mentions ?? [], [], "the first chunk has no mention");
  assert.equal(chunks[1].message, "second chunk mentions ￼ here");
  assert.deepEqual(
    chunks[1].mentions,
    [{ start: 22, length: 1, author: UUIDS.alice }],
    "the SECOND chunk's own mention, at its own local offset — not lost to the old i===0 gate",
  );
  assert.deepEqual(mock.state.violations, [], "every /v2/send body this test produced was well-shaped");
  server2.stop();
  wire2.close();
});

test("with no featureSets/update inside the grace, the server proceeds with nothing granted and drops traffic", async () => {
  const { server, wire, client, inbound, logs } = await boot(mock, {}, { grant: false });
  assert.ok(logs.some((l) => /no featureSets\/update within the grace/.test(l)));
  await waitFor(() => client.state.connected);
  mock.emit(dataMessage({ text: "anyone" }));
  await waitFor(() => server.state.dropReasons["no-grant"] === 1);
  assert.equal(inbound.filter((x) => x.method !== "channels/register").length, 0);
  await assert.rejects(
    wire.request("channels/publish", { channelId: GROUP_STREAM, content: [] }),
    /capability/,
  );
  server.stop();
  wire.close();
});

test("config: the missing variable is named, never a value; the receive URL derives from the base", () => {
  assert.equal(readConfig([], {}), "SIGNAL_CLI_URL is required (http://host:port)");
  assert.match(String(readConfig([], { SIGNAL_CLI_URL: "http://x:1" })), /^SIGNAL_NUMBER is unset/);
  assert.match(
    String(
      readConfig(["--number-env", "HOUSE_SIGNAL_NUMBER_ZZ"], { SIGNAL_CLI_URL: "http://x:1" }),
    ),
    /^HOUSE_SIGNAL_NUMBER_ZZ is unset/,
  );
  const c = readConfig(["--number-env=HOUSE_SIGNAL_NUMBER_ZZ"], {
    SIGNAL_CLI_URL: "https://x:1/",
    HOUSE_SIGNAL_NUMBER_ZZ: NUMBERS.bot,
    SIGNAL_GROUP_PRIVACY_MODE: "opt-in",
    SIGNAL_ALLOWED_GROUPS: "a, b",
    SIGNAL_MAX_MESSAGE_LENGTH: "-5",
  });
  assert.equal(typeof c, "object");
  if (typeof c === "string") return;
  assert.equal(c.wsUrl, "wss://x:1");
  assert.equal(c.baseUrl, "https://x:1");
  assert.equal(c.privacyMode, "opt-in");
  assert.deepEqual(c.allowedGroups, ["a", "b"]);
  assert.equal(c.maxMessageLength, 0, "a bad number is the default");
  assert.equal(c.numberEnv, "HOUSE_SIGNAL_NUMBER_ZZ");
});

test("PII conformance: no fixture phone number ever reaches a log line, a host-bound request, or a tool result", async () => {
  const { server, wire, client, inbound, logs } = await boot(mock, {
    SIGNAL_MAX_MESSAGE_LENGTH: "40",
  });
  await waitFor(() => client.state.connected);
  await wire.request("channels/open", { channelId: GROUP_STREAM });

  // a full mix: group ambient, a mention, a quote, a reaction, an attachment,
  // and a phone-only sender's DM (the one case where a number IS known here,
  // privately — it must still never leave through any of the three surfaces)
  mock.emit(dataMessage({ text: "hi all", group: GROUP }));
  mock.emit(
    dataMessage({
      text: "look",
      group: GROUP,
      attachments: [{ id: "img1", contentType: "image/png", filename: "a.png", size: 14 }],
    }),
  );
  mock.emit(
    reactionEnvelope({ emoji: "🫥", targetAuthorUuid: UUIDS.bot, targetTimestamp: 1, group: GROUP }),
  );
  mock.emit(dataMessage({ text: "hello from a number", from: "phoneOnly" }));
  const digest = phoneId(NUMBERS.phoneOnly);
  const dmStream = `signal:dm:${digest}`;
  await waitFor(() => server.state.channels.has(dmStream));

  const toolResults = [];
  toolResults.push(
    await wire.request("tools/call", {
      name: "send_message",
      arguments: { channelId: dmStream, content: "answering the number" },
    }),
  );
  toolResults.push(await wire.request("tools/call", { name: "list_groups", arguments: {} }));
  toolResults.push(
    await wire.request("tools/call", {
      name: "add_reaction",
      arguments: { channelId: GROUP_STREAM, messageId: `${UUIDS.alice}:1`, emoji: "👍" },
    }),
  );

  await waitFor(() => inbound.some((x) => x.method === "channels/incoming"));

  const haystacks = {
    "host-bound requests (channels/register, channels/incoming, push/event)": JSON.stringify(inbound),
    "tool call results": JSON.stringify(toolResults),
    "the server's own log lines": logs.join("\n"),
    "the introspection snapshot": JSON.stringify(server.snapshot()),
  };
  for (const [surface, haystack] of Object.entries(haystacks)) {
    for (const n of Object.values(NUMBERS)) {
      assert.ok(!haystack.includes(n), `fixture number ${n} leaked into ${surface}`);
    }
    assert.ok(!/\+1555\d{7}/.test(haystack), `a +1555… shaped number leaked into ${surface}`);
  }
  // the digest itself IS expected on the wire (that's the point of phoneId) —
  // confirm it's there, so this test would actually fail if a number replaced it
  assert.ok(JSON.stringify(inbound).includes(digest), "the digest, not the number, names the sender");
  server.stop();
  wire.close();
});

test("privacy fails closed on a MISSING privacy file: a group message is dropped, never forwarded, and the log names only the file's path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpl-signal-privacy-missing-"));
  const missingPath = join(dir, "does-not-exist.json");
  const { server, wire, client, inbound, logs } = await boot(mock, {
    SIGNAL_GROUP_PRIVACY_FILE: missingPath,
  });
  await waitFor(() => client.state.connected);
  const secretText = "the ambient content of this message must never reach a log line";
  mock.emit(dataMessage({ text: secretText, group: GROUP }));
  await waitFor(() => server.state.dropReasons["privacy-file-broken"] === 1);
  assert.equal(
    inbound.filter((x) => x.method === "push/event" || x.method === "channels/incoming").length,
    0,
    "no group traffic forwarded while the privacy file is absent",
  );
  const named = logs.filter((l) => l.includes(missingPath));
  assert.ok(named.length >= 1, "the log names the file by its path");
  assert.ok(
    named.every((l) => /missing/.test(l) && !l.includes(secretText)),
    "the log line says the file is missing — never the message content",
  );
  assert.ok(!logs.some((l) => l.includes(secretText)), "no log line anywhere carries the message content");
  server.stop();
  wire.close();
});

test("privacy fails closed on a MALFORMED privacy file: a group message is dropped, never forwarded, and the log names only the file's path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpl-signal-privacy-malformed-"));
  const badPath = join(dir, "broken.json");
  writeFileSync(badPath, "{ this is not json");
  const { server, wire, client, inbound, logs } = await boot(mock, {
    SIGNAL_GROUP_PRIVACY_FILE: badPath,
  });
  await waitFor(() => client.state.connected);
  const secretText = "another ambient secret that must never be logged verbatim";
  mock.emit(dataMessage({ text: secretText, group: GROUP }));
  await waitFor(() => server.state.dropReasons["privacy-file-broken"] === 1);
  assert.equal(
    inbound.filter((x) => x.method === "push/event" || x.method === "channels/incoming").length,
    0,
    "no group traffic forwarded while the privacy file fails to parse",
  );
  const named = logs.filter((l) => l.includes(badPath));
  assert.ok(named.length >= 1, "the log names the file by its path");
  assert.ok(
    named.every((l) => /failed to parse/.test(l) && !l.includes(secretText)),
    "the log line says parsing failed — never the message content",
  );
  assert.ok(!logs.some((l) => l.includes(secretText)), "no log line anywhere carries the message content");
  server.stop();
  wire.close();
});

test("edits and deletes: editMessage and remoteDelete forward as typed push/event, carrying the target message id", async () => {
  const { server, wire, client, inbound } = await boot(mock);
  await waitFor(() => client.state.connected);
  const originalTs = 1725100000001;
  mock.emit(dataMessage({ text: "original text", group: GROUP, timestamp: originalTs }));
  await waitFor(() => inbound.some((x) => x.method === "push/event" || x.method === "channels/incoming") || true);

  mock.emit(
    editMessageEnvelope({
      text: "corrected text",
      group: GROUP,
      targetTimestamp: originalTs,
      timestamp: originalTs + 1,
    }),
  );
  const editEvt = await waitFor(() =>
    inbound.find((x) => x.method === "push/event" && x.params.tags?.includes("chat:edited")),
  );
  assert.equal(editEvt.params.origin.targetMessageId, `${UUIDS.alice}:${originalTs}`);
  assert.equal(editEvt.params.payload.content[0].text, "alice: corrected text");
  assert.notEqual(editEvt.params.origin.messageId, editEvt.params.origin.targetMessageId);

  mock.emit(
    remoteDeleteEnvelope({ group: GROUP, targetTimestamp: originalTs, timestamp: originalTs + 2 }),
  );
  const delEvt = await waitFor(() =>
    inbound.find((x) => x.method === "push/event" && x.params.tags?.includes("chat:deleted")),
  );
  assert.equal(delEvt.params.origin.targetMessageId, `${UUIDS.alice}:${originalTs}`);
  assert.equal(delEvt.params.payload.content[0].text, "deleted a message");
  server.stop();
  wire.close();
});
