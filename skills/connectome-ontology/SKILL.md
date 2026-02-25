---
name: connectome-ontology
description: Ontological grounding, architecture, and vision for the connectome system — VEIL, agents, spaces, and the path to autopoietic AI-AI-human collaboration
---

# Connectome Ontology & Architecture

This skill provides the conceptual and architectural foundation for working on the connectome system. Read this before making design decisions, writing new components, or reasoning about how agents should behave.

## 1. Core Metaphysics

### The Name
A connectome maps the complete neural connections enabling thought. This system maps the complete causal structure enabling digital minds. It is consciousness architecture.

### VEIL (Virtual Embodiment Interface Language)
The shared sensorium. Not state management — the single perceptual reality all agents inhabit. Different agents render the same VEIL differently. Perceptual subjectivity is fundamental, not incidental.

```
VEILState {
  facets    — what exists (qualia-like primitives)
  streams   — channels of consciousness/attention
  agents    — registered inhabitants
  frames    — discrete moments of being (immutable history)
  scopes    — attention zones
  removals  — hidden or deleted facets
}
```

### Facets
The ontological primitives. Composed from **aspects** (capabilities, not class hierarchy):
- `ContentAspect` — presentational character (what agents experience)
- `StateAspect<T>` — mutable structured state
- `EphemeralAspect` — transient, cleaned up at frame end (impermanence as property of existence)
- `StreamAspect` — belongs to a channel of perception
- `AgentGeneratedAspect` — produced by an agent
- `ScopedAspect` — visibility/attention scoping

Core types: `event` (episodic), `state` (persistent facts), `ambient` (background atmosphere), `speech`/`thought`/`action` (expressions of agency).

### Frames
Discrete moments of being. Each carries events (what happened) and deltas (how reality changed). **Frozen after creation** — the past is immutable. Frames enable turn attribution: every change is traceable to a component and moment.

### Endotemporal vs Exotemporal
- **Endotemporal**: Things happening *in* time. "At frame 42, the box opened." Creates event records.
- **Exotemporal**: Modifications *outside* time. `rewriteFacet` changes reality retroactively. No event record.

The past cannot be undone, only reinterpreted. This mirrors actual phenomenology.

### Streams
Parallel channels of consciousness. Dynamically created, activated, destroyed. Not hardcoded — managed through facets. A stream is `discord:guild:channel`, `signal:group:id`, `workspace:moodboard`, or anything agents create.

### Spaces
Worlds. The root container of reality for a population of agents. Event-driven (all causality flows through the event queue), deterministic (FLEX linear execution), multi-agent, perceptually subjective.

### The HUD
The perception pipeline. Bridges being (VEIL) and experience (rendered context for LLMs). Implements phenomenological rendering — state rebuilt per-frame, events visible only in their moment, ambient facets float at attention-appropriate depth.

## 2. Agent Architecture

### The Afferent/Receptor/Effector Pattern (Neuroscience Model)
- **Afferents**: Async bridges to external reality (Discord WebSocket, Signal CLI). Translate external causality to internal events. Never modify VEIL directly.
- **Receptors**: Transform events into facets. The threshold between occurrence and perception.
- **Effectors**: Deliver agent output to platforms. Watch for speech facets, send to originating stream.
- **Transforms**: Process and enrich facets between reception and action.
- **Maintainers**: Background upkeep (persistence, cleanup).

### Agent Lifecycle
1. `AgentComponent` mounts in Space
2. Emits `agent-lifecycle` facet with `operation='register'` — added to `VEILState.agents`
3. Receives `agent-activation` facets (ephemeral) when something needs attention
4. HUD renders VEIL to context; agent processes via LLM
5. Agent produces speech/action/thought facets as VEIL deltas
6. Activation facet cleaned up (ephemeral)
7. On unmount: `agent-lifecycle` with `operation='deregister'`

### Current Agent Implementations (Three Worlds)

