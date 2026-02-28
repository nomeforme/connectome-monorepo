---
name: Agent Coordination
description: Local spawning and remote delegation — two modes of agency, both grounded in the shared workspace
---

# Agent Coordination

Two ways to extend your agency: spawn local processes (terminal/process tools) for work you execute yourself, or delegate to another agent (delegate tool) for work they should own. Both produce artifacts in `/workspace/shared/`. Both can flow through VEIL streams.

## Local vs Delegated

| Mode | Tool | When it fits |
|------|------|-------------|
| Local spawn | `terminal` / `process` | You're doing the work — writing files, running scripts, spawning Claude Code |
| Delegation | `delegate` | Another agent should own the work — they get activated on a branched workspace stream with inherited context |

Local spawning is faster (no activation roundtrip). Delegation creates proper stream topology and lets another agent work independently.

## Orchestration

For complex projects, combine both:

1. **Set up the workspace**:
   ```
   terminal(command="mkdir -p /workspace/shared/app/{backend,frontend,docs}")
   ```

2. **Do your part locally** (e.g., spawn Claude Code):
   ```
   terminal(command="su coder -c \"ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY claude -p --dangerously-skip-permissions 'Build an Express API in /workspace/shared/app/backend/'\"", background=true, pty=true, workdir="/workspace/shared/app/backend")
   ```

3. **Delegate the rest**:
   ```
   delegate(task="Build a React frontend connecting to localhost:3000", target_bot="claude-sonnet-4-6", workspace="app", workdir="app/frontend")
   delegate(task="Write API docs from the backend code", target_bot="claude-haiku-4-5", workspace="app", workdir="app/docs")
   ```

4. **Monitor**:
   ```
   process(action="list")
   terminal(command="find /workspace/shared/app -type f | head -50")
   ```

## Stream Topology

- Your local terminal work happens on your current stream
- Each `delegate` creates a `workspace:*` stream branched from your current stream
- Delegated agents inherit your conversation context up to the fork point
- Per-turn speech means progress is visible from all agents in real time
- All activity is recorded in VEIL frames — shared experience, auditable and replayable

## Tips

- Use the same `workspace` name across delegates to keep related work on one stream
- Check `process(action="list")` before spawning — stay under 32 concurrent processes
- For interactive multi-step work, prefer local spawn with `process(action="submit")`
