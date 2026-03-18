---
name: cross-package-refactor
description: Handle refactors spanning multiple submodule packages — coordinated changes, dependency-order commits, build verification, and submodule pointer updates. Trigger keywords — cross-package, multi-package, refactor across, rename across, move type, shared interface change.
---

# Cross-Package Refactor

Coordinate changes that span multiple workspace packages (submodules), respecting the dependency DAG, build order, and git structure.

## Prerequisites

- Clear understanding of what's being refactored and why
- GitNexus MCP for impact analysis

## Why This Skill Exists

Connectome is a monorepo of git submodules. A change to a shared type in `connectome-axon-interfaces` cascades to every axon. A proto change in `connectome-grpc-common` requires handler updates in `connectome-ts` and client updates in every consumer. These changes must be:

1. **Ordered by dependency** — leaves before consumers
2. **Build-verified at each step** — catch breakage early
3. **Committed per-submodule** — each repo gets its own commit
4. **Pushed with correct remotes** — different repos have different push targets

## Dependency DAG

```
Leaves (no internal deps):
  connectome-axon-interfaces
  connectome-grpc-common
  connectome-axon-binding

Mid-layer:
  connectome-ts (depends on: axon-interfaces, grpc-common)
  axon-server (depends on: axon-interfaces)

Agent layer:
  connectome-agent-core (depends on: connectome-ts)

Runtime layer:
  bot-runtime (depends on: agent-core, grpc-common, axon-binding)
  discord-axon (depends on: axon-interfaces, axon-server, grpc-common, axon-binding, connectome-ts)
  signal-axon (depends on: axon-interfaces, axon-server, grpc-common, axon-binding)
```

**Always modify packages in dependency order** — leaves first, runtimes last.

## Workflow

### Step 1: Map the Impact

Use GitNexus to understand the full blast radius:

```
mcp__gitnexus__impact: "What depends on <symbol/file being changed>?"
mcp__gitnexus__rename: "Find all references to <old-name>"  # for renames
```

Produce a change plan:

| Order | Package | What Changes | Why |
|-------|---------|-------------|-----|
| 1 | connectome-axon-interfaces | Change interface X | Source of truth |
| 2 | connectome-ts | Update usage of X | Consumer |
| 3 | discord-axon | Update usage of X | Consumer |
| 4 | signal-axon | Update usage of X | Consumer |

### Step 2: Execute in Dependency Order

For each package in order:

1. **Make the changes** in the submodule
2. **Build that package** to verify:
   ```bash
   pnpm turbo run build --filter=<package>
   ```
3. **If it fails**, fix before proceeding — don't accumulate breakage

After all packages are modified:

4. **Full workspace build**:
   ```bash
   cd /opt/connectome && pnpm turbo run build
   ```

### Step 3: Commit Per-Submodule

Each modified submodule gets its own commit. Use consistent commit messages:

```bash
git -C /opt/connectome/<package> add <files>
git -C /opt/connectome/<package> commit -m "$(cat <<'EOF'
refactor(<scope>): <description>

Part of cross-package refactor: <what's being refactored>
Relates to nomeforme/connectome-monorepo#<issue-id>

Co-Authored-By: Claude <model> <noreply@anthropic.com>
EOF
)"
```

### Step 4: Push in Dependency Order

Push leaves first, then consumers. This ensures that if anyone pulls a mid-layer package, its leaf dependencies are already available.

```bash
# For each package, using the correct remote:
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_new -o IdentitiesOnly=yes" \
  git -C /opt/connectome/<package> push <remote> <branch>
```

Refer to AGENTS.md for the remote/branch mapping per package.

### Step 5: Update Monorepo Submodule Pointers

```bash
cd /opt/connectome
git add <all-modified-submodules>
git commit -m "$(cat <<'EOF'
refactor: <description> (submodule updates)

Updated submodules:
- <package1>: <change>
- <package2>: <change>

Relates to #<issue-id>

Co-Authored-By: Claude <model> <noreply@anthropic.com>
EOF
)"

GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_new -o IdentitiesOnly=yes" \
  git push origin main
```

### Step 6: Verify Deployment

If the refactor affects runtime behavior:

```
mcp__connectome__docker_rebuild_all
mcp__connectome__docker_status
mcp__connectome__health
```

## Common Refactor Patterns

### Interface/type change in axon-interfaces
1. Change the type → build axon-interfaces
2. Fix all consumers (connectome-ts, axons, agent-core) → build each
3. Full build → commit → push

### Proto change in grpc-common
1. Update .proto → regenerate → build grpc-common
2. Update server handlers in connectome-ts → build
3. Update client usage in axons/bot-runtime → build each
4. Full build → commit → push

### Shared utility refactor
1. Change the utility in its home package → build
2. Update all importers → build each
3. Full build → commit → push

### Barrel export reorganization
1. Update the barrel (`src/index.ts`) → build
2. Fix deep imports in consumers → build each
3. Full build → commit → push

## Pitfalls

- **Don't skip intermediate builds** — a build failure in package 3 of 6 is much easier to fix than debugging a failure after all changes
- **`isolatedModules: true`** — use `export type` for type-only re-exports
- **Deep imports eliminated** — all imports go through barrel (`from '<package>'`)
- **Watch for circular dependencies** — especially when moving code between packages
- **Submodule pointer commits** — don't forget to update the monorepo after pushing submodules
