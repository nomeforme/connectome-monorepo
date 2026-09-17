// @ts-check
/* mcpl-signal/test/handshake.test.mjs — conformance over a REAL child
 * process (the server spawned via node, stdio only) with a mock signal-cli
 * behind it, driven directly through test/lib/wire.mjs's `spawnWire` (this
 * package has no host of its own to test against, so the test plays the
 * host's part itself): initialize → the manifest with an RFC-003 revision
 * → featureSets/update as a Request → a receipt → tools/list →
 * channels/register (the mock's group) → channels/open → an envelope on
 * the socket becomes channels/incoming on the open channel and push/event
 * on a closed one → a DM registers by channels/changed → send_message /
 * reply_message hit the mock's /v2/send with the external group id and a
 * quote → typing hits the mock → mcpl/manifest answers the same manifest
 * → an unknown method is a JSON-RPC error, never silence → a
 * Notification-form grant never readies → the plain-MCP path advertises
 * nothing. */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isManifestRevision, manifestDigest } from "@animalabs/mcpl-core";
import { createMockSignalCli, dataMessage, GROUP, mention, NUMBERS, UUIDS } from "./lib/mock-signal-cli.mjs";
import { spawnWire } from "./lib/wire.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "..", "src", "index.mjs");
const NUMBER_VAR = "HOUSE_SIGNAL_NUMBER_ZZ";
const GROUP_STREAM = `signal:group:${GROUP.internal_id}`;

const waitFor = async (fn, ms = 10_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** channels/incoming (one message) or push/event, normalized to one shape */
function normalize(method, params) {
  if (method === "channels/incoming") {
    const m = params.messages[0];
    return {
      envelope: "incoming",
      channelId: m.channelId,
      messageId: m.messageId,
      author: m.author,
      text: m.content.find((b) => b.type === "text")?.text ?? "",
      rawContent: m.metadata.rawContent,
      tags: m.tags,
      mentions: m.metadata.mentions,
    };
  }
  if (method === "push/event") {
    return {
      envelope: "push",
      channelId: params.origin.channelId,
      messageId: params.origin.messageId,
      author: { id: params.origin.authorId, name: params.origin.authorName },
      text: params.payload.content.find((b) => b.type === "text")?.text ?? "",
      rawContent: params.origin.rawContent,
      tags: params.tags,
      mentions: params.origin.mentions,
    };
  }
  return null;
}

let mock;
/** @type {ReturnType<typeof spawnWire>} */
let wire;
const channels = new Map();
const seen = [];

before(async () => {
  mock = await createMockSignalCli({
    groups: [{ ...GROUP, members: [NUMBERS.bot, UUIDS.alice] }],
    identities: [{ number: NUMBERS.bot, uuid: UUIDS.bot }],
  });
  process.env.SIGNAL_CLI_URL = mock.url;
  process.env[NUMBER_VAR] = NUMBERS.bot;
  wire = spawnWire({
    command: process.execPath,
    args: [INDEX, "--number-env", NUMBER_VAR],
    env: ["SIGNAL_CLI_URL", NUMBER_VAR],
    requestTimeoutMs: 5000,
  });
  wire.onRequest(async (method, params) => {
    if (method === "channels/register" || method === "channels/changed") {
      const list = params.channels ?? params.added;
      for (const d of list) channels.set(d.id, d);
      return { results: list.map((d) => ({ id: d.id, accepted: true })) };
    }
    const n = normalize(method, params);
    if (n) seen.push(n);
    if (method === "channels/incoming")
      return { results: params.messages.map((m) => ({ messageId: m.messageId, accepted: true })) };
    if (method === "push/event") return { accepted: true };
    return undefined;
  });
});
after(async () => {
  wire.notify("shutdown");
  await new Promise((r) => wire.onClose(() => r(null)));
  await mock.close();
});

test("handshake: manifest, revision, Request-form grant, receipt, tools, channels/register", async () => {
  const init = await wire.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { mcpl: { version: "0.5", featureSets: true } } },
    clientInfo: { name: "t", version: "0" },
  });
  const manifest = init.capabilities.experimental.mcpl;
  assert.equal(manifest.version, "0.5");
  assert.ok(isManifestRevision(manifest.revision));
  assert.equal(manifestDigest(manifest), manifest.revision, "the digest recomputes");
  wire.notify("notifications/initialized");
  const receipt = await wire.request("featureSets/update", {
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
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, undefined, "nothing degraded → no mode");
  assert.deepEqual(receipt.unavailableFeatures, []);
  const list = await wire.request("tools/list", {});
  assert.deepEqual(
    list.tools.map((t) => t.name).sort(),
    ["add_reaction", "list_groups", "reply_message", "send_message"],
  );
  await waitFor(() => channels.has(GROUP_STREAM));
  const d = channels.get(GROUP_STREAM);
  assert.equal(d.type, "signal");
  assert.equal(d.metadata.memberCount, 2);
  assert.ok(!JSON.stringify(d).includes("555"), "no number in a descriptor");
  await wire.request("channels/open", { channelId: GROUP_STREAM });
  assert.equal(mock.state.receivePaths.length, 1, "one receive socket");
  assert.equal(mock.state.receivePaths[0], `/v1/receive/${encodeURIComponent(NUMBERS.bot)}`);
});

