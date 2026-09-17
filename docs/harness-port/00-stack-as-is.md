# The stack as it is — a read of the fleet on `harness-port` (fce107f)

Written by agent B1, 2026-09-17, from a local read-only clone of this monorepo
(identical content, verified `diff`-clean against `/opt/connectome` on the live
box) plus live inspection of the box itself (container list, volumes,
`/proc/net/tcp`, disk, `docker logs`). Every claim below carries a `path:line`
citation into this repo, or is marked "live: <box fact>" for something only
the running box can show. Where I could not verify a claim I say so — this
doc is for a port designer who needs to know what's true, not what's tidy.

Scope: this describes the system generically as a house of chat-platform
bridges ("axons") speaking gRPC to a central perceptual-state server
("connectome"), fronting a fleet of one-process-per-bot LLM agents
("bot-runtime"). No reference to any specific archive or deployment content is
made below beyond what's needed to describe shape and scale.

## 0. Topology in one paragraph

One `connectome` gRPC server (port 50051) holds the only shared state — VEIL
(facets/frames/streams) — air-gapped on an internal-only Docker network
(`docker-compose.yml:137-139,783-789`). Each platform bridge ("axon" —
discord, signal, web live; telegram, whatsapp built but off) is its own
container/process, a gRPC **client** of connectome and a gRPC **server** of
its own tiny `AxonBindingService` (discord 50052, signal 50053, web 50056).
Each bot is its own container (`bot-runtime`, 21 running on the box today),
a gRPC client of both connectome and every axon it uses. Nothing but
connectome sees the union of all state; axons and bots see only what they
subscribe to or are pushed. `connectome-mcp` (port 3100) is a fourth kind of
reader: a Claude-Code-facing MCP server that reads the connectome gRPC API,
the Docker socket, and the state/workspace volumes directly as files.

## 1. connectome-ts — the VEIL server

### 1.1 VEIL model

VEIL expands to "Virtual Embodiment Interface Language" per the runtime
skill `skills/connectome-ontology/SKILL.md:15` — a single append-only event
log with a derived, queryable state projection.

- **Frame** (`connectome-ts/src/veil/types.ts:94-119`): one dequeued event,
  fully processed — `{sequence, timestamp, uuid, activeStream, events,
  deltas, transition, renderedSnapshot?, subCycleTrace?}`.
- **Facet** (`connectome-ts/src/veil/facet-types.ts:13-59,64-68`): a
  `BaseFacet {id, type, tags?}` composed with aspect interfaces
  (Content/State/AgentGenerated/Ephemeral/Scoped/Stream/Targeted). Concrete
  types: `SpeechFacet`/`ThoughtFacet`/`ActionFacet` (`:77-96`),
  `EventFacet`/`StateFacet`/`AmbientFacet`/`EphemeralFacet` (`:105-137`),
  `ConfigFacet` (`:146-149`), meta-facets `StateRewriteFacet`/
  `ScopeRewriteFacet`/`StreamRewriteFacet`/`AgentLifecycleFacet`
  (`:180-230`), `AgentActivationFacet`, `RenderedContextFacet`,
  `ActionDefinitionFacet`, `ElementTreeFacet`/`ElementRequestFacet`/
  `ComponentRequestFacet` (`:245-310`).
- **Stream** (`types.ts:60-74`): a conversation/channel id
  (e.g. `"discord:general"`), optionally with `parentId`/`forkSequence` for
  branch/fork (substreams).
- **VEILState** (`types.ts:176-190`): `facets: Map`, `scopes: Set`,
  `streams: Map`, `agents: Map`, `currentStream`, `frameHistory: Frame[]`,
  `currentSequence`, `removals`, `currentStateCache`.
- **`sync`/sub-cycle** (proto `SpaceEvent.sync` ↔
  `connectome-ts/src/spaces/types.ts:65-96`): a `sync:true` event is
  processed immediately in a nested sub-cycle instead of waiting for the next
  frame (`SubCycleConfig.maxDepth` default 10, `:99-113`) — an escape hatch
  from the one-event-per-frame rule, capped against infinite recursion.

### 1.2 Spaces — the MARTEM component model

Roles, all in `connectome-ts/src/spaces/receptor-effector-types.ts`:
**M**odulator (`:18-25`, preprocesses the event queue), **A**fferent
(`:29-49`, async external listener bridging a platform into events),
**R**eceptor (`:108-121`, stateless event→delta, priority default 50),
**T**ransform (`:123-158`, iterative state→delta derivation; convention
10=infra/50=derivation/100=rendering), **E**ffector (`:162-176`, reacts to
`FacetDelta[]`, returns events/external actions), **M**aintainer
(`:222-244`, phase-4 infra maintenance).

`Space.processFrame()` (`space.ts:759-948`) dequeues exactly **one** event
per frame, builds an `ExecutionContext`, runs every registered component's
`execute()` in priority order, flushes buffered emitted events, then
`veilState.finalizeFrame()` (`:945`) and ephemeral-facet cleanup. Ordering
is priority/constraint-sorted (`spaces/ordering/{component-ordering,
constraint-graph,topological-sort,ordering-diagnostics}.ts`,
`constraints.ts`). Every `Space`, including the bare gRPC one, gets two
built-ins unconditionally in its constructor (`space.ts:207-213`):
`VEILOperationReceptor` and `ActivationCompletedReceptor`.

### 1.3 Persistence — snapshots, deltas, frame buckets, blobs

