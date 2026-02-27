---
name: Agent Coordination
description: Patterns for coordinating local agent spawning with cross-bot delegation
---

# Agent Coordination

Combine local agent spawning (terminal/process tools) with cross-bot delegation (delegate tool) for complex multi-agent workflows.

## Local vs Remote Agents

| Approach | Tool | Use When |
|----------|------|----------|
| Local spawn | `terminal` + `process` | You need direct control, interactive sessions, or quick one-shots |
| Remote delegation | `delegate` | You want another bot to handle it independently via VEIL activation |

## Orchestration Pattern

As an orchestrator, you can mix both approaches:

1. **Spawn local agents** for tasks you want to supervise directly:
   ```
   terminal(command="claude 'Lint and fix all TypeScript files'", background=true, pty=true, workdir="/workspace/shared/my-project")
   ```

2. **Delegate to remote bots** for independent parallel work:
   ```
   delegate(task="Research best practices for WebSocket authentication", target_bot="claude-sonnet-4-6", workspace="my-project")
   ```

3. **Monitor everything**:
   ```
   process(action="list")  // Local agents
   // Remote bots' output flows through workspace:my-project VEIL stream
   ```

## Fan-Out / Fan-In

For maximum parallelism, spawn multiple local agents AND delegate to remote bots:

```
// Local: run tests
terminal(command="claude 'Run the test suite and fix any failures'", background=true, pty=true, workdir="/workspace/shared/app")

// Local: lint
terminal(command="claude 'Run ESLint and fix all warnings'", background=true, pty=true, workdir="/workspace/shared/app")

// Remote: documentation
delegate(task="Write API documentation for all endpoints in /workspace/shared/app/src/routes/", target_bot="claude-sonnet-4-6", workspace="app")

// Remote: security review
delegate(task="Review /workspace/shared/app/ for security vulnerabilities", target_bot="claude-haiku-4-5", workspace="app")
```

Then collect results:
```
process(action="list")  // Check local agent status
terminal(command="ls -la /workspace/shared/app/docs/")  // Check remote output
```

## Workspace Stream Advantage

Unlike standalone agents, spawned processes can have their output flow through VEIL workspace streams. This means:

- Other bots subscribed to the same workspace stream see your agents' output
- You can build collaborative pipelines where Bot A's agent output feeds Bot B's decisions
- All activity is recorded in VEIL's shared reality for auditing and replay

## Tips

- Local spawning is faster for quick tasks (no activation roundtrip)
- Remote delegation is better for long-running independent work
- Use the same `workspace` name across local and remote to keep everything on one stream
- Check `process(action="list")` before spawning — stay under 32 concurrent processes
- For interactive multi-step work, prefer local spawn with `process(action="submit")`
