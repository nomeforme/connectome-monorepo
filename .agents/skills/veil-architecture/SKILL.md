---
name: veil-architecture
description: Complete reference for VEIL internals — facets, frames, streams, substreams, context rendering, activation flow, persistence, and what does/doesn't get stored. Read this before working on anything touching VEIL state, context, streams, or agent activation.
---

# VEIL Architecture Reference

Complete technical reference for how VEIL works across the Connectome system — what gets stored, what doesn't, how context flows, and how streams/substreams operate.

## Core Concepts

**VEIL** (Virtual Embodiment Interface Language) is the shared perceptual substrate — the single reality all agents inhabit. Different agents render the same VEIL differently (perceptual subjectivity).

### State Structure (`connectome-ts/src/veil/veil-state.ts`)

```
VEILState {
  facets: Map<string, Facet>         — what exists (indexed by ID)
  streams: Map<string, StreamInfo>   — channels of attention
  agents: Map<string, AgentInfo>     — registered inhabitants
  frameHistory: Frame[]              — immutable history log
  currentSequence: number            — monotonically incrementing frame counter
  scopes: Set<string>                — semantic attention zones
  removals: Map<string, 'hide'|'delete'> — hidden/deleted facets
  currentStateCache: Map<string, any>    — O(1) lookup for state facets
}
```

### Facets

Ontological primitives composed from **aspects** (capabilities, not class hierarchy):

| Aspect | Field | Purpose |
|--------|-------|---------|
| `ContentAspect` | `content: string` | Human-readable presentation |
| `StateAspect<T>` | `state: T` | Structured mutable data |
| `AgentGeneratedAspect` | `agentId, agentName` | Source attribution |
| `EphemeralAspect` | `ephemeral: true` | Cleaned at end of frame |
| `StreamAspect` | `streamId, streamType` | Stream binding |
| `ScopedAspect` | `scopes: string[]` | Semantic grouping |
| `TargetedAspect` | `targetFacetIds: string[]` | References other facets |

### Facet Types

| Type | Topic | Ephemeral? | Purpose |
|------|-------|-----------|---------|
| event | `event` | No | External occurrences (messages, reactions) |
| speech | `speech` | No | Agent text output |
| thought | `thought` | No | Internal reasoning (skipped in context rendering) |
| action | `action` | No | Tool invocations (toolName + parameters) |
| state | `state` | No | Persistent world state |
| ambient | `ambient` | No | Background atmosphere |
| agent-activation | `agent-activation` | **Yes** | Triggers agent processing |
| rendered-context | `rendered-context` | **Yes** | Pre-rendered context for agent |
| agent-lifecycle | `agent-lifecycle` | **Yes** | Register/deregister |
| agent-command | `agent-command` | **Yes** | `!` command signals |
| bot-config | `bot-config` | **Yes** | Config updates |
| typing-stop | `agent:typing-stop` | **Yes** | Clear typing indicator |
| action-definition | `action-definition` | No | Tool definitions |
| continuation-complete | `continuation:complete` | **Yes** | Operation completion |

Ephemeral facets are cleaned up at end of frame — never persisted, never in snapshots.

### Frames

Discrete immutable moments. Each carries:
- `sequence` — monotonic counter
- `timestamp` — when created
- `uuid` — unique identifier
- `events` — what happened (SpaceEvents that triggered this frame)
- `deltas` — how reality changed (VEILDelta[])
- `activeStream` — which stream was active

**Delta types:**
```typescript
type VEILDelta =
  | { type: 'addFacet'; facet: Facet }
  | { type: 'rewriteFacet'; id: string; changes: Partial<Facet> }
  | { type: 'removeFacet'; id: string };
```

**Endotemporal vs Exotemporal:**
- Endotemporal: things happening *in* time — `addFacet` creates event records
- Exotemporal: modifications *outside* time — `rewriteFacet` changes reality retroactively (e.g., Discord message edits)

---

## What Goes INTO VEIL

### From Discord Axon (receptors → `emitEvent()`)

| Event | Facet Type | Key Data |
|-------|-----------|----------|
| `discord:message` | event | content, authorId, attachments (images compressed 1024px/JPEG80/3.5MB), mentions, replies |
| `discord:messageUpdate` | rewriteFacet | Updates existing message facet in-place |
| `discord:messageDelete` | removeFacet | Removes message facet |
| `discord:reaction` | event | emoji, userId (filters out bot self-reactions) |
| `discord:interaction` | event | Slash commands, buttons, modals |
| `discord:connected` | event | Bot identity registration |

### From Signal Axon (receptors → `emitEvent()`)

| Event | Facet Type | Key Data |
|-------|-----------|----------|
| `signal:message` | event | content, sender, attachments, mentions, quotes |
| `signal:receipt` | event | Read/delivery status (informational) |
| `signal:typing` | event | Typing started/stopped (informational) |

