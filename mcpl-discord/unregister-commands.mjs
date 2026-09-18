#!/usr/bin/env node
// mcpl-discord/unregister-commands.mjs
//
// One-off maintenance script: unregisters every guild (and any global)
// slash command the pinned upstream discord-mcpl server has ever
// registered for this bot application. The house never implements /undo
// (or /nudge//hide — the server's other admin commands) and the fleet's
// old axon never registered slash commands, so this clears the surface
// clean. Paired with patches/no-slash-commands.mjs +
// DISCORD_DISABLE_SLASH_COMMANDS=1 (README.md "Slash commands"), which
// stops the pinned server from ever re-registering them.
//
// Reads the bot token from the env var NAMED by --token-env (default
// DISCORD_TOKEN) — never a literal, never printed, never logged. Uses the
// discord.js already installed under this recipe's own node_modules
// (resolved via createRequire — this script is not a separate dependency
// of anything, and never vendors or duplicates that install).
//
// Usage:
//   node unregister-commands.mjs [--token-env NAME] [--dry-run]
//
// --dry-run lists every guild's (and the app's global) current commands
// and sets nothing. Run this INSIDE the house container, where the named
// token env var actually exists (see README.md "Slash commands").
//
// Intents: Guilds only — this script never reads messages or members.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client, GatewayIntentBits } = require("discord.js");

function parseArgs(argv) {
  let tokenEnv = "DISCORD_TOKEN";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--token-env") {
      tokenEnv = argv[++i];
      if (!tokenEnv) {
        console.error("unregister-commands.mjs: --token-env requires a NAME argument");
        process.exit(1);
      }
    } else if (arg.startsWith("--token-env=")) {
      tokenEnv = arg.slice("--token-env=".length);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      console.error(`unregister-commands.mjs: unrecognized argument ${arg}`);
      process.exit(1);
    }
  }
  return { tokenEnv, dryRun };
}

function namesOf(collection) {
  const list = [...collection.values()].map((c) => c.name);
  return list.length ? list.join(", ") : "(none)";
}

async function main() {
  const { tokenEnv, dryRun } = parseArgs(process.argv.slice(2));

  // Never print the token itself — only the NAME of the env var it came
  // from, which is not a secret.
  const token = process.env[tokenEnv];
  if (typeof token !== "string" || !token) {
    console.error(`unregister-commands.mjs: env var ${tokenEnv} is not set`);
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const ready = new Promise((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("error", (err) => reject(err));
  });

  await client.login(token);
  await ready;

  console.error(
    `[unregister-commands] logged in as ${client.user.tag}${dryRun ? " (--dry-run: listing only)" : ""}`,
  );

  let exitCode = 0;
  try {
    for (const guild of client.guilds.cache.values()) {
      const before = await guild.commands.fetch();
      console.error(`guild ${guild.id} · ${before.size} command(s): ${namesOf(before)}`);
      if (!dryRun) {
        const after = await guild.commands.set([]);
        console.error(`guild ${guild.id} · ${after.size} command(s) after`);
      }
    }

    if (client.application) {
      const globalBefore = await client.application.commands.fetch();
      if (globalBefore.size) {
        console.error(`global · ${globalBefore.size} command(s): ${namesOf(globalBefore)}`);
        if (!dryRun) {
          const globalAfter = await client.application.commands.set([]);
          console.error(`global · ${globalAfter.size} command(s) after`);
        }
      } else {
        console.error("global · 0 command(s)");
      }
    } else {
      console.error("global · application not available, skipped");
    }
  } catch (err) {
    console.error(`unregister-commands.mjs: ${err.message}`);
    exitCode = 1;
  } finally {
    client.destroy();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`unregister-commands.mjs: ${err?.message ?? err}`);
  process.exit(1);
});
