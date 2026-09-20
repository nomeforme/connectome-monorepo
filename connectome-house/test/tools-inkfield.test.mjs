// @ts-check
/* connectome-house/test/tools-inkfield.test.mjs — the ported
 * `paint_inkfield` tool: schema parity (name/required/description shape)
 * with the fleet's own (paint-inkfield-tool.ts), the not-configured
 * path, and a mocked bridge render landing as a media.attached frame
 * through blob-root.mjs — the same mechanism media_attach uses. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "inkfield-tools-blobs-"));
process.env.HOUSE_BLOB_ROOT = ROOT;
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.HOUSE_BLOB_ROOT;
  delete process.env.INKFIELD_BRIDGE_URL;
});

const { makeInkfieldTools } = await import("../src/tools/inkfield-tools.mjs");
const { resolveBlob } = await import("../src/blob-root.mjs");

function fakeTrace() {
  const frames = [];
  return { frames, frame: (type, data) => frames.push({ type, ...data }), result: (p) => ({ inline: String(p) }) };
}

test("paint_inkfield: definition matches the fleet's own shape", () => {
  const { definitions } = makeInkfieldTools();
  assert.equal(definitions.length, 1);
  const d = definitions[0];
  assert.equal(d.name, "paint_inkfield");
  assert.match(d.description, /Paint with InkField/);
  assert.deepEqual(d.inputSchema.required, []);
  assert.ok(d.inputSchema.properties.strokes);
  assert.ok(d.inputSchema.properties.recording);
  assert.ok(d.inputSchema.properties.workspace_path);
});

test("paint_inkfield: no INKFIELD_BRIDGE_URL is an honest not-configured result", async () => {
  delete process.env.INKFIELD_BRIDGE_URL;
  const tools = makeInkfieldTools();
  const trace = fakeTrace();
  tools.beginTurn({ trace }, "aria");
  const out = await tools.execute({
    id: "c1",
    name: "paint_inkfield",
    input: { strokes: [{ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }] },
  });
  assert.equal(out.content, "not configured here: INKFIELD_BRIDGE_URL");
});

test("paint_inkfield: providing more than one of strokes/recording/workspace_path is refused", async () => {
  process.env.INKFIELD_BRIDGE_URL = "http://fake-bridge";
  const tools = makeInkfieldTools();
  tools.beginTurn({ trace: fakeTrace() }, "aria");
  const out = await tools.execute({
    id: "c1",
    name: "paint_inkfield",
    input: { strokes: [], recording: "{}" },
  });
  assert.match(out.content, /exactly one of/);
});

test("paint_inkfield: a rendered PNG is stored as a blob and placed into the room's view", async () => {
  process.env.INKFIELD_BRIDGE_URL = "http://fake-bridge";
  const origFetch = globalThis.fetch;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://fake-bridge/render");
    return {
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  };
  try {
    const tools = makeInkfieldTools();
    const trace = fakeTrace();
    tools.beginTurn({ trace }, "aria");
    const out = await tools.execute({
      id: "c1",
      name: "paint_inkfield",
      input: { strokes: [{ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } }] },
    });
    assert.match(out.content, /already placed into this room's view/);
    const m = out.content.match(/blob\/([0-9a-f]{64})/);
    assert.ok(m, `expected a blob address in: ${out.content}`);
    const resolved = resolveBlob(m[1]);
    assert.ok(resolved, "the rendered PNG should be stored in the blob store");
    const attached = trace.frames.find((f) => f.type === "media.attached");
    assert.ok(attached, "expected a media.attached frame");
    assert.equal(attached.seen_by_model, false);
    assert.equal(attached.requested_by, "model");
    assert.equal(attached.by, "aria");
  } finally {
    globalThis.fetch = origFetch;
  }
});