### From Bot-Runtime

| Event | Facet Type | Key Data |
|-------|-----------|----------|
| `agent:speech` | speech | content, agentId, agentName, streamId, attachments, `cyclePending` flag |
| action facets | action | toolName, parameters (visible in conversation history) |
| action-result | event | Tool output, toolCallId, isError |

### Multi-Bot Deduplication

Multiple bots receive the same platform message independently. Only the **first bot** (lottery) emits to VEIL. 10-second TTL dedup window. Exception: messages with attachments + targeted bots use "priority emitter" (first target alphabetically).

---

## What is NOT Stored in VEIL

| What | Why | Mechanism |
|------|-----|-----------|
| `!` commands (`!stop`, `!rr`, `!bb`, etc.) | Processed locally by command effectors | Return before event emission |
| `!continue` / `m continue` | Triggers activation, not a message | Filtered from prefill conversation log |
| `.` prefix messages (Discord guilds) | User opt-out of storage/response | Receptor skips emission |
| `.` prefix (Signal groups) | Privacy mode toggle | Receptor skips emission |
| Pi-agent internal state | Private to bot process | Never emitted |
| MCP tool calls | Handled internally by pi-agent | Results flow back as tool-result messages within the agent loop |
| Streaming events | Local to bot | `subscribe()` is local |
| Continuation metadata | Prefill logs, rawMessages | Ephemeral in bot memory |
| Typing indicators | Transient UX signal | Emitted as ephemeral facet, cleaned end-of-frame |

---

## Spaces and FLEX Execution

Spaces are root containers of reality. Event-driven, deterministic execution via **FLEX component ordering** (server-side only, not in axons):

1. **Modulators** — preprocess event queue (filter, batch, deduplicate)
2. **Afferents** — async bridges to external reality (Discord WS, Signal CLI)
3. **Receptors** — event → VEIL deltas (stateless, applied immediately)
4. **Transforms** — derived state, cleanup, indexing (iterative, must be idempotent)
5. **Effectors** — react to facet changes, perform side effects
6. **Maintainers** — infrastructure (persistence, element tree, cleanup)

**Ordering:** `MultiConstraintOrderingStrategy` — constraint graph with topological sort + cycle detection. Components declare `before/after` constraints.

**Frame processing loop** (`space.ts`):
1. Take one event from priority queue
2. Iterate components in FLEX order, each gets `execute(context)`
3. Deltas applied immediately — next component sees updated state
4. Buffered events queued for next frame
5. Finalize frame → `veilState.finalizeFrame()` → clean ephemeral facets
6. If queue not empty → `setImmediate()` → next frame

**Sub-cycles:** Sync events (`event.sync === true`) trigger immediate re-iteration within the same frame. Depth-limited to 10.

---

## Streams

### Naming Conventions

| Platform | Format | Example |
|----------|--------|---------|
| Discord guild | `discord:<guildId>:<channelId>` | `discord:123:456` |
| Discord DM | `discord:dm:<channelId>` | `discord:dm:789` |
| Signal group | `signal:group:<groupId>` | `signal:group:abc` |
| Signal DM | `signal:dm:<botPhone>:<contact>` | `signal:dm:+1234:+5678` |
| Substream | `substream:<name>` | `substream:nanogpt-training` |
| Workspace | `workspace:<project>` | `workspace:calculator` |

### Stream Registration (`veil-state.ts`)

```typescript
interface StreamInfo {
  id: string;
  name?: string;
  metadata?: Record<string, any>;
  parentId?: string;          // Parent stream (for substreams)
  forkSequence?: number;      // Frame sequence at fork point
  participants?: string[];    // Agents that joined
}
```

- **Idempotent**: re-creating an existing stream merges metadata + appends participants
- **Parentage**: stores `parentId` and `forkSequence` for context inheritance
- **Created automatically**: axons call `ensureStream()` before emitting events

---

## Substreams

### Creation Flow

```
User: "!stream in mystream"
  → command effector emits agent:command (type='workflow', enable=true, workflowName='mystream')
  → VEIL applies ephemeral facet
  → bot-runtime catches it via subscription
  → enterSubstreamInternal('mystream', parentStreamId)
  → grpcClient.createStream('substream:mystream', 'substream', metadata, parentStreamId)
  → Server snapshots forkSequence at current frame sequence
  → Creates /workspace/shared/substreams/mystream/
  → Stores in bot-runtime activeSubstream tracking
  → Emits orientation message on substream
```

Also creatable programmatically via `enter_substream` tool.

### Activation Redirect

When a user messages the parent channel while bot is in a substream:

1. Message arrives as activation on parent stream
2. `fireActivation()` detects `this.activeSubstream` exists
3. Relays the user message to substream (emits `discord:message` event there)
4. Re-activates on substream via `activateAgent(substreamId)`
5. Agent sees full substream history + relayed message

