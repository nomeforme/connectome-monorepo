/* a receive-socket handshake that neither opens nor closes (signal-cli
 * restarting behind an accepting port) is abandoned and retried, never a
 * permanent silence for the account (2026-10-07: all 21 accounts wedged
 * after one signal-cli restart) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignalCli } from "../src/signal-cli.mjs";

test("a hung handshake times out and the loop retries until one opens", async () => {
  let attempts = 0;
  class FakeWS extends EventTarget {
    constructor() {
      super();
      attempts += 1;
      // the first two hang forever; the third opens
      if (attempts >= 3) setTimeout(() => this.dispatchEvent(new Event("open")), 5);
    }
    close() {}
  }
  const logs = [];
  const client = createSignalCli({
    baseUrl: "http://x",
    wsUrl: "ws://x",
    number: "+10000000000",
    log: (l) => logs.push(l),
    WebSocketImpl: /** @type {any} */ (FakeWS),
    backoffMs: { min: 5, max: 10 },
    connectTimeoutMs: 30,
  });
  client.receive(() => {});
  const deadline = Date.now() + 2000;
  while (!client.state.connected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(client.state.connected, true, logs.join("\n"));
  assert.equal(attempts, 3);
  assert.ok(logs.some((l) => /did not open within/.test(l)));
  client.stop();
});
