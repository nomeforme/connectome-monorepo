# mcpl-discord — install recipe for the pinned upstream Discord MCPL server

This directory is a **recipe, not a vendored copy**. `docs/harness-port/03-house-design.md`
§4 already argued the constraint this recipe follows: an MCP Live server for
Discord exists upstream (`anima-research/discord-mcpl` on GitHub, published to
npm as `@animalabs/discord-mcpl`), built to the MCPL spec the house's own
`connectome-house/src/mcpl/discord.mjs` adapter was written against. **It ships
no licence file** — as of this writing that means: read, clone, and run it
unmodified, never redistribute or vendor its source. So:

- `package.json` pins an **exact commit**, not a moving branch or tag:
  `github:anima-research/discord-mcpl#5fa3db9`, plus a `typescript`
  devDependency (see "Why a local typescript dependency" below).
- `npm install` here drops the server fresh into this directory's own
  `node_modules/@animalabs/discord-mcpl/` — gitignored (root `.gitignore`
  already covers all `node_modules/`; this recipe adds an explicit entry too,
  see below) and **never committed**.
- `npm run build` compiles that installed copy's own TypeScript into its own
  `dist/` with our `tsc`, in place. Nothing is copied out of `node_modules`
  into this repo at any point.
- `run.sh` execs the built server's own CLI entrypoint
  (`node_modules/@animalabs/discord-mcpl/dist/src/index.js --stdio`) as an
  unmodified stdio child. The house spawns this script; it never imports or
  requires anything from inside `node_modules/@animalabs/discord-mcpl`
  directly from house code.

Before this repo becomes a public home for the house design (05-ops.md,
06-rounds.md), either ask upstream for a licence or avoid depending on the
unlicensed package for anything that ships (03-house-design.md §4 verbatim).

## Why a local `typescript` devDependency

The pinned package's own `package.json` lists `typescript` as one of *its*
`devDependencies` (alongside `tsx`, `@types/node`). npm never installs a
nested dependency's `devDependencies` — only a package's own top-level ones —
so a bare `npm install` here would drop the server's source with no compiler
to build it. This recipe's `package.json` therefore carries its own
`typescript` devDependency, and `build` runs *our* `tsc` against *their*
`tsconfig.json` (`tsc -p node_modules/@animalabs/discord-mcpl`), emitting into
that package's own `dist/` exactly as its own `npm run build` would if it had
a compiler available. `run.sh` then execs that `dist/`, matching the house
adapter's target (`bin: dist/src/index.js`) exactly.

## Runtime environment (read by the pinned server itself, not this recipe)

None of these are read, set, or defaulted by anything in this directory —
they are documented here because the house's servers config is what actually
supplies them to the spawned child's environment.

| env var | required? | what it does |
|---|---|---|
| `DISCORD_TOKEN` | **required** | the Discord bot token. Verified absent in this recipe's offline build check (below) — never present in this repo, this task, or any fixture. |
| `DISCORD_GUILD_ID` | optional | comma-separated guild allowlist; each entry is `guildId` (every channel) or `guildId:chanId+chanId` (only those channels + their threads) |
| `DISCORD_DM_USERS` | optional | comma-separated user-id allowlist for DMs; when set, a DM from anyone else is dropped |
| `DISCORD_ADMIN_USERS` | optional | comma-separated user ids allowed to use the server's own admin slash command (`/undo`); unset = nobody |
| `DISCORD_FILTERS_FILE` | optional | path to a JSON file holding the same guild/channel/DM whitelists (plus a suppressed-reaction-emoji list) as the live source of truth, hot-reloaded every ~3s; wins over the two env vars above and is seeded from them on first run |
| `DISCORD_SUPPRESS_REACTION_EMOJIS`, `DISCORD_SUPPRESSED_REACTIONS_BASELINE` | optional | legacy/host-injected seeds for the filters file's reaction-suppression list; superseded once a filters file exists |
| `DISCORD_ATTACHMENT_INLINE_MAX_BYTES`, `DISCORD_BACKSCROLL_CHANNELS`, `DISCORD_BACKSCROLL_LIMIT`, `DISCORD_CATCHUP_LIMIT`, `DISCORD_STICKY_REPLY`, `DISCORD_MCPL_DEBUG_LOG`, `AGENT_TIMESTAMP_STYLE`, `AGENT_TIMEZONE` | optional | operational tuning; read straight off `process.env` by the pinned server, unrelated to this recipe |