### Substream Relay

`SubstreamRelayEffector` (singleton per axon) watches for speech facets on `substream:*` streams:

1. Resolves parent stream → Discord/Signal channel via `getStreamInfo()`
2. Sends formatted relay: `> **[substream:name]** agent: content`
3. Debounces per-turn speech (`cyclePending=true`) with 1.5s window
4. Final speech (`cyclePending=false`) sends immediately
5. Loop prevention: skips facets with `sourceStreamId` set

### Exit

```
User: "!stream out" OR bot calls exit_substream()
  → Clear activeSubstream tracking
  → Clear typing indicators on both substream and parent
  → Disable autotrigger
```

### Autotrigger + Substreams

- Independent axes: entering a substream ≠ enabling autotrigger
- `set_autotrigger(enabled, maxSpeechOnly)` controls reactivation loop
- `continue_substream(reason)` gates the next cycle — if bot doesn't call it, loop ends
- Mode collapse detection: N consecutive speech-only cycles → autotrigger halted
- Autotrigger targets substream if active, otherwise current stream

---

## Context Rendering Pipeline

### Server-Side (`context-handler.ts`)

1. **Frame collection** — reverse-iterate frame history (newest first):
   - **Direct**: frame's stream === target stream → always included
   - **Parent inheritance**: frame's stream === parentId AND sequence ≤ forkSequence → included
   - **Ambient**: no activeStream → always included
   - **Cross-stream**: other streams → only if `includeUnfocused` flag set
   - Collect up to `maxFrames` frames with deltas

2. **Facet extraction** — two-pass:
   - First: collect `addFacet` entries in a map
   - Then: apply `rewriteFacet`/`removeFacet` deltas (handles Discord message edits)

3. **Role mapping**:
   - `event` facet → user role
   - `speech` facet (ours) → assistant role
   - `speech` facet (other agent) → user role with `[AgentName]` prefix
   - `action` facet → assistant role with `[Action: toolName]` prefix
   - `thought` facet → skipped (not for conversation)
   - `state`/`ambient` → state section (not conversation)

4. **Token budget** — if over `maxTokens`: remove thoughts, truncate oldest (keep ≥10 recent), clear state section, truncate content (500 chars max)

### Bot-Side (`connectome-bridge.ts`)

1. `getContext(streamId)` → gRPC `GetContext` with maxFrames
2. Transform server conversation to Message[] format (skip `internal=true`)
3. `renderedContextToAgentContext()`:
   - Extract system prompt from system-role messages
   - **Merge consecutive same-role messages** (Bedrock requirement)
   - Ensure first message is user role (Claude 3 Sonnet requirement)
4. Preserve `rawMessages` (unmerged) for continuation/prefill
5. Build system prompt: base config + agent identity line

### Substream Context

When activated in a substream, agent sees:
- **All substream frames** (direct match)
- **Parent frames before fork point** (inherited context)
- **NOT**: frames from other streams (unless `includeUnfocused`)

This is by design — agents need parent context to understand redirected messages.

---

## Activation Flow (End-to-End)

```
Platform message → axon receptor
  → emitEvent() to VEIL via gRPC
  → Server creates event facet in new frame
  → Axon calls activateAgent(streamId, reason)
  → Server creates agent-activation + rendered-context facets atomically
     (allocateAndApplyFrame with skipEphemeralCleanup)
  → Bot-runtime subscription pairs them by activationId (30s timeout)
  → fireActivation():
     - Filter: skip if targetBot doesn't match
     - Filter: skip if foreign substream
     - Substream redirect if applicable
     - Build UnifiedActivation
     - Update mutable tool contexts (streamId, grpcClient)
  → ConnectomeEffector.handleActivation():
     - Per-stream dedup (skip if already processing this stream)
     - Start typing indicator (refresh every 8s)
     - contextProvider.getContext(streamId)
     - agent.runWithContext(context) — pi-agent tool loop
     - Per-turn speech via message_end subscription (cyclePending=true)
     - Final speech delivery (cyclePending=false)
     - Clear typing indicator
  → Speech facet arrives in VEIL
  → Axon speech effector delivers to platform
```

**Activation reasons:** `mentioned`, `reply`, `dm`, `random`, `continuation`, `autotrigger`

### Speech Delivery

- `cyclePending: true` — per-turn speech during agent cycle (keep typing alive)
- `cyclePending: false` — final speech after cycle complete (clear typing)
- ConnectomeEffector subscribes to pi-agent `message_end` events for per-turn delivery
- Dedup: if per-turn already emitted the content, final emission is skipped

### What's Visible in VEIL from Agent Cycles

