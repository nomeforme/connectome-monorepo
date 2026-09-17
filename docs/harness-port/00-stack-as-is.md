# The house harness fleet, as it stands today

Written by agent B1, 2026-09-17, against `harness-port` @ `fce107f` (branch created off
`inkfield`). Every claim below carries a `path:line` citation into this monorepo unless
marked `[sfo]`, meaning it was observed live on the box rather than in source. Local
reads were done against the read-only reference clone (`repos/connectome-monorepo` on
the upstream side); sfo reads were done over `ssh sfo`, read-only, no destructive command
run (see the report for the deferred-ops queue, which stayed empty — nothing needed
queuing on this pass).

This document describes a **generic multi-room agent harness**: a central state/
orchestration server ("connectome"), a set of platform adapters ("axons": Discord,
Signal, a generic web adapter, plus two written-but-undeployed adapters), and a fleet
of one-container-per-agent bot processes ("bot-runtime") that speak gRPC to both. No
project-specific archive or client content is referenced — this is infrastructure.

## 1. connectome-ts — the state/orchestration server

### 1.1 VEIL: facets, frames, streams, deltas

VEIL ("Virtual Environment Interface Language" per `connectome-ts/src/veil/veil-state.ts`
header, "Virtual Embodiment Interface Language" per the runtime skill
`skills/connectome-ontology/SKILL.md`) is a single append-only event log with a
derived, queryable state projection.

- **Facet** — the atomic unit of state. `BaseFacet = { id, type }`
  (`connectome-ts/src/veil/facet-types.ts`, mirrored in
  `connectome-axon-interfaces/src/veil.ts:53-56`). Facets compose from "aspects":
  `ContentAspect` (`content: string`), `StateAspect<T>` (`state: T`),
  `AgentGeneratedAspect` (`agentId`/`agentName`), `EphemeralAspect`, `ScopedAspect`
  (`scopes: string[]`), `StreamAspect` (`streamId`/`streamType`), `TargetedAspect`
  (`targetFacetIds`) — `connectome-axon-interfaces/src/veil.ts:16-56`. Concrete facet
  types: `speech`, `thought`, `action`, `event`, `state`, `ambient`, `ephemeral`,
  `config`, `internal-state`, plus meta/system facets (`state-change`, `scope-change`,
  `stream-change`, `agent-lifecycle`, `agent-activation`, `rendered-context`,
  `action-definition`) — `connectome-axon-interfaces/src/veil.ts:62-175`. Facets nest via
  `children: Facet[]` (legacy field, still populated —
  `connectome-ts/src/veil/types.ts:32-44`).
- **Frame** — one atomic state transition: `{ sequence, timestamp, uuid, activeStream,
  events: SpaceEvent[], deltas: VEILDelta[], transition, renderedSnapshot?,
  subCycleTrace? }` (`connectome-ts/src/veil/types.ts:94-119`). `VEILDelta` is one of
  `addFacet | rewriteFacet | removeFacet` (`connectome-axon-interfaces/src/veil.ts:237-240`,
  proto mirror `connectome-grpc-common/proto/connectome.proto:363-374`).
- **Stream** — NOT a facet type; a first-class registry entry: `StreamInfo { id, name,
  metadata, parentId, forkSequence, participants }` held in
  `VEILState.streams: Map<string, StreamInfo>` (`connectome-ts/src/veil/types.ts:60-67,
  176-190`). Streams can fork from a parent at a given sequence (`forkSequence`) —
  this is how "hierarchy-aware" context (a substream inheriting its parent channel's
  history up to the fork point) works; see `CreateStream` handling below.
- **Substream** — a plain stream whose id is prefixed `substream:` by convention
  (`discord-axon/src/grpc/components/substream-relay-effector.ts:5-9`), created with a
  `parentStreamId` pointing back at the originating channel stream (`!stream in <name>`
  → `signal-command-effector.ts`/`discord-command-effector.ts` `handleStream`). Nothing
  in connectome-ts itself distinguishes a substream from any other stream — the
  `substream:` prefix and relay-back-to-parent behavior are axon-side conventions.
- **VEILState** carries a `currentStateCache: Map<string, any>` — a memoized "current
  computed state" per state-facet id, rebuilt on restore
  (`connectome-ts/src/persistence/restoration.ts:69`, cache field at
  `connectome-ts/src/veil/types.ts:189`) so repeated state-facet reads don't replay
  every `state-change` delta each time.

### 1.2 Persistence — snapshots, deltas, frame buckets, blobs

Four parallel, independently-addressed primitives live under one `PERSISTENCE_DIR`
(default `./connectome-state`, `connectome-ts/src/grpc-main.ts:45`; on sfo this is the
bind-mounted `connectome-state` docker volume, see §11):