test("an ambient group message on the OPEN channel arrives as channels/incoming", async () => {
  mock.emit(dataMessage({ text: "morning all", group: GROUP }));
  const m = await waitFor(() => seen.find((x) => x.text.includes("morning all")));
  assert.equal(m.envelope, "incoming");
  assert.equal(m.channelId, GROUP_STREAM);
  assert.equal(m.author.id, UUIDS.alice);
  assert.equal(m.author.name, "alice");
  assert.equal(m.text, "alice: morning all");
  assert.equal(m.rawContent, "morning all");
  assert.ok(m.tags.includes("chat:ambient") && m.tags.includes("chat:group"));
  assert.ok(m.tags.includes("chat:from-human"));
  assert.match(m.messageId, new RegExp(`^${UUIDS.alice}:\\d+$`));
});

test("closed channel: ambient is missed, a mention of the account is push/event", async () => {
  await wire.request("channels/close", { channelId: GROUP_STREAM });
  mock.emit(dataMessage({ text: "nobody in particular", group: GROUP }));
  mock.emit(
    dataMessage({ text: "￼ are you there", group: GROUP, mentions: [mention(UUIDS.bot, 0)] }),
  );
  const m = await waitFor(() => seen.find((x) => x.text.includes("are you there")));
  assert.equal(m.envelope, "push");
  assert.equal(m.rawContent, `<@${UUIDS.bot}> are you there`);
  assert.equal(
    m.text,
    "alice: @aaaaaaaa are you there",
    "prose names what it knows; the token is in rawContent",
  );
  assert.ok(m.tags.includes("chat:mention") && m.tags.includes("chat:addressed"));
  assert.ok(!m.tags.includes("chat:ambient"));
  assert.deepEqual(m.mentions, [UUIDS.bot]);
  assert.ok(
    !seen.some((x) => x.text.includes("nobody in particular")),
    "ambient never left a closed channel",
  );
});

test("a DM registers its channel by channels/changed and pushes as chat:dm", async () => {
  mock.emit(dataMessage({ text: "psst" }));
  const m = await waitFor(() => seen.find((x) => x.text.includes("psst")));
  assert.equal(m.channelId, `signal:dm:${UUIDS.alice}`);
  assert.ok(
    m.tags.includes("chat:dm") && m.tags.includes("chat:private") && m.tags.includes("chat:addressed"),
  );
  await waitFor(() => channels.has(m.channelId));
  const d = channels.get(m.channelId);
  assert.equal(d.metadata.recipientName, "alice");
  assert.ok(!JSON.stringify(d).includes("555"));
});

test("tools: send_message and reply_message hit /v2/send with the external group id, a quote, and typing", async () => {
  const r1 = await wire.request("tools/call", {
    name: "send_message",
    arguments: { channelId: GROUP_STREAM, content: "hello porch" },
  });
  const j1 = JSON.parse(r1.content[0].text);
  assert.match(j1.messageId, new RegExp(`^${UUIDS.bot}:\\d+$`));
  const sent = mock.state.sent.at(-1);
  assert.deepEqual(sent.recipients, [GROUP.id], "the EXTERNAL id, mapped through /v1/groups");
  assert.equal(sent.message, "hello porch");
  assert.equal(sent.number, NUMBERS.bot, "the number goes to signal-cli and nowhere else");
  const inbound = seen.find((x) => x.text.includes("are you there"));
  const r2 = await wire.request("tools/call", {
    name: "reply_message",
    arguments: { channelId: GROUP_STREAM, messageId: inbound.messageId, content: "here" },
  });
  assert.ok(JSON.parse(r2.content[0].text).messageId);
  const reply = mock.state.sent.at(-1);
  assert.equal(reply.quote_author, UUIDS.alice);
  assert.equal(String(reply.quote_timestamp), inbound.messageId.split(":")[1]);
  await wire.request("channels/typing", { channelId: GROUP_STREAM, op: "start" });
  await waitFor(() => mock.state.typing.length >= 1);
  assert.equal(mock.state.typing[0].method, "PUT");
  assert.deepEqual(mock.state.typing[0].body, { recipient: GROUP.id });
});

test("mcpl/manifest answers the whole manifest; an unknown method is an error, never silence", async () => {
  const init = await wire.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { mcpl: { version: "0.5", featureSets: true } } },
    clientInfo: { name: "probe", version: "0" },
  });
  const manifest = await wire.request("mcpl/manifest", {});
  assert.deepEqual(manifest, init.capabilities.experimental.mcpl, "unchanged for the life of the connection");
  await assert.rejects(wire.request("inference/nope", {}), /-32601|not supported/);
});

test("capability-denied before a grant; a Notification-form grant never readies; the plain-MCP path advertises nothing", async () => {
  const wire2 = spawnWire({
    command: process.execPath,
    args: [INDEX, "--number-env", NUMBER_VAR],
    env: ["SIGNAL_CLI_URL", NUMBER_VAR],
    requestTimeoutMs: 5000,
  });
  wire2.onRequest(async () => ({}));
  try {
    await wire2.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { experimental: { mcpl: { version: "0.5", featureSets: true } } },
      clientInfo: { name: "probe2", version: "0" },
    });
    wire2.notify("notifications/initialized");
    await assert.rejects(
      wire2.request("channels/open", { channelId: GROUP_STREAM }),
      /-32002|capability/,
    );
    await assert.rejects(
      wire2.request("tools/call", { name: "send_message", arguments: {} }),
      /capability/,
    );
    // a Notification-form grant never readies
    wire2.notify("featureSets/update", { effectiveCapabilities: ["tools", "channels.lifecycle"] });
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(wire2.request("channels/open", { channelId: GROUP_STREAM }), /capability/);
    // the plain-MCP path: no experimental.mcpl advertised → none returned
    const plain = await wire2.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "p", version: "0" },
    });
    assert.equal(plain.capabilities.experimental, undefined);
  } finally {
    wire2.notify("shutdown");
    await new Promise((r) => wire2.onClose(() => r(null)));
  }
});