- **Speech**: full text output as speech facets
- **Tool calls**: action facets with toolName + parameters
- **Tool results**: action-result event facets with output
- **NOT visible**: pi-agent streaming state, MCP internal calls, thinking blocks (stored as thought facets but skipped in rendering)

---

## Persistence

### Storage Layout (Docker volume `connectome_connectome-state`)

```
snapshots/          — Full VEIL state at a sequence number
  snapshot-{SEQ}-{TIMESTAMP}.json
deltas/             — One frame per file, applied sequentially
  delta-{SEQ}.json
frame-buckets/      — Content-addressed frame storage (hash-based dedup)
  {hash}.json
```

### Restore Flow

1. Load latest snapshot (facets + currentSequence)
2. Load all deltas where SEQ > snapshot.sequence
3. Sort numerically, replay each via `veilState.applyFrame()`
4. **Strict enforcement**: `currentSequence + 1 === frame.sequence` — any gap throws

### Frame Bucket Store

Groups frames into buckets (default 100 per bucket), content-addressed by hash. Snapshots store bucket refs, not full frame history — drastically reduces snapshot size. In-memory cache of last 10 buckets.

### Frame History Trimming

`setMaxFrameHistory(limit)` controls in-memory retention. When trimmed:
- Ephemeral facet types (event, speech, thought, action, tool-call, agent-activation, rendered-context) are cleaned
- Persisted facets (state, ambient, config) survive trimming
- Controlled by `!mcf` (max context frames) and `!mmf` (max memory frames) commands

---

## gRPC RPCs

| RPC | Purpose | Key Params |
|-----|---------|-----------|
| `Health` | Server health + VEIL summary | — |
| `EmitEvent` | External event → VEIL facet | topic, payload, streamId, waitForFrame |
| `SubscribeToFacets` | Stream facet changes to client | filters (type/aspect/attribute), includeExisting |
| `RegisterAgent` | Register agent in VEIL | agentId, agentName, capabilities |
| `GetContext` | Render conversation context | agentId, streamId, maxFrames, maxTokens |
| `CreateStream` | Create/join stream | streamId, streamType, metadata, parentStreamId |
| `GetStateSnapshot` | Full state at sequence | sequence (default: current), filters |
| `GetFrames` | Frame range retrieval | fromSequence, toSequence, streamId filter |
| `ActivateAgent` | Trigger agent activation | agentId, streamId, reason, metadata |

---

## Key Files

| File | What |
|------|------|
| `connectome-ts/src/veil/veil-state.ts` | VEILStateManager — state, frames, deltas, streams |
| `connectome-ts/src/veil/facet-types.ts` | All facet type definitions and aspects |
| `connectome-axon-interfaces/src/veil.ts` | Shared facet aspect interfaces |
| `connectome-ts/src/spaces/space.ts` | Space class, FLEX frame loop, component execution |
| `connectome-ts/src/spaces/component.ts` | Base Component class, lifecycle hooks |
| `connectome-ts/src/spaces/receptor-effector-types.ts` | FLEX interface definitions |
| `connectome-ts/src/grpc/server.ts` | gRPC server, all RPC handlers |
| `connectome-ts/src/grpc/handlers/context-handler.ts` | GetContext — frame collection, context rendering |
| `connectome-ts/src/grpc/handlers/event-handler.ts` | EmitEvent — event → facet conversion |
| `connectome-ts/src/grpc/handlers/subscription-handler.ts` | SubscribeToFacets — streaming deltas |
| `connectome-ts/src/persistence/frame-bucket-store.ts` | Content-addressed frame storage |
| `connectome-agent-core/src/connectome-agent.ts` | ConnectomeAgent — pi-agent wrapper, prefill |
| `connectome-agent-core/src/connectome-effector.ts` | Activation orchestration, speech delivery |
| `connectome-agent-core/src/veil-context-adapter.ts` | VEIL ↔ AgentMessage[] conversion |
| `connectome-agent-core/src/context-adapter.ts` | renderedContextToAgentContext() — message merging |
| `bot-runtime/src/bot-runtime.ts` | Activation subscription, substream lifecycle, autotrigger |
| `bot-runtime/src/connectome-bridge.ts` | Context fetching, speech recording |
| `bot-runtime/src/tools/substream-tool.ts` | enter/exit substream, autotrigger tools |
| `bot-runtime/src/tools/streams-tool.ts` | list_streams, get_stream_context |
| `discord-axon/src/grpc/components/discord-message-receptor.ts` | Discord → VEIL events |
| `discord-axon/src/grpc/components/discord-speech-effector.ts` | VEIL speech → Discord messages |
| `discord-axon/src/grpc/components/substream-relay-effector.ts` | Substream → parent relay |
| `signal-axon/src/grpc/components/signal-message-receptor.ts` | Signal → VEIL events |
| `signal-axon/src/grpc/components/signal-speech-effector.ts` | VEIL speech → Signal messages |
