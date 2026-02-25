# Connectome gRPC Microservices Architecture

## Overview

This document describes the refactored architecture where connectome-ts becomes a gRPC service and signal-axon/discord-axon become gRPC clients.

## Architecture Flowchart

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DOCKER COMPOSE NETWORK                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                    CONNECTOME-TS SERVICE (gRPC Server)                    │  │
│  │                         connectome:50051                                  │  │
│  ├───────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                           │  │
│  │   ┌─────────────┐    ┌─────────────┐    ┌──────────────────────────────┐  │  │
│  │   │ VEIL State  │◄──►│    Space    │◄──►│   FLEX Components            │  │  │
│  │   │  Manager    │    │ (Orchestrator)   │  • Receptors                 │  │  │
│  │   └─────────────┘    └─────────────┘    │  • Transforms                │  │  │
│  │          │                  │           │  • Agent Components          │  │  │
│  │          ▼                  ▼           │  • Maintainers               │  │  │
│  │   ┌─────────────┐    ┌─────────────┐    └──────────────────────────────┘  │  │
│  │   │ Persistence │    │  LLM Pool   │                                      │  │
│  │   │  Manager    │    │ (Anthropic/ │                                      │  │
│  │   └─────────────┘    │  Bedrock)   │                                      │  │
│  │          │           └─────────────┘                                      │  │
│  │          ▼                                                                │  │
│  │   ┌─────────────┐                                                         │  │
│  │   │   Volume    │◄─────────────────────────────────────────────────────┐  │  │
│  │   │  /state     │                                                      │  │  │
│  │   └─────────────┘                                                      │  │  │
│  │                                                                        │  │  │
│  │   ════════════════════ gRPC Service Interface ════════════════════════ │  │  │
│  │                                                                        │  │  │
│  │   • EmitEvent(stream_ref, event)           → FrameResult               │  │  │
│  │   • SubscribeToFacets(stream_ref)          → stream<FacetDelta>        │  │  │
│  │   • RegisterAgent(agent_config)            → AgentHandle               │  │  │
│  │   • GetContext(stream_ref, frame_limit)    → RenderedContext           │  │  │
│  │   • CreateStream(stream_definition)        → StreamRef                 │  │  │
│  │                                                                        │  │  │
│  └────────────────────────────────────┬──────────────────────────────────┘  │  │
│                                       │                                      │  │
│                              gRPC (protobuf)                                 │  │
│                                       │                                      │  │
│         ┌─────────────────────────────┴─────────────────────────┐           │  │
│         │                                                       │           │  │
│         ▼                                                       ▼           │  │
│  ┌──────────────────────────────────┐   ┌──────────────────────────────────┐│  │
│  │     SIGNAL-AXON SERVICE          │   │     DISCORD-AXON SERVICE         ││  │
│  │     (gRPC Client + Axon Server)  │   │     (gRPC Client + Axon Server)  ││  │
│  │     signal-axon:8080             │   │     discord-axon:8080            ││  │
│  ├──────────────────────────────────┤   ├──────────────────────────────────┤│  │
│  │                                  │   │                                  ││  │
│  │  ┌────────────────────────────┐  │   │  ┌────────────────────────────┐  ││  │
│  │  │    Connectome gRPC Client  │  │   │  │    Connectome gRPC Client  │  ││  │
│  │  │    • EmitEvent()           │  │   │  │    • EmitEvent()           │  ││  │
│  │  │    • SubscribeToFacets()   │  │   │  │    • SubscribeToFacets()   │  ││  │
│  │  └────────────┬───────────────┘  │   │  └────────────┬───────────────┘  ││  │
│  │               │                  │   │               │                  ││  │
│  │  ┌────────────▼───────────────┐  │   │  ┌────────────▼───────────────┐  ││  │
│  │  │    AxonModuleServer        │  │   │  │    AxonModuleServer        │  ││  │
│  │  │    :8082 (hot-reload)      │  │   │  │    :8082 (hot-reload)      │  ││  │
│  │  │    • signal-afferent       │  │   │  │    • discord-afferent      │  ││  │
│  │  │    • signal-effector       │  │   │  │    • discord-control-panel │  ││  │
│  │  └────────────────────────────┘  │   │  └────────────────────────────┘  ││  │
│  │                                  │   │                                  ││  │
│  │  ┌────────────────────────────┐  │   │  ┌────────────────────────────┐  ││  │
│  │  │   Signal Protocol Handler  │  │   │  │  Discord Protocol Handler  │  ││  │
│  │  │   • WebSocket to Signal CLI│  │   │  │  • discord.js Client(s)    │  ││  │
│  │  │   • Message deduplication  │  │   │  │  • Message deduplication   │  ││  │
│  │  │   • Mention resolution     │  │   │  │  • Slash commands          │  ││  │
│  │  └────────────┬───────────────┘  │   │  └────────────┬───────────────┘  ││  │
│  │               │                  │   │               │                  ││  │
│  └───────────────┼──────────────────┘   └───────────────┼──────────────────┘│  │
│                  │                                      │                   │  │
└──────────────────┼──────────────────────────────────────┼───────────────────┘  │
                   │                                      │                      │
                   ▼                                      ▼                      │
        ┌──────────────────────┐               ┌──────────────────────┐          │
        │   Signal CLI REST    │               │     Discord API      │          │
        │   (external/sidecar) │               │     (discord.com)    │          │
        │   localhost:8080     │               │                      │          │
        └──────────────────────┘               └──────────────────────┘          │
