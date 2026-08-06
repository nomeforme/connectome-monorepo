# Agent Instructions

This file is the primary instruction surface for agents contributing to Connectome. It is injected into your context on every interaction — keep that in mind when proposing changes to it.

## Project Identity

Connectome is built agent-first. We design systems and use agents to implement them. The project provides a shared perceptual substrate (VEIL) for autonomous AI agents across Discord, Signal, and other platforms — and the project itself is built using agent-driven workflows.

## Skills

Agent skills live in `.agents/skills/`. Your harness can discover and load them natively. Runtime skills (how agents operate within VEIL) live in `skills/`.

## Workflow Chains

These pipelines connect skills into end-to-end workflows. Individual skill files don't describe these relationships.

- **Feature development:** `investigate` → `build-from-issue` → `review-changes` → deploy via MCP
  - Investigate maps vague ideas to concrete issues. Build implements when `agent-ready` is applied by a human.
- **Bug fix:** `debug-live` → `investigate` → `build-from-issue` → deploy via MCP
  - Debug uses Connectome MCP to inspect live VEIL state and Docker logs. Investigate structures the fix. Build implements it.
- **New axon component:** `add-axon-component` → `review-changes` → deploy via MCP
  - Guided creation of receptors, effectors, or transforms for platform axons (gRPC client classes, not server-side Space components).
- **New bot tool:** `add-bot-tool` → `review-changes` → deploy via MCP
  - Guided creation of tools for the bot-runtime tool system.
- **Refactor:** `investigate` → `cross-package-refactor` → `review-changes` → deploy via MCP
  - Cross-package refactors that span multiple submodules with coordinated commits.

## Architecture Overview

| Path | Components | Purpose |
|------|-----------|---------|
| `connectome-ts/` | VEIL state, spaces (FLEX ordering), gRPC server, persistence | Core framework — shared perceptual substrate |
| `connectome-agent-core/` | ConnectomeAgent, effector, platform adapters | Agent abstraction wrapping pi-agent with VEIL |
| `connectome-grpc-common/` | gRPC client/server, serialization | Protocol layer shared by all services |
| `connectome-axon-interfaces/` | Shared TypeScript interfaces | Leaf types package for axon components |
| `axon-server/` | Module server, hot reload | HTTP/WS server for loading axon modules |
| `connectome-axon-binding/` | Platform binding gRPC service | Dynamic bot-to-axon credential advertisement |
| `bot-runtime/` | Bot lifecycle, tools, configuration | Standalone bot process (one per agent) |
| `discord-axon/` | Discord gateway, receptors, effectors | Multi-bot Discord platform adapter |
| `signal-axon/` | Signal CLI bridge, receptors, effectors | Multi-bot Signal platform adapter |
| `connectome-mcp/` | MCP server for Claude Code | Exposes VEIL state, Docker, workspace to agents |
| `skills/` | Runtime skills (SKILL.md) | How agents operate within VEIL |
| `.agents/skills/` | Development skills (SKILL.md) | How agents build Connectome itself |

## Repository Structure

This is a **pnpm workspace monorepo** where each package is also a **git submodule** pointing to its own GitHub repo under `nomeforme/`. Issues are tracked on the monorepo: `nomeforme/connectome-monorepo`.

### Submodule → Repo mapping

| Directory | GitHub Repo | Branch | Push Remote |
|-----------|------------|--------|-------------|
| `connectome-ts` | nomeforme/connectome-ts | grpc | `fork` |
| `discord-axon` | nomeforme/discord-axon | grpc | `fork` |
| `signal-axon` | nomeforme/signal-axon | grpc | `origin` |
| `bot-runtime` | nomeforme/bot-runtime | main | `origin` |
| `connectome-agent-core` | nomeforme/connectome-grpc-agent | grpc | (check remote) |
| `connectome-grpc-common` | nomeforme/connectome-grpc-common | main | (check remote) |
| `connectome-axon-interfaces` | nomeforme/connectome-axon-interfaces | grpc | (check remote) |
| `axon-server` | nomeforme/axon-server | grpc | (check remote) |
| `connectome-axon-binding` | nomeforme/connectome-axon-binding | main | `origin` |
| `connectome-mcp` | nomeforme/connectome-mcp | main | `origin` |

### Git push convention

All pushes require the SSH key:
```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_new -o IdentitiesOnly=yes" git push <remote> <branch>
```

Never chain `cd` with `&&` in bash commands — use `git -C <path>` or absolute paths.

## MCP Tools

Agents have access to two MCP servers that provide rich context:

### Connectome MCP
- `docker_status`, `docker_logs`, `docker_restart`, `docker_rebuild_all`, `docker_stop_bots`, `docker_diagnose` — Docker infrastructure
- `get_streams`, `get_agents`, `get_facets`, `get_context`, `get_frames`, `get_events`, `get_speech` — Live VEIL state
- `snapshot_list`, `snapshot_inspect`, `snapshot_events`, `snapshot_frames`, `snapshot_search` — Persistence
- `workspace_list`, `workspace_read`, `workspace_search`, `workspace_write`, `workspace_delete` — Shared workspace

