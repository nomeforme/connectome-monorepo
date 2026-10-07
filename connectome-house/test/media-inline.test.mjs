/* A turn's live conversation carries the room's newest few attachments as
 * the real thing (for a being whose model sees them); everything older,
 * and every life, keeps the pointer line. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "media-inline-"));
process.env.HOUSE_BLOB_ROOT = join(ROOT, "blobs-root");
process.env.HOUSE_IDENTITY_SALT ??= "test-salt-media-inline";
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
for (const d of [process.env.HOUSE_RUNS_DIR, process.env.HOUSE_PRIVATE_DIR, process.env.HOUSE_COVENANTS_DIR]) mkdirSync(d, { recursive: true });

const { writeTestament } = await import("./lib/fixtures.mjs");
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");
const { putBlob } = await import("../src/blob-root.mjs");
const { liveMediaSeqs, seesMedia } = await import("../src/media-inline.mjs");
const { renderConversation } = await import("../src/room-turn.mjs");

// a 1x1 png
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function room(id, nImages) {
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "class.json"),
    JSON.stringify({ class: "wondering", owner: "mara", visibility: "public", being: "aria", beings: ["aria"], participants: [] }),
  );
  const frames = [];
  let seq = 0;
  for (let i = 0; i < nImages; i++) {
    const { sha } = putBlob(Buffer.concat([PNG, Buffer.from([i])]), { mime: "image/png", ext: ".png" });
    frames.push({ seq: seq++, t: "2026-10-05T00:00:00Z", type: "media.attached", by: "mara", path: `blob/${sha}`, kind: "image", mime: "image/png", requested_by: "human" });
    frames.push({ seq: seq++, t: "2026-10-05T00:00:01Z", type: "message", by: "mara", text: `picture ${i}` });
  }
  writeFileSync(join(runDir, "frames.jsonl"), frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
  return { id, runDir, cls: null, frames };
}

test("the newest few attachments ride as images for a Claude model; older ones stay pointer lines", () => {
  const rec = room("room-media", 8);
  assert.equal(liveMediaSeqs(rec.frames, { count: 4 }).size, 4);
  const convo = renderConversation(rec, "aria", { model: "claude-opus-4-8" });
  const images = convo.filter((m) => m.content.some((b) => b.type === "image"));
  const pointers = convo.filter((m) => m.content.length === 1 && /\[image from @mara/.test(m.content[0].text ?? ""));
  assert.equal(images.length, 6, "the newest six");
  assert.equal(images[0].participant, "mara", "under its sender's own name");
  assert.equal(pointers.length, 2, "the two oldest keep the pointer line");
  assert.match(images[0].content[0].text, /\[image from @mara/, "the label still rides beside the image");
});

test("a model that doesn't see media gets only pointer lines", () => {
  assert.equal(seesMedia("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"), false);
  const rec = room("room-media-local", 2);
  const convo = renderConversation(rec, "aria", { model: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf" });
  assert.equal(convo.filter((m) => m.content.some((b) => b.type === "image")).length, 0);
});

test("a message carrying an attachment leaves a media.attached frame in the record, before it, marked platform-origin when it came from a platform", async () => {
  const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
  const { readFileSync } = await import("node:fs");
  const { identityFor } = await import("../src/identity-map.mjs");
  const human = identityFor({ platform: "signal", id: "mara-uuid", display: "Mara" }).handle;
  const { id, error } = await openRoom({ platform: "synthetic", stream: "media-in-1", title: "media in", beings: ["aria"] });
  assert.equal(error, undefined);
  const { sha } = putBlob(Buffer.concat([PNG, Buffer.from([99])]), { mime: "image/png", ext: ".png" });
  const r = await roomInput({
    id,
    by: human,
    text: "can you see this",
    attachments: [`blob/${sha}`],
    observe: true,
    targets: [],
    external: { platform: "signal", message_id: "m-1" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const frames = readFileSync(join(process.env.HOUSE_RUNS_DIR, id, "frames.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const i = frames.findIndex((f) => f.type === "media.attached" && f.path === `blob/${sha}`);
  assert.ok(i >= 0, "the attachment is in the record");
  assert.equal(frames[i].origin, "platform", "never echoed back out by any seat");
  assert.equal(frames[i + 1].type, "message");
  assert.equal(frames[i + 1].text, "can you see this");
});
