// @ts-check
/* mcpl-web/test/handshake.test.mjs — conformance over a REAL child
 * process (src/index.mjs spawned via node, stdio only) with a fake board
 * behind it, the test playing the host (test/lib/wire.mjs's spawnWire):
 * initialize → the manifest with an RFC-003 revision → featureSets/update
 * as a Request → a receipt → tools/list → channels/register from the
 * board's hello.rooms → self (serverInfo.self or channels/self) → an
 * inbound post as channels/incoming on an opened channel → send_message
 * through the board's ack → mcpl/manifest → an unknown method is an
 * error. Plus the environment check: a missing variable exits 2, naming
 * the variable and never a value. Each test has its own board and child. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isManifestRevision, manifestDigest } from "@animalabs/mcpl-core";
import { FULL_GRANT } from "./lib/boot.mjs";
import { createFakeBoard, PRINCIPALS, ROOMS, TOKENS, waitFor } from "./lib/fake-board.mjs";
import { spawnWire } from "./lib/wire.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "..", "src", "index.mjs");
const GENERAL = ROOMS[0].id;

test("handshake over a real child: manifest, grant, tools, channels/register from hello, self, a post in, a send out", async (t) => {
  const board = await createFakeBoard();
  t.after(() => board.close());
  process.env.WEB_BOARD_URL = board.url;
  process.env.WEB_BOARD_TOKEN = TOKENS.fable;
  process.env.WEB_POLICY_GRACE_MS = "5000";
  const wire = spawnWire({
    command: process.execPath,
    args: [INDEX],
    env: ["WEB_BOARD_URL", "WEB_BOARD_TOKEN", "WEB_POLICY_GRACE_MS"],
    requestTimeoutMs: 8000,
  });
  const closed = new Promise((r) => wire.onClose(() => r(null)));
  t.after(async () => {
    wire.notify("shutdown");
    await closed;
  });
  /** @type {Map<string, any>} */
  const channels = new Map();
  /** @type {any[]} */
  const incoming = [];
  /** @type {any[]} */
  const selfNotes = [];
  wire.onRequest(async (method, params) => {
    if (method === "channels/register" || method === "channels/changed") {
      const list = params.channels ?? params.added;
      for (const d of list) channels.set(d.id, { ...d, via: method });
      return { results: list.map((d) => ({ id: d.id, accepted: true })) };
    }
    if (method === "channels/incoming") {
      incoming.push(...params.messages);
      return { results: params.messages.map((m) => ({ messageId: m.messageId, accepted: true })) };
    }
    if (method === "push/event") return { accepted: true };
    return undefined;
  });
  wire.onNotification((method, params) => {
    if (method === "channels/self") selfNotes.push(params.self);
  });

  const init = /** @type {any} */ (
    await wire.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { experimental: { mcpl: { version: "0.5", featureSets: true } } },
      clientInfo: { name: "t", version: "0" },
    })
  );
  const manifest = init.capabilities.experimental.mcpl;
  assert.equal(manifest.version, "0.5");
  assert.ok(isManifestRevision(manifest.revision));
  assert.equal(manifestDigest(manifest), manifest.revision, "the digest recomputes");
  assert.deepEqual(manifest.channels, { register: true, lifecycle: true, publish: true, incoming: true, typing: true });
  assert.equal(init.serverInfo.name, "mcpl-web");
  wire.notify("notifications/initialized");

  const receipt = /** @type {any} */ (await wire.request("featureSets/update", { effectiveCapabilities: FULL_GRANT }));
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, undefined, "nothing degraded → no mode");
  assert.deepEqual(receipt.unavailableFeatures, []);

  const list = /** @type {any} */ (await wire.request("tools/list", {}));
  assert.deepEqual(list.tools.map((x) => x.name).sort(), ["reply_message", "send_message"]);

  // channels/register carries every room the hello listed, in one request
  await waitFor(() => channels.size === ROOMS.length);
  for (const room of ROOMS) {
    const d = channels.get(room.id);
    assert.equal(d.via, "channels/register");
    assert.equal(d.type, "web");
    assert.equal(d.direction, "bidirectional");
    assert.equal(d.label, `${room.title} (web)`);
    assert.equal(d.metadata.roomTitle, room.title);
    assert.equal(d.metadata.community, "commons");
  }

  // self: either at initialize (the hello won the race) or by channels/self
  const self = init.serverInfo.self ?? (await waitFor(() => selfNotes[0]));
  assert.deepEqual(self, { id: PRINCIPALS.fable.id, display: PRINCIPALS.fable.display });

  await wire.request("channels/open", { channelId: GENERAL });
  await waitFor(() => board.subscribedCount() === 1);
  const post = board.emitPost({ text: "@Fable are you around?" });
  const m = await waitFor(() => incoming.find((x) => x.messageId === post.id));
  assert.equal(m.channelId, GENERAL);
  assert.equal(m.author.id, PRINCIPALS.bob.id);
  assert.ok(m.metadata.mentions.includes(PRINCIPALS.fable.id));

  const sent = /** @type {any} */ (
    await wire.request("tools/call", { name: "send_message", arguments: { channelId: GENERAL, content: "here" } })
  );
  const { messageId } = JSON.parse(sent.content[0].text);
  const onBoard = board.state.posts.find((p) => p.id === messageId);
  assert.ok(onBoard, "the result names the board's own post id");
  assert.equal(onBoard.author.id, PRINCIPALS.fable.id);
  assert.equal(onBoard.text, "here");

  const again = /** @type {any} */ (await wire.request("mcpl/manifest", {}));
  assert.equal(again.revision, manifest.revision);
  await assert.rejects(wire.request("no/such-method", {}), (e) => /not supported/.test(e.message));
});

test("a missing variable exits 2, naming the variable — never a value", async () => {
  const child = spawn(process.execPath, [INDEX], {
    env: { PATH: process.env.PATH ?? "", WEB_BOARD_URL: "http://127.0.0.1:1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  assert.equal(code, 2);
  assert.match(stderr, /WEB_BOARD_TOKEN is not set/);
});
