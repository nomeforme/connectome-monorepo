// @ts-check
/* connectome-house/test/resident-covenant.test.mjs — residentHandles():
 * a handle with no testament at all still passes through unfiltered
 * (downstream readers already require a real testament too), trims
 * whitespace, and keeps duplicates/order as given.
 *
 * Ported from a private deployment (2026-09-17): the source's own test
 * also covered `residentHandles()`'s walker-kind filter (`testamentFor(h)
 * ?.kind !== "walker"`), exercised against a DERIVED walker testament —
 * one synthesized per pinned model. That whole feature is cut from this
 * port (see the package README's "what was cut"), and with it goes any
 * way to produce a `kind: "walker"` testament at all: `testaments.mjs`'s
 * file-testament scan hardcodes every result's `kind` to `"resident"`
 * regardless of frontmatter content. The filter line in
 * `resident-covenant.mjs` is kept (harmless, defensive) but is dead code
 * in this port — not tested here for exactly that reason.
 *
 * HOUSE_COVENANTS_DIR is sandboxed before the first import — never a
 * real deployment's own covenants dir.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

let sandboxCovenants;
let residentHandles;

before(async () => {
  sandboxCovenants = mkdtempSync(join(tmpdir(), "resident-covenant-covenants-"));
  process.env.HOUSE_COVENANTS_DIR = sandboxCovenants;
  writeTestament(sandboxCovenants, "resident", { speaksFor: "mock" });
  ({ residentHandles } = await import("../src/resident-covenant.mjs"));
});

after(() => {
  rmSync(sandboxCovenants, { recursive: true, force: true });
  delete process.env.HOUSE_COVENANTS_DIR;
  delete process.env.HOUSE_RESIDENTS;
});

test("a handle with no testament at all still passes through unfiltered", () => {
  // downstream readers already require a real testament too — this
  // filter only ever removes a DEFINITE walker, never invents a refusal.
  process.env.HOUSE_RESIDENTS = "resident,nobody-configured-here";
  assert.deepEqual(residentHandles(), ["resident", "nobody-configured-here"]);
});

test("residentHandles(): trims, dedupes empties, ignores whitespace-only entries", () => {
  process.env.HOUSE_RESIDENTS = " resident , , resident ,another ";
  assert.deepEqual(residentHandles(), ["resident", "resident", "another"]);
});
