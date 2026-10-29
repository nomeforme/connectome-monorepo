// @ts-check
/* identity-map.mjs's account kind: `kind: "ai"` persists per entry across
 * platforms; anyone may mark or tighten; un-marking, raising or removing a
 * limit needs a keeper; a keeper's "human" can't be overridden by others. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "identity-ai-"));
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
for (const d of ["private", "runs", "covenants"]) mkdirSync(join(ROOT, d), { recursive: true });
process.env.HOUSE_IDENTITY_SALT = "identity-ai-test-salt-0123456789";
writeTestament(process.env.HOUSE_COVENANTS_DIR, "zz-ia-being");

const { identityFor, identityMapPath, kindOf, aiInfo, markAI, clearAI, setAILimit, linkIdentity } = await import(
  "../src/identity-map.mjs"
);
after(() => rmSync(ROOT, { recursive: true, force: true }));

test("markAI persists kind/by/at/reason on the entry; identityFor returns kind and ai_limit", () => {
  const { handle } = identityFor({ platform: "signal", id: "u-ia-1", display: "Botty One" });
  assert.equal(kindOf(handle), null);
  const r = markAI(handle, { by: "zz-ia-being", reason: "says it is a bot", limit: 2 });
  assert.deepEqual(r, { ok: true, changed: true, kind: "ai", ai_limit: 2 });
  const stored = JSON.parse(readFileSync(identityMapPath(), "utf8")).entries["signal:u-ia-1"];
  assert.equal(stored.kind, "ai");
  assert.equal(stored.kind_set_by, "zz-ia-being");
  assert.equal(stored.kind_reason, "says it is a bot");
  assert.equal(stored.ai_limit, 2);
  assert.ok(stored.kind_set_at);
  const again = identityFor({ platform: "signal", id: "u-ia-1" });
  assert.equal(again.kind, "ai");
  assert.equal(again.ai_limit, 2);
  assert.equal(aiInfo(handle)?.kind_set_by, "zz-ia-being");
});

test("lowering a limit is open to anyone; raising or removing needs a keeper", () => {
  const { handle } = identityFor({ platform: "signal", id: "u-ia-2", display: "Botty Two" });
  markAI(handle, { by: "a", limit: 3 });
  assert.equal(markAI(handle, { by: "b", limit: 1 }).ai_limit, 1);
  const raise = markAI(handle, { by: "b", limit: 5 });
  assert.equal(raise.ok, false);
  assert.equal(raise.needsKeeper, true);
  assert.equal(setAILimit(handle, null, { by: "b" }).needsKeeper, true);
  assert.equal(setAILimit(handle, 4, { by: "b" }).needsKeeper, true);
  assert.equal(aiInfo(handle)?.ai_limit, 1);
  assert.equal(setAILimit(handle, 4, { by: "kp", keeper: true }).ai_limit, 4);
  assert.equal(setAILimit(handle, null, { by: "kp", keeper: true }).ai_limit, null);
  // no limit now: setting one is a tightening, open to anyone
  assert.equal(setAILimit(handle, 2, { by: "b" }).ai_limit, 2);
  assert.equal(markAI(handle, { by: "b" }).changed, false, "no limit given keeps the current one");
});

test("clearAI refuses without a keeper; a keeper's 'human' blocks later non-keeper marks", () => {
  const { handle } = identityFor({ platform: "signal", id: "u-ia-3", display: "Maybe Bot" });
  markAI(handle, { by: "house:heuristic", reason: "fast" });
  const refused = clearAI(handle, { by: "zz-ia-being" });
  assert.equal(refused.ok, false);
  assert.equal(kindOf(handle), "ai");
  assert.deepEqual(clearAI(handle, { by: "kp", keeper: true }), { ok: true, changed: true });
  assert.equal(kindOf(handle), "human");
  assert.equal(identityFor({ platform: "signal", id: "u-ia-3" }).ai_limit, null);
  const remark = markAI(handle, { by: "house:heuristic", reason: "fast again" });
  assert.equal(remark.ok, false);
  assert.equal(remark.needsKeeper, true);
  assert.equal(markAI(handle, { by: "kp", keeper: true }).ok, true);
});

test("the mark covers every platform entry sharing the handle; beings and unknown handles refuse", () => {
  mkdirSync(join(process.env.HOUSE_PRIVATE_DIR ?? "", "zz-ia-two"), { recursive: true });
  linkIdentity({ platform: "signal", id: "u-ia-4", handle: "zz-ia-two" });
  linkIdentity({ platform: "discord", id: "d-ia-4", handle: "zz-ia-two" });
  markAI("zz-ia-two", { by: "x", limit: 1 });
  const entries = JSON.parse(readFileSync(identityMapPath(), "utf8")).entries;
  assert.equal(entries["signal:u-ia-4"].kind, "ai");
  assert.equal(entries["discord:d-ia-4"].kind, "ai");
  assert.equal(identityFor({ platform: "discord", id: "d-ia-4" }).kind, "ai");
  assert.equal(markAI("zz-ia-being", { by: "x" }).ok, false);
  assert.equal(markAI("nobody-here", { by: "x" }).ok, false);
  assert.equal(markAI("zz-ia-two", { by: "x", limit: -1 }).ok, false);
});
