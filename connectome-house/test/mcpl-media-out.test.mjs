// @ts-check
/* harness/test/mcpl-media-out.test.mjs — media-out.mjs against a REAL
 * sandboxed blob store (HOUSE_BLOB_ROOT): a media.attached frame's address
 * resolves to real bytes on disk, an over-ceiling blob is refused with its
 * size, an unknown sha 404s honestly, an unsupported platform never
 * guesses a shape, and the two real platforms' tool args match their
 * server's own schema (discord-mcpl's `files`, signal-mcpl's base64
 * `attachments`). Every harness/src import is DYNAMIC, after
 * HOUSE_BLOB_ROOT/HOUSE_RUNS_DIR are set (serve-paths.mjs reads its env at
 * module load). One sandbox; never app/shared/blobs (deletion-discipline). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BLOBS = mkdtempSync(join(tmpdir(), "house-media-out-blobs-"));
const RUNS = mkdtempSync(join(tmpdir(), "house-media-out-runs-"));
process.env.HOUSE_BLOB_ROOT = BLOBS;
process.env.HOUSE_RUNS_DIR = RUNS;

const { addRef, putBlob } = await import("../src/blob-root.mjs");
/** store bytes AND reference them from a room — resolveMediaAddress's
 * visibility gate needs at least one ref, same as a real share does. */
function shareBlob(bytes, meta) {
  const { sha } = putBlob(bytes, meta);
  addRef(sha, { run: "room-1", seq: 1 });
  return sha;
}
const {
  DISCORD_ATTACHMENT_MAX_BYTES,
  SIGNAL_ATTACHMENT_MAX_BYTES,
  humanBytes,
  maxBytesFor,
  resolveOutboundMedia,
  supportsAttachments,
  toolArgsFor,
} = await import("../src/mcpl/media-out.mjs");

test.after(() => {
  for (const d of [BLOBS, RUNS]) rmSync(d, { recursive: true, force: true });
});

test("maxBytesFor/supportsAttachments: discord and signal named, an unknown platform falls back honestly", () => {
  assert.equal(maxBytesFor("discord"), DISCORD_ATTACHMENT_MAX_BYTES);
  assert.equal(maxBytesFor("signal"), SIGNAL_ATTACHMENT_MAX_BYTES);
  assert.equal(maxBytesFor("mock"), DISCORD_ATTACHMENT_MAX_BYTES, "an unregistered platform's ceiling is the conservative one");
  assert.equal(supportsAttachments("discord"), true);
  assert.equal(supportsAttachments("signal"), true);
  assert.equal(supportsAttachments("mock"), false);
});

test("resolveOutboundMedia: a real stored blob resolves to real bytes and its mime", () => {
  const sha = shareBlob(Buffer.from("real-image-bytes"), { mime: "image/png", ext: ".png" });
  const r = resolveOutboundMedia({ path: `blob/${sha}`, filename: "photo.png" }, "discord");
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  assert.equal(r.bytes, Buffer.byteLength("real-image-bytes"));
  assert.ok(r.abs.endsWith(`${sha}.png`));
  assert.equal(r.filename, "photo.png");
});

test("resolveOutboundMedia: unknown sha is not-found, honestly — never a guess", () => {
  const r = resolveOutboundMedia({ path: `blob/${"a".repeat(64)}` }, "discord");
  assert.deepEqual(r, { ok: false, reason: "not-found" });
});

test("resolveOutboundMedia: over the platform's own ceiling is too-large, with the real byte count", () => {
  const sha = shareBlob(Buffer.alloc(DISCORD_ATTACHMENT_MAX_BYTES + 1), { mime: "image/png", ext: ".png" });
  const r = resolveOutboundMedia({ path: `blob/${sha}` }, "discord");
  assert.deepEqual(r, { ok: false, reason: "too-large", bytes: DISCORD_ATTACHMENT_MAX_BYTES + 1 });
  // signal's own ceiling is wider — the SAME blob resolves fine there
  const rSignal = resolveOutboundMedia({ path: `blob/${sha}` }, "signal");
  assert.equal(rSignal.ok, true, "signal's own ceiling is wider — the same blob resolves there");
});

test("resolveOutboundMedia: an unsupported platform never builds a call — unsupported before even resolving", () => {
  const sha = shareBlob(Buffer.from("x"), { mime: "text/plain" });
  assert.deepEqual(resolveOutboundMedia({ path: `blob/${sha}` }, "mock"), { ok: false, reason: "unsupported" });
});

test("toolArgsFor: discord gets files (host filesystem path, optional name); signal gets base64 attachments", () => {
  const sha = shareBlob(Buffer.from("hello"), { mime: "text/plain", ext: ".txt" });
  const r = resolveOutboundMedia({ path: `blob/${sha}`, filename: "note.txt" }, "discord");
  assert.equal(r.ok, true);
  assert.deepEqual(toolArgsFor("discord", r), { files: [{ path: r.abs, name: "note.txt" }] });
  const rNoName = { ...r, filename: null };
  assert.deepEqual(toolArgsFor("discord", rNoName), { files: [{ path: r.abs }] }, "no filename known — never guessed");
  const signalArgs = toolArgsFor("signal", r);
  assert.equal(signalArgs.attachments.length, 1);
  assert.equal(signalArgs.attachments[0].data, Buffer.from("hello").toString("base64"));
  assert.equal(signalArgs.attachments[0].mimeType, "text/plain");
  assert.equal(signalArgs.attachments[0].filename, "note.txt");
});

test("humanBytes: a plain, honest size string", () => {
  assert.equal(humanBytes(500), "500B");
  assert.equal(humanBytes(2048), "2KB");
  assert.equal(humanBytes(5 * 1048576), "5.0MB");
});
