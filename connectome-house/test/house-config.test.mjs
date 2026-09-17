// @ts-check
// house-config.mjs's own defaults: every DEFAULT equals this package's
// own hard-wired path, a house-config.json (HOUSE_CONFIG_FILE) overrides
// only the keys it names, and serve-paths.mjs's own env overrides still
// win over both. Never a real deployment's own house-config.json — only
// ever a mkdtemp fixture.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "house-config-"));
after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

test("houseConfig(): every default equals this package's own hard-wired path", async () => {
  const { houseConfig, DEFAULTS } = await import("../src/house-config.mjs");
  const cfg = houseConfig();
  assert.deepEqual(cfg, DEFAULTS);
  assert.equal(cfg.roots.runs, join(PACKAGE_ROOT, "runs"));
  assert.equal(cfg.roots.private, join(PACKAGE_ROOT, "private"));
  assert.equal(cfg.archive.enabled, false);
  assert.equal(cfg.archive.path, null);
});

test("houseConfig(): a house-config.json overrides only the keys it names, package-relative", async () => {
  const { houseConfig, _resetHouseConfigCache } = await import("../src/house-config.mjs");
  const houseJsonPath = join(FIXTURE_DIR, "house-config.json");
  writeFileSync(
    houseJsonPath,
    JSON.stringify({ roots: { runs: "zz-fixture-runs" }, archive: { enabled: true, path: "zz-archive" } }),
  );
  const prev = process.env.HOUSE_CONFIG_FILE;
  process.env.HOUSE_CONFIG_FILE = houseJsonPath;
  _resetHouseConfigCache();
  try {
    const cfg = houseConfig();
    assert.equal(
      cfg.roots.runs,
      join(PACKAGE_ROOT, "zz-fixture-runs"),
      "named key overrides, package-relative",
    );
    assert.equal(
      cfg.roots.private,
      join(PACKAGE_ROOT, "private"),
      "an unnamed key keeps its default",
    );
    assert.equal(cfg.archive.enabled, true);
    assert.equal(cfg.archive.path, join(PACKAGE_ROOT, "zz-archive"));
  } finally {
    if (prev === undefined) delete process.env.HOUSE_CONFIG_FILE;
    else process.env.HOUSE_CONFIG_FILE = prev;
    _resetHouseConfigCache();
  }
});

test("houseConfig(): HOUSE_ARCHIVE_PATH alone enables the archive mount with no house-config.json", async () => {
  const { houseConfig, _resetHouseConfigCache } = await import("../src/house-config.mjs");
  delete process.env.HOUSE_CONFIG_FILE;
  const prevArchive = process.env.HOUSE_ARCHIVE_PATH;
  process.env.HOUSE_ARCHIVE_PATH = "/tmp/some-archive";
  _resetHouseConfigCache();
  try {
    const cfg = houseConfig();
    assert.equal(cfg.archive.enabled, true);
    assert.equal(cfg.archive.path, "/tmp/some-archive");
  } finally {
    if (prevArchive === undefined) delete process.env.HOUSE_ARCHIVE_PATH;
    else process.env.HOUSE_ARCHIVE_PATH = prevArchive;
    _resetHouseConfigCache();
  }
});

test("serve-paths.mjs: RUNS/PRIVATE_DIR still honor HOUSE_RUNS_DIR/HOUSE_PRIVATE_DIR over house-config's own default", async () => {
  const { _resetHouseConfigCache } = await import("../src/house-config.mjs");
  delete process.env.HOUSE_CONFIG_FILE;
  _resetHouseConfigCache();
  const runsSandbox = mkdtempSync(join(tmpdir(), "house-config-runs-"));
  const privateSandbox = mkdtempSync(join(tmpdir(), "house-config-private-"));
  process.env.HOUSE_RUNS_DIR = runsSandbox;
  process.env.HOUSE_PRIVATE_DIR = privateSandbox;
  try {
    const { RUNS, PRIVATE_DIR } = await import("../src/serve-paths.mjs");
    assert.equal(RUNS, runsSandbox, "the env override wins over house-config's default");
    assert.equal(PRIVATE_DIR, privateSandbox);
  } finally {
    rmSync(runsSandbox, { recursive: true, force: true });
    rmSync(privateSandbox, { recursive: true, force: true });
  }
});
