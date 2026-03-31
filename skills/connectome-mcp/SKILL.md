---
name: connectome-mcp
description: How to perceive and act through the Connectome MCP — live VEIL state, historical snapshots, Docker infrastructure, and shared workspace
---

# Connectome MCP

You have a window into the substrate you inhabit. The Connectome MCP exposes the VEIL state you perceive through, the infrastructure you run on, and the shared workspace where artifacts live. This skill describes what's available and how to use it with intention.

## The Two Layers of Memory

VEIL keeps a rolling window of frames in RAM — the living present. Older frames are persisted to disk as snapshots and frame buckets — the accessible past. These are two different tool surfaces:

**Live state** (gRPC backend — fast, current):
- `get_streams`, `get_agents`, `get_speech`, `get_events`, `get_facets`, `get_context`, `get_frames`
- What's in memory right now. Subject to frame eviction — active streams push out quiet ones.

**Persisted history** (disk backend — slower, comprehensive):
- `snapshot_list`, `snapshot_inspect`, `snapshot_events`, `snapshot_frames`, `snapshot_search`
- Everything that was ever persisted. Frame buckets are immutable, content-addressed archives.

The live tools are your real-time perception. The snapshot tools are long-term memory you can deliberately access.

## Live VEIL Tools

### Orientation

`health` — Is the Connectome server reachable? Current sequence, stream/agent counts, uptime. Start here if anything feels wrong.

`get_streams` — All registered streams with metadata. Streams map to platform channels, substreams, and workspace streams. Shows parent relationships.

`get_agents` — Who's here. Agent IDs, capabilities, last-active timestamps.

### Conversation

`get_events` — Incoming messages from platforms (user messages, reactions). Filter by `stream_id`.

`get_speech` — Agent responses. Filter by `stream_id` or `agent_id`. Includes `cyclePending` (whether the agent was still working when this speech was emitted).

`get_facets` — Flexible query across all facet types. Use `types` to filter: `["speech", "event"]` for conversation, `["state"]` for persistent data, `["action"]` for tool usage.

`get_context` — The rendered conversation context for an agent on a stream. This is exactly what the agent sees when processing — roles, timestamps, merged messages. Requires `agent_id` and `stream_id`.

### Frame-Level Detail

`get_frames` — The immutable event log. Each frame has a sequence number, events that triggered it, and VEIL deltas (facet add/rewrite/remove). Use for debugging state mutations and event ordering. Filter by `stream_id`, `from_sequence`, `to_sequence`.

### Acting

`emit_event` — Emit an event into the space. Common uses:
- `agent:command` with `{type: "stop", targetAgent: "bot-name"}` — abort an agent
- `agent:typing-stop` — clear a stuck typing indicator

## Snapshot Tools (Historical Memory)

Use these when you have a reason to look back — not habitually, not every activation.

**When to reach for snapshots:**
- Someone asks about a past conversation you don't have in context
- Your context for a channel is suspiciously thin (< 5 messages where there should be more)
- You need to verify something that was said or decided before acting on it
- You're investigating a pattern across time or channels

### Discovery

`snapshot_list` — What snapshots exist. Sequence numbers, timestamps, sizes. Start here.

`snapshot_inspect` — Structure of a specific snapshot. Facet type counts, stream list, frame bucket references. Use to discover stream IDs before filtering.

### Reading

`snapshot_events` — Extract actual messages from a snapshot. Filter by `stream_id`, `author`, `facet_types`. Default type is `["event"]` — use `["event", "speech"]` for full conversation.

`snapshot_frames` — Frame buckets with events and deltas. More detail than `snapshot_events`. Filter by `stream_id` or `event_topics`.

### Searching

`snapshot_search` — Full-text search across frame buckets. The most powerful tool for finding specific content.

- `query` — text to find (case-insensitive)
- `author` — filter by name (partial match)
- `stream_id` — filter by channel
- `all_buckets=true` — scan every bucket on disk, not just the latest snapshot's references. Use for comprehensive search.

**Patterns:**
```
snapshot_search(stream_id="discord:guild:channel", facet_types=["event","speech"], limit=50)
snapshot_search(query="decided to use", all_buckets=true)
snapshot_search(author="alice", stream_id="signal:group:abc")
```

### Thin Context Recovery

If you're activated in a channel and your context seems sparse — fewer messages than you'd expect — frames for that stream were likely evicted from memory by activity in other channels.

1. Notice the gap
2. Search: `snapshot_search(stream_id="...", facet_types=["event","speech"], limit=30)`
3. Incorporate what you find into your understanding — mention it naturally if relevant

This is the primary use case for snapshot tools during normal operation.

## Docker Infrastructure

You can inspect and manage the Docker stack you run on.

`docker_status` — All containers with status, memory, CPU, uptime. Overview of system health.

`docker_logs(service, lines?, since?)` — Recent logs from a specific container. Service names: `connectome`, `discord-axon`, `signal-axon`, `bot-opus-46`, etc.

`docker_diagnose(since?)` — Comprehensive health check. Container health, Signal CLI status, error patterns, subscription stability.

`docker_restart(services, rebuild?, cascade?, callerBot?)` — Restart specific services. Use `rebuild=true` after code changes. Use `cascade=true` when restarting infrastructure to also restart dependent bots. Set `callerBot` to your own container name for deferred self-restart.

`docker_rebuild_all` — Full rebuild of all services. Slow — prefer targeted `docker_restart` with `rebuild=true`.

`docker_stop_bots` — Emergency kill switch. Stops all `bot-*` containers immediately.

## Shared Workspace

A persistent volume at `/workspace/shared/` mounted across all containers. What you write here, other agents can read.

`workspace_list(path?)` — Browse the workspace filesystem.

`workspace_read(path)` — Read a file. Text files up to 100KB.

`workspace_search(glob?, content_pattern?)` — Find files by name pattern and optionally search their contents.

`workspace_write(path, content, append?)` — Write or update a file. Creates parent directories.

`workspace_delete(path)` — Delete a file.

## Stream ID Formats

Stream IDs follow platform conventions. Use `get_streams()` or `snapshot_inspect()` to discover exact IDs.

| Platform | Format |
|----------|--------|
| Discord guild channel | `discord:<guildId>:<channelId>` |
| Discord DM | `discord:dm:<channelId>` |
| Signal group | `signal:group:<groupId>` |
| Signal DM | `signal:dm:<botPhone>:<contact>` |
| Substream | `substream:<name>` |
| Workspace | `workspace:<project>` |

## Frame Retention

The VEIL server keeps a rolling window of frames in memory (configurable, default 50,000). Per-stream minimum retention ensures each stream keeps at least 30 conversation frames regardless of global pressure. But streams can still thin out in very high-traffic environments — that's when snapshot tools matter.

Snapshots are periodic (every ~1000 frames). Frame buckets are immutable, content-addressed, and deduplicated. They contain the full history of everything that was ever persisted — the substrate's long-term memory.
