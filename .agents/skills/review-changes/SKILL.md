---
name: review-changes
description: Summarize changes across submodules, highlight cross-package impacts, flag VEIL invariant violations and breaking changes. Works on uncommitted diffs, staged changes, or branch comparisons. Trigger keywords — review, diff, what changed, summarize changes, review changes.
---

# Review Changes

Summarize a diff across the connectome monorepo, highlighting design decisions, cross-package impacts, and potential issues.

## Prerequisites

- In the connectome monorepo (`/opt/connectome`)
- GitNexus MCP available for impact analysis

## Input

The user may specify:
- Nothing (review all uncommitted changes across submodules)
- A submodule name (review changes in that package only)
- A commit range (review specific commits)
- A PR number on a submodule repo

## Workflow

### Step 1: Gather the Diff

For uncommitted changes across all submodules:

```bash
# Check each submodule for changes
git -C /opt/connectome submodule foreach 'git diff --stat HEAD 2>/dev/null || true'
git -C /opt/connectome submodule foreach 'git log --oneline origin/HEAD..HEAD 2>/dev/null || true'
```

For a specific package:
```bash
git -C /opt/connectome/<package> diff
git -C /opt/connectome/<package> log --oneline origin/<branch>..HEAD
```

For a PR:
```bash
gh pr diff <number> -R nomeforme/<repo>
```

### Step 2: Analyze with GitNexus

For each modified file, check cross-package impact:

```
mcp__gitnexus__impact — "What depends on <modified-symbol>?"
```

This catches breaking changes that span submodule boundaries (e.g., changing an interface in `connectome-axon-interfaces` that's consumed by all axons).

### Step 3: Produce Summary

```markdown
## Change Review: <scope>

### Overview
<1-3 sentences: what changed and why>

### Changes by Package

#### <package-name>
| File | Changes | Impact |
|------|---------|--------|
| `src/file.ts` | <what changed> | <who consumes this> |

### Cross-Package Impacts
- <interface/type changes affecting downstream packages>
- <gRPC proto changes requiring client updates>
- <shared utility changes>

### Key Design Decisions
- <decision with file:line reference and rationale>

### VEIL Invariants Check
- [ ] Frame sequence continuity preserved (strict `currentSequence + 1 === frame.sequence`)
- [ ] Facet aspect composition correct (ContentAspect, StateAspect, AgentGeneratedAspect, StreamAspect, etc.)
- [ ] New facet types declared in `connectome-axon-interfaces/src/veil.ts` if needed
- [ ] gRPC subscription filters updated if event topics changed
- [ ] VEILContextAdapter handles new facet types in `renderToMessages()` (agent-core)
- [ ] Serialization roundtrip intact: `facetToProto`/`protoToFacet` in grpc-common

### Potential Concerns
- <genuine risks — don't fabricate>

### Build Status
- `pnpm turbo run build`: <result>
```

### Step 4: Dependency Graph Check

Verify the change respects the dependency DAG:

```
Leaves: axon-interfaces, grpc-common, axon-binding
  → connectome-ts, axon-server
    → agent-core
      → bot-runtime, discord-axon, signal-axon
```

If a leaf package changed, verify all downstream consumers still compile. If a runtime package changed, verify it doesn't introduce circular dependencies.

## What to Flag

1. **Breaking interface changes** in leaf packages (axon-interfaces, grpc-common) — these cascade everywhere
2. **Proto changes** without corresponding handler updates
3. **New facet types** without `VEILContextAdapter.renderToMessages()` support and `facetToProto`/`protoToFacet` serialization
4. **Subscription topic changes** without updating all `subscribeToStreamDeltas()` / `subscribeToActivations()` callers
5. **Config type changes** in `BotRuntimeConfig` or `BotConfig` without migration path
6. **Missing build verification** — if `pnpm turbo run build` wasn't run
7. **Submodule pointer drift** — if commits were pushed to submodules but monorepo pointers not updated
