---
name: add-axon-component
description: Guided creation of a new receptor, effector, or transform for an axon (Discord, Signal, or new platform). Axon components are gRPC client-side classes — NOT server-side Space components. Generates boilerplate, registers in grpc-main.ts, and wires subscriptions. Trigger keywords — new receptor, new effector, add component, create component, axon component.
---

# Add Axon Component

Create a new component for a platform axon (Discord, Signal, or new).

## Important: Axon Components Are NOT Server-Side VEIL Components

Axon components follow the **receptor/effector naming convention** from the connectome ontology, but they are **plain TypeScript classes running as gRPC clients** — not instances of the server-side `Component` class from `connectome-ts/src/spaces/`. They don't participate in the FLEX execution cycle or MARTEM phases. They're gRPC client code that:

- **Receptors**: Listen to platform events (Discord WebSocket, Signal CLI) and emit events to the Connectome gRPC server
- **Effectors**: Subscribe to VEIL facets via gRPC and perform platform actions (send messages, add reactions)
- **Transforms**: Fetch and render context from the server for agent activations

## Component Types (as they actually exist in axons)

| Type | Role | Pattern |
|------|------|---------|
| **Receptor** | Platform event → gRPC emit | Listens to Discord.js/Signal CLI events, calls `grpcClient.emitEvent()` or `grpcClient.emitDiscordMessage()` |
| **Effector** | gRPC subscription → platform action | Calls `grpcClient.subscribeToStreamDeltas()`, sends messages via Discord.js or Signal REST API |
| **Transform** | Context rendering | Calls `grpcClient.getContext()`, returns `RenderedContext` for agent activation |

There are no Modulators or Maintainers in axons — those exist only in server-side Spaces.

## Existing Components

### Discord axon (`discord-axon/src/grpc/components/`)

| Class | File | Type | Purpose |
|-------|------|------|---------|
| `DiscordMessageReceptor` | `discord-message-receptor.ts` | Receptor | Discord `messageCreate`/`messageUpdate`/`messageDelete` → gRPC events. Handles mentions, attachments (image compression via sharp), continuation commands, typing indicators, activation triggering |
| `DiscordReadyReceptor` | `discord-ready-receptor.ts` | Receptor | Discord `ready` event → registers bot identity |
| `DiscordInteractionReceptor` | `discord-interaction-receptor.ts` | Receptor | Slash commands, buttons, modals → gRPC events |
| `DiscordReactionReceptor` | `discord-reaction-receptor.ts` | Receptor | `messageReactionAdd` → gRPC events |
| `DiscordSpeechEffector` | `discord-speech-effector.ts` | Effector | Speech/action facets → Discord messages. Manages typing indicators, mention resolution, message splitting (2000 char limit) |
| `DiscordCommandEffector` | `discord-command-effector.ts` | Effector | `!` commands → config updates and agent commands |
| `SubstreamRelayEffector` | `substream-relay-effector.ts` | Effector | Substream speech → parent Discord channel. Singleton, subscribes to all streams, filters `substream:` prefix |
| `FocusedContextTransform` | `focused-context-transform.ts` | Transform | Fetches context from server via gRPC for agent activations |

### Signal axon (`signal-axon/src/grpc/components/`)

