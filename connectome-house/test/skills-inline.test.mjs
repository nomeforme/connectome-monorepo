/* `inline: external` skills: in an external room the house marks them, the
 * being loads each in full (plus its `inline-with:` files from the skill dir
 * or the shared workspace, never elsewhere), and the address carries the
 * text so nothing needs a skill_read. Elsewhere they stay a one-line listing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "skills-inline-"));
const SHARED = mkdtempSync(join(tmpdir(), "shared-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "outside-"));
process.env.HOUSE_SKILLS_DIR = ROOT;
process.env.HOUSE_SHARED_DIR = SHARED;
mkdirSync(join(ROOT, "voice"), { recursive: true });
writeFileSync(join(SHARED, "primer.md"), "PRIMER TEXT");
writeFileSync(join(OUTSIDE, "secret.md"), "SECRET TEXT");
writeFileSync(join(ROOT, "voice", "beside.md"), "BESIDE TEXT");
writeFileSync(
  join(ROOT, "voice", "SKILL.md"),
  `---\nname: voice\ndescription: How to speak outside\ninline: external\ninline-with: ${join(SHARED, "primer.md")}, beside.md, ${join(OUTSIDE, "secret.md")}, ${join(SHARED, "absent.md")}\n---\n\n# Voice\nBe specific.\n`,
);
mkdirSync(join(ROOT, "plain"), { recursive: true });
writeFileSync(join(ROOT, "plain", "SKILL.md"), "---\nname: plain\ndescription: A plain skill\n---\nplain body");

const { skillsFor, inlineBody } = await import("../src/skills.mjs");
const { skillsText } = await import("../src/walk-address-strings.mjs");
const cov = { skills: ["/workspace/skills/voice", "/workspace/skills/plain"] };

test("outside an external room nothing is marked inline", () => {
  for (const s of skillsFor(cov)) assert.equal(s.inline, undefined, s.name);
});

test("in an external room only the inline skill is marked, with its files", () => {
  const [voice, plain] = skillsFor(cov, { external: true });
  assert.equal(voice.inline, true);
  assert.equal(voice.inlineWith.length, 4);
  assert.equal(plain.inline, undefined);
});

test("the being loads the body and allowed files only; the address carries them in full", () => {
  const [voice] = skillsFor(cov, { external: true });
  const body = inlineBody(voice);
  assert.match(body, /^# Voice\nBe specific\./);
  assert.doesNotMatch(body, /inline: external/); // frontmatter stripped
  assert.match(body, /PRIMER TEXT/);
  assert.match(body, /BESIDE TEXT/);
  assert.doesNotMatch(body, /SECRET TEXT/); // outside the skill dir and the shared workspace
  const t = skillsText([{ ...voice, body }], ["skill_read"]);
  assert.match(t, /<available_skills>[\s\S]*<\/available_skills>\n\nThe voice skill applies to this room and is loaded in full below\.\n<skill_content name="voice">\n# Voice/);
  assert.match(t, /PRIMER TEXT[\s\S]*<\/skill_content>$/);
});
