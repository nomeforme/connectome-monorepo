// @ts-check
/* harness/test/serve-paths.test.mjs — removeRun(id), the only sanctioned
 * way to delete a run directory (serve-paths.mjs). Guards against exactly
 * the three failure modes behind the 2026-08-18 `rm -rf runs/$ID` incident
 * (app/log.md): a silently-empty/invalid id, a path that escapes RUNS, and
 * a target that isn't really a directory.
 *
 * HOUSE_RUNS_DIR is set to a throwaway mkdtemp sandbox BEFORE serve-paths.mjs
 * is first imported (its RUNS constant is computed once, at import time,
 * from the env var), so this file never holds a live path into the real
 * ledger — same discipline as serve-snapshot.test.mjs.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runsSandbox = mkdtempSync(join(tmpdir(), "house-removerun-runs-"));
process.env.HOUSE_RUNS_DIR = runsSandbox;

const { RUNS, removeRun, runsReferencing } = await import("../src/serve-paths.mjs");
assert.equal(RUNS, runsSandbox, "sanity: serve-paths.mjs honored HOUSE_RUNS_DIR");

beforeEach(() => {
  rmSync(RUNS, { recursive: true, force: true });
  mkdirSync(RUNS, { recursive: true });
});

after(() => rmSync(RUNS, { recursive: true, force: true }));

test("removeRun: an empty or missing id throws — never a silent no-op over all of RUNS", () => {
  assert.throws(() => removeRun(""), /invalid run id/);
  assert.throws(() => removeRun(undefined), /invalid run id/);
  assert.throws(() => removeRun(null), /invalid run id/);
});

test("removeRun: a traversal id throws — RUN_ID_RE forbids \"/\" outright", () => {
  assert.throws(() => removeRun("../x"), /invalid run id/);
  assert.throws(() => removeRun("../../etc/passwd"), /invalid run id/);
  assert.throws(() => removeRun("a/b"), /invalid run id/);
});

test("removeRun: an id that's too short (below the 6-char floor) throws", () => {
  assert.throws(() => removeRun("abc"), /invalid run id/);
});

test("removeRun: a well-formed id naming a real dir under RUNS is removed", () => {
  const id = "zz-removerun-fixture";
  const dir = join(RUNS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "frames.jsonl"), "");
  assert.ok(existsSync(dir));

  assert.deepEqual(removeRun(id), { ok: true });

  assert.ok(!existsSync(dir), "the run dir is gone");
  assert.ok(existsSync(RUNS), "RUNS itself is untouched");
});

test("removeRun: refuses an ancestor another run's forkedFrom still names — {ok:false, referencedBy}; force removes it", () => {
  const parent = "zz-removerun-parent";
  const forks = ["zz-removerun-fork-b", "zz-removerun-fork-a"];
  mkdirSync(join(RUNS, parent), { recursive: true });
  writeFileSync(join(RUNS, parent, "class.json"), JSON.stringify({ class: "sounding" }));
  for (const f of forks) {
    mkdirSync(join(RUNS, f), { recursive: true });
    writeFileSync(
      join(RUNS, f, "class.json"),
      JSON.stringify({ class: "sounding", forkedFrom: { run: parent, seq: 2 } }),
    );
  }
  // an unrelated run, and one with no class.json at all — neither counts
  mkdirSync(join(RUNS, "zz-removerun-other"), { recursive: true });
  writeFileSync(join(RUNS, "zz-removerun-other", "class.json"), JSON.stringify({ class: "sounding" }));
  mkdirSync(join(RUNS, "zz-removerun-bare"), { recursive: true });

  assert.deepEqual(runsReferencing(parent), [...forks].sort());
  const refused = removeRun(parent);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.referencedBy, [...forks].sort());
  assert.match(refused.reason, /force/);
  assert.ok(existsSync(join(RUNS, parent)), "refused — the ancestor stays");

  // a fork (a leaf nobody points at) removes normally
  assert.deepEqual(removeRun(forks[0]), { ok: true });
  // the other fork still holds the parent
  assert.equal(removeRun(parent).ok, false);
  assert.deepEqual(removeRun(parent, { force: true }), { ok: true });
  assert.ok(!existsSync(join(RUNS, parent)));
});

test("removeRun: a well-formed id that doesn't exist under RUNS throws (not a directory)", () => {
  assert.throws(() => removeRun("zz-never-created-run"), /not a directory/);
});

test("removeRun: a well-formed id naming a FILE (not a dir) under RUNS throws", () => {
  const id = "zz-removerun-a-file";
  writeFileSync(join(RUNS, id), "not a directory");
  assert.throws(() => removeRun(id), /not a directory/);
  assert.ok(existsSync(join(RUNS, id)), "the file is left alone, never removed");
});
