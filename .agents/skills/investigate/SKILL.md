---
name: investigate
description: Deep codebase investigation of a problem or feature idea, producing a structured GitHub issue on connectome-monorepo. Uses GitNexus MCP for symbol/flow analysis and parallel subagents for cross-package exploration. Prequel to build-from-issue. Trigger keywords — spike, investigate, explore, research, feasibility, deep dive, what would it take.
---

# Investigate

Investigate a problem, map it to the codebase, and produce a structured GitHub issue on `nomeforme/connectome-monorepo` ready for `build-from-issue`.

A **spike** is exploratory. The user has a vague idea — a feature, a bug, a performance concern — but hasn't mapped it to code or assessed feasibility. This skill does that mapping.

## Prerequisites

- `gh` CLI authenticated (`gh auth status`)
- GitNexus MCP available for codebase queries
- Connectome MCP available for live state inspection (if debugging)

## Workflow Overview

```
User describes a problem
  │
  ├─ Step 1: Gather the problem statement
  │   └─ Ask ONE round of clarifying questions if genuinely needed
  │
  ├─ Step 2: Deep codebase investigation
  │   └─ GitNexus queries + parallel subagents + source reading
  │
  ├─ Step 3: Ensure labels exist on the repo
  │
  ├─ Step 4: Create GitHub issue with structured findings
  │
  └─ Step 5: Report to user with issue URL and next steps
```

## Step 1: Gather the Problem Statement

Extract from the user's input:

1. **What** they want (desired outcome or observed problem)
2. **Why** they want it (motivation, use case)
3. **Constraints** mentioned (backwards compatibility, performance, specific packages)

### Clarification policy

If too vague to identify which area of the codebase, ask **ONE** round. Do not over-interrogate.

Ask if: "make things faster", "fix the networking"
Don't ask if: "the typing indicators persist after responses", "add a new tool for X in bot-runtime"

## Step 2: Deep Codebase Investigation

This is the core of the skill. Use **multiple approaches in parallel**:

### 2a: GitNexus MCP queries

Start with targeted queries to map the problem space:

```
mcp__gitnexus__query: "How does <thing> work?"
mcp__gitnexus__impact: "What would change if we modified <symbol/file>?"
mcp__gitnexus__context: "Full context for <symbol>"
```

GitNexus indexes all workspace packages and knows the dependency graph, symbol relationships, and data flows.

### 2b: Parallel subagents for cross-package exploration

Launch Explore subagents for independent investigation threads:

- One per affected package if multiple are involved
- One for "find all similar patterns" across the codebase
- One for checking test coverage in the affected area

### 2c: Source reading

After GitNexus narrows the scope, read the actual source files. Follow the call chain from entry point through to the relevant behavior. Don't just grep — understand the logic.

### Investigation checklist

The investigation **must** cover:

1. **Which packages/subsystems are involved.** Confirm by reading code, not guessing from names.
2. **The exact code paths that would need to change.** File paths, line numbers, function names.
3. **How the affected subsystems work today.** Data flow, component interactions, gRPC calls.
4. **Feasibility and complexity assessment:**
   - **Low**: Isolated change, < 3 files, single package, clear path
   - **Medium**: Multiple files/packages, some design decisions, well-scoped
   - **High**: Cross-cutting changes, architectural decisions, significant unknowns
5. **Risks and design decisions needing human input.**
6. **Existing patterns to follow.** How similar things are already done in the codebase.
7. **Test coverage in the affected area.** What exists, what's missing.
8. **Which submodule repos will need commits.** Map to the push remote and branch for each.

### Connectome-specific investigation areas

**VEIL / connectome-ts**: Facet types in `connectome-axon-interfaces/src/veil.ts`, frame lifecycle in `connectome-ts/src/veil/veil-state.ts`, delta operations (`addFacet`/`rewriteFacet`/`removeFacet`), Space execution (FLEX ordering via `MultiConstraintOrderingStrategy`), server-side component types (Receptor/Transform/Effector/Maintainer — the MARTEM phases). VEILContextAdapter rendering in `connectome-agent-core/src/veil-context-adapter.ts`.

**gRPC / connectome-grpc-common**: Proto in `connectome-grpc-common/proto/connectome.proto` (9 RPCs: Health, EmitEvent, SubscribeToFacets, RegisterAgent, GetContext, CreateStream, GetStateSnapshot, GetFrames, ActivateAgent). Server handlers in `connectome-ts/src/grpc/`. Client (`ConnectomeClient`) in `connectome-grpc-common/src/client.ts`. Serialization: `facetToProto`/`protoToFacet`.

