---
name: Workspace Praxis
description: Shared filesystem, file attachments (attach_file), delegation, and artifact management. Read this skill when creating files, generating images, or sending file output to users.
---

# Workspace Praxis

You inhabit a VEIL space with other agents. You share a sensorium (facets, frames, streams) and a filesystem (`/workspace/shared/`). What you produce exists in both.

## Artifacts Are Real When They're Files

Code, scripts, documents — anything you create — goes to `/workspace/shared/`. A code block in chat is a description of something. A file in the workspace is the thing itself. Other agents can read it, run it, modify it, build on it. That's what makes it real in the shared space.

When asked to write code or produce something, use the terminal tool to create it:

```
terminal(command="mkdir -p /workspace/shared/calculator && cat > /workspace/shared/calculator/calc.py << 'PYEOF'\ndef add(a, b): return a + b\ndef sub(a, b): return a - b\nPYEOF", workdir="/workspace/shared/calculator")
```

Then run it, verify it, and tell people where it lives. The file is the artifact. Your message is the summary.

## Delegation Branches Context

When work involves another agent — whether someone asked, or you recognize the task decomposes naturally, or another agent is better suited — use `delegate`. This creates a workspace stream that branches from your current stream, inheriting conversation history up to the fork point. The delegated agent sees what led to the task without you repeating it.

```
delegate(task="Add unit tests for the calculator module", target_bot="claude-sonnet-4-6", workspace="calculator")
```

The delegated agent gets activated on `workspace:calculator` with inherited context from your stream. Their work lives on the branched stream — visible to the workspace, without polluting the originating conversation. Like git branches: histories diverge from a shared point.

Mentioning another agent by name in chat doesn't achieve this. It keeps everything flat on the main channel with no context branching and no workspace isolation. Delegation is the mechanism that creates proper stream topology.

## Shared Workspace

All agents mount `/workspace/shared/` — a Docker volume shared across every container. Convention:

- `/workspace/shared/{project-name}/` — one directory per project
- Files written by one agent are immediately readable by all others
- This is the ground truth — the shared material reality beneath the VEIL

### Filesystem Hygiene

Directories don't create themselves. Always `mkdir -p` before writing to a subdirectory:

```
terminal(command="mkdir -p /workspace/shared/my-project && cat > /workspace/shared/my-project/script.py << 'EOF'\n...\nEOF")
```

In Python scripts, create the directory programmatically:
```python
import os
os.makedirs('/workspace/shared/my-project', exist_ok=True)
```

After generating output files, **verify they exist**:
```
terminal(command="ls -la /workspace/shared/my-project/output.png")
```

Don't tell users a file is ready until you've confirmed it's on disk. A save call that fails silently produces no artifact — and your message becomes a lie.

### Sending Files to Chat

Files on disk are invisible to users in Discord/Signal unless you attach them. Use the `attach_file` tool to send images, documents, or other files alongside your message:

```
attach_file(file_path="/workspace/shared/my-project/output.png")
```

This reads the file, base64-encodes it, and queues it for delivery with your next speech. The attachment appears in Discord/Signal as a file upload alongside your message text.

- Only files in `/workspace/shared/` or `/tmp/` can be attached
- Max 8MB per file
- Call `attach_file` for each file you want to send
- Verify the file exists before attaching — `attach_file` on a missing path returns an error

If someone asks you to generate an image, chart, or file and show it to them, you must both create the file *and* call `attach_file`. Without the attach call, the file exists on disk but the user never sees it.

## Patterns

**Hand-off** — do your part, delegate the rest:
```
terminal(command="mkdir -p /workspace/shared/app && cat > /workspace/shared/app/main.py << 'EOF'\n...\nEOF")
delegate(task="Add tests for /workspace/shared/app/main.py", target_bot="claude-sonnet-4-6", workspace="app")
```

**Fan-out** — parallel independent subtasks:
```
delegate(task="Build the API in /workspace/shared/app/backend/", target_bot="claude-sonnet-4-6", workspace="app", workdir="app/backend")
delegate(task="Build the frontend in /workspace/shared/app/frontend/", target_bot="claude-haiku-4-5", workspace="app", workdir="app/frontend")
```

**Specialist routing** — match task to capability:
```
delegate(task="Research JWT auth best practices", target_bot="claude-sonnet-4-6", workspace="auth-research")
```

## Context Inheritance

Workspace streams inherit the parent conversation up to the fork point. The delegated agent sees what led to the task — describe what to do, not why. They already know why from the inherited history.

## Tips

- Use `workspace` to group related agents on the same VEIL stream
- Use `workdir` to point at the right subdirectory within `/workspace/shared/`
- Check `/workspace/shared/{project}/` to see what other agents have produced
- Per-turn speech means others see your progress step by step, not a wall of text at the end
