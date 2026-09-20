// @ts-check
/* connectome-house/test/tools-kohya.test.mjs — the ported kohya-lora-
 * training MCP surface: no KOHYA_MCP_URL means honestly nothing is
 * offered; with one, a mocked streamable-http JSON-RPC exchange
 * (initialize -> notifications/initialized -> tools/list) populates
 * `definitions` with the fleet's own `{server}__{tool}` prefixed name
 * (connectome-grpc-common/src/mcp/mcp-manager.ts), and tools/call
 * proxies through. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeKohyaTools } from "../src/tools/kohya-tools.mjs";

after(() => {
  delete process.env.KOHYA_MCP_URL;
});

function jsonRes(id, result) {
  return {
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

test("kohya: no KOHYA_MCP_URL — nothing offered, an honest not-configured result", async () => {
  delete process.env.KOHYA_MCP_URL;
  const tools = makeKohyaTools();
  await tools.ready;
  assert.deepEqual(tools.definitions, []);
  tools.beginTurn({ trace: { frame: () => {}, result: (p) => ({ inline: String(p) }) } });
  const out = await tools.execute({ id: "c1", name: "kohya-lora-training__anything", input: {} });
  assert.equal(out.content, "not configured here: KOHYA_MCP_URL");
});

test("kohya: connects, learns its tool list, and proxies a call", async () => {
  process.env.KOHYA_MCP_URL = "http://fake-kohya";
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, "http://fake-kohya");
    const body = JSON.parse(opts.body);
    seen.push(body.method);
    if (body.method === "initialize") return jsonRes(body.id, { protocolVersion: "2024-11-05" });
    if (body.method === "notifications/initialized")
      return { headers: { get: () => null }, text: async () => "" };
    if (body.method === "tools/list")
      return jsonRes(body.id, {
        tools: [{ name: "train_lora", description: "Train a LoRA", inputSchema: { type: "object", properties: {} } }],
      });
    if (body.method === "tools/call")
      return jsonRes(body.id, { content: [{ type: "text", text: "trained!" }] });
    throw new Error(`unexpected method ${body.method}`);
  };
  try {
    const tools = makeKohyaTools();
    await tools.ready;
    assert.deepEqual(seen, ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(tools.definitions.length, 1);
    assert.equal(tools.definitions[0].name, "kohya-lora-training__train_lora");
    assert.equal(tools.definitions[0].description, "Train a LoRA");

    tools.beginTurn({ trace: { frame: () => {}, result: (p) => ({ inline: String(p) }) } });
    const out = await tools.execute({ id: "c1", name: "kohya-lora-training__train_lora", input: { steps: 100 } });
    assert.equal(out.content, "trained!");
    assert.equal(seen.at(-1), "tools/call");
  } finally {
    globalThis.fetch = origFetch;
  }
});