| Class | File | Type | Purpose |
|-------|------|------|---------|
| `SignalWebSocketReceptor` | `signal-websocket-receptor.ts` | Receptor | Signal CLI WebSocket → parsed envelopes (messages, receipts, typing, attachments) |
| `SignalMessageReceptor` | `signal-message-receptor.ts` | Receptor | Parsed messages → gRPC events. Handles privacy mode, dedup, multi-bot routing |
| `SignalReceiptReceptor` | `signal-receipt-receptor.ts` | Receptor | Read/delivery receipts (informational) |
| `SignalTypingReceptor` | `signal-typing-receptor.ts` | Receptor | Typing started/stopped (informational) |
| `SignalSpeechEffector` | `signal-speech-effector.ts` | Effector | Speech facets → Signal messages via REST API. Mention conversion (phone numbers), message splitting |
| `SignalCommandEffector` | `signal-command-effector.ts` | Effector | `!` commands → config updates and agent commands |
| `SignalSubstreamRelayEffector` | `signal-substream-relay-effector.ts` | Effector | Substream speech → parent Signal group/DM |
| `FocusedContextTransform` | `focused-context-transform.ts` | Transform | Context rendering (same role as Discord's) |
| `MessageConsistencyChecker` | `message-consistency-checker.ts` | Utility | Multi-bot message dedup and reconnection |

## Workflow

### Step 1: Gather Requirements

1. **Which axon?** discord-axon or signal-axon?
2. **Component type?** Receptor (platform → gRPC), Effector (gRPC → platform), or Transform (context)?
3. **What does it do?** Plain-language description
4. **What platform events or facet types?** e.g., Discord `messageReactionAdd`, or speech facets with specific state

### Step 2: Study the Closest Existing Component

Read the most similar existing component in the target axon. Key things to note:
- How the constructor receives dependencies (gRPC client, Discord client, config, shared state)
- How `setup()` registers event listeners or subscriptions
- How errors are caught and logged
- How the component accesses the stream manager

Use GitNexus:
```
mcp__gitnexus__context: "discord-axon/src/grpc/components/<similar-component>.ts"
```

### Step 3: Create the Component File

Location: `<axon>/src/grpc/components/<name>.ts`

**Receptor template** (platform event → gRPC):
```typescript
import type { Client, Message } from 'discord.js';
import { DiscordGrpcClient } from '../client.js';
import { StreamManager } from '../stream-manager.js';
import type { SharedState, BotInstance } from '../types.js';

export interface <Name>ReceptorConfig {
  bot: BotInstance;
  state: SharedState;
}

export class <Name>Receptor {
  private bot: BotInstance;
  private state: SharedState;

  constructor(config: <Name>ReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
  }

  setup(): void {
    this.bot.discord.on('<event-name>', async (...args) => {
      try {
        await this.handle(...args);
      } catch (err) {
        console.error(`[<Name>Receptor:${this.bot.config.name}] Error:`, err);
      }
    });
  }

  private async handle(...args: any[]): Promise<void> {
    // 1. Extract data from platform event
    // 2. Get or create stream via stream manager
    const streamInfo = await this.bot.streamManager.getOrCreateStream(channelId, metadata);
    // 3. Emit to Connectome via gRPC
    await this.bot.grpcClient.emitEvent('<topic>', {
      // payload
    }, { streamId: streamInfo.streamId });
  }
}
```

**Effector template** (gRPC subscription → platform action):
```typescript
import type { Client, TextChannel } from 'discord.js';
import { DiscordGrpcClient } from '../client.js';
import { StreamManager, type StreamInfo } from '../stream-manager.js';
import type { SharedState, BotInstance } from '../types.js';

export interface <Name>EffectorConfig {
  bot: BotInstance;
  state: SharedState;
}

export class <Name>Effector {
  private bot: BotInstance;
  private state: SharedState;

  constructor(config: <Name>EffectorConfig) {
    this.bot = config.bot;
    this.state = config.state;
  }

  setup(): void {
    // Subscribe to facets via gRPC — uses the stream manager's callback system
    // or direct subscription on the gRPC client
    this.bot.streamManager.onSpeech((facet, streamInfo) => {
      // Filter: only handle facets from THIS bot
      if (facet.agentName !== this.bot.config.name) return;
      this.handle(facet, streamInfo).catch(err => {
        console.error(`[<Name>Effector:${this.bot.config.name}] Error:`, err);
      });
    });

    // OR: direct gRPC subscription for non-speech facets
    this.bot.grpcClient.subscribeToStreamDeltas(
      (facet) => {
        if (facet.type === '<target-type>') {
          this.handle(facet).catch(err => {
            console.error(`[<Name>Effector:${this.bot.config.name}] Error:`, err);
          });
        }
      },
      { /* filter options */ }
    );
  }

  private async handle(facet: any, streamInfo?: StreamInfo): Promise<void> {
    // 1. Extract data from facet
    // 2. Resolve Discord channel from streamInfo
    // 3. Call Discord API (send message, add reaction, etc.)
  }
}
```

### Step 4: Register the Component

In `<axon>/src/grpc-main.ts`, inside the `addBot()` function (or equivalent bot setup):

```typescript
import { <Name>Receptor } from './grpc/components/<name>.ts';

// Inside addBot(), after creating the bot instance:
const <name>Receptor = new <Name>Receptor({ bot, state });
<name>Receptor.setup();
```

**Important lifecycle notes:**
- **Per-bot components** (most receptors/effectors): instantiated inside `addBot()`, one per bot
- **Singleton components** (SubstreamRelayEffector): instantiated once after the first bot connects, shared across all bots
- **Order matters**: Receptors should be set up before the bot starts processing messages. gRPC client must be connected first.

### Step 5: Add to Component Index

Add the export to `<axon>/src/grpc/components/index.ts`.

### Step 6: Verify

```bash
pnpm turbo run build --filter=<axon-package>
```

### Step 7: Test with Docker

```
mcp__connectome__docker_restart  # restart the specific axon service
mcp__connectome__docker_logs     # verify no errors on startup
```

## Naming Conventions

- **File**: `<platform>-<purpose>-<type>.ts` (e.g., `discord-reaction-receptor.ts`, `signal-speech-effector.ts`)
- **Class**: `<Platform><Purpose><Type>` (e.g., `DiscordReactionReceptor`, `SignalSpeechEffector`)
- **Config**: `<Purpose><Type>Config` or inline in constructor
- **Exception**: `SubstreamRelayEffector` (no platform prefix — it's a singleton pattern)
- **Exception**: `FocusedContextTransform` (shared name across axons)

## Key Patterns

### gRPC Client Methods (Discord)
- `emitEvent(topic, payload, options)` — general event emission
- `emitDiscordMessage(message)` — Discord-specific message event
- `subscribeToStreamDeltas(callback, options)` — subscribe to speech + action facets (combined)
- `subscribeToActivations(callback, options)` — subscribe to agent-activation + rendered-context
- `subscribeToTypingStop(callback)` — subscribe to typing stop events
- `activateAgent(streamId, reason, metadata)` — trigger agent activation
- `getContext(streamId, options)` — fetch rendered context
- `ensureStream(channelId, metadata)` — create/verify stream exists

### Stream Manager
- `getOrCreateStream(channelId, metadata)` — returns `StreamInfo` with streamId, channelId, guildId, etc.
- `onSpeech(callback)` / `onAction(callback)` — register facet callbacks per stream

### Error Handling
- Wrap all async handlers in try/catch
- Log with `[ClassName:botName]` prefix for filtering in Docker logs
- Never let a component error crash the axon process

### Bot Identity Filtering
- Effectors must filter facets to only handle THIS bot's output: `facet.agentName === bot.config.name`
- Receptors must skip messages from THIS bot: `message.author.id === bot.userId`
