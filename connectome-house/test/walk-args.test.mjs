// @ts-check
/* connectome-house/test/walk-args.test.mjs — walker.mjs's own CLI surface
 * (src/walk-args.mjs). Rewritten from the reference harness's walk-
 * args.test.mjs: this port's flag set is far smaller (--being/--seat/
 * --room plus a few per-turn sizing knobs — see walk-args.mjs's own
 * header for why), so these pins cover ITS surface directly rather than
 * porting assertions about flags this port doesn't have. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWalkerArgs } from "../src/walk-args.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WALKER = join(HERE, "..", "src", "walker.mjs");

test("parseWalkerArgs: defaults with just --being and --seat", () => {
  const a = parseWalkerArgs(["--being", "aria", "--seat", "stdio"]);
  assert.equal(a.being, "aria");
  assert.equal(a.seat, "stdio");
  assert.equal(a.room, null);
  assert.equal(a.mock, false);
  assert.equal(a.maxTokens, 16384);
  assert.equal(a.thinking, undefined, "fleet default: thinkingLevel off (connectome-agent.ts:212), no bot sets it");
  assert.equal(a.maxConcurrent, 1, "the fleet's own one-cycle-per-bot default");
  assert.equal(a.platformsFile, null, "no platform children unless named");
  assert.equal(a.exitOnSeatLoss, false, "W6-R4 default: the being outlives the house");
});

test("parseWalkerArgs: --thinking <N> explicitly enables it", () => {
  const a = parseWalkerArgs(["--being", "aria", "--seat", "stdio", "--thinking", "4096"]);
  assert.deepEqual(a.thinking, { enabled: true, budgetTokens: 4096 });
});

test("parseWalkerArgs: --room, --mock, --thinking off, custom sizing", () => {
  const a = parseWalkerArgs([
    "--being", "aria", "--seat", "unix:/tmp/x.sock", "--room", "room-1",
    "--mock", "--thinking", "off", "--max-tokens", "999",
    "--stream-idle-ms", "1000", "--idle-watchdog-ms", "2000",
  ]);
  assert.equal(a.room, "room-1");
  assert.equal(a.mock, true);
  assert.equal(a.thinking, undefined);
  assert.equal(a.maxTokens, 999);
  assert.equal(a.streamIdleMs, 1000);
  assert.equal(a.idleWatchdogMs, 2000);
});

test("parseWalkerArgs: HOUSE_MOCK_MODEL=1 sets mock even without --mock", () => {
  const before = process.env.HOUSE_MOCK_MODE;
  process.env.HOUSE_MOCK_MODEL = "1";
  try {
    const a = parseWalkerArgs(["--being", "aria", "--seat", "stdio"]);
    assert.equal(a.mock, true);
  } finally {
    delete process.env.HOUSE_MOCK_MODEL;
    if (before !== undefined) process.env.HOUSE_MOCK_MODE = before;
  }
});

test("parseWalkerArgs: --thinking-effort is read, default 'medium'", () => {
  assert.equal(parseWalkerArgs(["--being", "a", "--seat", "stdio"]).thinkingEffort, "medium");
  assert.equal(
    parseWalkerArgs(["--being", "a", "--seat", "stdio", "--thinking-effort", "high"]).thinkingEffort,
    "high",
  );
});

test("walker.mjs: missing --being or --seat is a usage error, exit 1", () => {
  const missingSeat = spawnSync("node", [WALKER, "--being", "aria"]);
  assert.notEqual(missingSeat.status, 0);
  assert.match(missingSeat.stderr.toString(), /usage: walker\.mjs/);

  const missingBeing = spawnSync("node", [WALKER, "--seat", "stdio"]);
  assert.notEqual(missingBeing.status, 0);
  assert.match(missingBeing.stderr.toString(), /usage: walker\.mjs/);
});

test("parseWalkerArgs: --room is optional for a socket seat (the new default: one seat, many rooms)", () => {
  const a = parseWalkerArgs(["--being", "aria", "--seat", "unix:/tmp/does-not-matter.sock"]);
  assert.equal(a.being, "aria");
  assert.equal(a.room, null, "no --room named — the walker seats wherever the house finds it present");
});

test("parseWalkerArgs: --max-concurrent is read, at least 1", () => {
  assert.equal(parseWalkerArgs(["--being", "a", "--seat", "stdio", "--max-concurrent", "3"]).maxConcurrent, 3);
  assert.equal(
    parseWalkerArgs(["--being", "a", "--seat", "stdio", "--max-concurrent", "0"]).maxConcurrent,
    1,
    "never less than 1 — a walker always answers at least its own room",
  );
});

// harness-port W6-B, 2026-09-19: --platforms / HOUSE_PLATFORMS_FILE.

test("parseWalkerArgs: --platforms is read", () => {
  const a = parseWalkerArgs(["--being", "a", "--seat", "stdio", "--platforms", "/tmp/servers.json"]);
  assert.equal(a.platformsFile, "/tmp/servers.json");
});

test("parseWalkerArgs: HOUSE_PLATFORMS_FILE sets platformsFile even without --platforms", () => {
  const before = process.env.HOUSE_PLATFORMS_FILE;
  process.env.HOUSE_PLATFORMS_FILE = "/tmp/env-servers.json";
  try {
    const a = parseWalkerArgs(["--being", "a", "--seat", "stdio"]);
    assert.equal(a.platformsFile, "/tmp/env-servers.json");
  } finally {
    if (before === undefined) delete process.env.HOUSE_PLATFORMS_FILE;
    else process.env.HOUSE_PLATFORMS_FILE = before;
  }
});

test("parseWalkerArgs: --platforms overrides HOUSE_PLATFORMS_FILE when both are given", () => {
  const before = process.env.HOUSE_PLATFORMS_FILE;
  process.env.HOUSE_PLATFORMS_FILE = "/tmp/env-servers.json";
  try {
    const a = parseWalkerArgs(["--being", "a", "--seat", "stdio", "--platforms", "/tmp/flag-servers.json"]);
    assert.equal(a.platformsFile, "/tmp/flag-servers.json");
  } finally {
    if (before === undefined) delete process.env.HOUSE_PLATFORMS_FILE;
    else process.env.HOUSE_PLATFORMS_FILE = before;
  }
});

// harness-port W6-R4, 2026-09-19: --exit-on-seat-loss.

test("parseWalkerArgs: --exit-on-seat-loss is read, off by default", () => {
  assert.equal(parseWalkerArgs(["--being", "a", "--seat", "stdio"]).exitOnSeatLoss, false);
  assert.equal(
    parseWalkerArgs(["--being", "a", "--seat", "stdio", "--exit-on-seat-loss"]).exitOnSeatLoss,
    true,
  );
});
