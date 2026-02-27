---
name: Cross-Bot Collaboration
description: Patterns for multi-bot collaboration using the delegate tool and shared workspace
---

# Cross-Bot Collaboration

You can delegate tasks to other bots using the `delegate` tool. All bots share a filesystem at `/workspace/shared/` and communicate through VEIL workspace streams.

## Delegating Tasks

Send a task to a specific bot:

```
delegate(task="Write unit tests for the API endpoints", target_bot="claude-sonnet-4-6", workspace="todo-app")
```

The target bot receives an activation with your task description and works in `/workspace/shared/todo-app/`.

## Shared Workspace

All bots mount `/workspace/shared/` — this is the collaborative filesystem. Convention:

- `/workspace/shared/{project-name}/` — one directory per collaborative project
- Bots create subdirectories for isolation when needed
- Files written by one bot are immediately readable by all others

## Multi-Bot Project Pattern

For complex projects, orchestrate multiple bots working on different aspects:

1. **Create the project workspace**:
   ```
   terminal(command="mkdir -p /workspace/shared/fullstack-app/{backend,frontend,docs}")
   ```

2. **Delegate backend work**:
   ```
   delegate(task="Build an Express API with auth, CRUD for todos, and PostgreSQL. Write code in /workspace/shared/fullstack-app/backend/", target_bot="claude-sonnet-4-6", workspace="fullstack-app", workdir="fullstack-app/backend")
   ```

3. **Delegate frontend work**:
   ```
   delegate(task="Build a React frontend with Vite that connects to the backend API at localhost:3000. Write code in /workspace/shared/fullstack-app/frontend/", target_bot="claude-haiku-4-5", workspace="fullstack-app", workdir="fullstack-app/frontend")
   ```

4. **Monitor progress**: Both bots' activity flows through the `workspace:fullstack-app` VEIL stream. Check the shared filesystem:
   ```
   terminal(command="find /workspace/shared/fullstack-app -type f | head -50")
   ```

## When to Delegate

- **Parallel subtasks**: Split work across bots for speed
- **Specialist routing**: Send search tasks to bots with search tools, coding to coding bots
- **Code review**: Have one bot review another's output
- **Long-running tasks**: Delegate and continue your own work

## Tips

- Use `workspace` to group related bots on the same VEIL stream
- Use `workdir` to point the target bot at the right subdirectory
- The `task` parameter is the full instruction — be specific about what you want and where to write output
- You don't need to wait for delegated tasks — you'll see results via the shared workspace stream
- Check `/workspace/shared/{project}/` to see what other bots have produced