### GitNexus MCP
- `query` — Natural language queries about the codebase
- `context` — Get full context for a symbol or file
- `impact` — Analyze impact of changing a symbol or file
- `detect_changes` — Detect what changed since a commit
- `rename` — Find all references that need updating for a rename
- `cypher` — Raw Cypher queries against the code knowledge graph

Use GitNexus for codebase exploration instead of manual grep where possible. It indexes all workspace packages.

## Platform Commands

`!` commands are handled by axon command effectors and **never stored in VEIL**. They return early before any event is emitted. Both Discord and Signal axons support the same command set.

| Command | Description |
|---------|-------------|
| `!continue` | Continue from the bot's last message (pseudo-prefill). Also: `m continue`, `m go`, `m more` |
| `!stop` | Abort the current agent cycle |
| `!steer <msg>` | Redirect the running agent mid-cycle with a new instruction |
| `!stream in <name>` | Enter a named substream (activations redirect there) |
| `!stream out <name>` | Exit substream, return to parent channel |
| `!rr [N]` | Random reply chance (0=off, 1=100%, 10=10%) |
| `!bb [N]` | Bot-to-bot mention limit before requiring human |
| `!mcf [N\|reset]` | Max context frames for the server-side activation render (default 400 via `ACTIVATION_CONTEXT_MAX_FRAMES`). Bare = stream-wide; `@bot !mcf N` = that bot only; in-memory, per-stream |
| `!mmf [N]` | Max memory frames (in RAM) |
| `!mt [N]` | Max output tokens per response (0=model default) |
| `!autotrigger [on\|off]` | Autonomous self-triggering loop |
| `!help` | Show all commands |

**Continuation (`!continue`)** uses CLI-framed pseudo-prefill: builds a conversation log from the last N VEIL messages, wraps it in `<cmd>cut/cat</cmd>` framing, and calls the Anthropic/Bedrock API directly (bypassing pi-agent). Works on all model generations. Implemented in `connectome-agent-core/src/connectome-agent.ts` → `runDirectPrefill()`.

## MCP Server Configuration

MCP servers are configured in `bot-runtime/config.json`. Two levels:

1. **Global `mcp_servers` array** — defines available servers (name, transport, url/command)
2. **Per-bot `mcp` array** — lists which server names this bot should connect to

```json
{
  "mcp_servers": [
    { "name": "my-server", "transport": "sse", "url": "http://host:port/sse" },
    { "name": "stdio-server", "transport": "stdio", "command": "npx", "args": ["-y", "pkg"] }
  ],
  "bots": [
    { "name": "claude-opus-4-6", "mcp": ["my-server"], ... }
  ]
}
```

Transport types: `sse`, `streamable-http`, `stdio`. SSE servers need a URL. Stdio servers need command + args. Headers and env vars supported (use `${ENV_VAR}` syntax). After config change, restart the bot container. Logs show `[MCPManager] Connected to <name>, tools: ...` on success.

## Build System

```bash
# Full build (cached ~200ms, clean ~30s)
cd /opt/connectome && pnpm turbo run build

# Type check only
pnpm turbo run typecheck

# Clean and rebuild
pnpm turbo run clean && pnpm turbo run build
```

Dependency DAG: axon-interfaces/grpc-common/axon-binding (leaves) → connectome-ts/axon-server → agent-core → bot-runtime/discord-axon/signal-axon

All packages use `composite: true`, `tsc --build`, emit to `dist/`. Runtime uses `npx tsx src/...`.

## Docker Deployment

```bash
# Rebuild and restart all via MCP (preferred)
docker_rebuild_all

# Or manually
docker compose build && docker compose up -d

# Check health
docker_status
docker_diagnose

# View logs for a specific service
docker_logs  # with service name parameter
```

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/) format: `<type>(<scope>): <description>`
- Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`
- Scope is the package name (e.g., `discord-axon`, `bot-runtime`, `connectome-ts`)
- For cross-package changes, use the primary package or omit scope
- Include `Co-Authored-By: Claude <model> <noreply@anthropic.com>` when committing agent work

## Verification

Before committing:
```bash
# Must pass — type checking across all packages
pnpm turbo run build

# For submodule changes, verify the specific package
pnpm turbo run build --filter=<package-name>
```

## Issues and PRs

- All issues tracked on `nomeforme/connectome-monorepo`
- Issues use structured templates (see `.github/ISSUE_TEMPLATE/`)
- PRs target the submodule repo's tracked branch (grpc or main)
- PRs reference the monorepo issue: `Relates to nomeforme/connectome-monorepo#<id>`

## Security

- Never commit secrets, API keys, or private keys
- Wallet keys go in Docker secrets (`/run/secrets/`) or env vars — never in code
- Bot tokens in env vars per-container — never in config files
