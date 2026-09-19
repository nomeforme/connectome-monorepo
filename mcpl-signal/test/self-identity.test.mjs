// @ts-check
/* mcpl-signal/test/self-identity.test.mjs — this account's own identity,
 * announced to the host machine-readably and PII-safe (harness-port
 * W6-R1, 2026-09-19): src/self-identity.mjs's pure `selfInfo`/
 * `announceSelf` directly, then the two wire shapes over a real spawned
 * server (server.test.mjs/handshake.test.mjs's own pattern): `initialize`
 * carries `serverInfo.self` when the uuid is already known by then, and a
 * `channels/self` notification carries it the moment it becomes known
 * otherwise — either is correct (a race with the host's own handshake
 * timing), so the integration test accepts whichever one actually landed. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMockSignalCli, NUMBERS, UUIDS } from "./lib/mock-signal-cli.mjs";
import { spawnWire } from "./lib/wire.mjs";
import { announceSelf, selfInfo } from "../src/self-identity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "..", "src", "index.mjs");
const NUMBER_VAR = "HOUSE_SIGNAL_NUMBER_SELFID";
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

test("selfInfo: absent until the uuid is known; numberId is phoneId's own hash", () => {
  assert.equal(selfInfo({ uuid: null, number: NUMBERS.bot }), null);
  const info = selfInfo({ uuid: UUIDS.bot, number: NUMBERS.bot });
  assert.deepEqual(info, { uuid: UUIDS.bot, numberId: sha256(NUMBERS.bot) });
  assert.ok(!JSON.stringify(info).includes(NUMBERS.bot), "the raw number never rides along");
});

test("announceSelf: sends channels/self only once the uuid is known", () => {
  const sent = [];
  const conn = { sendNotification: (m, p) => sent.push([m, p]) };
  announceSelf(conn, { uuid: null, number: NUMBERS.bot });
  assert.deepEqual(sent, [], "no uuid yet — nothing sent");
  announceSelf(conn, { uuid: UUIDS.bot, number: NUMBERS.bot });
  assert.deepEqual(sent, [["channels/self", { self: { uuid: UUIDS.bot, numberId: sha256(NUMBERS.bot) } }]]);
});

let mock;
/** @type {ReturnType<typeof spawnWire>} */
let wire;
const notifications = [];

before(async () => {
  mock = await createMockSignalCli({ identities: [{ number: NUMBERS.bot, uuid: UUIDS.bot }] });
  process.env.SIGNAL_CLI_URL = mock.url;
  process.env[NUMBER_VAR] = NUMBERS.bot;
  wire = spawnWire({
    command: process.execPath,
    args: [INDEX, "--number-env", NUMBER_VAR],
    env: ["SIGNAL_CLI_URL", NUMBER_VAR],
    requestTimeoutMs: 5000,
  });
  wire.onRequest(async () => undefined);
  wire.onNotification((method, params) => notifications.push({ method, params }));
});
after(async () => {
  wire.notify("shutdown");
  await new Promise((r) => wire.onClose(() => r(null)));
  await mock.close();
});

test("initialize carries serverInfo.self when known, else a channels/self notification follows", async () => {
  const init = await wire.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { mcpl: { version: "0.5", featureSets: true } } },
    clientInfo: { name: "t", version: "0" },
  });
  let self = init.serverInfo?.self ?? null;
  if (!self) {
    const t0 = Date.now();
    while (!self) {
      if (Date.now() - t0 > 5000) throw new Error("channels/self notification never arrived");
      await new Promise((r) => setTimeout(r, 25));
      self = notifications.find((n) => n.method === "channels/self")?.params?.self ?? null;
    }
  }
  assert.equal(self.uuid, UUIDS.bot);
  assert.equal(self.numberId, sha256(NUMBERS.bot));
  assert.ok(!JSON.stringify(self).includes(NUMBERS.bot), "the raw number never rides along");
  assert.equal(init.serverInfo.name, "mcpl-signal");
});
