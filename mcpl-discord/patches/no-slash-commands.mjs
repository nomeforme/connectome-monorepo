#!/usr/bin/env node
// mcpl-discord/patches/no-slash-commands.mjs
//
// Idempotent post-install patch over the pinned upstream discord-mcpl
// server's own COMPILED output (node_modules/@animalabs/discord-mcpl/
// dist/src/*.js) — never this recipe's source (it has none to vendor),
// never a fork. Run automatically by this package's own "postinstall"
// script (package.json) right after `npm install` drops the pin into
// node_modules; can also be run by hand against an already-installed copy.
//
// What it does, in the compiled JS:
//   1. dist/src/index.js — wraps the unconditional
//      `await server.setupSlashCommands()` call in a check: when
//      process.env.DISCORD_DISABLE_SLASH_COMMANDS === "1", registration is
//      skipped and a stderr line is printed instead. Unset or any other
//      value: unchanged upstream behaviour.
//   2. dist/src/discord-adapter.js — defensively tightens the guildCreate
//      re-registration guard from `if (this.guildCommandDefs)` to
//      `if (this.guildCommandDefs && this.guildCommandDefs.length)`, so a
//      newly-joined guild is never handed an empty/undefined command-def
//      list even if some future code path sets guildCommandDefs to [].
//
// This is a plain string replacement, matched against the EXACT text the
// pinned commit (github:anima-research/discord-mcpl#5fa3db9) compiles to.
// If neither that text NOR this patch's own already-applied text is found,
// the pin has moved and blindly patching would be a silent no-op (or worse,
// a corrupt one) — so this script FAILS LOUDLY (non-zero exit, and the
// exact message below) instead. No Discord login happens here; this only
// edits files already on disk under node_modules (gitignored, not vendored,
// not committed).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", "node_modules", "@animalabs", "discord-mcpl");

const INDEX_PATH = join(pkgRoot, "dist", "src", "index.js");
const ADAPTER_PATH = join(pkgRoot, "dist", "src", "discord-adapter.js");

const INDEX_BEFORE = [
  "    try {",
  "        await server.setupSlashCommands();",
  "        console.error('[discord-mcpl] Slash commands registered');",
  "    }",
  "    catch (err) {",
  "        console.error('[discord-mcpl] Slash command setup failed:', err.message);",
  "    }",
].join("\n");

const INDEX_AFTER = [
  "    if (process.env.DISCORD_DISABLE_SLASH_COMMANDS === '1') {",
  "        console.error('[discord-mcpl] slash-command registration disabled by DISCORD_DISABLE_SLASH_COMMANDS');",
  "    }",
  "    else {",
  "        try {",
  "            await server.setupSlashCommands();",
  "            console.error('[discord-mcpl] Slash commands registered');",
  "        }",
  "        catch (err) {",
  "            console.error('[discord-mcpl] Slash command setup failed:', err.message);",
  "        }",
  "    }",
].join("\n");

const ADAPTER_BEFORE = [
  "            // Register slash commands in guilds joined after startup.",
  "            if (this.guildCommandDefs) {",
  "                guild.commands.set(this.guildCommandDefs).catch((err) => {",
  "                    console.error(`[discord-mcpl] Failed to register commands in new guild ${guild.id}:`, err.message);",
  "                });",
  "            }",
].join("\n");

const ADAPTER_AFTER = [
  "            // Register slash commands in guilds joined after startup.",
  "            if (this.guildCommandDefs && this.guildCommandDefs.length) {",
  "                guild.commands.set(this.guildCommandDefs).catch((err) => {",
  "                    console.error(`[discord-mcpl] Failed to register commands in new guild ${guild.id}:`, err.message);",
  "                });",
  "            }",
].join("\n");

function patchFile(path, label, before, after) {
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch (err) {
    console.error(
      `[no-slash-commands] cannot read ${label} at ${path}: ${err.message}. ` +
        `Has \`npm install\` run in mcpl-discord/ yet?`,
    );
    process.exit(1);
  }

  if (src.includes(after)) {
    console.error(`[no-slash-commands] ${label}: already patched — no-op`);
    return false;
  }

  if (!src.includes(before)) {
    console.error(
      `[no-slash-commands] ${label}: expected upstream text not found at ${path}. ` +
        `The pinned discord-mcpl commit may have changed — refusing to apply a ` +
        `patch blind. Update mcpl-discord/patches/no-slash-commands.mjs's ` +
        `expected text for the new pin before installing.`,
    );
    process.exit(1);
  }

  writeFileSync(path, src.replace(before, after), "utf8");
  console.error(`[no-slash-commands] ${label}: patched`);
  return true;
}

const indexChanged = patchFile(INDEX_PATH, "dist/src/index.js", INDEX_BEFORE, INDEX_AFTER);
const adapterChanged = patchFile(
  ADAPTER_PATH,
  "dist/src/discord-adapter.js",
  ADAPTER_BEFORE,
  ADAPTER_AFTER,
);

const changed = [indexChanged, adapterChanged].filter(Boolean).length;
console.error(`[no-slash-commands] done — ${changed}/2 file(s) patched this run`);