**Axons (discord-axon, signal-axon)**: These are gRPC CLIENT-side code, not server-side Space components. Receptors listen to platform events and call `grpcClient.emitEvent()`. Effectors subscribe via `grpcClient.subscribeToStreamDeltas()` and call platform APIs. All components are plain classes with `constructor()` + `setup()` pattern. Key shared types: `BotInstance`, `SharedState`, `StreamManager`, `DiscordGrpcClient`/`SignalGrpcClient`.

**Bot-runtime**: Tool factory pattern in `bot-runtime/src/tools/` (11 tool files). Config in `bot-config.ts` (`BotRuntimeConfig`). Activation flow: `subscribeToActivations()` → `fireActivation()` → `ConnectomeEffector.handleActivation()`. Context via `ConnectomeBridge` (wraps gRPC `GetContext`). Substream handling, autotrigger mechanism, platform binding via `AxonBindingClient`.

**Agent-core (connectome-agent-core)**: `ConnectomeAgent` wraps pi-agent-core with `VEILContextAdapter` + `VEILToolBridge` + `SkillRegistry`. `ConnectomeEffector` orchestrates activation → cycle → delivery. `PlatformAdapter` interface: `deliverSpeech()`, `formatContent()`, `buildStreamId()`, `cleanIncoming()`, `sendTypingIndicator()`.

## Step 3: Ensure Labels Exist

Check existing labels and create any that are missing:

```bash
gh label list -R nomeforme/connectome-monorepo --limit 100
```

Required labels (create if missing):

| Label | Color | Description |
|-------|-------|-------------|
| `spike` | `#d4c5f9` | Investigation/feasibility study |
| `feat` | `#a2eeef` | New feature |
| `fix` | `#d73a4a` | Bug fix |
| `refactor` | `#e4e669` | Code refactoring |
| `perf` | `#fbca04` | Performance improvement |
| `review-ready` | `#0e8a16` | Ready for human review |
| `agent-ready` | `#006b75` | Human-approved for agent build |
| `in-progress` | `#1d76db` | Implementation underway |
| `pr-opened` | `#5319e7` | PR created |
| Package labels | `#bfd4f2` | One per package: `connectome-ts`, `bot-runtime`, `discord-axon`, `signal-axon`, `agent-core`, `grpc-common`, `axon-binding`, `mcp` |

```bash
gh label create "<name>" -R nomeforme/connectome-monorepo --color "<color>" --description "<desc>" 2>/dev/null || true
```

## Step 4: Create the GitHub Issue

Create on `nomeforme/connectome-monorepo` using the spike template:

```bash
gh issue create -R nomeforme/connectome-monorepo \
  --title "<type>(<scope>): <concise description>" \
  --label "<type>" --label "<package>" --label "review-ready" \
  --body "$(cat <<'ISSUE_EOF'
## Problem Statement

<What and why — 2-4 sentences for stakeholders.>

## Technical Context

<How things work today in the affected area.>

## Affected Components

| Package | Key Files | Role |
|---------|-----------|------|
| <package> | `file1:line`, `file2:line` | <role in this change> |

## Technical Investigation

### Architecture Overview
<How the affected subsystems work. Data flow, gRPC calls, VEIL operations.>

### Code References

| Location | Description |
|----------|-------------|
| `package/src/file.ts:42` | <what and why relevant> |

### Current Behavior
<Trace the code path. Name functions, follow the flow.>

### What Would Need to Change
<By package. Specific functions and types. Stop short of implementation plan.>

### Patterns to Follow
<Existing patterns in the codebase to be consistent with.>

## Proposed Approach

<High-level direction, not steps. 3-6 sentences.>

## Scope Assessment

- **Complexity:** <Low / Medium / High>
- **Confidence:** <High / Medium / Low>
- **Packages affected:** <list>
- **Estimated files:** <count>
- **Submodule commits needed:** <list repos + branches>

## Risks & Open Questions

- <risk or decision needing human judgment>

## Test Considerations

- <testing strategy>
- <existing test patterns to follow>

---
*Created by spike investigation. Use `build-from-issue` to plan and implement.*
ISSUE_EOF
)"
```

**All findings go in the issue body.** Do NOT post follow-up comments.

## Step 5: Report to User

After creating the issue:

1. Issue URL (clickable markdown link)
2. 2-3 sentence summary of findings
3. Key risks or decisions needing attention
4. Packages and repos that will need changes
5. Next steps:

> Review the issue. Refine the proposed approach if needed, then apply the `agent-ready` label and use `build-from-issue` to create an implementation plan and build it.

## Design Principles

1. **Everything in the issue body.** No follow-up comments.
2. **No implementation plan.** That's `build-from-issue`'s job.
3. **One clarification round max.**
4. **Use MCP tools.** GitNexus for codebase queries, Connectome MCP for live state.
5. **Map to submodule repos.** Every investigation must identify which repos need commits and on which branches.
