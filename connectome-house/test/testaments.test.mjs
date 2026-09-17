// @ts-check
/* connectome-house/test/testaments.test.mjs — file testaments
 * (src/testaments.mjs): a covenant file's own kind/handle/speaks_for,
 * `knownHandle`, and `isResidentKind`.
 *
 * Ported from a private deployment (2026-09-17): the source also tested
 * a "derived walker testament per active MODEL_REGISTRY entry" feature —
 * cut from this port (see the package README's "what was cut": a
 * being-container's own model routing is not the house's concern here).
 * Only the file-testament half is tested below.
 *
 * HOUSE_COVENANTS_DIR is sandboxed before the first import — never a
 * real deployment's own covenants directory.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

let sandboxCovenants;
let testaments, testamentFor, knownHandle, isResidentKind;

before(async () => {
  sandboxCovenants = mkdtempSync(join(tmpdir(), "testaments-covenants-"));
  process.env.HOUSE_COVENANTS_DIR = sandboxCovenants;
  ({ testaments, testamentFor, knownHandle, isResidentKind } = await import(
    "../src/testaments.mjs"
  ));
});

after(() => {
  rmSync(sandboxCovenants, { recursive: true, force: true });
  delete process.env.HOUSE_COVENANTS_DIR;
});

test("a file testament's frontmatter reads back as kind: resident", () => {
  writeTestament(sandboxCovenants, "zz-tst-someone", { speaksFor: "mock" });
  const t = testamentFor("zz-tst-someone");
  assert.ok(t);
  assert.equal(t.kind, "resident");
  assert.equal(t.covenant.handle, "zz-tst-someone");
  assert.equal(t.covenant.speaks_for, "mock");
});

test("isResidentKind: true for a file testament, false for an unknown handle", () => {
  assert.equal(isResidentKind("zz-tst-someone"), true); // the file fixture from the prior test
  assert.equal(isResidentKind("no-such-handle-at-all"), false);
});

test("knownHandle: true for a file testament, false for an unknown handle", () => {
  assert.equal(knownHandle("zz-tst-someone"), true);
  assert.equal(knownHandle("no-such-handle-at-all"), false);
});

test("testaments() never throws with an empty covenants dir", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "testaments-empty-"));
  const prior = process.env.HOUSE_COVENANTS_DIR;
  process.env.HOUSE_COVENANTS_DIR = emptyDir;
  try {
    const out = testaments();
    assert.deepEqual(out, {});
  } finally {
    process.env.HOUSE_COVENANTS_DIR = prior;
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
