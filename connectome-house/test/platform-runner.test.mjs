// @ts-check
/* connectome-house/test/platform-runner.test.mjs — platform-runner.mjs
 * against a REAL mock MCPL child (test/lib/mock-mcpl-server.mjs, exactly
 * as mcpl-wire.test.mjs drives it) and a FAKE house seat (a minimal
 * send/on/isLive double this file owns — no real networking, full
 * control over "the house is down" without timing-dependent socket
 * teardown). Covers the mission's five proof points: hello carries the
 * mock's tools/channels; an inbound scripted message becomes
 * platform.incoming; a platform.call round-trips to platform.result by
 * id; the house-down buffer flushes hello-then-messages on reseat, in
 * order; a scripted crash yields platform.child "exited" and a restart
 * (a second hello). */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_ROOM } from "@connectome/seat-protocol";
import { spawnChild } from "../src/mcpl/child.mjs";
import { startPlatformRunner } from "../src/platform-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");

/** every runner this file starts — stopped in after() so a failed
 * assertion never leaves a mock child running. */
const runners = [];
after(() => {
  for (const r of runners) r.stop();
});

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "platform-runner-"));
}

/** a minimal being<->house seat double: send/on/isLive only, exactly the
 * surface platform-runner.mjs reads (the same shape SeatClient/StdioSeat
 * both expose) — full control over liveness, no real socket teardown. */
function makeFakeSeat() {
  let live = true;
  const sent = [];
  /** @type {Map<string, Array<(msg: any) => void>>} */
  const handlers = new Map();
  return {
    sent,
    setLive(v) {
      live = v;
    },
    isLive: () => live,
    send(msg) {
      if (!live) return false;
      sent.push(msg);
      return true;
    },
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    trigger(type, msg) {
      for (const fn of handlers.get(type) ?? []) fn(msg);
    },
  };
}

/** poll `pred` until it returns a truthy value, or throw after `timeoutMs`. */
async function waitFor(pred, { timeoutMs = 3000, stepMs = 15 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test("platform.hello arrives carrying the mock's own tools and channels", async () => {
  const dir = fixtureDir();
  const fixture = join(dir, "fixture.json");
  writeFileSync(fixture, JSON.stringify({ channels: [{ id: "mock:c1", kind: "channel" }] }));
  const seat = makeFakeSeat();
  const runner = startPlatformRunner({
    being: "aria",
    seat,
    servers: [{ name: "srv1", platform: "mock", command: "node", args: [MOCK, fixture, join(dir, "rec.jsonl")] }],
  });
  runners.push(runner);

  const hello = /** @type {any} */ (await waitFor(() => seat.sent.find((m) => m.type === "platform.hello")));
  assert.equal(hello.room, PLATFORM_ROOM);
  assert.equal(hello.server, "srv1");
  assert.equal(hello.platform, "mock");
  assert.equal(hello.being, "aria");
  assert.deepEqual([...hello.tools].sort(), ["reply_message", "send_message"]);
  assert.equal(hello.channels.length, 1);
  assert.equal(hello.channels[0].id, "mock:c1");
});

test("an inbound scripted message becomes a platform.incoming", async () => {
  const dir = fixtureDir();
  const fixture = join(dir, "fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      channels: [{ id: "mock:c1", kind: "channel" }],
      script: [{ after_ms: 50, incoming: { messageId: "m1", channelId: "mock:c1", content: [{ type: "text", text: "hi" }] } }],
    }),
  );
  const seat = makeFakeSeat();
  const runner = startPlatformRunner({
    being: "aria",
    seat,
    servers: [{ name: "srv1", platform: "mock", command: "node", args: [MOCK, fixture, join(dir, "rec.jsonl")] }],
  });
  runners.push(runner);

  const incoming = /** @type {any} */ (await waitFor(() => seat.sent.find((m) => m.type === "platform.incoming")));
  assert.equal(incoming.server, "srv1");
  assert.equal(incoming.msg.channelId, "mock:c1");
  assert.equal(incoming.msg.text, "hi");
});