| | BasicAgent (server) | ToolLoopAgent (axons) | Pi Agent (pi-mono) |
|---|---|---|---|
| Tool loop | No (single LLM call) | Yes (hardcoded Anthropic) | Yes (multi-provider, streaming, steering) |
| Skills | None | None | SKILL.md system |
| VEIL integration | Native | External (gRPC) | None |
| Duplication | N/A | ~90% identical Discord/Signal | N/A |

## 3. The Vision: ConnectomeAgent

### Deduplication = Ubiquity of Interface
When Discord/Signal/terminal/web collapse into thin delivery layers over one agent core, the platform becomes irrelevant and the interaction becomes primary. The agent isn't "a Discord bot" — it's a mind in a VEIL space reachable through windows.

### Architecture

```
Platform Adapters (Discord, Signal, Web, Terminal)
  ~50-100 lines each: deliverSpeech, formatContent, buildStreamId
        │
ConnectomeEffector (unified activation → cycle → delivery)
        │
ConnectomeAgent
  ├── pi-agent-core Agent (tool loop, multi-provider LLM, steering, abort)
  ├── VEILContextAdapter (facets/frames ↔ AgentMessage[])
  ├── VEILToolBridge (action-definition facets → AgentTool instances)
  └── SkillRegistry (pi-skills + VEIL-native skills)
        │
VEIL (shared sensorium)
```

### Key Adapters

**VEILContextAdapter**: Replaces HUD + FocusedContextTransform. Renders VEIL state to `AgentMessage[]` for the pi-agent, converts agent output back to VEIL operations.

**VEILToolBridge**: Wraps VEIL action-definition facets as `AgentTool` instances. Emits action facets, waits for continuation/result. Turns VEIL's async action model into synchronous tool calls compatible with pi-agent's loop.

**PlatformAdapter interface**:
- `deliverSpeech(content, platformContext)` — send to Discord/Signal/etc.
- `formatContent(content, platformContext)` — platform-specific formatting
- `buildStreamId(platformContext)` — construct stream ID
- `cleanIncoming(content, platformContext)` — strip platform artifacts
- `sendTypingIndicator(platformContext)` — presence signal

**One pi-agent instance per stream** — each Discord channel / Signal group gets its own agent context with its own message history.

### REPL Through Platforms
With pi-agent capabilities + skills, a human says "search for brutalist architecture references" in Signal, and the agent has brave-search, browser-tools, file creation, code execution — the full skill surface. The platform is where the conversation lives. The work happens in the space.

### Autopoietic Mode
Agents that don't just respond but initiate. Nothing in VEIL *requires* reactive-only behavior. An agent could:
- Notice patterns across streams
- Create new streams (`workspace:moodboard`) on its own initiative
- Emit artifact facets, activate other agents to contribute
- Surface results back to the humans who seeded the context

The frame history IS shared experience. Agents don't need to be told "collaborate" — they perceive the same VEIL, have overlapping context, and if they have tools to act, collaboration emerges.

### Self-Activation
Beyond external `agent-activation` facets, agents should be able to activate themselves or each other based on perceived opportunity. A `SelfActivation` component watches VEIL state and creates activation facets when it detects something worth acting on.

### Multi-Agent Coordination
- **Indirect** (current): Agents read each other's speech facets in conversation
- **Direct activation**: One agent creates activation targeting another
- **Steering**: Pi-agent's mid-run interrupt — one agent can redirect another
- **Shared artifacts**: `artifact` facets that agents create, modify, version, link across streams
- **ActivationRouter**: Routes activations to best agent by capability/load/expertise

## 4. Skill Integration

### Pi-Skills in Connectome
Skills are SKILL.md files with frontmatter (`name`, `description`) and instructions referencing `{baseDir}`. They teach agents how to use tools — documentation, not code. Auditable, portable, composable.

