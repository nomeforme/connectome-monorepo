// @ts-check
/* connectome-house/test/walk-address.test.mjs — the address composed per
 * turn (src/walk-address.mjs, src/who-address.mjs, src/platform-tools-
 * address.mjs). New pins (this port's own composition; the reference
 * harness's address-registry.mjs-driven system has no equivalent here —
 * see walk-address.mjs's own header).
 *
 * harness-port W-address-reconcile: HOUSE_COVENANTS_DIR AND
 * HOUSE_PRIVATE_DIR are both sandboxed before every import of a module
 * that could touch either (module-scope reads in testaments.mjs's
 * COVENANTS_DIR closure and serve-paths.mjs's PRIVATE_DIR const alike —
 * the latter is a plain const, resolved once at first evaluation, so
 * `who-address.mjs`/`walk-address.mjs` are pulled in by DYNAMIC import,
 * after the env vars are set, same discipline as resident-life.test.mjs's
 * own header explains). See address-reconcile.test.mjs for the fuller
 * identity/persona/presence/life-marker coverage this file doesn't
 * duplicate. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "walk-address-"));
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
writeFileSync(
  join(process.env.HOUSE_COVENANTS_DIR, "aria.md"),
  "---\nkind: testament\nhandle: aria\nspeaks_for: mock\n---\n\n## Origin\n\nPorted from nowhere in particular — keeper-facing record only.\n\n## Address\n\nAria's own persona line.\n",
);

const { presenceNote } = await import("../src/who-address.mjs");
const { toolsText } = await import("../src/platform-tools-address.mjs");
const { systemFor } = await import("../src/walk-address.mjs");

test("presenceNote: names distinct others, drops the walker's own name and blanks", () => {
  assert.equal(presenceNote("aria", ["aria"]), "");
  assert.equal(presenceNote("aria", ["mara", "aria", "mara", "theo"]), "Also present in this conversation so far: @mara, @theo.");
});

test("toolsText: empty/undefined -> no section; named tools render as a code-quoted list", () => {
  assert.equal(toolsText(undefined), "");
  assert.equal(toolsText([]), "");
  assert.equal(toolsText(["record_search", "media_attach"]), "## Your tools\n\nThis room currently offers you: `record_search`, `media_attach`.");
});

test("systemFor: a known being's testament ## Address section rides the address, with standing/room/tools/date — the Origin paragraph does not", () => {
  const text = systemFor({
    being: "aria",
    covenant: { model: "mock", tools: ["media_attach"], posture: "present" },
    context: { conversation: [{ participant: "mara" }], life: null, room: { id: "room-1" } },
  });
  assert.match(text, /Aria's own persona line\./);
  assert.ok(!text.includes("keeper-facing record only"), "the Origin paragraph never rides the turn");
  assert.match(text, /You are seated here as aria, speaking through mock\./);
  assert.match(text, /## Standing/);
  assert.match(text, /room "room-1"/);
  assert.match(text, /@mara/);
  assert.match(text, /`media_attach`/);
  assert.match(text, /Today's date is \d{4}-\d{2}-\d{2}\./);
});

test("systemFor: an unknown being (no testament) still composes, with no persona paragraph, but still states who's seated here", () => {
  const text = systemFor({
    being: "nobody",
    covenant: { model: "mock", tools: [], posture: null },
    context: { conversation: [], life: null, room: null },
  });
  assert.ok(!text.includes("persona"));
  assert.match(text, /You are seated here as nobody, speaking through mock\./);
  assert.match(text, /## Standing/);
  assert.ok(!text.includes("## The room you're in"));
  assert.ok(!text.includes("## Your tools"));
});

after(() => rmSync(ROOT, { recursive: true, force: true }));
