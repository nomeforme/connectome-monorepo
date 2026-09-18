// @ts-check
/* connectome-house/test/walk-address.test.mjs — the address composed per
 * turn (src/walk-address.mjs, src/who-address.mjs, src/platform-tools-
 * address.mjs). New pins (this port's own composition; the reference
 * harness's address-registry.mjs-driven system has no equivalent here —
 * see walk-address.mjs's own header). */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presenceNote } from "../src/who-address.mjs";
import { toolsText } from "../src/platform-tools-address.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "walk-address-"));
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
writeFileSync(
  join(process.env.HOUSE_COVENANTS_DIR, "aria.md"),
  "---\nkind: testament\nhandle: aria\nspeaks_for: mock\n---\n\nAria's own persona line.\n",
);

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

test("systemFor: a known being's testament body rides the address, with standing/room/tools/date", () => {
  const text = systemFor({
    being: "aria",
    covenant: { model: "mock", tools: ["media_attach"], posture: "present" },
    context: { conversation: [{ participant: "mara" }], life: null, room: { id: "room-1" } },
  });
  assert.match(text, /Aria's own persona line\./);
  assert.match(text, /## Standing/);
  assert.match(text, /room "room-1"/);
  assert.match(text, /@mara/);
  assert.match(text, /`media_attach`/);
  assert.match(text, /Today's date is \d{4}-\d{2}-\d{2}\./);
});

test("systemFor: an unknown being (no testament) still composes, with no persona paragraph", () => {
  const text = systemFor({
    being: "nobody",
    covenant: { model: "mock", tools: [], posture: null },
    context: { conversation: [], life: null, room: null },
  });
  assert.ok(!text.includes("persona"));
  assert.match(text, /## Standing/);
  assert.ok(!text.includes("## The room you're in"));
  assert.ok(!text.includes("## Your tools"));
});

after(() => rmSync(ROOT, { recursive: true, force: true }));