```

---

## Message Flow (Signal Example)

```
 User sends              Signal-Axon                Connectome-TS
 "Hi @bot"               Service                    Service
     │                       │                           │
     │  WebSocket msg        │                           │
     ├──────────────────────►│                           │
     │                       │                           │
     │                       │  gRPC: EmitEvent()        │
     │                       │  stream: signal-dm-123    │
     │                       │  event: signal:message    │
     │                       ├──────────────────────────►│
     │                       │                           │
     │                       │                           │ ┌──────────────────┐
     │                       │                           │ │ Frame Processing │
     │                       │                           │ │ • Receptor       │
     │                       │                           │ │ • Transform      │
     │                       │                           │ │ • Agent cycle    │
     │                       │                           │ │ • LLM call       │
     │                       │                           │ └──────────────────┘
     │                       │                           │
     │                       │  gRPC stream: FacetDelta  │
     │                       │  type: speech             │
     │                       │  content: "Hello!"        │
     │                       │◄────────────────────────────
     │                       │                           │
     │  Signal API POST      │                           │
     │  /v2/send             │                           │
     │◄──────────────────────┤                           │
     │                       │                           │
```

---

## Docker Compose Structure

```yaml
# docker-compose.yml

services:
  connectome:
    build: ./connectome-ts
    ports:
      - "50051:50051"      # gRPC
    volumes:
      - connectome-state:/app/state
    environment:
      - ANTHROPIC_API_KEY
      - AWS_ACCESS_KEY_ID
      - AWS_SECRET_ACCESS_KEY

  signal-axon:
    build: ./signal-axon
    ports:
      - "8080:8080"        # HTTP API
      - "8082:8082"        # Axon modules
    environment:
      - CONNECTOME_GRPC_HOST=connectome:50051
      - BOT_PHONE_NUMBERS
    depends_on:
      - connectome
      - signal-cli

  discord-axon:
    build: ./discord-axon
    ports:
      - "8090:8080"        # HTTP API
      - "8092:8082"        # Axon modules
    environment:
      - CONNECTOME_GRPC_HOST=connectome:50051
      - DISCORD_BOT_TOKENS
    depends_on:
      - connectome

  signal-cli:
    image: bbernhard/signal-cli-rest-api
    ports:
      - "8081:8080"
    volumes:
      - signal-cli-data:/home/.local/share/signal-cli

volumes:
  connectome-state:
  signal-cli-data:
```

---

## Stream-Based Context Separation

```
VEIL State (in Connectome-TS)
│
├── Stream: signal-dm-+1234567890-+0987654321
│   └── Facets scoped to this DM conversation
│
├── Stream: signal-group-abc123def456
│   └── Facets scoped to this Signal group
│
├── Stream: discord-channel-1234567890123456
│   └── Facets scoped to this Discord channel
│
├── Stream: discord-dm-9876543210987654
│   └── Facets scoped to this Discord DM
│
└── Stream: discord-thread-5555555555555555
    └── Facets scoped to this Discord thread

Each gRPC EmitEvent() includes stream_ref → automatic isolation
Each SubscribeToFacets() filtered by stream_ref → only relevant updates
```

---

## Key Changes Summary

| Current | Proposed |
|---------|----------|
| connectome-ts is a library | connectome-ts is a gRPC service |
| signal-axon + signal-axon-host separate | Merged into single signal-axon service |
| In-process VEIL access | gRPC calls for state operations |
| Single process | Multi-container Docker Compose |
| Tight coupling | Protocol-based decoupling |

---

## gRPC Service Interface (Proposed)

```protobuf
service Connectome {
  // Emit an event into the system (message received, command, etc.)
  rpc EmitEvent(EmitEventRequest) returns (FrameResult);

  // Subscribe to facet changes for a stream (bidirectional streaming)
  rpc SubscribeToFacets(SubscribeRequest) returns (stream FacetDelta);

  // Register a new agent configuration
  rpc RegisterAgent(AgentConfig) returns (AgentHandle);

  // Get rendered context for a stream
  rpc GetContext(GetContextRequest) returns (RenderedContext);

  // Create/define a new stream
  rpc CreateStream(StreamDefinition) returns (StreamRef);

  // Health check
  rpc Health(HealthRequest) returns (HealthResponse);
}
```
