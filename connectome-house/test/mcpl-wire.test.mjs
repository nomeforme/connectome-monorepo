// @ts-check
/* harness/test/mcpl-wire.test.mjs — the wire alone: NDJSON framing,
 * request/response correlation, a server→host Request answered (and an
 * unsupported one answered with an ERROR, never silence), a timeout, the
 * child leaving. Half against an in-process PassThrough pair, half against
 * the house's own mock server as a real child. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  METHOD,
  childEnv,
  expandTagClosure,
  manifestRevision,
  openWire,
  rpcError,
  spawnWire,
} from "../src/mcpl/wire.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");
/** every wire this file opens — closed in after(), so a failed assertion never leaks a child */
const wires = [];
after(() => {
  for (const w of wires) if (!w.isClosed()) w.close();
});

/** a host-side wire and a fake server-side reader/writer over two pipes */
function pair() {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const wire = openWire({ readable: toHost, writable: toServer, requestTimeoutMs: 300 });
  wires.push(wire);
  const serverLines = [];
  toServer.on("data", (b) => {
    for (const l of b.toString().split("\n")) if (l.trim()) serverLines.push(JSON.parse(l));
  });
  const serverSend = (m) => toHost.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const nextServerLine = async (pred = () => true) => {
    for (let i = 0; i < 50; i++) {
      const idx = serverLines.findIndex(pred);
      if (idx !== -1) return serverLines.splice(idx, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no server line");
  };
  return { wire, serverSend, nextServerLine, toHost };
}

test("framing + correlation: two requests in flight, answered out of order", async () => {
  const { wire, serverSend, nextServerLine } = pair();
  const a = wire.request("tools/list");
  const b = wire.request("channels/open", { channelId: "mock:c1" });
  const reqA = await nextServerLine((m) => m.method === "tools/list");
  const reqB = await nextServerLine((m) => m.method === "channels/open");
  assert.equal(reqA.jsonrpc, "2.0");
  assert.notEqual(reqA.id, reqB.id);
  assert.deepEqual(reqB.params, { channelId: "mock:c1" });
  serverSend({ id: reqB.id, result: { channel: { id: "mock:c1" } } });
  serverSend({ id: reqA.id, result: { tools: [] } });
  assert.deepEqual(await b, { channel: { id: "mock:c1" } });
  assert.deepEqual(await a, { tools: [] });
  wire.close();
});

test("a server→host Request is answered; an unsupported one gets -32601, never silence", async () => {
  const { wire, serverSend, nextServerLine } = pair();
  wire.onRequest(async (method, params) => {
    if (method === METHOD.PUSH_EVENT) return { accepted: true, seen: params.eventId };
    if (method === "model/info") return rpcError(-32601, "model/info is not supported here");
    return undefined;
  });
  serverSend({ id: 7, method: "push/event", params: { eventId: "e1" } });
  const r1 = await nextServerLine((m) => m.id === 7);
  assert.deepEqual(r1.result, { accepted: true, seen: "e1" });
  serverSend({ id: 8, method: "model/info", params: {} });
  const r2 = await nextServerLine((m) => m.id === 8);
  assert.equal(r2.error.code, -32601);
  serverSend({ id: 9, method: "something/else", params: {} });
  const r3 = await nextServerLine((m) => m.id === 9);
  assert.equal(r3.error.code, -32601);
  // a handler that throws still answers (internal error), never hangs the id
  wire.onRequest(() => {
    throw new Error("boom");
  });
  serverSend({ id: 10, method: "push/event", params: {} });
  const r4 = await nextServerLine((m) => m.id === 10);
  assert.equal(r4.error.code, -32603);
  wire.close();
});

test("notifications reach the handler; an error response rejects the pending request", async () => {
  const { wire, serverSend, nextServerLine } = pair();
  const seen = [];
  wire.onNotification((m, p) => seen.push([m, p]));
  serverSend({ method: "mcpl/manifestChanged", params: { revision: "x" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [["mcpl/manifestChanged", { revision: "x" }]]);
  const p = wire.request("tools/call", { name: "nope" });
  const req = await nextServerLine((m) => m.method === "tools/call");
  serverSend({ id: req.id, error: { code: -32602, message: "unknown tool" } });
  await assert.rejects(p, /unknown tool/);
  wire.close();
});

test("a request times out when the server never answers", async () => {
  const { wire } = pair();
  await assert.rejects(wire.request("tools/list", undefined, 50), /timed out/);
  wire.close();
});

test("the readable ending closes the wire and rejects what is still pending", async () => {
  const { wire, toHost } = pair();
  let closed = null;
  wire.onClose((info) => {
    closed = info;
  });
  const p = wire.request("tools/list", undefined, 0);
  toHost.end();
  await assert.rejects(p);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(closed, { code: null, signal: null });
  assert.equal(wire.isClosed(), true);
});

test("tag closure is the spec's, not the producer's", () => {
  assert.deepEqual(expandTagClosure(["chat:mention", "chat:ambient"]).sort(), [
    "chat:addressed",
    "chat:mention",
  ]);
  assert.deepEqual(expandTagClosure(["chat:dm"]).sort(), [
    "chat:addressed",
    "chat:dm",
    "chat:private",
  ]);
  assert.deepEqual(expandTagClosure(["chat:ambient", "chat:from-bot"]).sort(), [
    "chat:ambient",
    "chat:from-bot",
  ]);
  assert.deepEqual(expandTagClosure(undefined), []);
});

test("manifestRevision: stable, ignores its own revision field, and never throws", () => {
  const m = { version: "0.5", pushEvents: true, featureSets: { a: { uses: ["tools"] } } };
  const r1 = manifestRevision(m);
  assert.match(r1, /^sha256:[A-Za-z0-9_-]{43}$/);
  assert.equal(manifestRevision({ ...m, revision: "sha256:stale" }), r1);
  assert.notEqual(manifestRevision({ ...m, pushEvents: false }), r1);
  // an identifier the library refuses still yields an equality-only digest
  const weird = { version: "0.4", featureSets: [{ name: "has spaces!", uses: ["tools"] }] };
  assert.match(manifestRevision(weird), /^(sha256|json-sha256):/);
});

test("childEnv renames CHILD=HOUSE — discord-mcpl's DISCORD_TOKEN from the house's per-handle variable", () => {
  const env = childEnv(["DISCORD_TOKEN=HOUSE_DISCORD_TOKEN_ARIA", "PLAIN"], {
    PATH: "/bin",
    HOUSE_DISCORD_TOKEN_ARIA: "tok-aria",
    PLAIN: "p",
    DISCORD_TOKEN: "must-not-leak",
  });
  assert.equal(env.DISCORD_TOKEN, "tok-aria");
  assert.equal(env.PLAIN, "p");
  assert.equal(env.HOUSE_DISCORD_TOKEN_ARIA, undefined);
});

test("childEnv passes only named variables, never the whole environment", () => {
  const env = childEnv(["MOCK_TOKEN", "MISSING"], {
    PATH: "/bin",
    MOCK_TOKEN: "t",
    SECRET_OTHER: "no",
  });
  assert.deepEqual(env, { PATH: "/bin", MOCK_TOKEN: "t" });
});

test("spawnWire: the mock server as a real child — initialize, then exit on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "house-mcpl-wire-"));
  const fixture = join(dir, "fixture.json");
  writeFileSync(fixture, JSON.stringify({ channels: [] }));
  const wire = spawnWire({ command: "node", args: [MOCK, fixture, join(dir, "rec.jsonl")] });
  wires.push(wire);
  const init = /** @type {any} */ (
    await wire.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { experimental: { mcpl: { version: "0.5" } } },
      clientInfo: { name: "test", version: "0" },
    })
  );
  assert.equal(init.serverInfo.name, "mock-mcpl");
  assert.equal(init.capabilities.experimental.mcpl.version, "0.5");
  const closed = new Promise((r) => wire.onClose(r));
  wire.notify("shutdown");
  const info = await closed;
  assert.equal(info.code, 0);
  assert.equal(wire.isClosed(), true);
});

test("a non-JSON line on stdout is a debug-level skip, logged once per connection — never a repeating error; a real wire error still logs in full every time", async () => {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const logs = [];
  const wire = openWire({ readable: toHost, writable: toServer, requestTimeoutMs: 300, log: (l) => logs.push(l) });
  wires.push(wire);
  toHost.write("[discord-mcpl] some stray console line, not JSON-RPC at all\n");
  toHost.write("another stray line, same connection\n");
  await new Promise((r) => setTimeout(r, 30));
  const malformed = logs.filter((l) => l.includes("Malformed JSON-RPC message"));
  assert.equal(malformed.length, 1, "logged once, not once per stray line");
  assert.match(malformed[0], /^debug:/);
  assert.ok(!logs.some((l) => l.startsWith("wire error:")), "never the error-level line for this class");
  // the readable side is wrapped by node's own readline.Interface, which
  // rethrows an 'error' emitted directly on it (a second, unrelated
  // listener) — the writable side has no such wrapper, so it is the one
  // that exercises "a real wire error" here without that artifact.
  toServer.emit("error", new Error("boom"));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(logs.includes("wire error: boom"), "a genuine wire error still logs in full, every time");
});