Confirmed by reading `dist/src/index.js` directly (this recipe's own build
output, at the pinned commit): a bare `--stdio` run with no `DISCORD_TOKEN`
prints exactly `DISCORD_TOKEN environment variable is required` to stderr and
exits 1 — before constructing a Discord client or making any network call.
That is this recipe's offline proof (see "Verified on sfo" below).

## How the house names this server

The house's servers config (`connectome-house/src/mcpl/config.mjs` /
whatever `servers.json` a deployment carries — not this recipe's file to
own) names a server entry with `command: "<this dir>/run.sh"`, spawned as a
stdio child exactly like `mcpl-signal`'s own recipe. `run.sh` takes no
arguments and reads no file of its own; every env var above rides on the
child's spawned environment, supplied by whatever holds the real
`DISCORD_TOKEN` (never this repo, never a fixture).

## `being_tools` default list, and why speech tools are withheld

The pinned server (`5fa3db9`) declares 22 MCP tools. The house's own
adapter (`connectome-house/src/mcpl/discord.mjs`, `DEFAULT_BEING_TOOLS` —
not this recipe's file, cited here for why this recipe's server-side tool
surface and the house's being-facing allowlist are two different lists)
exposes a conservative **default subset of 9** to a seated being when a
deployment's servers file names no `being_tools` override of its own:

```
list_guilds, list_channels, list_channel_members, list_emojis,
filters_get, list_subscriptions, channel_missed,
add_reaction, remove_reaction
```

read/look-up/react-shaped tools only. **`send_message`, `reply_message`,
and `send_dm` — the server's own speech tools — are never in that default
list, and a being never calls them directly.** A being's actual speech
goes out through the house's own seat/speak path (`connectome-house/src/
mcpl/speak.mjs`, `outbound.mjs`), which composes the room's record, the
splitter, mention resolution, and delivery-tracking (§4.8/§4.18/O12–O18 of
`02-user-contract.md`) before ever calling this server's `send_message` —
calling it directly would let a being's turn bypass every one of those
seams (the record, the split, the delivered-message-id ledger a later 🫥
reaction resolves against). The remaining 13 tools (`edit_message`,
`delete_message`, `delete_channel`, `create_text_channel`, `filters_update`,
mutating; `fetch_history`, `fetch_around`, `refresh_channels`,
`mute_channel`, `unmute_channel`, `set_reaction_visibility` — rich or
account-settings shapes with no normalizer yet in `being-tools.mjs`) are
withheld the same way the discord.mjs comment already documents: a keeper
override may name them in a deployment's servers file, but the being-tools
normalizer gate refuses any tool with no registered normalizer regardless
of what the servers file names — default or override.

## The `m continue` prefix it drops

`02-user-contract.md` C10 and `00-stack-as-is.md` §4.3: the fork's
`!continue`/`m continue`/`m go`/`m more` trigger is handled *before* any
`!`-command dispatch, by the message receptor itself, and (Discord only)
the triggering message is deleted so the continuation prompt never lingers
in the channel. The pinned discord-mcpl server has no special-cased
knowledge of `m continue` at all — it forwards the raw inbound message like
any other. **The `m continue` prefix is dropped/interpreted entirely on the
house side** (the command lane in `connectome-house/src/commands/`, this
task's other half), using this server's ordinary `delete_message` tool
(withheld from being_tools above, but available to the house's own command
handler, which is not a being) to reproduce Discord's delete-on-continue
behaviour when the house's own tool surface supports it (`02-user-contract.md`
O24). This recipe supplies the transport only; the parsing and the delete
call are house-side, not this package's.

## Verified on sfo (offline of Discord)

```
$ npm install --no-audit --no-fund
added 39 packages in 7s
npm warn allow-scripts 1 package has install scripts not yet covered:
  sharp@0.33.5 (install: node install/check)
# NOT approved (see "sharp" below) — build proceeds without approving it.

$ npm run build
> mcpl-discord@0.0.0 build
> tsc -p node_modules/@animalabs/discord-mcpl
# (silent = success; dist/ populated under node_modules/@animalabs/discord-mcpl/)

$ env -u DISCORD_TOKEN ./run.sh
DISCORD_TOKEN environment variable is required
$ echo $?
1
```

No `DISCORD_TOKEN` was read (unset for the check), no Discord gateway
connection was attempted (the process exits before `DiscordAdapter` is even
constructed), and no real token exists anywhere in this recipe, this task,
or its fixtures.

### `sharp`'s pending install script

`sharp` (one of the pinned package's own dependencies, used for image
attachment processing) ships a postinstall script (`install/check`) that
npm/`allow-scripts` held for approval rather than running automatically.
Per this task's instructions, it was **not approved blindly**. The build
above (`tsc` only, no code execution) succeeds without it — `sharp`'s
prebuilt native binding still resolves for whatever image-processing calls
the server makes at runtime on platforms it ships a prebuild for; if a
future deployment's actual platform/arch needs `sharp`'s install script to
select the right binding, a keeper should review and approve it explicitly
(`npm approve-scripts sharp` from this directory) rather than this recipe
approving it on their behalf.

## Slash commands

The pinned server (`5fa3db9`) registers a guild application (slash) command,
`/undo` (plus `/nudge`, `/hide` — its own admin commands), on **every guild
it can see, at every boot** (`src/index.ts` ~line 155,
`server.setupSlashCommands()` → `discord-adapter.ts`'s
`registerGuildCommands`, `guild.commands.set(commands)`), and re-registers
them on any guild the bot joins later (`guildCreate`, same file). There is
no upstream env flag for this — every `process.env.DISCORD_*` read in
`src/index.ts`/`src/server.ts` is about message filtering, backscroll,
admin-user gating, or file paths; none of them gate command *registration*.

The house never implements `/undo` (or `/nudge`/`/hide`) — there is no
handler for them anywhere in `connectome-house/src`, and the fleet's old
axon never registered slash commands either. An unimplemented admin slash
command sitting on every guild is dead surface the house doesn't want, so
this recipe disables it:

- **`patches/no-slash-commands.mjs`** — an idempotent string-replacement
  patch over the *installed, compiled* `node_modules/@animalabs/
  discord-mcpl/dist/src/{index,discord-adapter}.js` (never this recipe's
  own source — it has none to patch — and never a fork of upstream). Run
  automatically by this package's own `postinstall` script right after
  `npm install` drops the pin into `node_modules` (including at image-build
  time — `docker/house/Dockerfile`'s `mcpl-discord-build` stage runs a bare
  `npm install`, no `--ignore-scripts`, so `postinstall` fires there too).
  It:
  1. Wraps the unconditional `await server.setupSlashCommands()` call so
     that when `DISCORD_DISABLE_SLASH_COMMANDS=1` is set in the spawned
     child's environment, registration is skipped and a stderr line is
     printed instead (`[discord-mcpl] slash-command registration disabled
     by DISCORD_DISABLE_SLASH_COMMANDS`). Unset, or any other value: upstream
     behaviour is unchanged.
  2. Defensively tightens the `guildCreate` re-registration guard from
     `if (this.guildCommandDefs)` to
     `if (this.guildCommandDefs && this.guildCommandDefs.length)`, so a
     newly-joined guild is never handed an empty/undefined command-def list.
  If the pinned commit ever moves and the expected upstream text isn't
  found, the patch **fails loudly** (non-zero exit, an exact message naming
  the file) rather than silently no-op'ing against a different pin.

- **Where the flag is set**: `mcpl-discord/config.mjs`'s (i.e.
  `connectome-house/src/mcpl/config.mjs`'s) `env` grammar only lets a
  server's `env` list name variable NAMEs or `CHILD=HOUSE` pairs — never a
  literal value — so the literal `"1"` lives on the **house service's own
  `environment:`** in `docker-compose.yml` (`DISCORD_DISABLE_SLASH_COMMANDS:
  "1"`), and `house/servers.json`'s `discord-pilot-3-opus` entry names the
  bare `DISCORD_DISABLE_SLASH_COMMANDS` in its own `env` list so
  `childEnv`/`spawnWire` (`connectome-house/src/mcpl/wire.mjs`) carries that
  same value down to the spawned `run.sh` child unchanged.

- **`unregister-commands.mjs`** — a one-off script to clear whatever the
  pinned server already registered *before* this patch existed (the patch
  only stops *future* registration; already-registered guild commands stay
  registered until explicitly cleared). For every guild the bot's token can
  see, it lists the guild's current commands, then clears them
  (`guild.commands.set([])`); it also clears any global (cross-guild)
  commands the same way. It logs in using the `discord.js` already
  installed under this recipe's own `node_modules` (resolved via
  `createRequire` — never a separate dependency) and touches nothing else.

  ```
  node mcpl-discord/unregister-commands.mjs --token-env DISCORD_TOKEN_CLAUDE_3_OPUS --dry-run
  node mcpl-discord/unregister-commands.mjs --token-env DISCORD_TOKEN_CLAUDE_3_OPUS
  ```

  Run **inside the house container**, where `DISCORD_TOKEN_CLAUDE_3_OPUS`
  (or whichever env var names a deployment's real bot token) actually
  exists — always `--dry-run` first to see what would be cleared. The token
  is read from the named env var only: never a literal, never printed,
  never logged.
