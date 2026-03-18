---
name: debug-live
description: Use Connectome MCP to inspect live VEIL state, Docker logs, stream/facet/frame state, and subscription health to diagnose production issues. Trigger keywords — debug, diagnose, what's wrong, check logs, inspect, why is, broken, not working, stuck.
---

# Debug Live

Diagnose production issues in a running Connectome deployment using MCP tools for live state inspection.

## Prerequisites

- Connectome MCP server available
- Docker services running

## Diagnostic Toolkit

### Infrastructure Health

```
mcp__connectome__docker_status    — Which containers are up/down, resource usage
mcp__connectome__docker_diagnose  — Automated health check across all services
mcp__connectome__health           — Connectome gRPC server health + VEIL state summary
```

**Start here.** Most issues are visible from health checks.

### Docker Logs

```
mcp__connectome__docker_logs      — Fetch recent logs for a specific service
```

Parameters: service name (connectome, discord-axon, signal-axon, bot-opus-46, etc.)

Common log patterns to search for:
- `[ERROR]`, `Error:`, `FATAL` — explicit errors
- `ECONNREFUSED`, `ENOTFOUND` — connectivity issues
- `timeout`, `deadline exceeded` — gRPC timeouts
- `OOM`, `heap out of memory` — memory exhaustion
- `[StreamManager]` — stream lifecycle events
- `[TypingStop]` — typing indicator lifecycle
- `[SubstreamRelay]` — substream message delivery
- `Wallet tools enabled` — tool initialization

### VEIL State Inspection

```
mcp__connectome__get_streams      — All active streams with metadata
mcp__connectome__get_agents       — Registered agents and their state
mcp__connectome__get_facets       — Facets in a stream (filter by type)
mcp__connectome__get_context      — Rendered context for an agent/stream
mcp__connectome__get_frames       — Frame history with deltas
mcp__connectome__get_events       — Recent events in the space
mcp__connectome__get_speech       — Speech facets (what agents said)
```

### Persistence

```
mcp__connectome__snapshot_list    — Available snapshots
mcp__connectome__snapshot_inspect — Snapshot metadata
mcp__connectome__snapshot_frames  — Frames in a snapshot
mcp__connectome__snapshot_search  — Search across snapshot content
```

### Workspace

```
mcp__connectome__workspace_list   — Files in shared workspace
mcp__connectome__workspace_read   — Read a workspace file
```

## Common Diagnostic Flows

### "Bot isn't responding"

1. `docker_status` — Is the bot container running?
2. `docker_logs` for the bot — Any errors on startup? Is it connected to gRPC?
3. `get_agents` — Is the agent registered with connectome?
4. `get_streams` — Does the stream exist? Is the agent subscribed?
5. `docker_logs` for the axon — Is the axon receiving messages? Is it forwarding activations?
6. Check platform binding — Is the bot's credential advertised to the axon?

### "Typing indicator stuck"

1. `docker_logs` for discord-axon — Search for `[TypingStop]` and the stream ID
2. `get_events` — Was `agent:typing-stop` emitted?
3. `docker_logs` for the bot — Did it emit typing-stop on completion?
4. Check if the bot is in a substream — typing-stop needs to target the parent stream

### "Message not delivered"

1. `docker_logs` for the axon — Did the speech effector fire?
2. `get_speech` — Is there a speech facet for the expected stream?
3. `get_facets` — Check for the speech facet, its cyclePending state
4. `docker_logs` for the bot — Did the agent produce output?
5. `get_context` — What context did the agent see? Was it activated?

### "Substream relay not working"

1. `get_streams` — Does the substream exist? What's its parent?
2. `docker_logs` for the axon — Search for `[SubstreamRelay]`
3. `get_speech` — Is speech being recorded in the substream?
4. Check the relay effector's subscription — is it subscribed to the right stream pattern?

### "Agent in wrong state / stale context"

1. `get_context` for the agent — What frames is it seeing?
2. `get_frames` — Check frame sequence for gaps (see `veil-delta-repair` skill)
3. `snapshot_list` + `snapshot_inspect` — Is persistence healthy?
4. `get_facets` — Look for stale state facets that should have been cleaned up

### "gRPC connectivity issues"

1. `docker_diagnose` — Checks inter-service connectivity
2. `docker_logs` for connectome — gRPC server errors, connection tracking
3. `docker_logs` for the affected client — Connection retry patterns
4. Check `docker_status` for port mappings and network configuration

## Escalation

If live debugging identifies a code issue:
1. Document findings (logs, state, root cause hypothesis)
2. Use `investigate` to create a structured issue
3. Or fix directly if the issue is small and well-understood

If the issue is a VEIL persistence problem (frame gaps, corrupted deltas):
1. Use the `veil-delta-repair` skill from `skills/veil-delta-repair/SKILL.md`
2. Never edit delta files manually — follow the repair procedure exactly
