// @ts-check
/* mcpl-signal/test/conformance.test.mjs — table-driven conformance vectors:
 * one signal-cli-rest-api json-rpc envelope (test/fixtures/envelopes/*.json)
 * → the exact MCPL wire payload this server emits for it (channels/incoming
 * and/or push/event), per the port's own L0 conformance method
 * (docs/harness-port/02-user-contract.md §9: "a table generated once from
 * the fork's own functions ... lives as test fixture data, never vendored
 * into production code"). Regenerate with
 * scripts/generate-envelope-fixtures.mjs (deliberately outside test/, so
 * it never auto-runs as a test itself) ONLY after a deliberate mapping
 * change, and diff before committing — this test is what would catch an
 * accidental one. Every fixture's own PII (numbers) is a fixture-only
 * +1555… value; the assertion below re-confirms none reaches an output. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  mapEnvelope,
  toDeletePush,
  toEditPush,
  toIncoming,
  toPush,
  toReactionPush,
} from "../src/envelopes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "fixtures", "envelopes");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

assert.ok(files.length > 0, "the fixtures dir must not be empty");

for (const file of files) {
  const doc = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  test(`conformance vector: ${doc.name} — ${doc.description}`, () => {
    // the fixture's own known-names convention: alice/carol, matching
    // generate-envelopes.mjs exactly (a fixture is only as portable as the
    // host-name assumption baked into its golden output).
    const KNOWN_NAMES = {
      "aaaaaaaa-0000-4000-8000-000000000002": "alice",
      "aaaaaaaa-0000-4000-8000-000000000003": "carol",
    };
    const named = (id) => KNOWN_NAMES[id] ?? null;

    const m = mapEnvelope(doc.raw, doc.self);
    assert.equal(m.kind, doc.expect.kind, "mapped kind");
    if (doc.expect.kind === "skip") {
      assert.equal(m.reason, doc.expect.reason, "skip reason");
      return;
    }
    assert.equal(m.channelId, doc.expect.channelId, "channelId");
    assert.equal(m.messageId, doc.expect.messageId, "messageId");
    const images = doc.images ?? [];
    if (m.kind === "message" || m.kind === "edited") {
      const textOffset = m.dotPrefixed ? 1 : 0;
      assert.deepEqual(toIncoming(m, named, images, textOffset), doc.expect.incoming, "channels/incoming");
      const push =
        m.kind === "edited"
          ? toEditPush(m, named, images, textOffset)
          : toPush(m, named, images, textOffset);
      assert.deepEqual(push, doc.expect.push, "push/event");
      if (m.kind === "edited")
        assert.equal(m.targetMessageId, doc.expect.targetMessageId, "targetMessageId");
    } else if (m.kind === "reaction") {
      assert.deepEqual(toReactionPush(m, doc.self), doc.expect.push, "push/event (reaction)");
    } else if (m.kind === "deleted") {
      assert.equal(m.targetMessageId, doc.expect.targetMessageId, "targetMessageId");
      assert.deepEqual(toDeletePush(m, doc.self), doc.expect.push, "push/event (delete)");
    }
    // no fixture phone number leaks into the fixture's own recorded output
    const wire = JSON.stringify(doc.expect);
    for (const n of Object.values({ bot: "+15550000001", alice: "+15550000002", phoneOnly: "+15550000003" }))
      assert.ok(!wire.includes(n), `${n} leaked into the fixture's own recorded output`);
  });
}
