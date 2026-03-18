---
name: build-from-issue
description: Given a GitHub issue number on connectome-monorepo, plan and implement the work. Operates iteratively — creates a plan, responds to feedback, builds when 'agent-ready' label is applied. Handles cross-submodule commits, turborepo builds, and Docker deployment. Trigger keywords — build from issue, implement issue, work on issue, build issue, start issue.
---

# Build From Issue

Plan, iterate on feedback, and implement work described in a GitHub issue on `nomeforme/connectome-monorepo`.

This skill operates as a **stateful workflow** — it can be run repeatedly against the same issue. Each invocation inspects labels, plan comment, and conversation history to determine the correct next action.

## Prerequisites

- `gh` CLI authenticated (`gh auth status`)
- In the connectome monorepo (`/opt/connectome`)
- GitNexus and Connectome MCP servers available

## Critical: `agent-ready` Label Is Human-Only

The `agent-ready` label is a **human gate**. Under **no circumstances** should any agent:

- Apply the `agent-ready` label
- Ask the user to let the agent apply it
- Suggest automating its application
- Bypass the check by proceeding without it

If the label is not present, **stop and wait**. This ensures a human explicitly authorizes every build.

## Agent Comment Markers

### Plan marker
The implementation plan lives in a **single comment** edited in place:
```
> **🏗️ build-plan**
```

### Conversation marker
All other comments (responses, status updates):
```
> **🏗️ build-agent**
```

## State Machine

```
Fetch issue + comments from nomeforme/connectome-monorepo
  │
  ├─ No plan comment found?
  │   → Analyze with GitNexus + subagents
  │   → Post plan comment
  │   → Add 'review-ready' label
  │   → STOP
  │
  ├─ Plan exists + new human comments?
  │   → Respond to feedback
  │   → Update plan if needed
  │   → STOP
  │
  ├─ Plan exists + 'agent-ready' + no 'in-progress'/'pr-opened'?
  │   → Scope check
  │   → BUILD (Steps 6–14)
  │
  ├─ 'in-progress' label?
  │   → Detect existing work, resume
  │
  ├─ 'pr-opened' label?
  │   → Report PR exists, STOP
  │
  └─ Plan exists + no new comments + no 'agent-ready'?
      → Report: awaiting review, STOP
```

## Step 1: Fetch the Issue

```bash
gh issue view <id> -R nomeforme/connectome-monorepo --json number,title,body,state,labels,author
```

If closed, report and stop. If `needs-triage` label, suggest `investigate` first.

## Step 2: Fetch and Classify Comments

```bash
gh issue view <id> -R nomeforme/connectome-monorepo --json comments --jq '.comments[] | {id: .id, body: .body, author: .author.login, createdAt: .createdAt, updatedAt: .updatedAt}'
```

Classify: **Plan** (starts with `🏗️ build-plan`), **Agent** (starts with `🏗️ build-agent`), **Human** (everything else).

## Step 3: Determine Action

Follow the state machine above based on plan existence, human comments, and labels.

---

## Branch A: Generate the Plan

### A1: Analyze with GitNexus + Subagents

Use GitNexus MCP to understand the affected code:

```
mcp__gitnexus__context — for each key symbol/file identified in the issue
mcp__gitnexus__impact — for each proposed change point
```

Then launch Explore subagents for deeper analysis of each affected package.

The analysis must determine:
1. Issue type: `feat`, `fix`, `refactor`, `chore`, `perf`, `docs`
2. Minimal set of changes satisfying requirements
3. Sequenced steps (each independently testable)
4. Tests needed (unit, integration) and where they live
5. Complexity: Low / Medium / High
6. Which submodule repos need commits (and their push remotes/branches)
7. Risks and unknowns

### A2: Post the Plan Comment

```bash
gh issue comment <id> -R nomeforme/connectome-monorepo --body "$(cat <<'EOF'
> **🏗️ build-plan**

## Implementation Plan

**Issue type:** `<type>`
**Complexity:** <Low|Medium|High>
**Confidence:** <High|Medium|Low>

### Summary
<2-3 sentences: what will change and the approach>

### Packages & Repos Affected

| Package | Repo | Branch | Push Remote | Changes |
|---------|------|--------|-------------|---------|
| <pkg> | nomeforme/<repo> | <branch> | <remote> | <summary> |

### Scope
- `<package>/<file>`: <what changes and why>

### Implementation Steps
1. <step — independently testable>
2. <step>

### Test Plan
- **Unit tests:** <what and where>
- **Integration tests:** <what, or N/A>

### Build Verification
- `pnpm turbo run build` must pass after all changes
- Docker rebuild if runtime behavior changed

### Risks & Open Questions
- <risk needing human input>

---
*Revision 1 — initial plan*
EOF
)"
```

### A3: Add `review-ready` label

