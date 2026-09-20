// @ts-check
/* connectome-house/test/tools-registration.test.mjs — the five C2-ports
 * tools ride the SAME offer path every other house tool does:
 * resolveCovenantFields intersects a testament's tools: list against
 * houseToolDefinitions()'s names (room-turn-tools.mjs). */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNS = mkdtempSync(join(tmpdir(), "tools-registration-runs-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "tools-registration-private-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
after(() => {
  rmSync(RUNS, { recursive: true, force: true });
  rmSync(PRIVATE, { recursive: true, force: true });
  delete process.env.HOUSE_RUNS_DIR;
  delete process.env.HOUSE_PRIVATE_DIR;
});

const { houseToolDefinitions, _resetHouseTools } = await import("../src/house-tools.mjs");
const { resolveCovenantFields } = await import("../src/room-turn-tools.mjs");

test("resolveCovenantFields: a covenant naming fetch+polymarket offers exactly those two", () => {
  _resetHouseTools();
  const offeredNames = new Set(houseToolDefinitions().map((d) => d.name));
  assert.ok(offeredNames.has("fetch"));
  assert.ok(offeredNames.has("polymarket"));
  const cov = { tools: ["fetch", "polymarket"] };
  const { tools } = resolveCovenantFields(cov, offeredNames, "aria", undefined);
  assert.deepEqual(tools, ["fetch", "polymarket"]);
});

test("resolveCovenantFields: every C2-ports tool name is offered by houseToolDefinitions()", () => {
  _resetHouseTools();
  const offeredNames = new Set(houseToolDefinitions().map((d) => d.name));
  for (const name of [
    "fetch",
    "polymarket",
    "get_wallet_info",
    "check_balance",
    "transfer",
    "x402_fetch",
    "paint_inkfield",
  ])
    assert.ok(offeredNames.has(name), `${name} should be offered`);
});

test("resolveCovenantFields: a covenant naming a NOT-yet-connected kohya tool is dropped, not thrown", () => {
  _resetHouseTools();
  const offeredNames = new Set(houseToolDefinitions().map((d) => d.name));
  const cov = { tools: ["fetch", "kohya-lora-training__train_lora"] };
  const origError = console.error;
  console.error = () => {};
  let out;
  try {
    out = resolveCovenantFields(cov, offeredNames, "aria", undefined);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(out.tools, ["fetch"]);
});
