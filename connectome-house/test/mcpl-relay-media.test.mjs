// @ts-check
/* harness-port P-C, 2026-09-17 — connectome-house/test/mcpl-relay-media.
 * test.mjs — the round trip this task's own OWNED files carry a human's
 * shared bytes through: media-in.mjs stores an inbound attachment into
 * the shared blob store (contract 3/4, platform-reach R2f), and
 * media-out.mjs resolves a `media.attached` frame back to a real
 * platform attachment shape for speak.mjs's speakMedia to send (contract
 * 5). test/mcpl-media-out.test.mjs already covers media-out.mjs alone in
 * detail; this file's own job is the SEAM: an address media-in.mjs
 * stores (after media-share.mjs's own ffmpeg re-encode — real bytes are
 * NOT preserved byte-for-byte, on purpose, media-normalize.mjs:1-14) is
 * the SAME address media-out.mjs resolves back out, to real bytes on
 * disk, shaped for whichever platform asks. One real sandboxed blob
 * store (HOUSE_BLOB_ROOT); never app/shared/blobs. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BLOBS = mkdtempSync(join(tmpdir(), "house-relay-media-blobs-"));
const RUNS = mkdtempSync(join(tmpdir(), "house-relay-media-runs-"));
process.env.HOUSE_BLOB_ROOT = BLOBS;
process.env.HOUSE_RUNS_DIR = RUNS;

const { addRef } = await import("../src/blob-root.mjs");
const { storeInboundAttachments } = await import("../src/mcpl/media-in.mjs");
const { resolveOutboundMedia, toolArgsFor } = await import("../src/mcpl/media-out.mjs");

test.after(() => {
  for (const d of [BLOBS, RUNS]) rmSync(d, { recursive: true, force: true });
});

// a real, decodable 2x2 red PNG (generated with `ffmpeg -f lavfi -i
// color=c=red:s=2x2 -frames:v 1`) — media-in.mjs's default
// storeSharedMedia (media-share.mjs) runs bytes through FFMPEG to
// normalize them (resize/re-encode, media-normalize.mjs), so undecodable
// fixture text is honestly refused, same as a corrupt upload would be;
// this is genuine, ffmpeg-decodable image bytes for that reason, not a
// placeholder string.
const PNG_2X2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==",
  "base64",
);

test("round trip: an inbound image (discord-mcpl's own base64 image block, decoded to bytes) stores, then resolves back out", async () => {
  const stored = await storeInboundAttachments(
    [{ bytes: PNG_2X2, mime: "image/png", filename: "photo.png" }],
    { platform: "discord", runId: "room-relay-1" },
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].mime, "image/jpeg", "media-normalize.mjs re-encodes to jpeg by default");
  assert.equal(stored[0].filename, "photo.png");
  assert.ok(stored[0].path.startsWith("blob/"));

  // a room must hold a ref before resolveOutboundMedia will find it
  // (visibility gate — the same one a real share goes through); media-
  // in.mjs's own storeSharedMedia already adds one for the calling run,
  // so this mirrors that, not a new behaviour.
  const sha = stored[0].path.slice("blob/".length);
  addRef(sha, { run: "room-relay-1", seq: 1 });

  // NOT a byte-identical round trip on purpose: media-share.mjs's own
  // normalizeMedia re-encodes every inbound image (ffmpeg — resize +
  // metadata strip, media-normalize.mjs:1-14), so the seam this test
  // proves is CONTENT-ADDRESSED CONTINUITY (the exact stored sha comes
  // back out, resolves to real bytes on disk, at this platform's own
  // shape) — never that the bytes are untouched.
  const resolved = resolveOutboundMedia({ path: stored[0].path, filename: stored[0].filename }, "discord");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.mime, "image/jpeg");
  assert.ok(resolved.bytes > 0);
  assert.equal(resolved.filename, "photo.png");

  const args = toolArgsFor("discord", resolved);
  assert.deepEqual(args, { files: [{ path: resolved.abs, name: "photo.png" }] });
});

test("round trip, signal shape: the SAME inbound path resolves to signal's base64 attachments shape, not discord's files shape", async () => {
  const stored = await storeInboundAttachments(
    [{ bytes: PNG_2X2, mime: "image/png", filename: null }],
    { platform: "signal", runId: "room-relay-2" },
  );
  assert.equal(stored.length, 1);
  assert.equal(
    stored[0].filename,
    null,
    "discord-mcpl never names an inbound image block — honestly null, never guessed",
  );
  const sha = stored[0].path.slice("blob/".length);
  addRef(sha, { run: "room-relay-2", seq: 1 });
  const resolved = resolveOutboundMedia({ path: stored[0].path, filename: stored[0].filename }, "signal");
  assert.equal(resolved.ok, true);
  const args = toolArgsFor("signal", resolved);
  const { readFileSync } = await import("node:fs");
  assert.equal(args.attachments[0].data, readFileSync(resolved.abs).toString("base64"));
  assert.equal(args.attachments[0].mimeType, "image/jpeg");
  assert.equal(args.attachments[0].filename, null);
});

test("an inbound attachment is dropped (never thrown) when the store isn't wired up, or when it refuses — the message's own text still lands either way", async () => {
  const notWiredUp = await storeInboundAttachments(
    [{ bytes: Buffer.from("x"), mime: "image/png", filename: "x.png" }],
    { platform: "discord", runId: "room-relay-3", storeSharedMedia: false, log: () => {} },
  );
  assert.deepEqual(notWiredUp, [], "storeSharedMedia not a function -> logged once, dropped, never a throw");

  const refused = await storeInboundAttachments(
    [{ bytes: Buffer.from("x"), mime: "image/png", filename: "x.png" }],
    {
      platform: "discord",
      runId: "room-relay-3",
      storeSharedMedia: async () => ({ error: "refused: fixture", code: "test-refusal" }),
      log: () => {},
    },
  );
  assert.deepEqual(refused, [], "the store's own refusal is honoured, not swallowed into a false success");

  const thrown = await storeInboundAttachments(
    [{ bytes: Buffer.from("x"), mime: "image/png", filename: "x.png" }],
    {
      platform: "discord",
      runId: "room-relay-3",
      storeSharedMedia: async () => {
        throw new Error("disk full (fixture)");
      },
      log: () => {},
    },
  );
  assert.deepEqual(thrown, [], "a store that throws is caught — one bad attachment never fails the whole message");
});

test("resolveOutboundMedia: an unsupported platform (mock, web) never guesses a shape — honest 'unsupported', no call built", () => {
  const args = resolveOutboundMedia({ path: "blob/deadbeef", filename: null }, "mock");
  assert.deepEqual(args, { ok: false, reason: "unsupported" });
});
