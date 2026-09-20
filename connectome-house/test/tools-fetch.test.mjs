// @ts-check
/* connectome-house/test/tools-fetch.test.mjs — the ported `fetch` tool:
 * schema parity with the fleet's own (bot-runtime.ts's createHttpTool),
 * a mocked happy path, and honest error text on a non-ok response. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFetchTools } from "../src/tools/fetch-tools.mjs";

// the fleet's own ToolHandler for "fetch" (bot-runtime.ts createHttpTool),
// as a JSON-Schema-shaped fixture: one param, effectively required (the
// fleet's ToolHandler has no `required` array, so ALL its params are
// required — connectome-agent-core/src/veil-tool-bridge.ts's own rule).
const FLEET_FETCH_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch content from (must be a valid HTTP/HTTPS URL)" },
  },
  required: ["url"],
};

function fakeTrace() {
  return { frame: () => {}, result: (p) => ({ inline: String(p) }) };
}

test("fetch: definition matches the fleet's own schema", () => {
  const { definitions } = makeFetchTools();
  assert.equal(definitions.length, 1);
  const d = definitions[0];
  assert.equal(d.name, "fetch");
  assert.equal(
    d.description,
    "Fetch content from a URL. Use this to retrieve web pages, APIs, or any HTTP-accessible content.",
  );
  assert.deepEqual(d.inputSchema, FLEET_FETCH_SCHEMA);
});

test("fetch: happy path returns the response body, truncated at the fleet's own cap", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "hello world" });
  try {
    const tools = makeFetchTools();
    tools.beginTurn({ trace: fakeTrace() });
    const out = await tools.execute({ id: "c1", name: "fetch", input: { url: "https://example.com" } });
    assert.equal(out.content, "hello world");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fetch: a non-ok response is an honest text result, never a throw", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found" });
  try {
    const tools = makeFetchTools();
    tools.beginTurn({ trace: fakeTrace() });
    const out = await tools.execute({ id: "c1", name: "fetch", input: { url: "https://example.com/gone" } });
    assert.match(out.content, /HTTP 404/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fetch: no url is an honest refusal, not a crash", async () => {
  const tools = makeFetchTools();
  tools.beginTurn({ trace: fakeTrace() });
  const out = await tools.execute({ id: "c1", name: "fetch", input: {} });
  assert.match(out.content, /No URL provided/);
});
