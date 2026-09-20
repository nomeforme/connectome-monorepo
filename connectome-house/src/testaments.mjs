// @ts-check
/* Which handles this house has issued a covenant to: covenant/*.md files
 * whose frontmatter carries `kind: testament` and `handle:` (a FILE
 * testament, kind: "resident" in the returned record).
 *
 * Ported from a private deployment (2026-09-17): the source also
 * synthesized one DERIVED testament per entry in its own pinned-model
 * registry, so every model it could route to was automatically "a being"
 * too. Per this port's target design (a being's model-resolver and
 * gateway routing are the being's OWN container's concern, never the
 * house's — see docs/harness-port/03-house-design.md §3.1), that feature
 * is cut here: a house covenant is always an explicit file. A deployer
 * wanting a model available with no bespoke persona can still write a
 * one-line testament pointing `speaks_for` at that model id.
 *
 * testaments() returns {handle -> {path, covenant, kind}}, cached by a
 * dir/mtime signature so a keeper's edit is picked up without a restart.
 * `knownHandle` is the required gate before any handle reaches
 * PRIVATE_ROOT's bare join; `isResidentKind` is the narrower gate every
 * autonomy-bearing site must use instead. HANDLE_RE: lowercase slug,
 * 2-24 chars, letters/digits/dashes, starting with a letter or digit. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { houseConfig } from "./house-config.mjs";
import { PRIVATE_ROOT } from "./serve-paths.mjs";

/** the covenant-file scan root — overridable so tests can plant a fixture
 * testament without touching a real deployment's own covenant directory. */
export const COVENANTS_DIR = () =>
  process.env.HOUSE_COVENANTS_DIR || join(houseConfig().roots.private, "..", "covenants");

/** same grammar as accounts.mjs's HANDLE_RE (lowercase slug, 2-24 chars,
 * letters/digits/dashes, starting with a letter or digit). */
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;

function isValidHandle(h) {
  return typeof h === "string" && HANDLE_RE.test(h);
}

/* ---------- a small hand-rolled frontmatter parser ----------
 * Bare scalars, one level of nested maps (2-space indent), and flow
 * lists only — not a general YAML parser. */

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => parseScalar(x)) : [];
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  return s;
}

function parseFrontmatter(block) {
  const root = {};
  let nested = null;
  for (const raw of block.split("\n")) {
    if (!raw.trim()) continue;
    const m = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const [, indent, key, val] = m;
    if (indent.length === 0) {
      if (val.trim() === "") {
        nested = {};
        root[key] = nested;
      } else {
        root[key] = parseScalar(val);
        nested = null;
      }
    } else if (nested) {
      nested[key] = parseScalar(val);
    }
  }
  return root;
}

/** split a markdown file into its YAML frontmatter block and body — the
 * ONE place the `---` fence grammar lives (user-notes.mjs, serve-identity.mjs,
 * resident-tools.mjs import this rather than re-spelling the regex).
 * `front` is null when the file has no fence at all. */
export function splitFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { front: null, body: text };
  return { front: m[1], body: text.slice(m[0].length) };
}

/** The ONE part of a testament BODY meant to reach a being directly — the
 * text between a `## Address` heading and the next `## ` heading (or
 * EOF). Everything else a covenant file carries below its frontmatter —
 * an Origin paragraph, porting notes, a quoted historical line, anything
 * written about the being rather than to it — is keeper-facing record,
 * never spoken to the being itself. Shared by `walk-address.mjs`'s
 * `personaFor()` (the turn's own persona prose) and `resident-life.mjs`'s
 * `testamentBody()` (the life's own head-seed) — one gate, read the same
 * way in both places. Returns null when the body carries no such section
 * at all, or an empty one — an honest gap, never a fallback to the whole
 * body. @param {string} body @returns {string|null} */
export function addressSection(body) {
  const lines = String(body ?? "").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Address\s*$/.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n").trim();
  return section.length ? section : null;
}

/** frontmatter `address_mode` — the ONE frontmatter field `walk-address.mjs`'s
 * `systemFor()` reads to decide how a being's own `## Address` section
 * rides the turn: `"verbatim"` (the default — the old fleet's own
 * system-prompt shape, as-is: the Address text IS the whole composed
 * address, nothing else assembled around it) or `"append"` (today's full
 * house address, with the Address text riding where `personaFor()` puts
 * it). Anything else written there is a keeper's typo, not a third mode —
 * logged once and treated as the default rather than silently doing the
 * wrong thing. @param {string} handle @returns {"verbatim"|"append"} */
export function addressModeFor(handle) {
  const t = testamentFor(handle);
  const raw = t?.covenant?.address_mode;
  if (raw === "append") return "append";
  if (raw === undefined || raw === null || raw === "verbatim") return "verbatim";
  console.error(
    `[address] ${t.path}: unknown address_mode ${JSON.stringify(raw)} — falling back to verbatim`,
  );
  return "verbatim";
}

function readCovenant(path) {
  const { front } = splitFrontmatter(readFileSync(path, "utf8"));
  if (front == null) return null;
  return parseFrontmatter(front);
}

/* ---------- the scan, cached by a dir/mtime signature ---------- */

let cache = { dir: null, sig: "", value: /** @type {Record<string, any>} */ ({}) };

function dirSignature(dir) {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      try {
        return `${f}:${statSync(join(dir, f)).mtimeMs}`;
      } catch {
        return f;
      }
    })
    .sort()
    .join("|");
}

/** every testament in the covenants dir — {handle -> {path, covenant,
 * kind: "resident"}}. Cached until the scanned dir's file set or any .md
 * file's mtime changes. */
export function testaments() {
  const dir = COVENANTS_DIR();
  const sig = dirSignature(dir);
  if (cache.dir === dir && cache.sig === sig) return cache.value;
  const out = /** @type {Record<string, any>} */ ({});
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      try {
        const covenant = readCovenant(path);
        if (covenant && covenant.kind === "testament" && typeof covenant.handle === "string") {
          out[covenant.handle] = { path, covenant, kind: "resident" };
        }
      } catch {
        /* an unreadable/malformed file is honestly absent from the scan,
           never a thrown error at request time */
      }
    }
  }
  cache = { dir, sig, value: out };
  return out;
}

/** the one testament for `handle`, or null (including for an invalid
 * handle shape — never even reaches the scan). */
export function testamentFor(handle) {
  if (!isValidHandle(handle)) return null;
  return testaments()[handle] ?? null;
}

/** valid AND (a private root already exists for it, OR it holds a
 * testament). A handle that fails this is honestly unknown to the house,
 * not silently created.
 *
 * Ported from a private deployment: the source also treated a handle
 * known to its own product-side account store as "known" here. That
 * account system is a product-layer concern (this port carries no user
 * accounts), so this port drops that third check — a deployment wanting
 * it back can widen this function itself. */
export function knownHandle(h) {
  if (!isValidHandle(h)) return false;
  if (existsSync(PRIVATE_ROOT(h))) return true;
  return !!testamentFor(h);
}

/** whether `handle` holds a RESIDENT-kind testament — every autonomy-
 * bearing site (the HOUSE_RESIDENTS allowlist, resident-tool mounting,
 * elective continuation) must gate on THIS, not on knownHandle. */
export function isResidentKind(handle) {
  return testamentFor(handle)?.kind === "resident";
}
