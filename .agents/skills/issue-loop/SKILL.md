---
name: issue-loop
description: Poll connectome-monorepo for actionable issues and process them through the build pipeline. Designed to run via /loop. Checks for agent-ready issues to build, review-ready issues to report, and stale in-progress issues to flag. Trigger keywords — issue loop, poll issues, start loop, watch issues.
---

# Issue Loop

Poll `nomeforme/connectome-monorepo` for actionable issues and process them through the development pipeline.

**Invoke with:** `/loop 10m /issue-loop`

## What It Does Each Tick

### 1. Fetch actionable issues

```bash
# Issues ready for building (human-approved)
gh issue list -R nomeforme/connectome-monorepo --label "agent-ready" --state open --json number,title,labels --jq '.[] | select(.labels | map(.name) | (contains(["in-progress"]) or contains(["pr-opened"])) | not)'

# Issues awaiting review (for status reporting only)
gh issue list -R nomeforme/connectome-monorepo --label "review-ready" --state open --json number,title

# Stale in-progress issues (started but no activity)
gh issue list -R nomeforme/connectome-monorepo --label "in-progress" --state open --json number,title,updatedAt
```

### 2. Process agent-ready issues

For each `agent-ready` issue that is NOT `in-progress` or `pr-opened`:

1. Load the `build-from-issue` skill
2. Run it against the issue number
3. The skill handles the full state machine: plan → build → commit → push → deploy → label update

**Only process ONE issue per tick.** This prevents context overload and ensures each build gets full attention. If multiple are queued, process the oldest first.

### 3. Check stale in-progress

For any `in-progress` issue not updated in >1 hour:
- Post a status comment asking if the build stalled
- Do NOT automatically restart — let the human decide

### 4. Report status

After each tick, output a brief status:
```
[issue-loop] Tick at <time>
  agent-ready: #4, #7 (processing #4)
  review-ready: #3, #5
  in-progress: #4 (just started)
  stale: none
```

## Safety Controls

- **Never apply `agent-ready`** — only humans do that
- **One issue per tick** — prevents runaway parallel builds
- **Don't restart stale builds** — flag them for human attention
- **Skip closed issues** — even if labels are stale
- **Respect the state machine** — if `build-from-issue` says STOP, stop

## Configuration

Default interval: 10 minutes. Adjust based on your workflow:
- `5m` — active development, fast feedback
- `10m` — normal pace
- `30m` — background monitoring

## Starting and Stopping

**Start:**
```
/loop 10m /issue-loop
```

**Stop:**
Press Escape or Ctrl+C to interrupt the loop, or close the Claude Code session.

## Prerequisites

- `gh` CLI authenticated with access to `nomeforme/connectome-monorepo`
- All development skills available (build-from-issue, investigate, etc.)
- MCP servers running (for Docker deployment after builds)
