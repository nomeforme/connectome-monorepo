// @ts-check
/* connectome-house/test/house-tools.test.mjs — mountHouseTools()
 * combines every ported tool module's definitions into ONE array
 * (registerTools(defs)'s exact input shape) and dispatches a call to the
 * right module by name. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNS = mkdtempSync(join(tmpdir(), "house-tools-runs-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "house-tools-private-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
after(() => {
  rmSync(RUNS, { recursive: true, force: true });
  rmSync(PRIVATE, { recursive: true, force: true });
  delete process.env.HOUSE_RUNS_DIR;
  delete process.env.HOUSE_PRIVATE_DIR;
});

const { mountHouseTools, houseToolDefinitions, isHouseTool, executeHouseTool, _resetHouseTools } =
  await import("../src/house-tools.mjs");

function fakeTrace() {
  return { frame: () => {}, result: (p) => ({ inline: String(p) }) };
}

test("houseToolDefinitions: every entry matches registerTools(defs)'s own shape", () => {
  _resetHouseTools();
  mountHouseTools();
  const defs = houseToolDefinitions();
  assert.ok(defs.length > 10);
  for (const d of defs) {
    assert.equal(typeof d.name, "string");
    assert.equal(typeof d.description, "string");
    assert.equal(typeof d.inputSchema, "object");
  }
  const names = defs.map((d) => d.name);
  assert.ok(names.includes("record_list"));
  assert.ok(names.includes("media_view"));
  assert.ok(names.includes("self_note_read"));
  assert.ok(names.includes("task_continue"));
  assert.ok(names.includes("house"));
});

test("isHouseTool: true for a mounted tool, false for an unknown/platform one", () => {
  assert.equal(isHouseTool("ledger"), true);
  assert.equal(isHouseTool("list_channels"), false);
});

test("executeHouseTool: dispatches to the owning module and returns {ok, content}", async () => {
  mkdirSync(join(RUNS, "r1"), { recursive: true });
  const ctx = { id: "r1", runDir: join(RUNS, "r1"), trace: fakeTrace() };
  const out = await executeHouseTool("self_note_write", { text: "hello" }, ctx, "aria", "call-1");
  assert.equal(out.ok, true);
  assert.match(out.content, /now reads as you wrote it/);
});

test("executeHouseTool: an unknown tool is an honest refusal, never a throw", async () => {
  const out = await executeHouseTool("archive_read", {}, {}, "aria", "call-2");
  assert.equal(out.ok, false);
  assert.match(out.content, /is not offered here/);
});
