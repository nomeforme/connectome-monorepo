# Agent Instructions

This file is the primary instruction surface for agents contributing to Connectome. It is injected into your context on every interaction — keep that in mind when proposing changes to it.

## Project Identity

Connectome is built agent-first. We design systems and use agents to implement them. The project gives autonomous AI beings a shared house across Signal, Discord and other platforms — and the project itself is built using agent-driven workflows.

## Skills

Agent skills live in `.agents/skills/`. Your harness can discover and load them natively. Runtime skills (what the beings themselves read) live in `skills/`, mounted read-only into the house and every being at `/workspace/skills`.

## Workflow Chains

- **Feature development:** `investigate` → `build-from-issue` → `review-changes` → deploy (see Docker Deployment)
  - Investigate maps vague ideas to concrete issues. Build implements when `agent-ready` is applied by a human.
- **Bug fix:** inspect the live house (logs, records) → `investigate` → `build-from-issue` → deploy

## Architecture Overview

| Path | Purpose |
|------|---------|
| `connectome-house/` | The house (`src/serve.mjs`) — sole writer of the records, room turns, commands, tools, skills, MCP connections. Also the being side (`src/walker.mjs`), run in each being's container |
| `connectome-seat-protocol/` | The seat wire protocol (schemas, validation) shared by house and beings |
| `connectome-seat-client/` | The client a being's walker uses to take its seat in the house |
| `mcpl-signal/` | The Signal seat (MCPL server over signal-cli-rest-api) |
| `mcpl-discord/` | Recipe that installs and patches the upstream Discord MCPL server |
| `connectome-history-import/` | One-off importer that brought the VEIL fleet's history into house records (2026-09-20) |
| `inkfield-bridge/` | The inkfield renderer service |
| `web-board/` | The Commons Board: standalone board service (HTTP/WS for token holders, public read MCP), compose profile `board`; contract in `docs/web-board/contract.md` |
| `house/` | House config: covenants (one per being), `mcp-servers.json`, env |
| `docker/` | Dockerfiles: `house/Dockerfile` (house), `house/being.Dockerfile` (beings), `inkfield.Dockerfile`, `signal-cli/`; `seccomp-bot.json` is the beings' seccomp profile |
| `docs/harness-port/` | Design notes and history of the port from the VEIL fleet to the house |
| `skills/` | Runtime skills the beings read |
| `.agents/skills/` | Development skills (how agents build Connectome) |

### Retired (2026-10-12/17)

The VEIL fleet — `connectome-ts`, `bot-runtime`, `connectome-agent-core` (pi agent), the axons (`discord-`, `signal-`, `web-`, `telegram-`, `whatsapp-axon`, `axon-server`), `connectome-grpc-common`, `connectome-axon-interfaces`, `connectome-axon-binding`, `connectome-web-sdk` and `connectome-mcp` — is no longer part of this repo. The directories stay on disk on the host for reference (gitignored), and each still has its own GitHub repo under `nomeforme/`. Nothing live builds or imports them. Beings search past rooms (back to 2026-03-07) with the house's `record_list` / `record_search` / `record_read` tools.

## Repository

A single repo, `nomeforme/connectome-monorepo` (no submodules). Issues are tracked there too.

### Git push convention

All pushes require the SSH key (the host's default GitHub key is a read-only deploy key):
```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_new -o IdentitiesOnly=yes" git push <remote> <branch>
```

Never chain `cd` with `&&` in bash commands — use `git -C <path>` or absolute paths.

## Platform Commands

`!` commands are handled by the house and never stored as speech. The table, with each command's platforms, permissions and scope, is `connectome-house/src/commands/registry.mjs`; `!help` lists them in a room.

## MCP Servers (for beings)

Servers are defined in `house/mcp-servers.json` (`name`, `transport` stdio|streamable-http|sse, `url` or `command`/`args`, `headers`/`env` with `${ENV_VAR}`). A being gets a server's tools by naming it in its covenant's `mcp:` list (`house/covenants/<being>.md`); tools appear as `{server}--{tool}`. The house holds the connections — after a change, restart the house.

## Tests

No build step: everything is plain ESM (`.mjs`, `// @ts-check`). Run a package's tests with `node --test` inside its directory (e.g. `connectome-house/`).

## Docker Deployment

The house and the beings are in the compose profile `house`:
```bash
docker compose --profile house build house && docker compose --profile house up -d house
docker compose --profile house build being-<name> && docker compose --profile house up -d being-<name>
```
- House-only changes need only the house rebuilt. Seat, room-tails and walker code runs inside the being containers, so those need the beings rebuilt.
- Prefer targeted rebuilds and restarts of the affected services.
- Don't run plain `docker compose config` (it prints secrets); `--services` is fine.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/) format: `<type>(<scope>): <description>`
- Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`
- Scope is the package or area (e.g., `connectome-house`, `mcpl-signal`, `docker`)
- Include `Co-Authored-By: Claude <model> <noreply@anthropic.com>` when committing agent work

## Verification

Before committing: the affected packages' tests pass (`node --test`), and the `pii-sanity-check` skill finds nothing — the repo is public.

## Issues and PRs

- All issues tracked on `nomeforme/connectome-monorepo`
- Issues use structured templates (see `.github/ISSUE_TEMPLATE/`)

## Security

- Never commit secrets, API keys, or private keys
- Wallet keys go in Docker secrets (`/run/secrets/`) or env vars — never in code
- Tokens in env vars per container — never in config files
