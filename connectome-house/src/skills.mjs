// @ts-check
/* connectome-house/src/skills.mjs — a being's skills (Agent Skills
 * standard: a SKILL.md with `name`/`description` frontmatter), named by its
 * testament's `skills:` list exactly as the fleet's `skill_paths` named
 * them. Discovery matches the fleet's loader: a path may be a SKILL.md, a
 * directory (any top-level .md, plus every SKILL.md beneath it), first
 * name wins, a skill without a description is skipped.
 *
 * Skills live under HOUSE_SKILLS_DIR (default /workspace/skills — the same
 * absolute paths the testaments carry, so a path reads the same from the
 * house and from a being's terminal). Each turn the house hands the being
 * its skills' {name, description, location}; the being's address lists
 * them, and `skill_read` (or a terminal) loads one when the task matches.
 */
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { traceReach } from "./trace.mjs";

const DEFAULT_ROOT = "/workspace/skills";
export const skillsRoot = () => process.env.HOUSE_SKILLS_DIR ?? DEFAULT_ROOT;
const READ_CAP = 200_000;

/** testament path → path on this machine: `/workspace/skills/x` is read
 * under the skills root (identical by default); a relative path is taken
 * relative to it; any other absolute path as-is. */
export function resolveSkillPath(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  const root = skillsRoot();
  if (p === DEFAULT_ROOT || p.startsWith(DEFAULT_ROOT + "/")) return join(root, p.slice(DEFAULT_ROOT.length));
  return isAbsolute(p) ? p : join(root, p);
}

/** minimal frontmatter: `key: value` lines between leading `---` fences;
 * quoted values unquoted; `true`/`false` as booleans. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  /** @type {Record<string, any>} */
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fm[kv[1]] = v === "true" ? true : v === "false" ? false : v;
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

function loadFile(file) {
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(file, "utf8"));
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!description) return null;
    return {
      name: String(frontmatter.name || basename(dirname(file))),
      description,
      location: file,
      baseDir: dirname(file),
      hidden: frontmatter["disable-model-invocation"] === true,
    };
  } catch {
    return null;
  }
}

function loadDir(dir, includeRootMd, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const s = statSync(full);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) loadDir(full, false, out);
    else if (isFile && ((includeRootMd && e.name.endsWith(".md")) || (!includeRootMd && e.name === "SKILL.md"))) {
      const s = loadFile(full);
      if (s) out.push(s);
    }
  }
}

/** every skill a testament's `skills:` list names, first name wins.
 * @param {unknown} paths @returns {{name: string, description: string, location: string, baseDir: string, hidden: boolean}[]} */
export function loadSkills(paths) {
  if (!Array.isArray(paths)) return [];
  const found = [];
  for (const p of paths) {
    const abs = resolveSkillPath(p);
    if (!abs || !existsSync(abs)) continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) loadDir(abs, true, found);
    else if (abs.endsWith(".md")) {
      const s = loadFile(abs);
      if (s) found.push(s);
    }
  }
  const byName = new Map();
  for (const s of found) if (!byName.has(s.name)) byName.set(s.name, s);
  return [...byName.values()];
}

/** what rides on a turn's covenant: the skills a being's address lists */
export function skillsFor(cov) {
  return loadSkills(cov?.skills)
    .filter((s) => !s.hidden)
    .map(({ name, description, location }) => ({ name, description, location }));
}

const within = (base, p) => {
  const rel = relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** `skill_read`: a being reads one of its own skills, or a file beside it.
 * Granted on any turn whose testament names skills. */
export function makeSkillTools() {
  const definitions = [
    {
      name: "skill_read",
      description:
        "Read one of your skills (listed in <available_skills>), or a file inside that skill's directory. " +
        "Pass the skill's name or its location; pass `path` to read a file the skill references, relative to its directory.",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string", description: "The skill's name or location, as listed" },
          path: { type: "string", description: "Optional: a file inside the skill's directory, relative to it" },
        },
        required: ["skill"],
      },
    },
  ];
  let activeCtx = null;
  let activeHandle = null;

  function read(input, cov) {
    const want = String(input?.skill ?? "").trim();
    if (!want) throw new Error("skill_read: name a skill");
    const skills = loadSkills(cov?.skills);
    const s = skills.find((k) => k.name === want || k.location === want || k.baseDir === want || resolveSkillPath(want) === k.location);
    if (!s) throw new Error(`skill_read: no skill "${want}". Yours: ${skills.map((k) => k.name).join(", ") || "(none)"}`);
    let file = s.location;
    if (input?.path) {
      file = resolve(s.baseDir, String(input.path));
      try {
        file = realpathSync(file);
      } catch {
        throw new Error(`skill_read: ${input.path} not found in ${s.baseDir}`);
      }
      if (!within(realpathSync(s.baseDir), file)) throw new Error("skill_read: path is outside the skill's directory");
    }
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`skill_read: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (text.length > READ_CAP) text = `${text.slice(0, READ_CAP)}\n… (truncated)`;
    if (file === s.location) {
      const body = parseFrontmatter(text).body;
      text = `<skill name="${s.name}" location="${s.location}">\nReferences are relative to ${s.baseDir}/\n\n${body}\n</skill>`;
    }
    return { content: text };
  }

  return {
    definitions,
    /** test seam: the reader against an explicit covenant */
    _readFor: read,
    beginTurn(ctx, handle) {
      activeCtx = ctx;
      activeHandle = handle;
    },
    /** @param {{id: string, name: string, input: any}} call */
    async execute(call) {
      const { covenantFor } = await import("./resident-covenant.mjs");
      const cov = activeHandle ? covenantFor(activeHandle) : null;
      return traceReach(activeCtx, call, async () => read(call.input, cov));
    },
  };
}