```bash
gh issue edit <id> -R nomeforme/connectome-monorepo --add-label "review-ready"
```

Report plan posted, awaiting review. Stop.

---

## Branch B: Respond to Feedback

For each human comment newer than last agent comment:

1. Quote the relevant portion
2. Respond based on codebase understanding
3. Post with conversation marker

If feedback requires plan changes, **edit the existing plan comment** via API:

```bash
gh api repos/nomeforme/connectome-monorepo/issues/comments/<comment-id> -X PATCH -f body="<updated plan>"
```

Preserve revision history at the bottom.

---

## Branch C: Build

### Step 4: Scope Check

If Complexity is High or Confidence is Low, warn the user but continue (they applied `agent-ready`).

### Step 5: Conflict Detection

Check for existing work on this issue:

```bash
# Check across all submodule repos that the plan touches
gh pr list -R nomeforme/<repo> --state open --search "<issue-id>" --json number,title,url
```

### Step 6: Make Changes

Work in the monorepo at `/opt/connectome`. Changes happen in submodule directories.

**Follow the plan's implementation steps in order.** Read source files before modifying. Stick to the plan unless you discover something requiring deviation.

### Step 7: Build Verification

After all changes:

```bash
cd /opt/connectome && pnpm turbo run build
```

This must pass. If it fails, fix the issues and retry (up to 3 attempts).

### Step 8: Write Tests

Follow the plan's Test Plan. Place tests alongside existing tests for each package:
- `__tests__/` directories for Jest-based packages
- Same patterns as existing tests in each package

### Step 9: Commit Per Submodule

**Critical**: Each modified submodule needs its own commit and push. The monorepo commit updates submodule pointers.

For each modified submodule:

```bash
# Stage and commit within the submodule
git -C /opt/connectome/<package> add <files>
git -C /opt/connectome/<package> commit -m "$(cat <<'COMMIT_EOF'
<type>(<scope>): <description>

Relates to nomeforme/connectome-monorepo#<issue-id>

<brief explanation>

Co-Authored-By: Claude <model> <noreply@anthropic.com>
COMMIT_EOF
)"

# Push to the correct remote and branch
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_new -o IdentitiesOnly=yes" \
  git -C /opt/connectome/<package> push <remote> <branch>
```

Then update the monorepo submodule pointers:

```bash
git -C /opt/connectome add <modified-submodules>
git -C /opt/connectome commit -m "$(cat <<'COMMIT_EOF'
<type>: <description> (submodule updates)

Relates to #<issue-id>

Updated submodules:
- <package>: <what changed>

Co-Authored-By: Claude <model> <noreply@anthropic.com>
COMMIT_EOF
)"

GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_new -o IdentitiesOnly=yes" \
  git -C /opt/connectome push origin main
```

### Step 10: Docker Deployment (if runtime changes)

If the changes affect runtime behavior, rebuild and deploy:

```
mcp__connectome__docker_rebuild_all
```

Then verify health:

```
mcp__connectome__docker_status
mcp__connectome__health
```

### Step 11: Post Summary on Issue

```bash
gh issue comment <id> -R nomeforme/connectome-monorepo --body "$(cat <<'EOF'
> **🏗️ build-agent**

## Implementation Complete

### What was built
<1-2 sentence summary>

### Commits
| Package | Commit | Repo |
|---------|--------|------|
| <pkg> | `<sha>` | nomeforme/<repo> |

### Tests
- Unit: <count> added
- Integration: <count or N/A>

### Build Status
- `pnpm turbo run build`: ✅
- Docker rebuild: <✅ or N/A>

### Deployment
<deployed / not deployed — describe>
EOF
)"
```

### Step 12: Update Labels

```bash
gh issue edit <id> -R nomeforme/connectome-monorepo --remove-label "in-progress" --remove-label "review-ready" --add-label "pr-opened"
```

Note: For the monorepo workflow, "pr-opened" may mean "commits pushed" since PRs go to individual repos. If a PR is appropriate for a specific submodule, create it there.

---

## Branch D: Resume In-Progress

If `in-progress` label present, check for uncommitted changes in submodules and resume from the appropriate step.

## Useful Commands

| Command | Description |
|---------|-------------|
| `gh issue view <id> -R nomeforme/connectome-monorepo --json ...` | Fetch issue |
| `gh issue comment <id> -R nomeforme/connectome-monorepo --body "..."` | Comment |
| `gh issue edit <id> -R nomeforme/connectome-monorepo --add-label "..."` | Label |
| `pnpm turbo run build` | Full workspace build |
| `pnpm turbo run build --filter=<pkg>` | Single package build |
| `mcp__connectome__docker_rebuild_all` | Rebuild Docker |
| `mcp__connectome__docker_status` | Check services |
| `mcp__gitnexus__impact` | Analyze change impact |