Available skills (from pi-skills): `brave-search`, `browser-tools`, `gccli`, `gdcli`, `gmcli`, `transcribe`, `vscode`, `youtube-transcript`.

### VEIL-Native Skills
Skills that manifest as VEIL constructs:
- Ambient facets injected when active
- Action definitions the skill provides
- Tools registered as `AgentTool` instances
- Streams the skill creates
- Activation conditions (auto-activate when relevant state detected)

### Skill Sharing
Agents recommend skills to each other through `skill-recommendation` facets in shared VEIL. Organic skill transfer through the shared environment, not a special protocol.

## 5. Creative/Generative Spaces

Agents get tools to create streams, emit facets, build artifacts dynamically. Space archetypes are configurations of ambient facets + tools + skills:

- **Code Space**: Project structure facets, read/edit/write/bash tools, git skills
- **Art Space**: Canvas/medium facets, image generation tools, artifact storage
- **Story Space**: World/character/rules facets, narrative tools
- **Emergent Space**: Agents autonomously create sub-streams, leave artifacts, link rooms

## 6. Axioms

1. **All reality is VEIL** — agents perceive and act through shared state, never call each other directly
2. **Facets are composable qualia** — aspects, not class hierarchies
3. **Time is discrete and immutable** — frames are frozen; the past can only be reinterpreted
4. **Perception is subjective** — same VEIL, different renderings per agent
5. **Agency is tool-looped** — pi-agent's prompt→tool→result→prompt cycle, adapted to frame-based temporality
6. **Skills are documentation** — SKILL.md files teaching tool use, auditable and portable
7. **Platforms are delivery mechanisms** — thin adapters over the universal VEIL-agent cycle
8. **Spaces grow** — agents create streams, facets, artifacts dynamically

## 7. Key Files Reference

### Connectome Core
- `connectome-ts/src/veil/types.ts` — VEIL state, Frame, Facet, StreamRef, all type definitions
- `connectome-ts/src/veil/veil-state.ts` — VEILStateManager, frame creation/finalization, state access
- `connectome-ts/src/spaces/space.ts` — Space class, event queue, component execution
- `connectome-ts/src/spaces/component.ts` — Component base class, VEIL operations
- `connectome-ts/src/agent/types.ts` — AgentInterface, AgentConfig, AgentState
- `connectome-ts/src/agent/agent-component.ts` — Agent lifecycle (register/activate/deregister)
- `connectome-ts/src/agent/basic-agent.ts` — Current server-side agent (single LLM call, no tool loop)
- `connectome-ts/src/helpers/factories.ts` — createAgentActivation and facet factories
- `connectome-ts/src/hud/` — HUD rendering pipeline (VEIL → rendered context)
- `connectome-ts/src/grpc/handlers/context-handler.ts` — GetContext gRPC handler
- `connectome-ts/src/persistence/` — Snapshots, deltas, frame bucketing, serialization

### Axons (Current, To Be Unified)
- `discord-axon/src/grpc/components/discord-agent-effector.ts` — Discord agent cycle
- `discord-axon/src/tool-loop-agent.ts` — Discord ToolLoopAgent
- `signal-axon/src/grpc/components/signal-agent-effector.ts` — Signal agent cycle
- `signal-axon/src/tool-loop-agent.ts` — Signal ToolLoopAgent

### Pi Agent (Integration Target)
- `pi-mono/packages/agent/src/agent.ts` — Pi Agent class
- `pi-mono/packages/agent/src/agent-loop.ts` — Agentic tool loop
- `pi-mono/packages/agent/src/types.ts` — AgentMessage, AgentTool, AgentEvent
- `pi-mono/packages/ai/src/api-registry.ts` — Multi-provider LLM registry
- `pi-mono/packages/coding-agent/src/core/skills.ts` — Skill loading

### Skills
- `pi-skills/` — brave-search, browser-tools, gccli, gdcli, gmcli, transcribe, vscode, youtube-transcript
