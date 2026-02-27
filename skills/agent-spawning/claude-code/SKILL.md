---
name: Claude Code Spawning
description: Patterns for spawning and managing Claude Code instances via the terminal and process tools
---

# Claude Code Spawning

You have access to `terminal` and `process` tools that let you spawn and manage Claude Code instances.

**Critical**: Claude Code must run as the `coder` user (it refuses `--dangerously-skip-permissions` as root). Always use this pattern:

```
su coder -c "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p --dangerously-skip-permissions '<your task>'"
```

- `-p` — print mode (non-interactive, returns output)
- `--dangerously-skip-permissions` — allows file writes without prompting (safe: we're in a Docker sandbox)
- `su coder -c` — runs as non-root user (required)
- `ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY` — passes the API key to the subprocess

## One-Shot Execution (preferred)

For self-contained tasks — Claude Code runs, writes files, and returns output:

```
terminal(command="su coder -c \"ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p --dangerously-skip-permissions 'Create a hello_world.py that prints Hello World with a random string'\"", workdir="/workspace/shared/my-project")
```

This blocks until Claude Code finishes and returns its full output.

## Background Execution

For longer tasks — spawn in background and monitor:

```
terminal(command="su coder -c \"ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p --dangerously-skip-permissions 'Build a REST API with Express and TypeScript'\"", background=true, pty=true, workdir="/workspace/shared/my-project")
```

Returns a `session_id`. Then monitor:

```
process(action="poll", session_id="proc_abc123")   // Check status + recent output
process(action="log", session_id="proc_abc123")     // Full output
process(action="log", session_id="proc_abc123", lines=50)  // Last 50 lines
```

## Parallel Spawning

Spawn multiple Claude Code instances for independent subtasks:

```
terminal(command="su coder -c \"ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p --dangerously-skip-permissions 'Write the database models'\"", background=true, pty=true, workdir="/workspace/shared/app/backend")
terminal(command="su coder -c \"ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p --dangerously-skip-permissions 'Set up the React project with Vite'\"", background=true, pty=true, workdir="/workspace/shared/app/frontend")
```

Monitor all:

```
process(action="list")  // See all running processes
```

## Tips

- **Always use `su coder -c "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p --dangerously-skip-permissions '...'"` — never run claude as root**
- Use `workdir` to point at the project directory
- For large tasks, use `background=true` so you can monitor progress
- Claude Code output may include ANSI escape codes — focus on the text content
- If a process hangs, use `process(action="kill")` to terminate
- Default timeout is 2 minutes — use `timeout` parameter for longer tasks (e.g. `timeout=300000` for 5 min)
- Create the project directory first and make it writable by coder: `terminal(command="mkdir -p /workspace/shared/my-project && chown coder:coder /workspace/shared/my-project")`