| Primitive | On-disk path | Cadence / trigger | Code |
|---|---|---|---|
| **Snapshot** | `<dir>/snapshots/snapshot-<seq>-<ts>.json` | Every `snapshotInterval` frames (server default **1000**, `grpc-main.ts:46`; the `PersistenceMaintainer` class's own internal default is 100 if constructed without a config, `persistence-maintainer.ts:19,65` — the host always passes an explicit value, so the 1000 wins in production) | `connectome-ts/src/persistence/persistence-maintainer.ts:104-147`, path building `file-storage.ts:80-81` |
| **Delta** | `<dir>/deltas/delta-<seq>.json` | Every frame (fire-and-forget, skips pure-streaming frames — `activation:stream` topic — to avoid flooding, `persistence-maintainer.ts:52-62`) | `persistence-maintainer.ts:75-102`, path `file-storage.ts:293-294` |
| **Frame bucket** | `<dir>/frame-buckets/<hash[0:2]>/<hash[2:]>.json` | Batches of 100 frames (`bucketSize` default, `frame-bucket-store.ts:34,45`), content-addressed (sha256 of the JSON'd frame array, `frame-bucket-store.ts:173-177`), git-object-style 2-char shard dir (`frame-bucket-store.ts:179-184`). A snapshot references buckets by `FrameBucketRef{hash,startSequence,endSequence,frameCount,streamIds}` instead of embedding frame history — this is the "fragment snapshot" mechanism: each new snapshot only serializes frames *since the last snapshot* (`persistence-maintainer.ts:109-123`), keeping snapshot size roughly proportional to the interval, not total history. | `connectome-ts/src/persistence/frame-bucket-store.ts` (full file) |
| **Blob** | `<basePath>/blobs/<sha[0:2]>/<sha>.bin` + sibling `.json` metadata sidecar | On `PutBlob` RPC (content-addressed, sha256, dedup on identical bytes — `alreadyExisted: true`) | `connectome-ts/src/persistence/blob-store.ts:1-21` (header comment is the spec), write path `blob-store.ts:96-139` (tmp-file + atomic rename, crash-safe) |

Additional: `bucket-refs-index.json` at the persistence-dir root (referenced
`file-storage.ts:47`) and `migration-progress.json` (written by
`connectome-ts/src/persistence/blob-migrator.ts`, a one-shot script
`connectome-ts/scripts/migrate-blobs.ts` for moving legacy inline attachment bytes into
the blob store retroactively).

**Restoration** (`connectome-ts/src/persistence/restoration.ts`): on boot, the host
loads the latest snapshot, deserializes `VEILState` (facets, streams, agents, sequence,
removals — `restoreVEILState`, lines 21-70), rebuilds `currentStateCache`
(`veilManager.rebuildStateCache()`, line 69), then restores the `Space`'s component
tree (`restoreSpace`, lines 224-255, using a `ComponentRegistry` keyed by class name —
components not registered there throw fatally on restore, line 191). In-flight
scripts/tool-calls that were `running`/`blocked`/`pending` at crash time are marked
`error` on restore, since Lua/script state cannot survive a restart
(`restoration.ts:133-140, 149-155`). Frame history itself (beyond what's in the latest
snapshot's fragment) is lazily reloaded from frame buckets via `FrameBucketStore.
loadFrames()`/`getFrameRange()` as needed, not eagerly.

`MAX_FRAME_HISTORY` (default 50,000, `grpc-main.ts:52`) caps in-RAM frame history;
`MIN_FRAMES_PER_STREAM` (default **5**, dropped from 30 — a comment records why:
with 100+ streams, protecting 30 message-frames each inflated `state.facets` past the
gRPC 64MB frame limit, "the 428 MB get_streams incident", `grpc-main.ts:47-53`).

### 1.3 The gRPC server — every RPC

Proto: `connectome-grpc-common/proto/connectome.proto` (374 lines), service
`ConnectomeService` (lines 12-48). Server scaffolding in
`connectome-grpc-common/src/server.ts` (grpc-js `Server`, 64MB max send/receive message
size — up from the 4MB default, explicitly to allow large rendered contexts,
`server.ts:236-243`; keepalive: `grpc.keepalive_permit_without_calls=1`,
`grpc.http2.min_ping_interval_without_data_ms=10000`, same lines). Handlers are wired
into connectome-ts in `connectome-ts/src/grpc/server.ts:createGrpcServer()`.

| RPC | Carries | Server-side handler |
|---|---|---|
| `Health` | client_id → healthy, current_sequence, active_streams, active_agents, uptime_ms | `grpc/server.ts:75-84` |
| `EmitEvent` | a `SpaceEvent` (topic, source, JSON payload, priority, metadata, sync flag) + `wait_for_frame` → `FrameResult` (deltas) | `grpc/handlers/event-handler.ts` (646 lines — see §1.4) |
| `SubscribeToFacets` | filters (types/aspect-match/attribute-match), `include_existing`, `from_sequence` (resume point), `stream_ids` → **server-streaming** `FacetDelta` | `grpc/handlers/subscription-handler.ts` — subscribes to `VEILStateManager`'s own change emitter, converts only the *latest* frame's deltas per tick (`subscription-handler.ts:94-112`), buffered server-side against slow consumers (`BufferedDeltaWriter`, drops oldest past 1000 queued, `grpc-common/src/server.ts:27-70`) |
| `RegisterAgent` | agent_id/name/type/capabilities/metadata → session_token (in-memory only — wiped on server restart, `grpc/server.ts:62-70,326`) | `grpc/server.ts:96-139` |
| `GetContext` | agent_id, stream_id, max_frames, max_tokens, facet_types, include_unfocused → JSON `context_json` blob + token/frame counts | `grpc/handlers/context-handler.ts` (see §1.4 — this is the load-bearing one) |
| `CreateStream` | stream_id, stream_type, metadata, optional parent_stream_id → idempotent create-or-join, records fork sequence | `grpc/server.ts:152-195` |
| `GetStateSnapshot` | sequence (0=current), facet_types/stream_ids filters → full facet/stream/agent listing at that sequence | `grpc/server.ts:198-246` |
| `GetFrames` | from/to sequence, limit, stream_ids → raw frame list | `grpc/server.ts:249-283` |
| `ActivateAgent` | agent_id, stream_id, reason, priority, metadata → **pre-renders context server-side** and pushes it as two new VEIL facets (`agent-activation` + `rendered-context`) in one atomic frame, rather than returning it to the caller | `grpc/server.ts:286-384` — this is the mechanism bot-runtime actually consumes (§6.1) |
| `PutBlob` | client-streaming: first message a header (content_type/filename/size hint), then raw chunks → sha256 blob_id, dedup flag | `grpc-common/src/server.ts:565-615`, storage `connectome-ts/src/persistence/blob-store.ts` |
| `GetBlob` | blob_id → server-streaming: header message then 256KB chunks (`BLOB_CHUNK_SIZE`, `grpc-common/src/server.ts:184-185`), backpressure-respecting (`await drain`, lines 646-653) | `grpc-common/src/server.ts:622-662` |

mTLS is opt-in per-service (`GRPC_TLS` env, `ServerCredentials.createSsl(...)` when all
three cert paths are present, else insecure — `grpc-common/src/server.ts:262-272`; same
pattern in `connectome-axon-binding/src/server.ts:147-157`).

### 1.4 EventHandler and ContextHandler — the two things that matter most

**EventHandler** (`connectome-ts/src/grpc/handlers/event-handler.ts`) turns raw
platform events into VEIL facets so `GetContext` can find them:

- `discord:message` / `signal:message` → new `event`-type facet, id
  `msg-discord-<messageId>` / `msg-signal-<senderId>-<timestamp>` (deterministic —
  needed so reactions can look the message back up), idempotent against duplicate
  emits from multiple bots seeing the same platform event (lines 112-144, 178-206ish).
- `discord:messageUpdate` → `rewriteFacet` on the same id, replacing `content` and
  stamping `editedAt` (lines 147-163). `discord:messageDelete` → `removeFacet` (lines
  166-175). No equivalent Signal delete/edit topic exists in the receptor set found
  (Signal's protocol doesn't expose message edits/deletes the way Discord's does).
- **🫥 redaction** (event-handler.ts:396-513): a single-purpose reaction channel.
  `discord:reaction` / `signal:reaction` / `web:reaction` events are inspected for
  `payload.emoji === '🫥'` (U+1FAE5) — every other emoji is ignored server-side
  (line 412-417, comment explicitly invites "future reactions can hook here"). On
  match, the target message facet (looked up by a per-platform deterministic id, with
  a `speechAliasMap` fallback for **bot-authored** messages, which live under
  `speech-<eventId>` ids rather than `msg-<platform>-*` — populated by an
  `agent:speech:delivered` event the axon's speech-effector emits after a successful
  platform send, lines 40-70, 375-393) gets `state.hiddenFromContext` flipped based on
  whether *any* user currently holds the reaction (`hiddenReactors: string[]`, lines
  459-490) — an add/remove-symmetric, multi-user-safe toggle. The facet is **not**
  deleted or hidden from storage/snapshots/search — only `ContextHandler` (§ below)
  skips it when building what an LLM sees (`context-handler.ts:203-205, 401`).
- Attachments arrive already as content-addressed blob refs (axons upload bytes via
  `PutBlob` before emitting) or, on the legacy path, inline bytes/base64 — the `Facet.
  attachments[].blobId | inline_data | url` oneof, proto `connectome.proto:167-178`.

**ContextHandler** (`connectome-ts/src/grpc/handlers/context-handler.ts`, 473 lines) is
**the** rendering path every production bot actually uses. It does **not** go through
`connectome-ts/src/hud/*` (frame-tracking-hud.ts — 1897 lines — context-transform.ts,
frame-extraction.ts): that HUD pipeline is used only by connectome-ts's own in-process
agent path (`src/agent/basic-agent.ts`, `agent-component.ts`, the debug server,
examples — confirmed by grepping every importer of `hud/`, none of which are outside
`connectome-ts/` itself or `connectome-agent-core/src/veil-context-adapter.ts`, which is
its OWN separate/parallel rendering path — see §5.2's "two context paths" note).
Instead, `ContextHandler.buildContext()` hand-builds a plain JSON object directly from
frame deltas and the live facet map:

1. Collects frames in two passes — direct-stream frames and same-fork-point parent-
   stream frames first (a hard priority), then backfills remaining budget with
   "ambient" (no-`activeStream`) frames, so a busy unrelated stream can't crowd out a
   quiet channel's own history (`context-handler.ts:74-125`).
2. Replays `addFacet`/`rewriteFacet`/`removeFacet` deltas per-facet-id across those
   frames (so a Discord edit shows its **final** content, not the original —
   `context-handler.ts:305-329`), applies the 🫥 redaction filter, and maps `event`/
   `speech`/`thought`/`action` facets to `{role, content, timestamp, metadata}`
   entries — `role` for another agent's speech is `user` with a `<name>` prefix
   (own-speech detection matches by `agentId` OR `agentName`, since axons emit
   `agentId=<bot display name>` while the registry uses a different generated id —
   `context-handler.ts:242-278`).
3. `state`/`ambient`/`config` facets are separately scanned into a `context.state{}`
   map (only from the live facet Map, not frame deltas — deliberately, to avoid
   re-surfacing orphaned facets from trimmed-out frames, `context-handler.ts:351-382`).
4. `maxTokens` trimming is a coarse fallback chain: drop internal thoughts → shift
   oldest messages → clear state → truncate remaining message bodies to 500 chars
   (`context-handler.ts:424-454`) — token counting itself is `chars/4`
   (`estimateTokens`, line 38-40), not a real tokenizer.

`ACTIVATION_CONTEXT_MAX_FRAMES` (env, default 400) is the frame budget for the
**server-side pre-render** that `ActivateAgent` triggers — resolved per-activation with
a metadata override (`!mcf`) clamped to [10, 2000] (`grpc/server.ts:36-46`). This is
distinct from `GetContext`'s own `max_frames` parameter, which a caller can set
directly (used when a bot pulls context outside the activation flow, e.g. via the
`streams` tool — bot-runtime `src/tools/streams-tool.ts`).

### 1.5 Spaces, components, FLEX ordering

`Space` (`connectome-ts/src/spaces/space.ts`) hosts `Component`s
(`spaces/component.ts`) which implement receptor/effector/transform roles against
`ISpaceEvent`/`VEILDelta` (types re-exported from `connectome-axon-interfaces`, not
redefined — `connectome-ts/src/spaces/receptor-effector-types.ts` composes with
`connectome-axon-interfaces/src/veil.ts`'s `IVEILComponent`/`IInteractiveComponent`).
"FLEX ordering" (named in `AGENTS.md`) is a topological-sort-based execution order
(`connectome-ts/src/spaces/ordering/topological-sort.ts`,
`constraint-graph.ts`) driven by per-component priority constraints
(`spaces/constraints.ts`, e.g. `ComponentPriority.MAINTAINER` used by
`PersistenceMaintainer`, `persistence-maintainer.ts:25`) — components declare ordering
constraints relative to each other rather than a hardcoded list, so a receptor always
runs before the effectors/maintainers that depend on its output within one frame.

### 1.6 Debug UI

`connectome-ts/src/debug/debug-server.ts` (1053 lines) serves an HTTP+WS debug
interface on `DEBUG_PORT` (default 3015, `grpc-main.ts:55`), gated by `DEBUG_ENABLED`
(default false). Mapped in docker-compose (`connectome` service, `"3015:3015"`) but
`DEBUG_ENABLED` is not set anywhere in the committed compose (defaults false) — so it's
present but off by default in this deployment; not verified live on sfo whether it's
been toggled on (would show as a listening port inside the `connectome` container).

## 2. connectome-grpc-common

Shared scaffolding both connectome-ts and every axon depend on
(`connectome-grpc-common/src/server.ts` base `ConnectomeServer`/`BufferedDeltaWriter`,
`client.ts` — 864 lines — the `ConnectomeClient` used by every axon and bot-runtime).
Notable client methods beyond the obvious RPC wrappers: `subscribe()`
(`client.ts:298-378`) wraps `SubscribeToFacets` with **auto-reconnect** (exponential
backoff, capped 30s, jitter — lines 364-368) and **sequence-resume** (`lastSequence`
tracked client-side, replayed as `fromSequence` on reconnect so a dropped stream
doesn't silently miss deltas — lines 305-311). Serialization helpers
(`serialization/facet-serializer.ts`, `event-serializer.ts`, `attachment-handler.ts`)
convert between the JS `Facet`/`SpaceEvent` shapes and proto wire messages. GlitchTip/
Sentry error tracking is initialized once per process via `initErrorTracking()`
(`connectome-grpc-common/src/sentry.ts:3-35`), reading `SENTRY_DSN` or falling back to
`GLITCHTIP_DSN` — called at the top of every service's main entrypoint (e.g.
`connectome-ts/src/grpc-main.ts:10-11`, `discord-axon/src/grpc-main.ts:17-18`, same
pattern in signal/web/telegram/whatsapp-axon). `mcp/mcp-manager.ts` (398 lines) is the
generic MCP client pool bot-runtime uses (stdio/SSE/streamable-HTTP transports,
`mcp-manager.ts:1-49`) — one connection pool shared by every configured server for a
bot.

## 3. Axon binding — the credential-advertisement side-channel

Proto: `connectome-axon-binding/proto/axon-binding.proto` (50 lines). Purpose stated in
the file header: "Secrets never transit the Connectome server" — Discord tokens/Signal
phone numbers flow **bot-runtime → axon directly**, bypassing connectome-ts entirely.

- `AxonBindingServer` (`connectome-axon-binding/src/server.ts`, 179 lines) runs
  **inside each axon process**, holding bindings in an in-memory
  `Map<"platform:agentName", AxonBinding>` (line 22-23) — nothing is persisted; a
  restarted axon starts with zero bindings and waits for the next bot-runtime
  keepalive. `AdvertiseBinding` only emits a `binding:added` event (which the axon
  wires to actually log the bot into Discord/Signal) when the key is **new**
  (`server.ts:98-104`) — repeat keepalives are silently ack'd. `forgetBinding()`
  (lines 47-65) exists specifically as a **self-healing retry hinge**: a documented
  incident (`server.ts:53-58`) had one bot sit mute on Discord for 23 days because a
  single gRPC timeout during the advertise call meant the axon never retried adding
  it, even though bot-runtime kept re-advertising every 30s. Consumers must call
  `forgetBinding()` whenever *their* attempt to add the bot fails, converting the
  existing keepalive loop into the retry mechanism (no new timer needed).
- `AxonBindingClient` (`src/client.ts`) is instantiated **inside bot-runtime**
  (`bot-runtime/src/bot-runtime.ts:16,1086-1153`) — one client per platform binding,
  with its own independent retry-then-30s-keepalive loop
  (`advertiseWithRetry`/`bot-runtime.ts:1080-1153`; the literal `30_000` at line 1150).
- **Ports**: 50052 (discord-axon), 50053 (signal-axon), 50056 (web-axon) — all set via
  `AXON_BINDING_PORT` env per-service in docker-compose, all started the same way in
  each axon's `grpc-main.ts` (`discord-axon/src/grpc-main.ts:20,61,267-270`;
  `signal-axon/src/grpc-main.ts:21,72,349-352`; `web-axon/src/grpc-main.ts:20,50,
  416-419`). **The proto's own comment only names Discord and Signal**
  (`axon-binding.proto:24`), but in practice **web-axon uses the same binding
  protocol** — `bot-runtime/src/bot-config.ts:607-611` unconditionally builds a `web`
  binding whenever `WEB_AXON_HOST` is set (no token/credential required, since web has
  none), and `web-axon/src/grpc-main.ts` imports and starts `AxonBindingServer` exactly
  like the other two. Telegram/WhatsApp axons import it too
  (`telegram-axon/src/grpc-main.ts`, `whatsapp-axon/src/grpc-main.ts` both reference
  `AxonBindingServer`) but are not deployed (§7).
- **No authentication** on `AdvertiseBinding` beyond network reachability — anything
  that can reach `discord-axon:50052` (etc.) on the internal Docker network can claim
  any `agent_name`. This is by design given `grpc-internal` is air-gapped from the
  internet, but it means the axon trusts the docker network boundary entirely; mTLS is
  available (same `tls: {caCertPath,certPath,keyPath}` config shape as the main gRPC
  service, `connectome-axon-binding/src/types.ts:16-30`) but off unless `GRPC_TLS=true`
  is threaded through — it is **not** wired to the compose `GRPC_TLS` env var anywhere
  found in the axon binding call sites (bot-runtime's `advertiseWithRetry` constructs
  `AxonBindingClient` with only `{host, port}`, no `tls` — `bot-runtime.ts:1100` — so
  binding-channel mTLS would need to be added explicitly if desired; today it rides
  bare on the internal network only).

`connectome-axon-interfaces` (`src/core.ts`, `events.ts`, `manifest.ts`,
`persistence.ts`, `veil.ts`) is a separate, unrelated concept: shared TypeScript
interface contracts (`IComponent`, `ISpaceEvent`, `IAxonManifest`,
`IVEILComponent`/`IInteractiveComponent`) that the **legacy, non-gRPC** axon-module
system (`IAxonManifest.hotReload`, `IAxonEnvironment`) and connectome-ts's component
types both build on. `manifest.ts`'s `IAxonManifest` is a *code-hot-reload* manifest
(name/version/main/componentClass/hotReload/hash) — not the same thing as
credential-advertisement.

`axon-server` (`@connectome/axon-server`, `AxonModuleServer` class,
`axon-server/src/axon-module-server.ts`) is an HTTP+WS server that transpiles and
serves TypeScript axon-module source over the wire with hot-reload notifications
(`axon-module-server.ts:180-226` — an esbuild `transformSync` on every module fetch,
plus a `/ws/hot-reload` WebSocket). **This is dead code in production.** It is still a
declared dependency and imported by each axon's *legacy* entrypoint
(`discord-axon/src/server.ts:28`, `signal-axon/src/axon-main.ts:21`), but the
Dockerfiles' `CMD` runs `src/grpc-main.ts`, not `server.ts`/`axon-main.ts`
(`docker/discord-axon.Dockerfile:85`, `docker/signal-axon.Dockerfile:85`,
`docker/web-axon.Dockerfile:70` all `CMD ["node","--import","tsx","src/grpc-main.ts"]`)
— confirmed no `grpc-main.ts` in any axon imports `AxonModuleServer` or
`@connectome/axon-server` (only the legacy `server.ts`/`axon-main.ts`/
`axon-modules/index.ts` do). The `8082`/`8092` "AXON module server (if needed)" ports
in docker-compose are `EXPOSE`d by the Dockerfile but nothing binds them at runtime
under the live `CMD`.

## 4. discord-axon and signal-axon — the deployed, feature-complete axons

Both run multi-bot: one gRPC client + platform session per bot, all sharing one axon
process (`discord-axon/src/grpc-main.ts`, `signal-axon/src/grpc-main.ts`). Boot order in
both: start `AxonBindingServer` first (so bot-runtimes can start advertising
immediately) → load any startup-batch tokens/phones from env → for each discovered
bot, log into the platform, register with connectome (`RegisterAgent`), wire up
receptors/effectors, subscribe to that bot's speech/action facets
(`discord-axon/src/grpc-main.ts:264-270` binding-server-first comment; equivalent
`signal-axon/src/grpc-main.ts:346-352`).

### 4.1 Dispatch — how a bot decides to respond

| Signal | Default (compose) | Comparison logic | Citation |
|---|---|---|---|
| Mention / reply-to-bot | always activates | exact match on resolved user id | `discord-axon/…/discord-message-receptor.ts:404-416` |
| DM | always activates, no mention needed | — | `discord-message-receptor.ts:411-415` |
| `RANDOM_REPLY_CHANCE` | discord/signal **1000**, web **0** | `randomChance>0 && Math.floor(Math.random()*randomChance)===0` — **inverse probability**: N=1 is 100%, N=1000 is 1-in-1000, **0 disables it** (guarded, not a divide-by-zero) | `discord-message-receptor.ts:420-429` (log line literally prints `1/${randomChance}`) |
| `MAX_BOT_MENTIONS` ("bot-to-bot budget") | discord/signal **1**, web **3** | per-**stream** counter, incremented each time a bot-authored message triggers another bot's activation, reset to 0 on the next **human** message in that stream; `<=0` disables the cap | `discord-message-receptor.ts:110-114, 449-458` |
| Autotrigger | off by default | `!autotrigger [on\|off]` toggles a loop that keeps reactivating the bot after each cycle **only if** the bot calls the `continue_substream` tool that cycle — no call, loop ends (prevents mode-collapse loops) — `--max-speech-only <N>` (default 5) ejects after N consecutive no-tool-use cycles | `bot-runtime/src/tools/continue-substream-tool.ts:1-11`, help text `discord-axon/…/discord-command-effector.ts:187-192` |
| Substreams (`!stream in/out`) | — | bot's activations redirect into a `substream:<name>` stream (parent-linked, full history); a `SubstreamRelayEffector`/`SignalSubstreamRelayEffector` mirrors substream speech/action back to the originating channel as quoted relay lines | `discord-axon/…/substream-relay-effector.ts:1-20` |

### 4.2 `!` commands — full inventory, and where the two axons actually diverge

Both axons parse `!`-prefixed messages in a **command effector** that returns a
response string **before any VEIL event is emitted** — `!` commands are never stored
in frame history on either platform (`discord-command-effector.ts:64-138`,
`signal-command-effector.ts` same shape). `AGENTS.md`'s command table (in this repo)
is **incomplete** — the actual `switch` in each effector additionally implements
`!h-default`, `!secret`, `!tts`, and `!sysprompt`, none of which appear in `AGENTS.md`'s
list:

| Command | Discord | Signal | Notes |
|---|---|---|---|
| `!help` `!rr` `!bb` `!mcf` `!mmf` `!mt` `!h-default` `!stop` `!steer` `!autotrigger` `!stream` `!secret` `!tts` `!sysprompt` | yes | yes | `discord-command-effector.ts:94-134`, `signal-command-effector.ts:98-140` |
| `!split` | **no** | **yes** | Signal-only — configures outbound chunk length at runtime (Signal's practical message length is far smaller than Discord's 2000-char hard cap, so Discord has no equivalent knob) — `signal-command-effector.ts:119` |

This directly contradicts `AGENTS.md`'s claim that "Both Discord and Signal axons
support the same command set." `!continue` / `m continue` / `m go` / `m more` are
**not** in either command-effector's switch at all — they're intercepted one layer
earlier, in the **message receptor**, before the command-effector or any VEIL emission
ever runs:

- Discord (`discord-message-receptor.ts:124-149`): regex-matches
  `/^!continue\b/i|/^m\s+(continue|go|more)\b/i`, **deletes the triggering Discord
  message** (`message.delete()`, line 131), then calls `ActivateAgent(...,
  continuation:'true')` directly — the trigger text never becomes a `discord:message`
  event, so it never reaches VEIL at all.
- Signal (`signal-message-receptor.ts:227-260`): same regex, same early
  `ActivateAgent(..., continuation:'true')` call, but **does not** delete anything —
  Signal has no message-delete-as-bot capability; the comment is explicit that the
  early return (never emitting the event in the first place) is what keeps it out of
  VEIL, not a delete-after-the-fact (`signal-message-receptor.ts:246-247`).
- `connectome-agent-core/src/connectome-agent.ts:847` additionally filters any
  `m continue`-shaped **user**-role message out of the prefill conversation log it
  builds for `runDirectPrefill()` (comment: "signal doesn't delete them") — this
  appears to be defense-in-depth for an edge case (e.g. a message that slipped through
  before this fix, or one not caught by the receptor's own regex) rather than the
  primary mechanism; the primary mechanism on both platforms is the early return above.

`!continue` itself, once triggered, drives `ConnectomeAgent.runDirectPrefill()`
(`connectome-agent-core/src/connectome-agent.ts:808-894`): builds a conversation log
from the last 5 VEIL messages with participant labels, then frames it as a CLI
simulation — `<cmd>cut -c 1-N < untitled.txt</cmd>` / assistant turn holding the full
log / `<cmd>cut -c N+1- < untitled.txt</cmd>` — and calls the Anthropic/Bedrock API
**directly**, bypassing pi-agent's own tool loop entirely (Bedrock gets a native
prefill shape; direct Anthropic gets the CLI-framed tail-cut variant, with an added
"You are Claude Code" system-prompt line under OAuth — lines 866-894).

### 4.3 Reactions, edits, deletes, attachments, typing, TTS, splitting

| Feature | Discord | Signal |
|---|---|---|
| Reactions → VEIL | `DiscordReactionReceptor` (`discord-reaction-receptor.ts`, full file) listens `messageReactionAdd`/`Remove`, cross-bot-deduped (10s TTL keyed on message+user+emoji+direction, `:14-42`), emits `discord:reaction` | Reactions arrive inline in the Signal WebSocket's `dataMessage.reaction` field (`signal-websocket-receptor.ts:247-357`), forwarded as `signal:reaction` — no separate dedupe cache found for signal reactions (message-level dedupe exists, reaction-level doesn't) |
| 🫥 redaction | server-side, identical mechanism both platforms — see §1.4 | same |
| Edits | `discord:messageUpdate` → `rewriteFacet` (event-handler.ts:147-163) | **no equivalent found** in `signal-message-receptor.ts` — Signal's protocol doesn't surface edits the same way |
| Deletes | `discord:messageDelete` → `removeFacet` (event-handler.ts:166-175) | not found |
| Attachments | downloaded from Discord CDN, uploaded to blob store via `PutBlob`, referenced by `blobId` before facet creation (`discord-message-receptor.ts:609-618` region) | same pattern — `uploadAttachmentsToBlobStore()` (`signal-message-receptor.ts:629-660ish`), comment notes "each unique image hits PutBlob" once per bot that reaches this point |
| Typing (inbound, informational) | not modeled as a separate receptor | `SignalTypingReceptor` — logs/forwards to VEIL for state tracking only, explicitly "don't trigger agent activation" (`signal-typing-receptor.ts:1-46`) |
| Typing (**outbound**, bot-is-composing) | yes — on receiving a message that will trigger activation, sends `channel.sendTyping()` and refreshes every 8s (Discord expires typing after 10s), hard safety cap 10 minutes, cleared on final speech delivery or `agent:typing-stop` (`discord-message-receptor.ts:489-507`, cleared in `discord-speech-effector.ts:190-203`) | **no outbound typing indicator in the live gRPC path** — the only `sendTyping`/`sendTypingIndicator` code in signal-axon lives in the legacy, undeployed `axon-modules/signal-afferent.ts` (dead code per §3's `axon-server` finding) |
| TTS | **not an axon feature at all** — synthesis happens bot-side in `connectome-agent-core/src/tts/omnivoice-provider.ts`, attached to the outgoing `agent:speech` event as a normal attachment (blobId); `!tts on/off` just flips a `bot-config` facet (`ttsEnabled`) bot-runtime's effector reads (`discord-command-effector.ts:536-576`, identical `signal-command-effector.ts:441-474`) | same — axon speech-effectors treat a TTS mp3 exactly like any other attachment (comment, `signal-speech-effector.ts:134`: "observed live: a painting PNG + its TTS mp3") |
| Splitting | 2000-char Discord hard cap, split on newline → space → forced (`message-splitter.ts:1-34`) | default 400 chars (`DEFAULT_MAX_LENGTH`, `message-splitter.ts:8`), tries paragraph → sentence → word breaks (`:30-60`); `MAX_MESSAGE_LENGTH=0` (compose default) means "native" — Signal's own "see more" truncation UI handles it, per the compose comment |

Additional discord/signal-only components: `FocusedContextTransform` (both) fetches +
renders per-agent context and injects bot identity into the system prompt, filtered by
stream (`discord-axon/…/focused-context-transform.ts:1-11`); `MessageConsistencyChecker`
(signal only) detects when a targeted bot's independent WebSocket missed a group
message and forces a reconnect+re-inject (`message-consistency-checker.ts:1-11`);
`MessageDeduplicator` (both, near-identical) suppresses N-bots-see-the-same-message
fan-out down to one emit (`discord-axon/src/message-deduplicator.ts:1-10`,
`signal-axon/src/message-deduplicator.ts:1-10`).

## 5. bot-runtime and connectome-agent-core — the standalone agent process

One container per bot (`bot-runtime/src/bot-runtime.ts`, 1495 lines — "pure cognitive
loop: receives activations via gRPC subscription, runs the agent, records speech back
through VEIL. No platform clients," header comment lines 1-11).

### 5.1 Boot and the activation loop

1. Connect to connectome (`ConnectomeClient.connect()`), then `registerAgent()` —
   `bot-runtime.ts:120-140`.
2. Init wallet if configured, connect MCP servers, build the tool list
   (`bot-runtime.ts:142-148` — see §5.4).
3. `subscribeToActivations()` — **not polling**: a single long-lived `SubscribeToFacets`
   stream filtered to `{agent-activation, rendered-context, bot-config,
   agent-command}` facet types, pairing `agent-activation` and `rendered-context`
   deltas by `activationId` (either can arrive first; a 30s TTL map holds the
   unpaired half) and calling `fireActivation()` once both are present
   (`bot-runtime.ts:344-416`). This is the **push mechanism** that replaces polling —
   `ConnectomeClient.subscribe()` (`connectome-grpc-common/src/client.ts:298-378`)
   already provides auto-reconnect + resume-from-sequence; bot-runtime layers a 60s
   heartbeat on top as a secondary safety net against the case where the transport
   *looks* alive but the server has gone unreachable (`bot-runtime.ts:422-438`,
   comment explains why sequence-comparison isn't used: the subscription is
   type-filtered, so the global sequence and this stream's own delta count diverge
   normally).
4. Axon-binding advertisement: for each binding built from env
   (`bot-runtime/src/bot-config.ts:573-620` — `DISCORD_TOKEN`+`DISCORD_AXON_HOST` →
   discord binding, `SIGNAL_PHONE`+`SIGNAL_AXON_HOST` → signal, **`WEB_AXON_HOST` alone
   → web binding, unconditionally, no credential required**), `advertiseWithRetry()`
   attempts up to 10 times (backoff capped 15s) then keeps a 30s keepalive interval
   running for the life of the process (`bot-runtime.ts:1080-1153`).
5. Speech goes back out via `EmitEvent('agent:speech', …)` (`bot-runtime.ts:849,875,
   1000,1018`) — the matching axon's speech-effector, subscribed to that stream's
   speech/action facets, is what actually delivers it to the platform.

### 5.2 ConnectomeAgent — the pi-agent wrapper, and the two context paths

`connectome-agent-core/src/connectome-agent.ts` (1259 lines) wraps **pi-ai**
(`@earendil-works/pi-ai`, imported via its `/compat` static-catalog subpath because
pi-ai 0.80 moved `getModels`/`streamSimple` off the package root —
`connectome-agent-core/src/model-resolver.ts:20-27`) — "pi-agent" in `AGENTS.md` refers
to this upstream library, not a component written in this repo.

**Two context-rendering paths coexist**, documented explicitly in
`connectome-agent-core/src/types.ts:156-188`:
- **Server-side** (`VEILContextAdapter`, `connectome-agent-core/src/veil-context-adapter.ts`)
  — converts raw VEIL frames/facets directly, used when `ConnectomeAgent` runs
  in-process against a `VEILStateLike` (this is how connectome-ts's own examples/
  debug tooling embed an agent; not what the deployed fleet uses).
- **Client-side** (`GrpcContextProvider` pattern) — calls `GetContext` over gRPC and
  maps the resulting JSON via `renderedContextToAgentContext()`/`resolveAttachmentRefs()`
  (`connectome-agent-core/src/context-adapter.ts:135-298`) into pi-agent's message
  format. **This is what bot-runtime actually uses** — `bot-runtime/src/
  connectome-bridge.ts:13,199-242,514` imports exactly these two functions;
  `VEILContextAdapter` is not referenced anywhere in `bot-runtime/`.

**Model routing** (`connectome-agent-core/src/model-resolver.ts`, full file read):
`resolveModel()` tries pi-ai's own registry first (`anthropic` then `amazon-bedrock`),
falling back to a hand-maintained `PINNED_MODELS` table (lines 50-182) for models
pi-ai 0.80 dropped from its catalog outright (every Claude 3.x entry, several Claude 4
dated snapshots) but that the providers still serve — captured verbatim from pi-ai
0.53's registry so cost/context metadata stays accurate rather than approximated.
Cross-region Bedrock ids (`us.`/`eu.`/`apac.`/`global.` prefix) fall back to the
unprefixed base model, cloned with the prefixed id (lines 211-220). Separate resolver
functions for non-Bedrock routes: `resolveGatewayModel()` builds an
`openai-completions`-API model that routes through **Vercel AI Gateway**
(`ai-gateway.vercel.sh/v1`, used for models like Opus 4 via Vertex whose direct/Bedrock
routes are retired — `model-resolver.ts:242-295`); `resolveOpenRouterModel()` routes
through **OpenRouter** for elder models the first-party API has retired (verified
example in the file: `claude-opus-4-1` 404s direct but answers via
`anthropic/claude-opus-4.1` on OpenRouter, lines 301-353); `resolveLocalModel()`
targets a self-hosted OpenAI-compatible endpoint (llama.cpp/llama-server on a
Tailscale-addressed GPU box for the `plantoid` bot — docker-compose's
`bot-plantoid` service, `PLANTOID_ENDPOINT`/`LOCAL_LLM_API_KEY` env vars,
`model-resolver.ts:369-406`).

**Auth**: `PiAuthProvider` (`connectome-agent-core/src/pi-auth-provider.ts`) reads
`~/.pi/agent/auth.json` (bind-mounted read-write into every bot container,
docker-compose `${HOME}/.pi/agent:/root/.pi/agent`) for OAuth tokens tied to a Claude
subscription (Max/Pro) — `pi login` run once on the host. In **strict mode**, scoped
only to the `anthropic` provider, an unusable OAuth credential throws
(`OAuthUnavailableError`) instead of silently falling through to `ANTHROPIC_API_KEY`
(deliberate — the file header explains a prior silent-fallback bug meant a bot could
run on the metered API key for weeks while believed to be on the subscription,
`pi-auth-provider.ts:1-20`).

### 5.3 RLM — recursive sub-agent capability

`connectome-agent-core/src/rlm/` (barrel: `index.ts:1-3` "RLM (Recursive Sub-Agent)") is
a wrapper around `rawwerks/ypi`'s `rlm_query`/`rlm_parse_json`/`rlm_cost` binaries
(vendored into the bot-runtime image at build time,
`docker/bot-runtime.Dockerfile:30-31,100-103`), giving a bot the ability to spawn a
bounded child-LLM call tree with its own depth/call-count/dollar-budget/wall-clock
guardrails (`rlm/types.ts:16-40`), optional `jj` workspace isolation, and Pi extensions
in children. Exposed to the agent as tools: `rlm_query`, `rlm_check_job`, `rlm_cost`
(`rlm/tools.ts` per the barrel export).

### 5.4 Tools

| Tool | Purpose | Citation |
|---|---|---|
| `attach_file` | Uploads a file to the blob store, queues a sha256 ref that the effector embeds in `agent:speech` as `Attachment.blobId` — bytes only ever travel bot→server (PutBlob) then server→axon (GetBlob), never broadcast through the facet pub/sub | `bot-runtime/src/tools/attach-tool.ts:1-14` |
| `continue_substream` | Bot must call this each cycle to opt into another autotrigger cycle; absence ends the loop | `continue-substream-tool.ts:1-10` |
| `delegate` | Cross-bot task delegation over the existing `agent:activate` pipeline (server creates an `agent-activation` facet; target's `fireActivation()` picks it up) | `delegate-tool.ts:1-8` |
| `enlist` | Peer-to-peer immediate activation of another participant **on the current stream** (vs. delegate's own branched workspace stream) | `enlist-tool.ts:1-7` |
| `init_experiment` / `run_experiment` / `log_experiment` | Autonomous edit→run→measure→keep/discard loop; state reconstructed from `autoresearch.jsonl` each call so it survives context compaction | `experiment-tool.ts:1-9` |
| `inject_secret` | Reads a name from `!secret`-populated `/workspace/shared/secrets/`, pipes the **value** over SSH to a remote `.env` — the LLM only ever sees the name, never the value | `inject-secret-tool.ts:1-8` |
| `paint_inkfield` | Drives the real published InkField app headlessly via `inkfield-bridge`, writes a PNG to shared workspace (see §8) | `paint-inkfield-tool.ts:1-20` |
| `process` | list/poll/log/submit/kill for background processes spawned by `terminal` | `process-tool.ts:1-4` |
| `save_attachment` | Saves an incoming attachment (populated into context by `ConnectomeBridge`) to the bot's workspace | `save-attachment-tool.ts:1-8` |
| `list_streams` / `get_stream_context` | Pull-based cross-stream awareness — peek at another channel's recent conversation on demand | `streams-tool.ts:1-10` |
| `enter_substream` / `exit_substream` / `set_autotrigger` | Programmatic substream/autotrigger control (independent axes — substream = "lives in a named stream", autotrigger = "gets reactivated each cycle") | `substream-tool.ts:1-8` |
| `terminal` | PTY-based (`node-pty`) foreground/background shell execution via the shared `ProcessRegistry`; no per-command sandboxing inside the tool itself — the **container** is the sandbox (seccomp profile + optional Landlock wrapping the whole node process, see §9) | `terminal-tool.ts:1-6`, `process-registry.ts:9,51-92` |
| `get_wallet_info` / `check_balance` / `transfer` / x402 fetch | On-chain balance/transfer/micropayment tools for EVM (viem) and Solana (`@solana/web3.js`) wallets; on-chain state queried live, not mirrored into VEIL | `wallet-tool.ts:1-8,13-20` |

**Sandbox mechanics**: `docker/bot-entrypoint.sh` wraps the **entire** node process in
`landlock-exec` when `LANDLOCK_ENABLED=true` (falls back gracefully on older kernels) —
`exec landlock-exec node --import tsx src/entry.ts` (`bot-entrypoint.sh:6-9`); the
terminal tool itself does no additional per-command restriction. `docker/
landlock-exec.c` applies filesystem Landlock rules (read/execute broadly, deny
write/create/remove outside allowed paths — full ruleset constants at
`landlock-exec.c:27-42`) before `exec()`ing the real command. This is layered under the
docker-compose `security_opt: seccomp=docker/seccomp-bot.json` applied to every
bot-runtime container via the `x-bot-runtime` anchor (`docker-compose.yml:25-26`) — the
live profile (confirmed identical between the committed `docker/seccomp-bot.json` and
the profile actually applied to a running container `[sfo]`) default-allows all
syscalls except a 32-name blocklist (kernel-module load, reboot, swap, mount, time
changes, ptrace, BPF, NUMA/`move_pages` family) plus a namespace-creation block
(`unshare` masked against `CLONE_NEWUSER|CLONE_NEWNET|CLONE_NEWNS`) and three
argument-filtered `socket()` denials: **AF_PACKET** (17, raw packet capture),
**AF_BLUETOOTH** (31), **AF_VSOCK** (40) — comments embedded in the live profile
confirm these exact labels `[sfo]`.

### 5.5 Skills, config

`connectome-agent-core/src/skill-loader.ts` (435 lines) loads `SKILL.md` files
(frontmatter + body, validated name/description) from configured paths and formats
them into a system-prompt fragment. The runtime skills actually shipped
(`skills/*/SKILL.md`): `agent-spawning/{claude-code,collaboration,coordination}` (how
to spawn Claude Code / treat the shared workspace as real / choose local-spawn vs
delegate), `autoresearch` (the experiment-loop tools), `connectome-mcp` (how to read
live VEIL state vs. historical snapshots through the MCP surface), `connectome-ontology`
(VEIL/agent/space conceptual grounding), `economic-operations` (wallet tools),
`platform-commands` (the canonical `!`-command reference — notably documents `!hN
<msg>` per-message trim and the full command list **more completely and more
accurately than `AGENTS.md`** — see §4.2), `veil-delta-repair` (manual recovery
procedure for a broken delta chain on the persistence volume).

`bot-runtime/config.json` holds a `bots[]` array (name, model, per-bot `mcp: string[]`
server-name list, wallet config, tool config) and a top-level `mcp_servers[]` array
(name/transport/url-or-command/args/env, `${ENV_VAR}` interpolation) — the shape
`AGENTS.md`'s "MCP Server Configuration" section documents accurately.

## 6. web-axon, connectome-web-sdk, telegram-axon, whatsapp-axon

### 6.1 web-axon — deployed, but the least feature-complete of the three live axons

`web-axon/src/ws-server.ts` is a bare `ws` `WebSocketServer` (`WEB_AXON_PORT`, default
8080 inside the container, mapped `8085:8080` in compose) — "the 'platform' that
web-axon wraps... Analogous to the Discord gateway or Signal CLI WebSocket" (header
comment, `ws-server.ts:1-6`). Protocol is JSON-over-WebSocket, typed in
`connectome-web-sdk/src/protocol.ts` (client→server: `connect, create_stream, join,
leave, message, typing, get_history, list_streams, set_ambient, react`; server→client:
`welcome, stream_created, stream_joined, speech, typing, typing_stop, agents, error,
user_message, message_ack, history, stream_list`). It **does** support: typing
indicators both directions (`ClientTyping`/`ServerTyping`/`ServerTypingStop`), 🫥
reactions (`ClientReact` — same server-side redaction as Discord/Signal, protocol.ts
comment explicitly says so), and attachments — but **only inline base64** (`ClientAttachment.
data`, protocol.ts:37-46, comment: "omitted for future direct-upload paths" — no
blob-ref upload path from the browser side exists yet). `!` commands
(`web-axon/src/grpc/components/web-command-effector.ts:43-66`): `!help !rr !bb !mcf
!mmf !mt !stop !steer !sysprompt` — **missing** `!h-default`, `!autotrigger`,
`!stream`, `!secret`, `!tts`, and (obviously, no Signal-specific concern) `!split`
relative to Discord/Signal. No edit/delete support found in `web-message-receptor.ts`
or `grpc-main.ts`. Registers with `AxonBindingServer` on port **50056** exactly like
discord/signal (§3).

`connectome-web-sdk` (`src/client.ts`, `protocol.ts`) is a small typed client
(`ConnectomeWebClient`) for the above protocol. **Nothing else in this monorepo
imports `@connectome/web-sdk`** — grepped every `package.json` and every non-
`web-axon`/`connectome-web-sdk` source file for the import specifier, zero hits. No
real browser frontend ships in this repo; the SDK's own types reference a
`clientApp` field (example value `'xenopoem'` in a code comment) implying an external,
not-checked-in consumer.

### 6.2 telegram-axon and whatsapp-axon — written, not deployed

Neither has a `docker/*.Dockerfile`, and both service blocks in `docker-compose.yml`
are fully commented out (`docker-compose.yml:337-365` whatsapp,
`:371-396` telegram; corresponding `*_AXON_HOST` lines in the bot-runtime env anchor
are commented `:54-57`) — confirmed no drift between the committed file and what's
live on sfo (`git diff` clean `[sfo]`), and neither container appears in `docker ps`
`[sfo]`. Both are structurally complete, not stubs: full `grpc-main.ts`,
`bot-instance.ts`, `client.ts`, `stream-manager.ts`, command-effector,
message-receptor, speech-effector, message-deduplicator, mention-resolver,
message-splitter, speech-cleanup, and real dependencies (`grammy ^1.41.0` for
Telegram, `@whiskeysockets/baileys 7.0.0-rc.9` for WhatsApp — both real, current
libraries, not placeholders). **WhatsApp is the more mature of the two**: it alone has
`whatsapp-connection-receptor.ts` (Baileys session lifecycle),
`whatsapp-receipt-receptor.ts`, `whatsapp-typing-receptor.ts`, and a dedicated
`rate-limiter.ts` util — none of which telegram-axon has any equivalent of. Verdict:
**written but never deployed**, WhatsApp closer to production-ready than Telegram.
Completeness ranking for a port designer: discord/signal (full feature set, deployed) >
whatsapp (full component set, undeployed) > telegram (full component set but thinner,
undeployed) > web (deployed but deliberately minimal — no edits/deletes, inline-only
attachments, smaller command surface).

## 7. connectome-mcp

`connectome-mcp/src/http-server.ts` exposes MCP over **Streamable HTTP**
(`POST /mcp` JSON-RPC, `GET /mcp` SSE, `DELETE /mcp` session end —
`http-server.ts:6,19,26,64,89`) on port 3100. Full tool list from `src/tools.ts`
(28 tools, `CONNECTOME_TOOLS` array): `health, get_streams, get_agents, get_speech,
get_events, get_facets, get_context, get_frames, emit_event, workspace_{list,read,
search,write,delete}, snapshot_{list,inspect,events,frames,export,search},
docker_{status,logs,restart,rebuild_all,stop_bots,diagnose}`. **`AGENTS.md`'s own tool
list omits `emit_event` and `snapshot_export`**, both present in code. `docker.ts`
shells out to real `docker compose` commands (`docker compose up -d`, `--build`,
`--force-recreate`) against `COMPOSE_DIR=/opt/connectome`
(`connectome-mcp/src/docker.ts:15,222-244`) — the compose service mounts `.:/opt/
connectome:ro` (read-only bind of the whole repo) **and** `/var/run/docker.sock:...:ro`
(docker-compose.yml:158-159). The `ro` mode on the socket bind only prevents the
container from overwriting the socket file — it does **not** narrow the Docker Engine
API surface reachable through it; a container with this mount can still start, stop,
rebuild, and inspect every other container on the host. This is a materially
privileged mount and should be called out explicitly to anyone porting this container.

## 8. inkfield-bridge

A generic "drive a headless-browser render job, deliver the output to the shared
workspace" pattern — `inkfield-bridge/server.js` never self-hosts the third-party
engine it wraps (deliberate license-compliance design documented in
`inkfield-bridge/README.md:7-58`: driving the real published web app over the network
via its own documented agent-facing hooks, vs. bind-mounting/vendoring the engine,
which the upstream license reserves). Two HTTP surfaces: `POST /render` (three input
modes — a simplified stroke plan, a full raw recording, or a `workspacePath` into the
shared workspace) and `GET/POST /inbox` (a human drop-page that lands files into
`shared-workspace/…/inbox/` for a bot to find via `workspace_list`/`workspace_search`).
Architecture is queue/rate-limit/coalesce/circuit-breaker around a "dream lane" (GPU
worker over Tailscale, `INKFIELD_DREAM_WORKER_URL`) with local-headless-Chromium
fallback (README.md:105-141). **Rollout-status discrepancy worth flagging**: the
README (`README.md:389-391`) says this is "Live only on bot-opus-46 today... not in
the shared `&bot-env` anchor," but the committed `docker-compose.yml` has
`INKFIELD_BRIDGE_URL` **inside** the shared `&bot-env` anchor
(`docker-compose.yml:60-62`) with a comment reading "Rolled out to all bots after a
single-bot pilot on bot-opus-46" — i.e. the doc and the compose file disagree about
current rollout scope; the compose file is more likely current (it's the thing that
actually governs every bot container's environment) but this should be verified, not
assumed, before a port carries either claim forward.

## 9. docker-compose — every service

| Service | Runs from | Networks | Notable |
|---|---|---|---|
| `connectome` | source (`tsx`) | `grpc-internal` only — **air-gapped, zero internet** | ports 50051 (gRPC), 3015 (debug, off by default); `NODE_OPTIONS=--max-old-space-size=8192` (raised for large snapshot restores, comment cites a specific 5163-frame/433-snapshot incident — **now stale**: live volume has 590 snapshots at sequence ~381,183, `[sfo]`) |
| `connectome-mcp` | **compiled `dist/`** (only service that doesn't run from source) | `grpc-internal` + `external` | docker.sock + repo bind mounts, see §7 |
| `inkfield` | source | `grpc-internal` + `external` | no InkField vendored (§8) |
| `signal-axon` | source | `grpc-internal` + `external` | ports 8082 (dead axon-server port), 50053 (binding) |
| `discord-axon` | source | `grpc-internal` + `external` | ports 8092→8082 (dead), 50052 (binding) |
| `web-axon` | source | `grpc-internal` + `external` | ports 8085→8080 (WS), 50056 (binding) |
| `whatsapp-axon`, `telegram-axon` | — | — | fully commented out (§6.2) |
| `bot-*` (21 services via `x-bot-runtime` anchor) | source, non-root `coder` user | `grpc-internal` + `external` | `read_only: true`, seccomp, tmpfs on `/tmp` `/home/coder` `/root/.npm` `/root/.cache` `/root/.ssh`; each exposes only `127.0.0.1:91xx:8000` (not reachable off-box); `LANDLOCK_ENABLED` opt-in |
| `glitchtip` + `glitchtip-db` | image | `external` | error tracking, port 8090 |
| `signal-cli` | image (`bbernhard/signal-cli-rest-api:0.99`, with a bind-mounted **override** of the bundled signal-cli binary to a locally-built 0.14.5, fixing an upstream NPE — `docker-compose.yml:738-744`) | `external` | port 8080 |

**Volumes**: `connectome-state` (VEIL persistence, §1.2/§11), `shared-workspace`
(cross-bot filesystem), `bot-config-overrides` (per-bot `!sysprompt override`
persistence — written rw by axon command-effectors, mounted **read-only** into
bot-runtime containers so a bot's own `terminal`/`process` tools cannot corrupt or
delete it, `docker-compose.yml:70-76,229-230`), `glitchtip-db-data`,
`glitchtip-uploads`. **Networks**: `grpc-internal` (`internal: true` — Docker enforces
no outbound internet from this network), `external` (Discord/Signal/LLM-provider/
error-tracking egress). Building/rebuilding: every axon + bot-runtime + connectome
Dockerfile does a **self-contained** multi-stage build (own scratch `pnpm-workspace.yaml`/
`turbo.json` written inline, only the packages that service actually needs copied in —
no shared build context across services) via `pnpm turbo run build --filter=<pkg>`;
`docker/bot-runtime.Dockerfile` additionally vendors `landlock-exec` (compiled
statically from `docker/landlock-exec.c`), `rlm_query`/`rlm_parse_json`/`rlm_cost`
(cloned from `rawwerks/ypi`), the `claude` CLI itself, and `uv` — all baked into the
image, not fetched at runtime. Rebuild path: `docker_rebuild_all` (connectome-mcp tool)
or manual `docker compose build && docker compose up -d`.

## 10. scripts/ and skills/ (development, not runtime)

`scripts/glitchtip-entrypoint.sh` waits for GlitchTip's web server then idempotently
creates the Django superuser from env vars. `scripts/glitchtip-setup.sh` is a one-time
post-boot script (org/projects/DSN/API-token creation via GlitchTip's session-auth
browser API). `scripts/setup-wallet.sh` generates Solana/EVM keypairs, encrypts them
under a file-based `WALLET_MASTER_KEY` (never an env var, specifically so `terminal`/
`process` tools can't read it via `env`), and patches `.env`/`bot-runtime/config.json`.
`scripts/ping-opus-4-vertex.sh` is a manual diagnostic for the Vercel-AI-Gateway→Vertex
route to a retired Bedrock model. `.agents/skills/` (development-time, not covered
here) vs. `skills/` (runtime, loaded into bot system prompts, §5.5) are two distinct
directories serving two different audiences.

## 11. The state volume today — live findings `[sfo]`

`connectome_connectome-state` is a Docker **named volume**, driver `local` — its
`_data` directory (`/var/lib/docker/volumes/connectome_connectome-state/_data`) is a
plain bind-mount path on the box's root filesystem (`findmnt` shows source
`/dev/sda[/connectome-state/_data]`, fstype ext4) — **not** a separately-provisioned
block device; it shares the same 100GB root disk as everything else on the box (44GB
used / 51GB available at read time). Total volume size: **44GB**. Breakdown:

| Directory | Size | Count |
|---|---|---|
| `snapshots/` | **38GB** (86% of the volume) | 590 files |
| `frame-buckets/` | 4.2GB | 256 shard dirs |
| `deltas/` | 982MB | 248,970 files |
| `blobs/` | 423MB | 254 shard dirs |

Snapshots dominate despite the fragment-snapshot design (§1.2) intending to bound
per-snapshot size — 590 snapshots averaging ~65MB each suggests either very large
per-snapshot VEIL-state serialization (facet map, not frame history, since fragments
only carry incremental frames) or infrequent full (non-fragment) snapshots re-copying
substantial state; not root-caused on this pass, flagged for the port designer as
something to profile before assuming fragment snapshots keep this bounded at scale.
Frame-buckets' oldest file mtimes predate the volume's own Docker-level `CreatedAt`
(2026-09-16) by months, consistent with the volume having been restored/rsynced from
an earlier backup rather than built up fresh since creation — also not confirmed
further on this pass. Other unrelated volumes exist on the same box
(`connectome_ari-memories`, `connectome_whatsapp-auth-state` — the latter orphaned
now that the whatsapp-axon service block is commented out) but were not investigated;
they fall outside this stack's live compose config.

## 12. Auxiliary, standalone infrastructure `[sfo]`

- **glitchtip** / **glitchtip-db**: part of this repo's own `docker-compose.yml`
  (§9) — confirmed running and healthy.
- **bedrock-keepalive**: **not** part of this monorepo or its compose file — a wholly
  separate project at `/opt/bedrock-keepalive` with its own `docker-compose.yml`
  (`com.docker.compose.project=bedrock-keepalive`), running independently (up 2 weeks
  at read time). Purpose, per its own README: AWS Bedrock periodically marks unused
  model versions `LEGACY` and can revoke account access after a rolling ~30-day
  inactivity window; this script discovers every region+model the account can reach,
  resolves the correct invokable id (direct vs. cross-region inference profile — using
  "the same region-prefix / cross-region-profile resolution logic used in
  `connectome-agent-core`'s `model-resolver.ts`, just driven by live Bedrock API state"
  per its own README), and pings each with a minimal Converse call on a
  `MIN_INTERVAL_DAYS=14` schedule, keeping every model this fleet might route to
  (§5.2) from silently losing account access to inactivity.