Directory layout under `PERSISTENCE_DIR`
(`docker-compose.yml:118-119` → `/workspace/connectome-ts/state`, bind-mounted
from a named volume — see §10 for what's actually on disk today):

```
snapshots/                          # periodic full VEILState dumps
deltas/                             # per-frame delta log
frame-buckets/<hash[0:2]>/<hash>.json   # immutable frame batches, git-object sharded
blobs/<sha[0:2]>/<sha>.{json,bin}   # content-addressed attachment bytes
bucket-refs-index.json
migration-progress.json             # blob-migration resume state
```

- **Frame buckets** (`connectome-ts/src/persistence/frame-bucket-store.ts:1-183`):
  frames grouped into buckets of `bucketSize` (default 100), sha256 over
  `JSON.stringify(bucket.frames)`, LRU-cached (max 10, `:1-183`).
  `FrameBucketRef` records which stream types are present (`:102-113`).
- **Blob store** (`connectome-ts/src/persistence/blob-store.ts:1-130`):
  `blob_id = sha256(bytes)`; write-once, crash-safe (`.tmp` + atomic rename,
  `:113-130`), orphan `.tmp` swept on init, **never deletes** ("living
  archive", `:19-20`). Backs the proto's `PutBlob`/`GetBlob` RPCs (§1.4).
- **Snapshots vs. deltas vs. buckets**: `TransitionManager`
  (`persistence/transition-manager.ts:1-95`) hooks
  `space.addDebugObserver().onFrameComplete` → `onFrameEnd()` (`:95`) →
  `createSnapshot()` (`:117,142`) every `snapshotInterval` frames (class
  default 100; `grpc-main.ts` env `SNAPSHOT_INTERVAL` default 1000).
  `FileStorageAdapter` (`persistence/file-storage.ts:44-67,474`) creates the
  `snapshots/`, `deltas/`, `frame-buckets/` dirs and the bucket-refs index.
- **The proto's "deprecated for writes" comment explained**:
  `connectome-ts/scripts/migrate-blobs.ts` + `persistence/blob-migrator.ts`
  (docstring `:1-30`) is "Phase 2 of the content-addressed blob store
  rollout" — rewrites legacy inline-bytes attachments in snapshots/
  frame-buckets/deltas into `blob_id` refs. Crash-safe (`.v2` + rename),
  idempotent, resumable via `migration-progress.json`, explicitly "no
  live-server impact" (files on disk only). See `plan.md:1-322` at repo root
  for the full design history (production incident that motivated it: a
  93 MB speech facet with 4 inline video attachments cascaded
  `DEADLINE_EXCEEDED` to every subscriber — `plan.md:17-22`).
- `serialization.ts`, `restoration.ts`, `component-registry.ts`: confirmed as
  the object↔JSON snapshot bridge and component-type reconstruction by
  import graph; not read line-by-line by this pass.

Live on the box (see §10) the state volume is 44 GB: 38 GB snapshots (590
files today), 4.2 GB frame-buckets, 982 MB deltas, 423 MB blobs (2,724 blob
files), plus the 3.3 MB `migration-progress.json` recording **142,838**
completed blob-migration entries.

### 1.4 The gRPC server — every RPC

`connectome-grpc-common/proto/connectome.proto` defines `ConnectomeService`.
Server-side implementation is `connectome-ts/src/grpc/server.ts` unless noted:

| RPC | What it does | Touches |
|---|---|---|
| `Health` (`:75-84`) | Live counts + uptime, read-only | in-memory VEILState |
| `EmitEvent` (`:87-89` → `grpc/handlers/event-handler.ts`) | Routes an event into the Space queue; synthesizes facets for known event types; maintains a bounded (10k FIFO) `speechAliasMap` (`:37-51`) so a 🫥 reaction on the bot's *own* message (stored as `speech-<eventId>`, not the platform message id) still resolves | Space queue, VEILState |
| `SubscribeToFacets` (`:92-94`, streaming → `subscription-handler.ts`) | Per-client callback + filters (types/aspect/attribute match), `includeExisting`/`fromSequence`/`streamIds`; pushes deltas as facets change | in-memory subscriber list |
| `RegisterAgent` (`:97-139`) | In-memory `registeredAgents: Map` (**not persisted** — wiped on server restart, `:62-70`), issues a session token, emits `agent:registered` | in-memory only |
| `GetContext` (`:142-149` → `handlers/context-handler.ts`) | Resolves agent from `registeredAgents`, renders VEIL→JSON conversation (§1.5) | frameHistory, facets (read-only) |
| `CreateStream` (`:152-195`) | Idempotent create-or-join by `streamId`; `parentStreamId` records a fork point for branching | VEILState streams map |
| `GetStateSnapshot` (`:198-246`) | Filters `veilState.getStateAtSequence()` by facetTypes/streamIds, read-only | in-memory VEILState |
| `GetFrames` (`:249-283`) | Filters the **in-process** `frameHistory` array (bounded by `MAX_FRAME_HISTORY` env, default 50000, min 5/stream — comment cites a prior "428 MB get_streams incident", `grpc-main.ts:44-49`) | in-memory array, **not** the on-disk bucket store |
| `ActivateAgent` (`:286-383`) | Builds two facets in one atomic frame: `agent-activation` + `rendered-context` (calls `resolveActivationMaxFrames()`, `:39-46`, which clamps `!mcf`'s per-request override else env `ACTIVATION_CONTEXT_MAX_FRAMES` default 400, clamp [10,2000], then renders via the context handler with `maxTokens:200000`) | VEILState, one frame write |
| `PutBlob` (`:387-396`, client-streaming) | → `BlobStore.putBlob()` | blob store on disk |
| `GetBlob` (`:399-404`, server-streaming) | → `BlobStore.getBlob()` | blob store on disk |

Note (`server.ts:322-326`): if `registeredAgents` doesn't know an agent name
(e.g. an axon gRPC channel auto-reconnected after a server restart without
re-registering), `ActivateAgent` falls back to `metadata.targetBot`. This is
a real resilience gap a port must reproduce or fix deliberately.

Discord/signal-axon confirm (via their own `client.ts`, see §4) they never
call `GetFrames` at all — only `EmitEvent`, `SubscribeToFacets`,
`RegisterAgent`, `GetContext`/`ActivateAgent`, `CreateStream`, `PutBlob`/
`GetBlob`, `Health`, and `GetStateSnapshot` (for stream metadata only, with
a `facetTypes:['__none__']` sentinel to avoid shipping the whole facet
store — same sentinel used by `connectome-mcp`, §6).

### 1.5 Context rendering — VEIL to bot-visible text

`ContextHandler.handleGetContext()`
(`connectome-ts/src/grpc/handlers/context-handler.ts:57-160`) is a
**hand-rolled JSON builder, not a template/HUD renderer**:

1. Two-pass frame collection (`:74-125`): pass 1 takes every frame whose
   `activeStream` matches the requested `streamId` (or its parent stream, up
   to the fork point) — this is "the conversation" and gets priority up to
   `maxFrames`. Pass 2 fills any remaining budget with ambient (no
   `activeStream`) or, if `includeUnfocused`, cross-stream frames — so
   peripheral noise can never crowd out real history.
2. `buildContext()` (`:165-392`) walks `addFacet`/`rewriteFacet`/
   `removeFacet` deltas in order per facet id (`:308-329`) — **this is how a
   Discord message edit updates in-place**: a `rewriteFacet` delta patches
   `content`/`state` on the already-collected facet before it's ever
   rendered; a `removeFacet` delta deletes it from the render set entirely.
3. Redaction — **this is the 🫥 mechanism, and it lives here, not in any
   axon**: any facet with `state.hiddenFromContext === true` is skipped
   silently in both the focused path (`:203-205`) and the unfocused/demoted
   path (`:401`). The facet stays in VEIL storage, snapshots, and search —
   only the rendered conversation omits it, so "the LLM must have no signal
   that a message was ever there" (comment, `:198-202`).
4. Role mapping: `event`→`user` (`:222-239`); `speech`→`assistant` if
   `agentId`/`agentName` matches the requesting agent, else `user` with a
   `<agentName> ...` prefix and dedup-by-content guard (`:240-278`);
   `thought`→`system`, marked `internal:true` (`:279-285`, stripped first
   under token pressure); `action`→`assistant`, formatted
   `[Action: toolName] content` (`:286-297`).
5. `state`/`ambient`/`config` facets go into a separate `context.state{}`
   map, not the conversation array (`:355-382`); `ambient` facets are
   further filtered by `targetAgentId` (`:369-373`).
6. Token estimate is `Math.ceil(text.length/4)` (`:38-40`) — no real
   tokenizer. `trimContext()` (`:424-454`) degrades in stages: drop internal
   thoughts → shift oldest messages (floor of 10 kept) → drop `state{}`
   entirely → truncate the last 5 messages' content to 500 chars.

`ACTIVATION_CONTEXT_MAX_FRAMES` is read *only* in `server.ts:36` and feeds
`resolveActivationMaxFrames()`, called *only* from `ActivateAgent`'s render
step — it governs the activation-baked context specifically; an ad-hoc
`GetContext` call (e.g. from `connectome-mcp`) passes its own `maxFrames`.

### 1.6 Compression / HUD transforms — built, likely dead in production

`connectome-ts/src/transforms/{compression-transform,continuation-transform,
frame-snapshot-transform,state-transition-transform,active-stream-transform}.ts`
and `src/hud/*` implement a much richer pipeline on paper: automatic
range-compression via a `CompressionEngine`, continuation-tag-triggered
follow-ups (the mechanism `!continue`'s framing docs would suggest),
per-frame rendered-snapshot capture via `FrameTrackingHUD`, auto-generated
`event` facets from `StateFacet` changes, and generic `activeStream`
derivation.

**Evidence this is not wired into the live gRPC path**: `grpc-main.ts`'s
`GrpcServerApplication.initialize()` logs a minimal-space message and adds
no application components; `host.ts` only calls `space.addComponent()` for
`PersistenceMaintainer`/`ComponentManager` (infra) plus two dynamic
call-sites. A repo-wide grep for these five transform names across
discord-axon/signal-axon/web-axon/connectome-agent-core/bot-runtime returns
zero hits. Corroborating: `EmitEvent` (`event-handler.ts:84-92`) and
`ActivateAgent` (`server.ts:365`) both set `frame.activeStream` **manually**
— redundant if `ActiveStreamTransform` ran. Live corroboration: `docker logs
connectome` on the box (6h of uptime, 113k total lines since the container's
Aug-6 creation) shows zero lines matching `compress|continuation|hud|active.
?stream` in a 30-minute recent window, and `ContextHandler` (§1.5) builds its
JSON directly from raw deltas without touching `FrameTrackingHUD` anywhere
in its 473 lines. **Confidence: high but not exhaustive** — I did not
confirm this by reading connectome's full startup log from Aug 6, and
`src/index.ts`'s barrel export still pulls all five transforms in, so a
future re-wiring is one `addComponent()` call away, not a large lift.

### 1.7 Debug UI, agent/* liveness, dead top-level dirs

- **Debug UI** (port 3015, `docker-compose.yml:109`): confirmed —
  `host.ts:264-267,341-345` starts a `DebugServer` when `DEBUG_ENABLED`.
  Live: the box's boot log shows `Debug UI: disabled` (default, matches
  `docker-compose.yml:120`).
- **`src/agent/*` is split-liveness, not uniformly dead**: live because
  every `Space` registers `ActivationCompletedReceptor`
  (`space.ts:213`) which pulls in `agent/activation-completed-receptor.ts`
  → `agent/response-parser.ts` → `agent/action-parser.ts`,
  `agent/types.ts`, `agent/incremental-tool-detector.ts` — these five files
  run in production. `agent-component.ts`, `agent-effector.ts`,
  `agent-element.ts`, `agent-factory.ts`, `basic-agent.ts` are imported only
  from `src/index.ts`, `core-components.ts`, `debug/debug-registry.ts`,
  `scripting/tool-registry.ts`, and `examples/` — **not** from
  `grpc-main.ts`/`grpc/server.ts`/`host.ts` — legacy/example-only on the
  gRPC path.
- **Dead relative to the deployed gRPC server** (verified by import graph,
  not by running anything): `examples/` (incl. `archive/`), root `test-*.ts`
  scratch scripts, `extensions/session-viewer/`, `src/elements/
  console-chat*.ts`, `src/components/console-receptors.ts`, and the whole
  `src/testing/*` family (`session-cli.ts`, `websocket-api.ts`,
  `mcp-server*.ts`, `debug-mcp*.ts`, `session-server-v3.ts`,
  `websocket-client.ts`) — this last group looks like a separate,
  self-contained session/MCP/WebSocket runtime with no relation to the
  axon+bot-runtime stack.
- **Docker entrypoint, confirmed**: `docker/connectome.Dockerfile` copies
  only `connectome-axon-interfaces`+`connectome-grpc-common`+`connectome-ts`
  ("self-contained build — no shared files from the monorepo"), builds
  `--filter=@connectome/connectome-ts`, `CMD ["node","--import","tsx",
  "src/grpc-main.ts"]`. `grpc-main.ts` → bare `GrpcServerApplication` →
  `Space` + `VEILStateManager` + `BlobStore` + `startGrpcServer()` is the
  **entire** production connectome-ts runtime.

## 2. connectome-grpc-common — the transport layer

- `src/server.ts`/`src/client.ts` (grpc-js wrapper around the compiled
  `.proto`); `connectome-ts/src/grpc/server.ts` wires its handlers via
  `server.setHandlers(handlers)` (`connectome-ts server.ts:407`).
- `src/serialization/attachment-handler.ts:1-90`: legacy inline-attachment
  path only — `MAX_INLINE_SIZE=1MB` (`:12`), `CHUNK_SIZE=64KB` (`:16`), JPEG
  quality 80 / max dimension 1920. Does not itself mint `blob_id`s.
- `src/serialization/facet-serializer.ts`: the real wire bridge for
  attachments — `ProtoAttachment` carries both `inlineData?` and `blobId?`;
  serialize prefers `blobId` else base64/Buffer/array→`inlineData`;
  deserialize prefers `blobId`, falls back to `inlineData` — the concrete
  code behind the proto's "blob_id (preferred)" comment.
- `src/mcp/mcp-manager.ts` (398 lines): `MCPManager extends EventEmitter`,
  manages stdio/SSE/streamable-HTTP `@modelcontextprotocol/sdk` clients,
  exposes `getToolHandlers()`/`getAllToolHandlers()` — this is the MCP-client
  pool `AGENTS.md`'s "MCP Server Configuration" section describes, imported
  directly by `bot-runtime/src/bot-runtime.ts:14` (see §5.6).
- `src/sentry.ts:37` (`initErrorTracking({serviceName})`): reads `SENTRY_DSN`
  or `GLITCHTIP_DSN`, `tracesSampleRate:0.1`, tags `service:serviceName`,
  installs global `uncaughtException`/`unhandledRejection` handlers. Called
  from `connectome-ts`'s `grpc-main.ts:10-11` with `serviceName:'connectome'`
  — GlitchTip's actual central-server wiring.

## 3. axon-binding, axon-interfaces, axon-server — the binding protocol

`connectome-axon-binding/proto/axon-binding.proto` defines
`AxonBindingService {AdvertiseBinding, WithdrawBinding, ListBindings}` — the
direct, connectome-bypassing channel a bot-runtime uses to hand a platform
credential (Discord token, Signal phone) straight to the axon that needs it
("secrets never transit the Connectome server", proto header comment).
`AxonBindingServer` (`connectome-axon-binding/src/server.ts:19-179`) runs
*inside* each axon; `AxonBindingClient` (`src/client.ts:12-152`) runs inside
each bot-runtime. Bindings are held purely in memory, keyed
`"platform:agentName"` (`server.ts:22-33`) — `AdvertiseBinding` upserts the
map and only emits `binding:added` (a Node `EventEmitter` event the axon's
`grpc-main.ts` listens for to actually add the bot) when the key is new;
repeat advertisements are "keepalive re-advertisements, silently acked"
(`:96-107`). This is why `bot-runtime.ts`'s 30s re-advertise loop
(`00-stack-as-is.md` §5.10) matters operationally, not just as a liveness
signal: `forgetBinding()` (`server.ts:47-65`) exists specifically so that
when an axon fails to actually stand up a bot after receiving a binding, it
can drop the binding *without* emitting `binding:removed`, so the next
30s keepalive is treated as new and retried — a documented, named self-heal
for a real incident (`server.ts:52-57`: a bot "sat mute on Discord" for
three weeks in 2026-08 after one gRPC timeout closed the retry channel
behind it; matches the 2026-08-06→08-29 outage discord-axon's own
`grpc-main.ts` comments independently describe, `00-stack-as-is.md` §4.1 —
two files, two teams' worth of comments, the same incident).

- **Ports**: `AXON_BINDING_PORT` is 50052 (discord), 50053 (signal), 50056
  (web) — set per-service in `docker-compose.yml:234,279,320` and read by
  each axon's own `grpc-main.ts`. **Live-verified** via each container's
  `/proc/net/tcp`: discord-axon and signal-axon each show exactly one
  listening TCP port besides Docker's DNS stub (their own binding port);
  web-axon shows its binding port on IPv4 and its WebSocket server
  separately on the IPv6 wildcard (`/proc/net/tcp6`) — each axon listens on
  exactly its documented ports and nothing else.
- **The proto only documents discord/signal, but web-axon also runs an
  `AxonBindingServer`** (confirmed in web-axon's own `grpc-main.ts`) and the
  box shows ~21 established inbound connections to web-axon's binding port
  from distinct peers at any time — i.e. every bot-runtime container
  advertises to web-axon too, not just discord/signal, despite the proto
  comment's credential examples only covering the first two platforms. Since
  `credentials` is a free-form `map<string,string>` (proto, not a
  discord/signal-specific schema), nothing in the wire format actually
  restricts this — web-axon's bots likely send an empty or near-empty
  credentials map (web-axon has no token/phone to receive); this doc did not
  trace the exact payload `web-axon/src/grpc/bot-instance.ts` sends, flagged
  as a gap for the porting team to confirm directly.
- **No authentication on `AdvertiseBinding`, confirmed by direct read**: the
  handler (`server.ts:82-108`) only checks that `agentName`/`platform` are
  non-empty — any peer reachable on the `grpc-internal` Docker network can
  claim to be any `agent_name` for any platform, and the server has no
  notion of "this bot-runtime is allowed to claim this name." mTLS *is*
  wired as an option in both `server.ts:147-157` and `client.ts:42-51`
  (same cert-path config shape as the main connectome gRPC), but it's
  opt-in and, live-verified, unused today — `docker/certs` is empty but for
  `.gitkeep`.
- **`axon-server/` (module server / hot reload) is dead weight on the live
  path.** AGENTS.md describes it as an "HTTP/WS server for loading axon
  modules" with hot reload, and docker-compose maps a port for it
  (`8092:8082` discord, `8082:8082` signal — comment "AXON module server (if
  needed)"). **Live-verified**: `docker top discord-axon`/`signal-axon`/
  `web-axon` show exactly one Node process per container running
  `grpc-main.ts`, and `/proc/net/tcp` inside each shows no listener on 8082
  at all. The port mapping is vestigial in the current deployment; nothing
  binds it.
- `connectome-axon-interfaces` (`src/core.ts`, `events.ts`, `manifest.ts`,
  `persistence.ts`, `veil.ts`): shared leaf types for axon components
  (receptor/effector/transform shapes, event payload shapes, a `manifest.ts`
  describing axon self-advertisement of capabilities — distinct from, and
  unrelated to, the credential-advertisement binding protocol above).

## 4. Axons — discord, signal (live), web (live, thinner), telegram/whatsapp (built, off)

### 4.1 Shared shape (discord + signal)

Both are gRPC clients of connectome and gRPC servers of `AxonBindingService`.
Boot (`grpc-main.ts` in each): starts the binding server, then for each
bound credential (env token/phone, or one arriving live via
`AdvertiseBinding`) builds a `BotInstance` (one platform client + one
`ConnectomeClient` + one `StreamManager`) and wires that bot's receptors/
effectors. A 60s reconciliation sweep re-adds any binding whose health check
(`grpcClient.getAgentId() !== undefined`, not just presence) fails — a real
outage from 2026-08 (partial registration left a bot silently deaf for three
weeks, `discord-axon/src/grpc-main.ts:108-117`) motivated the current
all-or-nothing rollback in `addBot()` (`:211-239`).

RPC usage (both axons' `client.ts`): `RegisterAgent` on connect
(capabilities `['send-message','receive-message','slash-commands',
'reactions']`); `EmitEvent` for every inbound platform event; `SubscribeTo
Facets` for outbound speech/actions/activations/typing-stop; `PutBlob`/
`GetBlob` for attachments; `GetContext`/`ActivateAgent` to trigger a turn;
`CreateStream` for substreams; `Health` heartbeat; `GetStateSnapshot` (with
the `facetTypes:['__none__']` sentinel) for stream metadata only. **Neither
axon calls `GetFrames`.**

### 4.2 Dispatch — should this bot respond?

Both axons separate "emit the message to VEIL" from "activate (reply)" — a
message can be stored without a reply, never the reverse.

- **Mention/reply targeting**: Discord matches `message.mentions.users`
  against a live username map (`discord-message-receptor.ts:117-122`) and
  resolves `message.reference` for reply-to-bot (`:203-211`). Signal matches
  `event.mentions[].uuid` (`signal-message-receptor.ts:711-738`) and treats
  a Signal *quote* as the reply equivalent (`:743-747`, Signal has no true
  reply feature).
- **Emission arbitration**: untargeted messages go through a single-winner
  lottery (`message-deduplicator.ts` in each, keyed by platform message id,
  10s TTL). Targeted-without-attachment messages: every targeted bot emits
  its own copy, deduped server-side by deterministic facet id (avoids a
  "quiet activation beats message facet" race). Targeted-with-attachment:
  only the alphabetically-first targeted bot does the (expensive) attachment
  processing and emits; others skip both.
- **Activation priority (both, same order)**: mentioned → reply/quote → DM
  (always activates) → random-reply roll. Discord's random roll only fires
  when *no* bot was targeted at all; Signal's fires for any group message
  the bot itself wasn't targeted by, *including* ones mentioning other bots
  — a real behavioral asymmetry between the two platforms.
- **`RANDOM_REPLY_CHANCE`**: read in each `config-loader.ts` (code default
  200 both), but `docker-compose.yml`'s actual shipped env defaults are
  `1000` for discord/signal (i.e. 0.1% per message) and `0` for web — the
  compose file's defaults, not the code's, are what's live. Both parse via
  `parseInt(...)||default`, which silently turns an explicit `0` back into
  the default (a latent bug Signal's own code comments flag; Discord has no
  equivalent guard).
- **Bot-to-bot budget**: a per-stream `Map<streamId, number>` counter,
  incremented only when the triggering message's author is itself a bot,
  reset to 0 on any human message. Ceiling = `MAX_BOT_MENTIONS` (code
  default 1 both; compose default 1 discord, override via `!bb`). This
  counter, resettable only by a human message, is the **sole** anti-loop
  mechanism — there is no global rate limit.
- **Autotrigger / substreams**: the axon only relays an `agent:command`
  event (`type:'autotrigger'` or `type:'workflow'`); the actual
  self-triggering loop and substream routing live server-side/bot-runtime-
  side. `!stream in/out` maps to a server-side stream with a
  `parentStreamId` (via `CreateStream`); `FocusedContextTransform` and
  `StreamManager` on the axon are stream-scoped so entering a substream just
  changes which `streamId` a given activation fetches context from.
- **Privacy modes**: Signal has `GROUP_PRIVACY_MODE` (`opt-in`/`opt-out`,
  default `opt-out`) governing whether non-mentioned group messages are
  stored at all, with a `.`-prefix escape hatch either way. Discord has a
  simpler rule: any non-DM message starting with `.` is skipped entirely, no
  opt-in mode.

### 4.3 `!` commands

Both effectors (`discord-command-effector.ts`, `signal-command-effector.ts`)
recognize the same 14: `!help`, `!rr [N]`, `!bb [N]`, `!mcf [N|reset]`,
`!mmf [N]`, `!mt [N]`, `!h-default [N|off]`, `!stop`, `!steer <msg>`,
`!autotrigger [on|off]`, `!stream in|out <name>`, `!secret <name> <value>|
list|delete`, `!tts on|off`, `!sysprompt [temp|override|reset] <text|file>`.
Signal alone adds **`!split [N]`** (live-tunes its message-split threshold —
moot for Discord's hard 2000-char wall). None of these ever reach VEIL;
they return early in the receptor before any event is emitted
(`discord-message-receptor.ts:189-199`, `signal-message-receptor.ts:280-291`
— matches `AGENTS.md`'s framing exactly). **`!continue`/`m continue`/`m go`/
`m more` are handled even earlier than the rest** — not in the command
effector at all, but by regex in the *message receptor itself*
(`discord-message-receptor.ts:124-149`, `signal-message-receptor.ts:227-260`)
before any `!`-dispatch logic runs, calling `ActivateAgent(...,
continuation:'true')` directly. Discord additionally deletes the triggering
message (`message.delete()`, `:131`) so the continuation prompt never
lingers in the channel; Signal has no delete capability here and relies on
the early-return alone to keep it out of VEIL. `!sysprompt override` persists to
`/workspace/bot-config-overrides/<botName>.json` via tmp-file+atomic-rename;
`!h-default` similarly persists per-stream, surviving axon restart (most
other commands are in-memory only, lost on restart). `!secret` never touches
VEIL or gRPC at all — pure filesystem write under `shared-workspace`.

### 4.4 Reactions, including 🫥

Neither axon decodes 🫥 semantics — that's server-side, in
`ContextHandler` (§1.5). What the axons own: Discord's
`DiscordReactionReceptor` listens to *both* `messageReactionAdd` and
`...Remove` ("any-🫥-present hides, unhiding needs notice when the last
user unreacts", comment at `discord-reaction-receptor.ts:73-78`); Signal's
websocket receptor forwards `dataMessage.reaction` (previously silently
dropped) specifically for this; and both speech effectors register a
secondary id-alias (`msg-discord-<id>` / `msg-signal-<uuid>-<ts>` →
`speech-<eventId>`) right after sending, via a low-priority
`agent:speech:delivered` event, so a user's 🫥 on the *bot's own* message
resolves back to the right facet (this is the client-side half of the
`speechAliasMap` in `event-handler.ts` from §1.4).

### 4.5 Edits and deletes

Discord: `messageUpdate` → dedup(`edit-<id>`) → `EmitEvent(discord:
messageUpdate)`; `messageDelete` → dedup(`delete-<id>`) →
`EmitEvent(discord:messageDelete)` (`discord-message-receptor.ts:542-606`).
Signal has no native "delete" distinct from Signal's own edit/remote-delete
protocol messages: `env.editMessage` → `signalMessageUpdate`;
`env.dataMessage.remoteDelete` → `signalMessageDelete`
(`signal-websocket-receptor.ts:412-483`), both group-deduped. This axon
fork did not trace the connectome-ts-side handler for these two event
topics against `VEILDeltaType.VEIL_REWRITE_FACET`/`VEIL_REMOVE_FACET` — a
gap for whoever owns that server-side mapping to confirm directly.

### 4.6 Attachments

Inbound (both): downloaded from the platform, images normalized via `sharp`
(resize ≤1024px, JPEG q80, two escalating recompression passes if still
>3.5 MB — duplicated logic in both axons), then `PutBlob`'d; the emitted
message event carries only the `blob_id`. Non-image files up to
`FILE_MAX_BYTES` (default 10 MB) are blob-stored the same way; oversized
files pass through as metadata-only. Outbound: speech effectors resolve
`blobId` refs via `GetBlob` immediately before platform delivery, with two
legacy inline fallback shapes (`Uint8Array`, base64 string) still accepted.

### 4.7 Typing

Discord sends `channel.sendTyping()` on activation and re-fires on an 8s
interval (platform typing expires ~10s) with a 10-minute safety timeout,
cleared via a server-pushed `agent-typing-stop` subscription. **Signal has
no outbound typing indicator at all** — `SignalTypingReceptor` only forwards
*inbound* `typingMessage` events; no `/v1/typing-indicator` call exists
anywhere in signal-axon. A real, easy-to-miss platform asymmetry for a port
to reproduce (or knowingly drop) per axon.

### 4.8 Message splitting

Discord `message-splitter.ts` (`:4-34`): 2000-char default, breaks at
newline ≥50% through, else space ≥50%, else force. Signal's
(`:8-67`): 400-char *default* (a UX choice, not a platform limit — Signal's
real ceiling is much higher), tries paragraph break, then sentence-ending
punctuation, then word boundary, else force; when `MAX_MESSAGE_LENGTH=0`
("native", the docker-compose default) only a hard safety cap applies, no
aggressive chunking.

### 4.9 TTS at the axon layer

Neither speech effector synthesizes audio — both are pure delivery: a
`speech` facet's `attachments[]` may already carry a `blobId` pointing at
pre-rendered audio, fetched via `GetBlob` like any other attachment.
`speech-cleanup.ts` in both strips LLM-emitted tool-call-as-text artifacts
and XML-like tags while preserving platform mention syntax — text hygiene,
not audio. Actual synthesis is `connectome-agent-core/src/tts/*` (§5.7).

### 4.10 Dedup

Discord: `Map<messageId,{firstReceiver,timestamp}>`, 10s TTL — no DM/group
distinction (every bot receives every guild message via its own gateway
connection). Signal: same shape but DMs always bypass dedup (only one bot's
phone number is ever the DM recipient); an `isReprocessed` flag lets the
Signal-only `MessageConsistencyChecker` bypass dedup when force-reinjecting
a message one bot's WebSocket silently missed (`message-consistency-
checker.ts:42-202` — a resilience layer with **no Discord equivalent**,
because Discord's gateway delivery is evidently trusted not to need it).

### 4.11 Legacy dead code inside discord-axon and signal-axon

`discord-axon/src/index.ts` exports a 1759-line `CombinedDiscordAxonServer`
(`src/server.ts`) built on Express+`ws`+`@connectome/axon-server`'s
`AxonModuleServer` — an entirely different, pre-gRPC embedding architecture.
`src/modules/{discord-control-panel,discord-afferent,component-factory}.ts`
import `connectome-ts` Space types directly (server-side components, not
gRPC clients). **`docker/discord-axon.Dockerfile:85` confirms the real
entrypoint is `CMD ["node","--import","tsx","src/grpc-main.ts"]`** — none of
`index.ts`/`server.ts`/`modules/*` is in the live path. Signal's
`src/axon-main.ts` + `src/axon-modules/*` are the same legacy shape (though
signal's own `index.ts` is a thin live re-export, unlike discord's).
`discord-axon/config.json` and `signal-axon/config.json` are both dead —
each `config-loader.ts` states outright "no static config.json; bot
identities are discovered on login" (`discord-axon/src/grpc/config-
loader.ts:1-6`, same wording in signal). Both legacy config files list a bot
named **`ari`** that appears in neither `docker-compose.yml`'s bot roster nor
any currently-running container — and the box independently carries an
orphaned Docker volume `connectome_ari-memories` (**live-verified**,
`docker volume ls`) alongside a `connectome_bot-config-overrides` volume
that *is* live. `ari` is retired debris, not a currently-served bot.

### 4.12 web-axon — thinner by design, not incomplete

`web-axon/src/grpc-main.ts` wires an `AxonBindingServer` (port from
`AXON_BINDING_PORT`) and a `WsServer` (`ws-server.ts`, port from
`WEB_AXON_PORT`, matches `docker-compose.yml`'s `8085:8080` mapping — live-
verified listening on the IPv6 wildcard). Dispatch logic that discord/signal
split into dedicated files is folded inline into `grpc-main.ts`'s `onMessage`
switch. **Confirmed absent, by design**: no `message-deduplicator.ts` (a
direct WS session isn't a polled/webhook API prone to redelivery), no
`mention-resolver.ts` (mention detection is one inline `extractMentions()`
function, longest-name-first substring match), no `message-splitter.ts` (no
platform char limit — it's JSON over a socket), no `focused-context-
transform.ts`. `config-loader.ts` *does* read and use `RANDOM_REPLY_CHANCE`,
`MAX_BOT_MENTIONS`, `MAX_CONVERSATION_FRAMES` (compose defaults 0/3/100).
One latent discrepancy: the code's own bare-env fallback for
`MAX_BOT_MENTIONS` is `1`, but compose always supplies `3` in practice — the
code default is dead under compose, live only for a bare `node` run.
web-axon's `!` command set (`web-command-effector.ts:43-66`) is a strict
subset of discord/signal's: `!help`, `!rr`, `!bb`, `!mcf`, `!mmf`, `!mt`,
`!stop`, `!steer`, `!sysprompt` — missing `!h-default`, `!autotrigger`,
`!stream`, `!secret`, `!tts` (and, unsurprisingly, `!split`). And its
attachment handling is inline-base64 only, not blob-ref-backed like the
other four axons: `connectome-web-sdk/src/protocol.ts:34-35,45` documents
the client attachment shape as "bytes may be sent inline as base64 `data`,
or omitted (metadata-only) for future direct-upload paths" — there is no
browser-side `PutBlob` upload path today, so a port must decide whether to
add one or accept that web attachments stay small/inline by construction.

`connectome-web-sdk` (`src/client.ts`, `protocol.ts`) is a full browser
client (`ConnectomeWebClient`: reconnect/backoff, event emitter, every
protocol action as a method) whose `ClientPayload`/`ServerPayload` types
match `grpc-main.ts`'s switch exactly, with **one asymmetry**: the SDK
declares and emits a client-side `error` event (`protocol.ts:161-165`,
`client.ts:232-234`) that the server **never actually sends** — grep finds
no `type:'error'` literal anywhere in web-axon's source. **No consumer of
this SDK exists inside the monorepo** — a `grep -rl "@connectome/web-sdk"`
hits only the package's own files and web-axon's own type imports; a code
comment references an example client app by name, implying a real consumer
exists outside this repo, unverifiable from here.

### 4.13 telegram-axon and whatsapp-axon — built, not deployed

Both have complete-looking source trees (grammY 1.41 for telegram,
`@whiskeysockets/baileys` 7.0.0-rc.9 for whatsapp — both real
`dependencies`, not `devDependencies`) structurally on par with discord/
signal: `message-deduplicator.ts`, `mention-resolver.ts`, `focused-context-
transform.ts`, `message-splitter.ts` all present for both. No stub markers —
every `throw new Error` found is an ordinary "not connected yet" guard
clause, the same defensive pattern discord/signal use. Whatsapp's
`baileys-session.ts` (294 lines) is a genuine multi-file-auth-state,
QR/pairing-code, reconnect-with-backoff session manager, not a stub; it adds
a `rate-limiter.ts` unique among all five axons (WhatsApp's anti-spam
sensitivity). **The actual blocker, confirmed by absence**: neither
`docker/telegram-axon.Dockerfile` nor `docker/whatsapp-axon.Dockerfile`
exists on disk — `docker-compose.yml`'s commented-out service blocks for
both (`:333-396`) reference Dockerfiles that were never written, and
whatsapp's `whatsapp-auth-state` named volume is commented out too (though
see §10 — a live volume by that name exists on the box regardless, likely
from an earlier uncomment/redeploy cycle). Verdict: **code-complete,
never-deployed**, not aspirational skeletons — turning either on today would
need a Dockerfile written before anything else.

Maturity table (dedup / mention-resolver / substream support / splitter, all
`find`-confirmed present or absent):

| Axon | dedup | mention-resolver | focused-context (substream) | splitter | Deployed? |
|---|---|---|---|---|---|
| discord | yes | yes | yes | yes | yes |
| signal | yes | yes | yes | yes | yes |
| telegram | yes | yes | yes | yes | **no** (no Dockerfile) |
| whatsapp | yes | yes | yes | yes | **no** (no Dockerfile) |
| web | no (by design) | inline only | no | no (no char limit) | yes |

## 5. bot-runtime + connectome-agent-core — one process per bot

### 5.1 Boot and the turn loop

`bot-runtime/src/entry.ts:18-55` → `BotRuntime.start()`
(`bot-runtime.ts:113-274`): connect gRPC to connectome → `RegisterAgent` →
resolve model (§5.3) → build `ConnectomeAgent` → `assertAuthReady()`
(fail-fast on dead OAuth) → build `ConnectomeBridge` + `ConnectomeEffector`
(adapter = `NullPlatformAdapter`, i.e. no direct platform delivery from this
process — delivery is entirely the axon's job) → `subscribeToActivations()`
→ `advertiseAxonBindings()`.

**Push-driven, not polling**: `subscribeToActivations()`
(`bot-runtime.ts:349-416`) opens a `SubscribeToFacets` stream filtered to
`agent-activation`/`rendered-context`/`bot-config`/`agent-command`, pairs
activation+context facets by `activationId` (30s TTL join), fires
`fireActivation()` → `effector.handleActivation()`. A 60s `health()` RPC is
a secondary liveness check; the gRPC channel's own keepalive (30s ping / 5s
timeout) handles stream death and reconnect.

`bot-config.ts`'s `BotRuntimeConfig` (`:124-222`) holds model, prompt,
tools, `skill_paths`, `rlm`, `tts`, gateway/endpoint, `mcp`, connectome
host:port, `axon_bindings`, wallet, `compute_hosts`, tls. `loadBotConfig()`
(`:319-434`) reads `bot-runtime/config.json` plus a per-bot overlay at
`/workspace/bot-config-overrides/<name>.json` — the file `!sysprompt
override` writes (§4.3).

`ConnectomeAgent` (`connectome-agent-core/src/connectome-agent.ts`, 1259
lines) pools a `pi-agent-core` `Agent` per stream (LRU + idle sweep) so
concurrent streams don't collide. Two cycle entry points: `runPiCycle()`
(server-side VEIL→messages via `VEILContextAdapter`) and — **the path the
effector actually uses** — `runWithContext()`, fed the pre-rendered
`AgentContext` from `GetContext`/the inline `rendered-context` facet. Both
call `piAgent.prompt()` → `waitForIdle()` → extract new messages →
`messagesToVEILOps()`.

**`!continue`'s "CLI-framed pseudo-prefill"** is `runDirectPrefill()`
(`:808-941`): builds a participant-labeled conversation log wrapped in
`<cmd>cut -c 1-N < untitled.txt</cmd>`-style framing and calls
`@anthropic-ai/sdk`/`@anthropic-ai/bedrock-sdk` `.messages.create()`
**directly**, bypassing pi-agent's tool loop entirely — this is why
`AGENTS.md` says it "works on all model generations".

`ConnectomeEffector.handleActivation()` (`connectome-effector.ts:147-328`):
per-stream dedup, typing indicator, fetch context, subscribe to per-turn
`message_end` for streaming speech, `agent.runWithContext()`, clean +
deliver, optional TTS, `speechRecorder.recordSpeech()` → `agent:speech`
event. `ActivationRouter` (`activation-router.ts`) is grep-confirmed
**dead/unused** — not imported anywhere; one process serves exactly one bot
today, so there's nothing to route between.

### 5.2 pi-agent / pi-ai

External deps: `@earendil-works/pi-agent-core` (the `Agent` class) and
`@earendil-works/pi-ai` (model registry, streaming, OAuth). connectome-
agent-core adds: the VEIL bridge, per-stream agent pooling, a hand-pinned
model table (§5.3), RLM, TTS, thinking-control, skill-loader, refusal-
capture, and the direct-prefill bypass. `pi-auth-provider.ts` (253 lines)
reads `~/.pi/agent/auth.json` (the `${HOME}/.pi/agent:/root/.pi/agent`
volume, shared by **every** bot container) and explicitly handles a
multi-container OAuth refresh-token rotation race: Anthropic rotates the
token on use, so N−1 concurrent bots refreshing at once get `invalid_grant`
— the fix is reload-and-retry-once. `strict:true` mode throws
`OAuthUnavailableError` instead of silently falling back to
`ANTHROPIC_API_KEY` (a documented fix for a prior 3-week silent-billing
incident).

### 5.3 Model routing

`model-resolver.ts` (406 lines), `resolveModel()` (`:206-228`): pi-ai's own
registry (anthropic→bedrock) first, then a hand-pinned `PINNED_MODELS` table
(`:50-182` — `claude-opus-5`, `claude-3-opus-20240229`,
`claude-3-haiku-20240307`, `claude-sonnet-4-20250514`, four Bedrock
3.x/3.5/3.7 entries) restoring models a pi-ai registry purge had deleted,
then cross-region-prefix fallback (`us./eu./apac./global.`). Dispatch
(`bot-runtime.ts:169-183`) branches on the bot's `config.json` fields, not
an env switch: `gateway:'vercel'` → `resolveGatewayModel()` (Vercel AI
Gateway, e.g. `claude-opus-4` routed via `vertex` since its direct/Bedrock
routes sunset); `gateway:'openrouter'` → `resolveOpenRouterModel()` (reaches
retired first-party models like `claude-opus-4.1`; OpenRouter reads its own
env key, no injection needed); `endpoint` set → `resolveLocalModel()`
(self-hosted OpenAI-compatible server — plantoid's local Qwen over
Tailscale); else direct Anthropic/Bedrock. Per-request key injection
(`connectome-agent.ts:146-193`) supplies `VERCEL_AI_GATEWAY_API_KEY` /
`LOCAL_LLM_API_KEY` (default `sk-local`) / an `AWS_REGION` override, by
provider.

`bot-runtime/config.json`'s 20-bot roster (ground truth, read directly)
confirms every provider path in one file: 9 bots on plain `model` strings
(direct Anthropic OAuth/API key), 5 on Bedrock model-id strings (2 with an
explicit `aws_region` override — `eu-west-2`, `ap-southeast-1` — for
region-specific model availability), 1 (`claude-opus-4`) on
`gateway:"vercel"` + `gateway_only:["vertex"]`, 1 (`claude-opus-4-1`) on
`gateway:"openrouter"`, and 1 (`plantoid`) on a bare `endpoint` (local
llama.cpp-style server) with its own `tts`/`context_window`/
`disable_thinking` fields and a large freeform persona prompt. `max_tokens`
ranges 1024 (older/API-key bots) to 16384 (current-generation bots);
`rlm` (§5.9) is only configured on 7 of the newest/highest-capability bots.

### 5.4 Tools (`bot-runtime/src/tools/*.ts`)

| Tool | Does | Calls out to |
|---|---|---|
| `attach-tool.ts` (`attach_file`) | Reads a local file, uploads via blob store (≤8 MB) | `PutBlob` RPC |
| `save-attachment-tool.ts` | Persists an incoming attachment to `/workspace/shared` | filesystem |
| `delegate-tool.ts` | Cross-bot handoff: creates a `workspace:<name>` stream + `agent:activate` event | `CreateStream`/`EmitEvent` — no direct channel between bots |
| `enlist-tool.ts` | Immediate same-stream peer activation | `ActivateAgent` |
| `experiment-tool.ts` (784 lines) | `autoresearch` init/run/log/dashboard loop, state in a local `autoresearch.jsonl` | local filesystem + LLM |
| `inject-secret-tool.ts` | Pipes a stored secret over SSH stdin into a remote `.env`; value never touches argv or LLM context | SSH to a named compute host |
| `paint-inkfield-tool.ts` | POSTs to `${INKFIELD_BRIDGE_URL}/render`, gated solely on that env var being set | inkfield-bridge HTTP API (§9) |
| `process-tool.ts` + `process-registry.ts` | Manages background processes via real PTYs (`node-pty`) | child processes in-container |
| `terminal-tool.ts` | Foreground/background shell exec, plus SSH+rsync to named `compute_hosts` | shell / SSH — **no landlock/seccomp inside the tool itself**; sandboxing is container-level only (read-only rootfs + `seccomp-bot.json` unconditional, `LANDLOCK_ENABLED=true` opt-in, §8.2) |
| `streams-tool.ts`, `substream-tool.ts`, `continue-substream-tool.ts` | list/enter/exit substreams, autotrigger state machine (5 consecutive speech-only cycles → forced mode-collapse ejection, `bot-runtime.ts:816-936`) | `CreateStream`/`SubscribeToFacets` |
| `wallet-tool.ts` | `get_wallet_info`/`check_balance`/`transfer`/`x402_fetch` (viem + `@solana/web3.js`) | on-chain RPCs; keys are AES-256-GCM+scrypt encrypted at rest, master key read **only from a file** (`secrets/wallet_master_key`), never an env var — specifically so `terminal`/`process` can't exfiltrate it via `env`/`printenv` |

### 5.5 Skills

`connectome-agent-core/src/skill-loader.ts` loads skills from **filesystem
paths listed in each bot's own `skill_paths` array** in `config.json` — not
automatically from the monorepo's top-level `skills/` directory; a bot only
gets a skill if it's explicitly listed (confirmed against `config.json`:
most current-generation bots list all 7; older API-key bots list only
`platform-commands`). One SKILL.md per file, YAML frontmatter
(name/description/disable-model-invocation). The 7 runtime skills
(`skills/agent-spawning/{claude-code,collaboration,coordination}`,
`autoresearch`, `connectome-mcp`, `connectome-ontology`,
`economic-operations`, `platform-commands`, `veil-delta-repair`) teach,
respectively: spawning a nested Claude Code instance as a non-root user;
workspace-file-based collaboration and `delegate`-branching; the local-vs-
delegate spawning choice; an edit/run/measure/keep-or-discard experiment
loop with `git checkout -- .` revert on discard; how to use the
`connectome-mcp` tool surface (§6); the VEIL conceptual model
(facets-as-qualia, streams-as-attention, frames-as-moments); wallet/x402
usage; and the canonical, more-complete-than-`AGENTS.md` `!`-command
reference (`platform-commands/SKILL.md` documents `!split`, `!tts`,
`!sysprompt`'s four modes, and `!h-default`, all real but not all listed
in `AGENTS.md` itself); and a VEIL-delta-repair runbook for a specific
"Frame sequence error: expected N, got M" recovery scenario.

### 5.6 MCP servers, from the bot side

`bot-runtime.ts:14` imports `MCPManager` directly from
`@connectome/grpc-common` (§2). `initTools()` filters each bot's `mcp` array
against the global `mcp_servers` list in `config.json` (§5.3's ground truth:
`everything` (stdio), `wolfram` (streamable-http), `kohya-lora-training`
(streamable-http, private URL), `connectome` (streamable-http, →
`connectome-mcp:3100/mcp` — bots can call their own connectome-mcp tools),
`glitchtip` (stdio, `mcp-glitchtip` npm package) — then `connectAll()` and
appends `getAllToolHandlers()` to the bot's tool set.

### 5.7 TTS

`tts-provider.ts`: a bot-scoped provider synthesizing only the final
per-cycle message. `omnivoice-provider.ts` is the one concrete
implementation today; config shape `{provider:'omnivoice', endpoint, voice,
format, speed, ...}`, endpoint overridable per-bot via
`<BOT_NAME>_TTS_ENDPOINT` (plantoid uses this — see `docker-compose.yml`'s
`PLANTOID_TTS_ENDPOINT`). `ConnectomeEffector.synthesizeSpeechAudio()`
appends the result as a normal blob-backed attachment on the `agent:speech`
facet — the axon speech effectors then deliver it exactly like any other
attachment (§4.9), no separate TTS-specific plumbing on the axon side.

### 5.8 RLM

`connectome-agent-core/src/rlm/subprocess.ts` spawns an **external CLI**,
`rlm_query` (not vendored in this repo — a code comment names a sibling
project, "ypi", as the source of truth for the recursion mechanics),
sync or async. `guardrails.ts` enforces depth/call-count/budget/timeout
before spawning; only wired in when a bot's `config.json` has an `rlm` block
(7 bots today, all current-generation Claude models, `maxDepth:2,
maxCalls:10, timeoutSeconds:300`). A spawned child agent shares the parent's
streamFn/model/tools.

### 5.9 Thinking mode and wallets

`thinking-control.ts`: a small first-match adapter registry; the only
concrete adapter today is `adapters/qwen-no-think.ts` (Qwen 3.x's
`/no_think` marker), applied every cycle in `ConnectomeBridge.
buildSystemPrompt()`, backing bot-plantoid's `disable_thinking:true`.
Wallets: `scripts/setup-wallet.sh` (top-level, §11) is the provisioning tool
that produces the `enc:`-prefixed, AES-256-GCM+scrypt-encrypted secrets
`wallet-tool.ts` decrypts using the file-only master key; `WALLET_CHAINS`
env format is `chain|network|rpc_url[|chain_id],...` (see
`docker-compose.yml:65`).

### 5.10 What a bot container structurally needs today

`CONNECTOME_GRPC_HOST` (hard requirement — the data plane).
`DISCORD_AXON_HOST`/`SIGNAL_AXON_HOST`/`WEB_AXON_HOST` — **confirmed live,
not vestigial**: these drive the separate axon-binding protocol
(`AxonBindingClient`, `bot-runtime.ts:1063-1153`, 10 retries + 30s keepalive
re-advertise) that pushes credentials straight to the axon, bypassing
connectome entirely, per §3. Plus: model credentials (OAuth file, API key,
AWS creds, or a gateway key, depending on the bot), the `mcp_servers` list,
the `shared-workspace` volume (read-write), the `bot-config-overrides`
volume (read-only), wallet secrets + master-key file if wallets are enabled,
and `INKFIELD_BRIDGE_URL` if painting is enabled. Everything is `config.json`
-driven per bot, not a single global env switch.

## 6. connectome-mcp — the Claude-Code-facing operator surface

Two transports share one tool set and three backends
(`connectome-mcp/src/mcp-server.ts:37-119`): stdio (`server.ts`, for a local
Claude Code session) and HTTP (`http-server.ts`, one fresh `Server` instance
per session, for containers — this is what `bot-runtime/config.json`'s
`connectome` MCP entry points at).

| Backend | Tools | Reaches |
|---|---|---|
| `ConnectomeBackend` (`backend.ts`) | `health`, `get_streams`, `get_agents`, `get_speech`, `get_events`, `get_facets`, `get_context`, `get_frames`, `emit_event` | gRPC to `connectome:50051` via `@grpc/grpc-js` loading the proto directly. `get_streams`/`get_agents`/`get_speech`/`get_events`/`get_facets` all call `GetStateSnapshot` with a `facetTypes:['__none__']` sentinel to avoid shipping the whole facet store (mirrors the axons' own use of this sentinel, §4.1); `get_facets` refuses to run with no filter at all |
| `DockerBackend` (`docker.ts`) | `docker_status`, `docker_logs`, `docker_restart`, `docker_rebuild_all`, `docker_stop_bots`, `docker_diagnose` | shells out via `child_process.exec` to `docker`/`docker compose ...` with `cwd: COMPOSE_DIR` — needs both the mounted `/var/run/docker.sock` and the bind-mounted repo at `/opt/connectome:ro` |
| `SnapshotBackend` (`snapshot.ts`) | `snapshot_list`, `snapshot_inspect`, `snapshot_events`, `snapshot_frames`, `snapshot_search`, and `snapshot_export` (present in code, **not** in `AGENTS.md`'s documented list — an undocumented extra) | reads `CONNECTOME_STATE_DIR` directly off disk — the same volume as connectome's own `PERSISTENCE_DIR`, mounted separately here |
| `WorkspaceBackend` (`workspace.ts`) | `workspace_list`, `workspace_read`, `workspace_search`, `workspace_write`, `workspace_delete` | reads/writes `WORKSPACE_PATH` = the `shared-workspace` volume, with path-traversal sandboxing and a 100 KB read cap / text-extension allowlist |

**A note on the docker.sock mount's real privilege**: `docker-compose.yml`
mounts the socket `:ro` (`/var/run/docker.sock:/var/run/docker.sock:ro`,
`docker-compose.yml:158`), which only stops this container from overwriting
the socket *file* — it does not narrow the Docker Engine API reachable
through it. A container with this mount can still start, stop, rebuild, and
inspect every other container on the host via that socket, `:ro` or not.
Worth calling out explicitly to anyone porting `connectome-mcp` forward:
the `:ro` flag reads as more restrictive than it is.

## 7. inkfield-bridge — a proxy, never a fork

`inkfield-bridge` is glue: it drives headless Chromium (Puppeteer) against
the real, externally-published inkField app over the network, using that
app's own documented agent hooks — it does **not** vendor or bind-mount the
upstream engine, a deliberate licensing choice (`inkfield-bridge/README.md`,
`docs/COMPLIANCE.md`: the license reserves "integrating the rendering
engine into another application"; using the published app is unrestricted,
self-hosting/embedding it is not).

- `POST /render` (`server.js`) accepts one of `strokes[]` (simple mode,
  expanded via `lib/score.js`'s stroke-plan composer), `recording` (raw
  inkField JSON), or `workspacePath` (render a file already in
  `shared-workspace`) — this is exactly what `paint-inkfield-tool.ts` calls.
- `GET/POST /inbox` — a human drop page (`public/inbox.html`) for someone
  who painted at the real app and downloaded their own recording to hand to
  a bot via `workspace_search`.
- `GET /health`/`/healthz` — used by `docker/inkfield.Dockerfile`'s
  healthcheck.
- Pipeline: per-IP rate limit → validation → sha256-input coalescer (dedupes
  retry storms) → circuit breaker guarding an optional external GPU render
  worker → local-lane fallback (concurrency 1 — one shared headless Chrome
  can't render concurrently without corruption).
- `dream-worker/` is **not part of this docker-compose stack** — a
  stateless twin of the render logic, deployed by hand on a separate GPU box
  reached over Tailscale via `INKFIELD_DREAM_WORKER_URL` (unset by default
  = local-only rendering). Documented measured speedup ~21x GPU vs. local.
- **Rollout-scope documentation drift, confirmed by direct read**:
  `inkfield-bridge/README.md:389-390` says "Live only on `bot-opus-46` today
  (pilot scope — `INKFIELD_BRIDGE_URL` is set on that bot's `docker-
  compose.yml` block specifically, deliberately not in the shared
  [`&bot-env`] anchor)". But the committed `docker-compose.yml` has
  `INKFIELD_BRIDGE_URL` **inside** the shared `&bot-env` anchor
  (`docker-compose.yml:60-62`), with its own comment reading "Rolled out to
  all bots after a single-bot pilot on bot-opus-46." The compose file — the
  thing that actually governs every bot's environment — is almost certainly
  the current truth and the README is stale, but a port designer should
  verify with the keeper rather than assume either document silently, since
  they flatly disagree about scope.

## 8. docker-compose.yml, Dockerfiles, and the sandbox

### 8.1 Services (from `docker-compose.yml`, byte-identical between the local
clone and `/opt/connectome` on the box — verified by `diff`)

| Service | Build | Ports (host:container) | Network(s) | read_only | Notable volumes |
|---|---|---|---|---|---|
| `connectome` | `docker/connectome.Dockerfile` | 50051 gRPC, 3015 debug | grpc-internal only (air-gapped) | yes | `connectome-state` |
| `connectome-mcp` | `docker/connectome-mcp.Dockerfile` | 3100 | grpc-internal + external | yes | `shared-workspace`, `connectome-state` (ro-ish), docker.sock, repo bind-mount |
| `inkfield` | `docker/inkfield.Dockerfile` | 8099 | grpc-internal + external | **no** | `shared-workspace` |
| `signal-axon` | `docker/signal-axon.Dockerfile` | 8082 (unused, §3), 50053 | grpc-internal + external | yes | `shared-workspace`, `bot-config-overrides` (rw) |
| `discord-axon` | `docker/discord-axon.Dockerfile` | 8092→8082 (unused, §3), 50052 | grpc-internal + external | yes | same pattern |
| `web-axon` | `docker/web-axon.Dockerfile` | 8085→8080, 50056 | grpc-internal + external | yes | same pattern |
| `whatsapp-axon`, `telegram-axon` | — | — | — | — | **entire service block commented out**, §4.13 |
| `bot-*` (21 services via `x-bot-runtime` anchor) | `docker/bot-runtime.Dockerfile` | `127.0.0.1:9100-9120 → 8000` | grpc-internal + external | yes | `shared-workspace` (rw), `bot-config-overrides` (ro), `${HOME}/.pi/agent` (shared OAuth), wallet + Anthropic-key file secrets, certs |
| `glitchtip-db` | `postgres:16-alpine` | — | external | no | `glitchtip-db-data` |
| `glitchtip` | `glitchtip/glitchtip:latest` | 8090→8080 | external | no | `glitchtip-uploads` |
| `signal-cli` | `bbernhard/signal-cli-rest-api:0.99` | 8080 | external | no | signal-cli's own data dir (not inspected — off-limits) |

Every axon and bot-runtime service depends on `connectome: condition:
service_healthy`; bot-runtimes additionally wait on `connectome-mcp` and
`web-axon` (`service_started`). Networks: `grpc-internal` (`internal: true`
— genuinely no internet route) and `external` (internet + inter-service
where needed). **The `connectome` service is the only one with zero
membership in `external`** — the "air-gapped" claim in the compose header
comment is real, not aspirational, for that one service.

### 8.2 Dockerfiles and the boot chain

All service Dockerfiles are multi-stage, `FROM ubuntu:24.04 AS base`
(`inkfield.Dockerfile` instead bases on
`ghcr.io/puppeteer/puppeteer:23.11.1` for a preinstalled Chromium), each
self-contained (own docstring: "no shared files from the monorepo" —
rebuilding one service never invalidates another's cache), all using
`tini` as PID-1. CMD per service, confirmed by direct read: `connectome`,
`discord-axon`, `signal-axon`, `web-axon` all run
`node --import tsx src/grpc-main.ts`; `connectome-mcp` runs the
**pre-compiled** `node dist/http-server.js` (not `tsx` — the multi-transport
HTTP server, not the stdio `server.ts`); `inkfield` runs `node server.js`;
`bot-runtime` runs `docker/bot-entrypoint.sh`.

`bot-runtime.Dockerfile` creates a non-root `coder` user owning
`/workspace/shared`; the connectome/axon Dockerfiles run as root, relying on
`read_only:true` + tmpfs (§8.1) instead of a user switch. A dedicated
`security-tools` build stage compiles `docker/landlock-exec.c`
(`gcc -O2 -static`) into `/usr/local/bin/landlock-exec`.

`docker/bot-entrypoint.sh` (10 lines): if `LANDLOCK_ENABLED=true` and the
binary exists, `exec landlock-exec node --import tsx src/entry.ts`,
otherwise plain `exec node --import tsx src/entry.ts`. `landlock-exec.c`
(156 lines): sets `PR_SET_NO_NEW_PRIVS`, applies a Landlock ruleset (kernel
ABI v2, no-ops gracefully below kernel 5.13 or when unsupported) restricting
read-write to `/tmp`, `/workspace/shared`, `/home/coder`, `/root/.pi`,
`/proc/self`, and read-only to `/workspace`, `/usr`, `/lib`, `/lib64`,
`/etc`, `/dev`, `/proc`, `/sys`, `/run/secrets` — then `execvp`s the real
command. `docker/seccomp-bot.json` is `SCMP_ACT_ALLOW`-by-default with
explicit denials for kernel-module/reboot/swap/mount/time-change/BPF/ptrace/
NUMA syscalls (32-name group), namespace creation (`unshare` with a masked
`CLONE_NEWUSER|NEWNET|NEWNS` check), and raw/AF_PACKET/AF_BLUETOOTH/
AF_VSOCK socket creation — matching the compose header's claimed security
posture line for line. **Live-verified**: every currently-running bot
container's `SecurityOpt` carries exactly this seccomp JSON.

### 8.3 mTLS

`GRPC_TLS` is a compose-wide opt-in flag, default `false`; the corresponding
`docker/certs` mount exists everywhere but **live-verified empty** (only a
`.gitkeep`) on the box today — mTLS is written into the architecture but not
actually in effect in this deployment, for connectome, for the axon-binding
protocol (§3), or for anything else. For axon-binding specifically, even
flipping `GRPC_TLS=true` on today's code would not turn on mTLS for that
channel: `bot-runtime.ts:1100` constructs every `AxonBindingClient` with
only `{host, port}`, never a `tls` config, so the option that exists in
`connectome-axon-binding/src/{server,client,types}.ts` is unreachable from
the only caller that exists — it would need explicit wiring, not just a
flag flip, before mTLS could ever protect that channel.

## 9. Top-level `scripts/` and `skills/`

- `glitchtip-entrypoint.sh` — wraps GlitchTip's own `run-all-in-one.sh`,
  polls for readiness, then idempotently runs `createsuperuser --noinput` if
  admin env vars are set. This is `docker-compose.yml`'s `glitchtip`
  `entrypoint: "/entrypoint.sh"` mount.
- `ping-opus-4-vertex.sh` — a **manual, one-shot diagnostic**, not a
  keepalive daemon: curls Vercel AI Gateway's `/v1/chat/completions` pinned
  to the `vertex` upstream, to verify the retired `claude-opus-4` model is
  still reachable that way. A repo-wide grep for "keepalive" inside this
  monorepo turns up only the axon-binding re-advertisement keepalive
  (bot-runtime re-advertises every ~30s) and ordinary gRPC transport
  keepalive — **no bedrock-keepalive script or job exists inside this
  repo**; see §10 for where it actually lives.
- `setup-wallet.sh` (328 lines) — per-bot wallet provisioning: generates
  `secrets/wallet_master_key` if absent (chmod 600, file not env, so
  `terminal`/`process` tools can't read it via `env`), generates Solana
  ed25519 and/or EVM secp256k1 keys, AES-256-GCM+scrypt-encrypts them under
  the master key, appends `enc:`-prefixed values to `.env`, and patches
  `bot-runtime/config.json` to add the `economic-operations` skill path for
  that bot. Idempotent; refuses to overwrite without `--force`.
- `skills/` (runtime, distinct from `.agents/skills/` dev-facing skills) —
  content summarized in §5.5.

## 10. The box, live — what's running under all of this

Everything in this section is a direct observation on the running box,
2026-09-17, not a code claim.

- **21/21 bots defined in `docker-compose.yml` are running and healthy**,
  plus discord-axon, signal-axon, web-axon, connectome, connectome-mcp,
  inkfield, signal-cli, glitchtip, glitchtip-db — every service the compose
  file defines (minus the two commented-out axons) is up.
- **The state volume is a bind-mounted block volume, not a plain Docker
  local volume**, per `/etc/fstab`: a separate 100 GB cloud block-storage
  disk is mounted at a host path under `/mnt/` and then **bind-mounted a
  second time** onto `/var/lib/docker/volumes/connectome_connectome-state/
  _data`, with `x-systemd.requires-mounts-for`/`x-systemd.before=docker.
  service` ordering in fstab so Docker never starts before the block device
  is attached. **Size: 44 GB used of 100 GB** (38 GB snapshots — 590 files,
  86% of the volume, ~65 MB/file average — 4.2 GB frame-buckets, 982 MB
  deltas, 423 MB blobs — 2,724 files). The root filesystem is a separate
  119 GB disk at 53% used. Corroborating the bind-mount finding
  independently of `/etc/fstab`: the volume object's own Docker `CreatedAt`
  is 2026-09-16, but the oldest file physically inside `frame-buckets/`
  dates to 2026-03-07 — six months earlier than the "volume" supposedly
  existed, consistent with a Docker-level volume recreation (a compose
  config-hash change is enough to trigger one) pointing at an
  already-populated bind path rather than a fresh volume with fabricated
  timestamps. **Root cause of the 38 GB, found by direct read**: the
  "fragment snapshot" optimization in `persistence-maintainer.ts:104-147`
  only fragments *frame history* — `fromSequence` filters `frameHistory` to
  just the frames since the last snapshot (`:111,269-270` in
  `serialization.ts`'s `serializeVEILState()`). The **facet map is not
  fragmented at all**: every snapshot re-serializes `state.facets` in its
  *entirety* (`serialization.ts:233-243`, skipping only hard-deletes), and
  `serializeSpace(this.rootSpace)` (`persistence-maintainer.ts:106`)
  re-serializes the full component/space tree every time too. Since facets
  accumulate and are rarely deleted (🫥 only sets a `hidden` flag, it
  doesn't remove the facet, §1.5), the live facet map only grows — so 590
  "fragment" snapshots each still pay the full cost of the ever-larger
  facet map, and only the frame-history slice is actually bounded by the
  design. This is a real scaling concern for a port: at 1000-frame
  intervals, snapshot cost grows with total conversational history, not
  with the interval, and will keep growing indefinitely under the current
  design.
- `shared-workspace` volume: ~3 GB, mixed bot-authored files (documents,
  audio, fonts, python/uv caches) plus per-project subdirectories the bots
  themselves created via the workspace tools.
  `bot-config-overrides` volume: 4 KB (essentially empty — few or no bots
  have used `!sysprompt override` recently).
- Host: 8 vCPU, 15 GB RAM (7.3 GB used, 7.4 GB buff/cache at the time of
  writing) — `docker-compose.yml`'s comment about needing
  `--max-old-space-size=8192` headroom on a 15 GB host checks out exactly.
  Docker: 46 images (17.5 GB, 9 GB reclaimable), 35 containers, local
  volumes 48.8 GB total.
- **Submodule pins** (`git submodule status` on `/opt/connectome`,
  `harness-port`@`fce107f`): every package tracks its own upstream branch —
  most are on `main` or `grpc`, but `connectome-grpc-common` is pinned to
  `feat/blob-store` and `connectome-web-sdk` to `feature/sysprompt` — i.e.
  the deployed tree mixes a stable core with two packages still on
  feature branches.
- **`bedrock-keepalive`** — a standalone container (`bedrock-keepalive:
  latest`, up 2 weeks, its own `bedrock-keepalive_default` network) living
  at `/opt/bedrock-keepalive` on the box, **entirely outside this
  docker-compose stack and outside this git repo**. Per its own README: AWS
  marks inactive Bedrock model versions `LEGACY` and can eventually revoke
  account access to them; this daemon discovers every Bedrock region and
  every Anthropic model/inference-profile combination the account can see,
  and pings each with a minimal `Converse` call on a schedule
  (`MIN_INTERVAL_DAYS=14`) purely to keep AWS's 30-day activity clock from
  expiring — a standing correction for a policy, not a bug. Its own
  comments explicitly note it mirrors `connectome-agent-core/model-
  resolver.ts`'s region-prefix/cross-region-profile resolution logic,
  independently, against live AWS API state rather than a hardcoded table.
  It is a long-running daemon with its own internal scheduling loop, not
  cron/systemd-timer-driven (confirmed: no crontab, no matching systemd
  timer on the box).
- **`glitchtip`**: `glitchtip/glitchtip:latest` + a dedicated
  `postgres:16-alpine` (`glitchtip-db`), both up ~2 months (much older than
  the rest of the fleet, which was recreated 6 hours before this read) —
  the error-tracking backbone every service's `GLITCHTIP_DSN` reports to,
  plus a `mcp-glitchtip` MCP tool bots can call directly (§5.6).
- Two unrelated debris volumes exist on the box and are **not** part of
  this monorepo's compose file: `connectome_ari-memories` (§4.11 — a
  retired bot) and `ari-emo_ari-memories` (a different, unrelated project
  by naming convention) — noted only so a port designer doesn't mistake
  them for live state.

## 11. Summary — what's real vs. vestigial, at a glance

| Claimed in compose/proto/AGENTS.md | Actually live? | Evidence |
|---|---|---|
| Axon module server (port 8082/8092) | **No** | `/proc/net/tcp` inside discord/signal-axon shows no listener there |
| mTLS (`GRPC_TLS`) | **No** | `docker/certs` empty but for `.gitkeep` |
| Compression/continuation/HUD transforms | **Likely no** | Not wired in `host.ts`/`grpc-main.ts`; zero cross-package importers; no matching `docker logs` output in a 30-min window |
| `GetFrames` RPC | Implemented, **unused by any axon** | grep of both `client.ts` files |
| `ActivationRouter` (agent-core) | **No** | Zero importers; one process = one bot today |
| telegram-axon / whatsapp-axon | **No** (code exists, no Dockerfile) | `docker/*.Dockerfile` listing |
| discord-axon/signal-axon legacy `config.json` + pre-gRPC server | **No** | Dockerfile CMD points at `grpc-main.ts`; `config-loader.ts` says so itself |
| axon-binding for web (not in the proto's own comment) | **Yes, live** | ~21 established connections to web-axon:50056 on the box |
| bedrock-keepalive | **Yes, but outside this repo entirely** | separate compose project on the same box |
