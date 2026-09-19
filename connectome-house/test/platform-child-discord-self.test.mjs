// @ts-check
/* connectome-house/test/platform-child-discord-self.test.mjs — harness-
 * port W6-R5, 2026-09-19: THE BUG's being-hosted half, child.mjs's own
 * corner. discord-mcpl's own connect line ("[discord-mcpl] Discord
 * connected as bot <id>") is the ONLY way this being's own account id
 * ever surfaces — no `channels/self` notification of its own, unlike
 * mcpl-signal. child.mjs's `say` (wire.mjs's own spawnWire forwards every
 * stderr line here, "stderr: " prefixed) parses it into `state.self.id`,
 * re-firing `onReady` exactly like the "channels/self" case one function
 * above it — so platform-runner.mjs's own `sendHello` (which reads
 * `snap.self`) goes out again carrying it.
 *
 * A fake `spawn` stands in for wire.mjs's own spawnWire — no real
 * process, no socket, just enough of the Wire shape for child.mjs's own
 * handshake to reach "ready"; full control over the exact line the
 * child's own log callback receives (spawnChild's `spawn` option is
 * already overridable — a test seam, not a new one). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnChild } from "../src/mcpl/child.mjs";

const MANIFEST = {
  version: "0.5",
  pushEvents: true,
  inferenceLifecycle: true,
  channels: { register: true, publish: true, incoming: true, lifecycle: true, typing: true },
  featureSets: { "mock.messaging": { description: "d", uses: ["tools"] } },
};

/** just enough of wire.mjs's own Wire interface for one handshake. */
function fakeWire() {
  let closed = false;
  return {
    onRequest() {},
    onNotification() {},
    onClose() {},
    isClosed: () => closed,
    close() {
      closed = true;
    },
    notify() {},
    request(method) {
      if (method === "initialize")
        return Promise.resolve({
          capabilities: { tools: {}, experimental: { mcpl: MANIFEST } },
          serverInfo: {},
        });
      if (method === "featureSets/update") return Promise.resolve({ accepted: true });
      if (method === "tools/list") return Promise.resolve({ tools: [] });
      return Promise.resolve({});
    },
  };
}

test("discord-mcpl's own connect line, forwarded through stderr, sets state.self.id and re-fires onReady", async () => {
  /** @type {((line: string) => void)|null} */
  let capturedLog = null;
  let readyCount = 0;
  /** @type {any} */
  let lastSnapshot = null;
  const handle = spawnChild(
    { name: "srv1", platform: "discord", command: "node", args: [] },
    {
      spawn: (opts) => {
        capturedLog = opts.log;
        return fakeWire();
      },
      onReady: (snap) => {
        readyCount += 1;
        lastSnapshot = snap;
      },
    },
  );
  await handle.start();
  assert.equal(readyCount, 1, "the initial handshake fired onReady once");
  assert.equal(lastSnapshot.self, null, "no id known yet");
  assert.ok(capturedLog, "the child's own log callback reached spawn() (wire.mjs's own stderr path)");

  // exactly the line wire.mjs's own spawnWire forwards (its stderr
  // handler prefixes every line "stderr: " before calling this same log).
  /** @type {(line: string) => void} */ (capturedLog)(
    "stderr: [discord-mcpl] Discord connected as bot 555000000000000099",
  );

  assert.equal(readyCount, 2, "a NEW self fires a fresh onReady, same as the Signal `channels/self` path");
  assert.deepEqual(
    handle.snapshot().self,
    { id: "555000000000000099" },
    "state.self.id set from the stderr line",
  );

  // idempotent: the same id again is not a change, no extra onReady.
  /** @type {(line: string) => void} */ (capturedLog)(
    "stderr: [discord-mcpl] Discord connected as bot 555000000000000099",
  );
  assert.equal(readyCount, 2, "an unchanged id fires no extra onReady");
});
