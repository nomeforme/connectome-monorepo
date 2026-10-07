#!/usr/bin/env node
// @ts-check
/* tools/patch-membrane.mjs — membrane's native-tools request builder
 * (buildNativeToolRequest) carries text, tool_use/tool_result, thinking and
 * image blocks, and silently drops a `document` block (a PDF) — so a PDF a
 * human sent never reached the model. This adds the one missing branch,
 * next to the image branch: {type:"document", source:{type:"base64",
 * media_type, data}, title?}. Idempotent; run after install (the house
 * image runs it at build). Exits non-zero when the anchor can't be found,
 * so a membrane upgrade that moves the code fails the build loudly instead
 * of quietly dropping PDFs again.
 *
 * usage: node tools/patch-membrane.mjs [<node_modules root> ...]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const MARK = "/* house: document blocks */";
const BRANCH = `${MARK}
                else if (block.type === 'document' && block.source && block.source.type === 'base64') {
                    content.push({
                        type: 'document',
                        source: { type: 'base64', media_type: block.source.mediaType, data: block.source.data },
                        ...(block.filename ? { title: block.filename } : {}),
                    });
                }
                `;

/** every membrane dist/membrane.js reachable from here (the package's own
 * resolution, plus any pnpm-store copy under the given roots) */
function targets(roots) {
  const out = new Set();
  try {
    const req = createRequire(join(process.cwd(), "noop.js"));
    const pkg = req.resolve("@animalabs/membrane/package.json");
    out.add(join(pkg, "..", "dist", "membrane.js"));
  } catch {
    /* not resolvable from cwd */
  }
  for (const root of roots) {
    const pnpm = join(root, ".pnpm");
    if (!existsSync(pnpm)) continue;
    for (const d of readdirSync(pnpm)) {
      if (!d.startsWith("@animalabs+membrane@")) continue;
      const f = join(pnpm, d, "node_modules", "@animalabs", "membrane", "dist", "membrane.js");
      if (existsSync(f)) out.add(f);
    }
  }
  return [...out].map((p) => resolve(p));
}

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["node_modules", "../node_modules"];
const files = targets(roots);
if (!files.length) {
  console.error("patch-membrane: no @animalabs/membrane found");
  process.exit(1);
}
let failed = false;
for (const f of files) {
  let s = readFileSync(f, "utf8");
  if (s.includes(MARK)) {
    console.log(`patch-membrane: already patched ${f}`);
    continue;
  }
  const start = s.indexOf("buildNativeToolRequest(request, messages) {");
  const anchor = start >= 0 ? s.indexOf("else if (block.type === 'image') {", start) : -1;
  if (anchor < 0) {
    console.error(`patch-membrane: anchor not found in ${f}`);
    failed = true;
    continue;
  }
  s = s.slice(0, anchor) + BRANCH + s.slice(anchor);
  writeFileSync(f, s);
  console.log(`patch-membrane: patched ${f}`);
}
process.exit(failed ? 1 : 0);
