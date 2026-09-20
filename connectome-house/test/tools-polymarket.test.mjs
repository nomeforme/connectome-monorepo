// @ts-check
/* connectome-house/test/tools-polymarket.test.mjs — the ported
 * `polymarket` CLI tool: schema parity with the fleet's config-driven
 * tool_configs entry, the not-configured path (no POLYMARKET_CLI), a
 * mocked happy path against a stub binary script, and the subcommand
 * whitelist. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePolymarketTools } from "../src/tools/polymarket-tools.mjs";

// the fleet's own tool_configs entry for "polymarket" (bot-runtime/config.json).
const FLEET_POLYMARKET_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: 'Arguments to pass to the polymarket CLI (e.g. "markets search bitcoin --limit 5")',
    },
  },
  required: ["command"],
};

function fakeTrace() {
  return { frame: () => {}, result: (p) => ({ inline: String(p) }) };
}

const SANDBOX = mkdtempSync(join(tmpdir(), "polymarket-cli-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test("polymarket: definition matches the fleet's own tool_configs entry", () => {
  const { definitions } = makePolymarketTools();
  assert.equal(definitions.length, 1);
  const d = definitions[0];
  assert.equal(d.name, "polymarket");
  assert.match(d.description, /Query Polymarket prediction markets/);
  assert.deepEqual(d.inputSchema, FLEET_POLYMARKET_SCHEMA);
});

test("polymarket: no POLYMARKET_CLI is an honest not-configured result", async () => {
  delete process.env.POLYMARKET_CLI;
  const tools = makePolymarketTools();
  tools.beginTurn({ trace: fakeTrace() });
  const out = await tools.execute({ id: "c1", name: "polymarket", input: { command: "markets list" } });
  assert.equal(out.content, "not configured here: POLYMARKET_CLI");
});

test("polymarket: happy path runs the configured binary and returns its stdout", async () => {
  const bin = join(SANDBOX, "polymarket-stub.sh");
  writeFileSync(bin, "#!/bin/sh\necho '{\"ok\":true,\"args\":\"'\"$*\"'\"}'\n");
  chmodSync(bin, 0o755);
  process.env.POLYMARKET_CLI = bin;
  try {
    const tools = makePolymarketTools();
    tools.beginTurn({ trace: fakeTrace() });
    const out = await tools.execute({ id: "c1", name: "polymarket", input: { command: "markets list --limit 5" } });
    assert.match(out.content, /"ok":true/);
    assert.match(out.content, /-o json markets list --limit 5/);
  } finally {
    delete process.env.POLYMARKET_CLI;
  }
});

test("polymarket: an unlisted subcommand is refused before any exec", async () => {
  process.env.POLYMARKET_CLI = "/bin/true";
  try {
    const tools = makePolymarketTools();
    tools.beginTurn({ trace: fakeTrace() });
    const out = await tools.execute({ id: "c1", name: "polymarket", input: { command: "rm -rf /" } });
    assert.match(out.content, /not an allowed subcommand/);
  } finally {
    delete process.env.POLYMARKET_CLI;
  }
});
