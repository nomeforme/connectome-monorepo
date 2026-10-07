/* A testament's `skills:` paths load the way the fleet's skill_paths did,
 * ride the turn as {name, description, location}, list in the address,
 * and skill_read loads one (never a file outside its directory). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "skills-"));
process.env.HOUSE_SKILLS_DIR = ROOT;
mkdirSync(join(ROOT, "alpha"), { recursive: true });
writeFileSync(join(ROOT, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Do alpha things\n---\n\n# Alpha\nsee notes.md\n");
writeFileSync(join(ROOT, "alpha", "notes.md"), "alpha notes");
mkdirSync(join(ROOT, "group", "beta"), { recursive: true });
writeFileSync(join(ROOT, "group", "beta", "SKILL.md"), "---\nname: Beta Skill\ndescription: \"Beta, quoted\"\n---\nbody");
mkdirSync(join(ROOT, "nodesc"), { recursive: true });
writeFileSync(join(ROOT, "nodesc", "SKILL.md"), "# no frontmatter");
writeFileSync(join(ROOT, "secret.txt"), "nope");

const { loadSkills, skillsFor, makeSkillTools } = await import("../src/skills.mjs");
const { skillsText } = await import("../src/walk-address-strings.mjs");

test("testament paths (/workspace/skills/…) resolve under the skills root; dirs recurse; no description, no skill", () => {
  const s = loadSkills(["/workspace/skills/alpha", "/workspace/skills/group", "/workspace/skills/nodesc", "/workspace/skills/missing"]);
  assert.deepEqual(s.map((k) => k.name), ["alpha", "Beta Skill"]);
  assert.equal(s[1].description, "Beta, quoted");
  assert.equal(s[0].location, join(ROOT, "alpha", "SKILL.md"));
});

test("the address lists them in the standard block", () => {
  const t = skillsText(skillsFor({ skills: ["/workspace/skills/alpha"] }), ["skill_read"]);
  assert.match(t, /<available_skills>[\s\S]*<name>alpha<\/name>[\s\S]*<description>Do alpha things<\/description>/);
  assert.equal(skillsText([], []), null);
});

test("skill_read loads a skill by name, a file beside it, and never a file outside it", async () => {
  const cov = { skills: ["/workspace/skills/alpha"] };
  const tools = makeSkillTools();
  const read = (input) => tools._readFor(input, cov);
  assert.match(read({ skill: "alpha" }).content, /<skill name="alpha"[\s\S]*# Alpha/);
  assert.equal(read({ skill: "alpha", path: "notes.md" }).content, "alpha notes");
  assert.throws(() => read({ skill: "alpha", path: "../secret.txt" }), /outside/);
  assert.throws(() => read({ skill: "zeta" }), /no skill/);
});
