---
name: add-bot-tool
description: Guided creation of a new tool for the bot-runtime tool system. Generates the tool factory function, context interface, registration in initTools, and optional skill documentation. Trigger keywords — new tool, add tool, create tool, bot tool.
---

# Add Bot Tool

Create a new tool that agents can call during their activation cycles in the bot-runtime.

## Prerequisites

- Clear understanding of what the tool does
- Knowledge of any external APIs or services it needs

## Bot-Runtime Tool Architecture

Tools follow a **factory pattern** — each tool file exports a `create<Name>Tool(ctx)` function that returns a `ToolHandler` object. The `ToolHandler` interface comes from `connectome-agent-core`:

```typescript
interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, any>;  // JSON Schema
  required?: string[];
  handler: (input: Record<string, any>) => Promise<string>;
}
```

Tools are registered in `bot-runtime/src/bot-runtime.ts` → `initTools()`.

## Existing Tools (Complete Inventory)

```
bot-runtime/src/tools/
├── attach-tool.ts              — attach_file (send files to Discord/Signal)
├── save-attachment-tool.ts     — save_attachment (save incoming attachments to workspace)
├── streams-tool.ts             — list_streams, get_stream_context
├── enlist-tool.ts              — enlist (recruit another agent)
├── continue-substream-tool.ts  — continue_substream (request autotrigger continuation)
├── substream-tool.ts           — enter_substream, exit_substream, set_autotrigger
├── terminal-tool.ts            — terminal/shell (configurable name, supports remote via SSH/Tailscale)
├── process-tool.ts             — process management (list, poll, log, submit, kill sessions)
├── delegate-tool.ts            — delegate (cross-bot task delegation, creates workspace:* streams)
├── wallet-tool.ts              — get_wallet_info, check_balance, transfer, x402_fetch
└── experiment-tool.ts          — init_experiment, run_experiment, log_experiment, experiment_dashboard
```

### Context Types (Shared Mutable State Per Tool)

Each tool family uses a context object that's updated per-activation:

| Context | Fields | Used By |
|---------|--------|---------|
| `TerminalVeilContext` | `streamId, grpcClient, agentId, agentName, pendingAttachments, incomingAttachments` | attach-tool, save-attachment-tool, terminal-tool |
| `StreamToolContext` | `agentId, currentStreamId, grpcClient, agentName` | streams-tool |
| `EnlistToolContext` | `grpcClient, agentName, agentId, currentStreamId` | enlist-tool |
| `ContinueSubstreamContext` | `continuationRequested, nextReason, isSubstreamActive` | continue-substream-tool |
| `SubstreamToolContext` | `enterSubstream, exitSubstream, setAutotrigger, getActiveSubstream, isAutotriggerActive` (function refs) | substream-tool |
| `DelegateActivationContext` | `streamId` | delegate-tool |
| `ExperimentToolContext` | `agentName, agentId, streamId, grpcClient, parentStreamId` | experiment-tool |
| `WalletToolContext` | `evmAccount, evmClients, solanaKeypair, solanaConnections, chains, streamId` | wallet-tool |

## Workflow

### Step 1: Define the Tool

Gather:
1. **Name**: snake_case, descriptive (e.g., `check_balance`, `search_web`)
2. **Description**: What the agent sees — clear, actionable, includes when to use it
3. **Parameters**: JSON Schema for inputs
4. **Return value**: What the agent gets back (always a JSON string)
5. **Side effects**: External calls, state changes
6. **Context needed**: What shared state/clients the tool requires

### Step 2: Study the Closest Existing Tool

Read the most similar tool file. Use GitNexus:
```
mcp__gitnexus__context: "bot-runtime/src/tools/<similar>-tool.ts"
```

### Step 3: Create the Tool File

Location: `bot-runtime/src/tools/<name>-tool.ts`

**Single tool template:**

```typescript
import type { ToolHandler } from 'connectome-agent-core';

export interface <Name>ToolContext {
  streamId?: string;  // Updated per-activation
  // Add clients, connections, cached state
}

export function create<Name>Tool(ctx: <Name>ToolContext): ToolHandler {
  return {
    name: '<tool_name>',
    description: '<What this tool does. When the agent should use it.>',
    parameters: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: '<what this parameter is>'
        }
      },
      required: ['param1']
    },
    handler: async (params: Record<string, any>) => {
      try {
        const result = await doSomething(params.param1, ctx);
        return JSON.stringify({ success: true, data: result });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  };
}
```

**Multi-tool template** (like wallet-tool.ts):

```typescript
export function create<Name>Tools(ctx: <Name>ToolContext): ToolHandler[] {
  return [
    {
      name: '<action_1>',
      description: '...',
      parameters: { ... },
      handler: async (params) => { ... }
    },
    {
      name: '<action_2>',
      // ...
    }
  ];
}
```

### Step 4: Add Context to BotRuntime

In `bot-runtime/src/bot-runtime.ts`:

1. Add the context field:
```typescript
private <name>ToolCtx?: <Name>ToolContext;
```

2. Initialize in startup (after config is loaded):
```typescript
if (/* condition for enabling this tool */) {
  this.<name>ToolCtx = {
    // ... initialize clients, connections
  };
}
```

3. Register in `initTools()`:
```typescript
if (this.<name>ToolCtx) {
  toolHandlers.push(create<Name>Tool(this.<name>ToolCtx));
  console.log(`<Name> tool enabled`);
}
```

4. Update per-activation in `fireActivation()`:
```typescript
if (this.<name>ToolCtx) {
  this.<name>ToolCtx.streamId = streamId;
}
```

### Step 5: Add Config (if needed)

If the tool requires configuration beyond env vars, add types to `bot-runtime/src/bot-config.ts`:

```typescript
export interface <Name>Config {
  // Tool-specific config
}
```

Add to `BotRuntimeConfig` and wire into `loadBotConfig()`.

### Step 6: Create Skill Documentation (optional)

If the tool is complex enough to warrant agent guidance:

`skills/<name>-operations/SKILL.md`

Register per-bot via `skill_paths` in bot config.

### Step 7: Verify

```bash
pnpm turbo run build --filter=bot-runtime
```

### Step 8: Deploy and Test

```
mcp__connectome__docker_rebuild_all
mcp__connectome__docker_logs  # check for "<Name> tool enabled" in bot logs
```

## Design Guidelines

1. **Return JSON strings** — tool results are serialized for the LLM
2. **Include success/error structure** — agents need to know if a call worked
3. **Descriptive parameter schemas** — the agent only sees the schema to decide what to pass
4. **Fail gracefully** — return error messages, don't throw unhandled exceptions
5. **Log operations** — `console.log('[<ToolName>] ...')` for debugging via Docker logs
6. **Respect the activation cycle** — tools run during an agent's activation; long-running ops should provide progress or timeout
7. **Don't duplicate VEIL** — if state is authoritative elsewhere (on-chain, external API), query it directly
8. **Use ProcessRegistry for subprocesses** — terminal-tool and process-tool demonstrate the pattern for spawning and managing background processes with output buffering