test("a platform.call reaches the mock and its platform.result comes back with the same id", async () => {
  const dir = fixtureDir();
  const fixture = join(dir, "fixture.json");
  writeFileSync(fixture, JSON.stringify({ channels: [{ id: "mock:c1", kind: "channel" }] }));
  const seat = makeFakeSeat();
  const runner = startPlatformRunner({
    being: "aria",
    seat,
    servers: [{ name: "srv1", platform: "mock", command: "node", args: [MOCK, fixture, join(dir, "rec.jsonl")] }],
  });
  runners.push(runner);

  await waitFor(() => seat.sent.find((m) => m.type === "platform.hello"));
  seat.trigger("platform.call", {
    type: "platform.call",
    room: PLATFORM_ROOM,
    server: "srv1",
    id: "call-1",
    name: "send_message",
    args: { channelId: "mock:c1", content: "hey" },
  });
  const result = /** @type {any} */ (
    await waitFor(() => seat.sent.find((m) => m.type === "platform.result" && m.id === "call-1"))
  );
  assert.equal(result.server, "srv1");
  assert.equal(result.ok, true);
  assert.match(result.result?.content?.[0]?.text ?? "", /messageId/);
});

test("a platform.call for an unknown server answers ok:false rather than hanging", async () => {
  const dir = fixtureDir();
  const fixture = join(dir, "fixture.json");
  writeFileSync(fixture, JSON.stringify({ channels: [] }));
  const seat = makeFakeSeat();
  const runner = startPlatformRunner({
    being: "aria",
    seat,
    servers: [{ name: "srv1", platform: "mock", command: "node", args: [MOCK, fixture, join(dir, "rec.jsonl")] }],
  });
  runners.push(runner);

  seat.trigger("platform.call", {
    type: "platform.call",
    room: PLATFORM_ROOM,
    server: "no-such-server",
    id: "call-x",
    name: "send_message",
    args: {},
  });
  const result = /** @type {any} */ (
    await waitFor(() => seat.sent.find((m) => m.type === "platform.result" && m.id === "call-x"))
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /no such server/);
});

test("house socket down -> inbound buffered -> reseated -> hello then the buffered message, in order", async () => {
  const dir = fixtureDir();
  const fixture = join(dir, "fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      channels: [{ id: "mock:c1", kind: "channel" }],
      script: [{ after_ms: 300, incoming: { messageId: "m2", channelId: "mock:c1", content: [{ type: "text", text: "buffered-msg" }] } }],
    }),
  );
  const seat = makeFakeSeat();
  const runner = startPlatformRunner({
    being: "aria",
    seat,
    reseatPollMs: 20,
    servers: [{ name: "srv1", platform: "mock", command: "node", args: [MOCK, fixture, join(dir, "rec.jsonl")] }],
  });
  runners.push(runner);

  await waitFor(() => seat.sent.find((m) => m.type === "platform.hello")); // initial ready
  seat.sent.length = 0; // only post-close traffic matters from here
  seat.setLive(false);

  // the scripted incoming fires at 300ms while the seat is down.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(seat.sent.length, 0, "nothing was actually SENT while the house was down");

  seat.setLive(true); // reseat — polled every 20ms
  const helloAgain = /** @type {any} */ (await waitFor(() => seat.sent.find((m) => m.type === "platform.hello")));
  const incomingAfter = /** @type {any} */ (await waitFor(() => seat.sent.find((m) => m.type === "platform.incoming")));
  assert.ok(
    seat.sent.indexOf(helloAgain) < seat.sent.indexOf(incomingAfter),
    "the fresh hello is sent before the buffered message it unblocked",
  );
  assert.equal(incomingAfter.msg.text, "buffered-msg");
});

test("child exit -> platform.child \"exited\", then a restart brings a second hello", async () => {
  const dir = fixtureDir();
  const fixture = join(dir, "fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({ channels: [{ id: "mock:c1", kind: "channel" }], script: [{ after_ms: 100, crash: true }] }),
  );
  const seat = makeFakeSeat();
  const fastSpawn = (server, opts) => spawnChild(server, { ...opts, backoffMs: { min: 40, max: 80 } });
  const runner = startPlatformRunner({
    being: "aria",
    seat,
    spawnChildFn: fastSpawn,
    servers: [{ name: "srv1", platform: "mock", command: "node", args: [MOCK, fixture, join(dir, "rec.jsonl")] }],
  });
  runners.push(runner);

  await waitFor(() => seat.sent.find((m) => m.type === "platform.hello")); // first ready, before the scripted crash
  const exited = /** @type {any} */ (
    await waitFor(() => seat.sent.find((m) => m.type === "platform.child" && m.state === "exited"))
  );
  assert.equal(exited.server, "srv1");

  const secondHello = await waitFor(
    () => seat.sent.filter((m) => m.type === "platform.hello").length >= 2,
    { timeoutMs: 4000 },
  );
  assert.ok(secondHello, "restarted and became ready again after the backoff");
});
