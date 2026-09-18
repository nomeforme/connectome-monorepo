// @ts-check
/* connectome-house/test/media-tools.test.mjs — media_list/media_attach/
 * media_view against a real sandboxed blob-root.mjs store: listing what a
 * room has already shared, re-attaching an address without seeing it,
 * and viewing an image (byte caps, per-turn budget, the media.attached
 * world-fact each reach records). */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "media-tools-blobs-"));
process.env.HOUSE_BLOB_ROOT = ROOT;
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.HOUSE_BLOB_ROOT;
});

const { putBlob } = await import("../src/blob-root.mjs");
const { makeMediaTools } = await import("../src/media-tools.mjs");
const { frameFactory, writeFrames } = await import("./lib/fixtures.mjs");

const RUNS = mkdtempSync(join(tmpdir(), "media-tools-runs-"));
after(() => rmSync(RUNS, { recursive: true, force: true }));

function fakeTrace() {
  const frames = [];
  return { frames, frame: (type, data) => frames.push({ type, ...data }), result: (p) => ({ inline: String(p) }) };
}

let sha;
let runDir;

before(() => {
  const bytes = Buffer.from("not-really-a-png-but-bytes-are-bytes");
  ({ sha } = putBlob(bytes, { mime: "image/png", ext: ".png" }));
  runDir = join(RUNS, "room-a");
  mkdirSync(runDir, { recursive: true });
  const f = frameFactory();
  writeFrames(runDir, [f.fWorldMounted({}), f.fMediaAttached("mara", `blob/${sha}`, "image")]);
});

test("media_list: shows what this room has already shared", () => {
  const tools = makeMediaTools();
  const ctx = { runDir, trace: fakeTrace() };
  tools.beginTurn(ctx, "aria");
  const out = tools.execute({ id: "c1", name: "media_list", input: {} }).content;
  assert.match(out, new RegExp(`blob/${sha}`));
  assert.match(out, /image/);
});

test("media_list: an empty room says so honestly", () => {
  const tools = makeMediaTools();
  const emptyDir = join(RUNS, "room-empty");
  mkdirSync(emptyDir, { recursive: true });
  writeFrames(emptyDir, [{ seq: 0, t: new Date().toISOString(), type: "room.mounted" }]);
  const ctx = { runDir: emptyDir, trace: fakeTrace() };
  tools.beginTurn(ctx, "aria");
  const out = tools.execute({ id: "c1", name: "media_list", input: {} }).content;
  assert.match(out, /nothing has been shared/);
});

test("media_attach: places a known address in view without seeing it, records the reach", () => {
  const tools = makeMediaTools();
  const ctx = { runDir, trace: fakeTrace() };
  tools.beginTurn(ctx, "aria");
  const out = tools.execute({ id: "c1", name: "media_attach", input: { path: `blob/${sha}` } }).content;
  assert.match(out, /now rides this room's view/);
  assert.match(out, /not seen it/);
  const attached = ctx.trace.frames.find((f) => f.type === "media.attached");
  assert.ok(attached, "a media.attached frame was written");
  assert.equal(attached.seen_by_model, false);
  assert.equal(attached.requested_by, "model");
});

test("media_attach: an unknown address is refused honestly", () => {
  const tools = makeMediaTools();
  const ctx = { runDir, trace: fakeTrace() };
  tools.beginTurn(ctx, "aria");
  const out = tools.execute({ id: "c1", name: "media_attach", input: { path: "blob/notreal" } }).content;
  assert.match(out, /no media file lives at that address/);
});

test("media_view: brings the image into context and marks it seen", () => {
  const tools = makeMediaTools();
  const ctx = { runDir, trace: fakeTrace() };
  tools.beginTurn(ctx, "aria");
  const out = tools.execute({ id: "c1", name: "media_view", input: { path: `blob/${sha}` } });
  assert.ok(Array.isArray(out.content));
  const imageBlock = out.content.find((b) => b.type === "image");
  assert.ok(imageBlock, "an image block was returned");
  const attached = ctx.trace.frames.find((f) => f.type === "media.attached");
  assert.equal(attached.seen_by_model, true);
});

test("media_view: a non-viewable extension is refused, address still nameable", () => {
  const { sha: textSha } = putBlob(Buffer.from("plain text"), { mime: "text/plain", ext: ".txt" });
  const tools = makeMediaTools();
  const ctx = { runDir, trace: fakeTrace() };
  tools.beginTurn(ctx, "aria");
  const out = tools.execute({ id: "c1", name: "media_view", input: { path: `blob/${textSha}` } }).content;
  assert.match(out, /isn't viewable in-context/);
});
